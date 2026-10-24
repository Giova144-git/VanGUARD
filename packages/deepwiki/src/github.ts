// Lectura de GitHub para DeepWiki: metadatos + commit, árbol y archivos crudos. Solo `deps.fetch` (corre en el Worker
// y en Node). Cada función acota sus subpeticiones y los bytes que parsea: en Workers Free cada paso tiene 10 ms de
// CPU y <= 40 subpeticiones. Basado en deepwiki/src/github.mjs de Andrés.
// El token nunca se registra ni entra en mensajes de error; redirecciones a otro host no se siguen (no lo filtran).
import { RepoFullName } from '@vanguard/contracts';
import type { WikiRepoRef } from '@vanguard/contracts';
import { carpetaExcluida, rutaInsegura } from './filtros.ts';
import type { Deps, EntradaArbol, Limites, MetaRepo } from './tipos.ts';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const AGENTE = 'vanguard-deepwiki';
const ESPERA_MS = 20_000;
const MAX_BYTES_JSON = 256_000;           // respuestas chicas (repo, commits?per_page=1)
const CONCURRENCIA_ARCHIVOS = 5;
// Más que esto no se parsea: se baja al árbol superficial. ~450 KB son unas 2.000 entradas; medido, 6.200 entradas
// (1,49 MB) costaban 13-16 ms entre JSON.parse, filtros y orden, más que los 10 ms de CPU de un paso.
export const MAX_BYTES_ARBOL = 450_000;
const MAX_ESPERA_S = 3600;               // tope de reintentarEnS
export const MAX_CARPETAS_SUPERFICIAL = 20;
export const MAX_SUBPETICIONES_META = 3;
export const MAX_SUBPETICIONES_ARBOL = 30; // + 3 de leerMeta = 33 <= 40 en el paso `arbol`
const RE_SHA = /^[0-9a-f]{40}$/;
// Primero las carpetas que suelen tener el código; el resto en el orden en que las devuelve GitHub.
const CARPETAS_FUENTE = new Set(['src', 'apps', 'packages', 'services', 'libs', 'lib', 'cmd', 'internal', 'pkg',
  'app', 'server', 'client', 'api', 'web', 'backend', 'frontend', 'core']);

export type CodigoErrorGithub = 'repo_invalido' | 'ref_invalida' | 'repo_no_encontrado' | 'ref_no_encontrada'
  | 'limite_github' | 'token_invalido' | 'repo_vacio' | 'github_error' | 'github_red' | 'respuesta_invalida';

// `reintentarEnS`: en limite_github, segundos hasta que GitHub vuelve a aceptar (retry-after o x-ratelimit-reset),
// acotado a 1 hora; el consumidor de la cola lo usa como delaySeconds en vez de gastar sus reintentos enseguida.
export class ErrorGithub extends Error {
  readonly codigo: CodigoErrorGithub;
  readonly status: number | null;
  readonly reintentarEnS: number | null;
  constructor(codigo: CodigoErrorGithub, mensaje: string, status: number | null = null, reintentarEnS: number | null = null) {
    super(mensaje);
    this.name = 'ErrorGithub';
    this.codigo = codigo;
    this.status = status;
    this.reintentarEnS = reintentarEnS;
  }
}

export type ArbolRepo = {
  entradas: EntradaArbol[];   // solo blobs (archivos); en modo superficial, parcial
  truncado: boolean;          // GitHub truncó o el cuerpo pasaba de MAX_BYTES_ARBOL: se usó el árbol superficial
  subpeticiones: number;
};
export type ArchivoLeido = { path: string; contenido: string; bytes: number };

type Cupo = { restantes: number; usadas: number };
type Contexto = 'repo' | 'ref' | 'arbol' | 'archivo';

// «dueño/repo», https://github.com/dueño/repo(.git) o github.com/dueño/repo → «dueño/repo» validado (para la CLI).
export function normalizarRepo(entrada: string): string {
  const m = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(entrada.trim());
  const nombre = m ? `${m[1]}/${m[2]}` : '';
  if (!RepoFullName.safeParse(nombre).success) {
    throw new ErrorGithub('repo_invalido', 'Repo inválido: usa dueño/repo o https://github.com/dueño/repo.');
  }
  return nombre;
}

function validarRepo(nombre: string): string {
  if (!RepoFullName.safeParse(nombre).success) throw new ErrorGithub('repo_invalido', 'Nombre de repo inválido (dueño/repo).');
  return nombre;
}

// Reglas de git check-ref-format que importan para armar una URL segura.
function refValida(ref: string): boolean {
  return ref.length >= 1 && ref.length <= 100 && !/[\u0000- \u007f~^:?*[\\]/.test(ref) && !ref.includes('..')
    && !ref.includes('//') && !ref.includes('@{') && !ref.startsWith('/') && !ref.endsWith('/') && !ref.endsWith('.')
    && ref !== '@';
}

const codificarRuta = (ruta: string) => ruta.split('/').map(encodeURIComponent).join('/');

function cabeceras(deps: Deps, accept: string | null): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': AGENTE };
  if (accept) { h.Accept = accept; h['X-GitHub-Api-Version'] = '2022-11-28'; }
  if (deps.githubToken) h.Authorization = `Bearer ${deps.githubToken}`;
  return h;
}

// Una subpetición con cupo. Sigue como mucho una redirección y solo dentro del mismo host (repo renombrado).
async function pedir(deps: Deps, url: string, accept: string | null, cupo: Cupo, seguir: boolean): Promise<Response> {
  let actual = url;
  for (let salto = 0; ; salto++) {
    if (cupo.restantes <= 0) throw new ErrorGithub('github_error', 'Se agotó el cupo de peticiones a GitHub de este paso.');
    cupo.restantes--; cupo.usadas++;
    let res: Response;
    try {
      res = await deps.fetch(actual, { headers: cabeceras(deps, accept), redirect: 'manual',
        signal: AbortSignal.timeout(ESPERA_MS) });
    } catch {
      throw new ErrorGithub('github_red', 'No se pudo contactar a GitHub (red o tiempo de espera agotado).');
    }
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const destino = res.headers.get('location');
    await descartar(res);
    const origen = new URL(actual).origin;
    let siguiente: URL | null = null;
    try { siguiente = destino ? new URL(destino, actual) : null; } catch { siguiente = null; }
    if (!seguir || salto >= 1 || !siguiente || siguiente.origin !== origen) {
      throw new ErrorGithub('github_error', `GitHub respondió una redirección no admitida (${res.status}).`, res.status);
    }
    actual = siguiente.href;
  }
}

async function descartar(res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* el cuerpo ya estaba cerrado */ }
}

// Segundos de espera que pide GitHub: retry-after (límite secundario) o x-ratelimit-reset (época, límite primario).
export function esperaDe(cabeceras: Headers, ahoraMs: number): number | null {
  const ra = Number(cabeceras.get('retry-after'));
  let s = Number.isFinite(ra) && ra > 0 ? ra : NaN;
  if (Number.isNaN(s) && cabeceras.get('x-ratelimit-remaining') === '0') {
    const reset = Number(cabeceras.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) s = reset - ahoraMs / 1000;
  }
  return Number.isFinite(s) ? Math.min(MAX_ESPERA_S, Math.max(1, Math.ceil(s))) : null;
}

function errorDeEstado(status: number, contexto: Contexto, conToken: boolean, res?: Response, deps?: Deps): ErrorGithub {
  if (status === 401) return new ErrorGithub('token_invalido', 'El token de GitHub no es válido o venció; vuelve a conectar tu GitHub.', status);
  if (status === 403 || status === 429) {
    const espera = res ? esperaDe(res.headers, (deps?.ahora?.() ?? new Date()).getTime()) : null;
    return new ErrorGithub('limite_github', conToken
      ? 'Límite de GitHub o permiso insuficiente; revisa tu conexión de GitHub.'
      : 'Límite de GitHub alcanzado; conecta tu GitHub para seguir.', status, espera);
  }
  if (contexto === 'ref' && (status === 404 || status === 422)) {
    return new ErrorGithub('ref_no_encontrada', 'No existe esa rama, tag o commit en el repo.', status);
  }
  if (status === 404) {
    return new ErrorGithub('repo_no_encontrado', conToken
      ? 'Repo inexistente o sin acceso con tu conexión de GitHub.'
      : 'Repo inexistente o privado sin conexión de GitHub.', status);
  }
  if (status === 409) return new ErrorGithub('repo_vacio', 'El repositorio está vacío.', status);
  return new ErrorGithub('github_error', `GitHub respondió ${status}.`, status);
}

// Lee el cuerpo sin pasar de `max` bytes; null si se pasa (se corta la descarga sin decodificar ni parsear nada).
async function leerAcotado(res: Response, max: number): Promise<Uint8Array | null> {
  const declarado = Number(res.headers.get('content-length'));
  if (Number.isFinite(declarado) && declarado > max) { await descartar(res); return null; }
  if (!res.body) return new Uint8Array(0);
  const lector = res.body.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { try { await lector.cancel(); } catch { /* nada */ } return null; }
      trozos.push(value);
    }
  } catch {
    // El tiempo de espera también corta la lectura del cuerpo: se informa como error de red.
    throw new ErrorGithub('github_red', 'No se pudo contactar a GitHub (red o tiempo de espera agotado).');
  }
  if (trozos.length === 1 && trozos[0]) return trozos[0];
  const todo = new Uint8Array(total);
  let o = 0;
  for (const t of trozos) { todo.set(t, o); o += t.byteLength; }
  return todo;
}

const decodificar = (b: Uint8Array) => new TextDecoder().decode(b);

async function leerJson(res: Response, max: number): Promise<unknown> {
  const cuerpo = await leerAcotado(res, max);
  if (!cuerpo) throw new ErrorGithub('respuesta_invalida', 'GitHub devolvió una respuesta demasiado grande.');
  try { return JSON.parse(decodificar(cuerpo)); } catch {
    throw new ErrorGithub('respuesta_invalida', 'GitHub devolvió una respuesta ilegible.');
  }
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const textoONulo = (v: unknown) => (typeof v === 'string' ? v : null);

// Metadatos del repo y commit exacto de la rama/tag pedida (o de la rama principal). <= 3 subpeticiones.
export async function leerMeta(ref: WikiRepoRef, deps: Deps): Promise<MetaRepo> {
  const nombre = validarRepo(ref.repo_full_name);
  const pedida = ref.ref?.trim() || undefined;
  if (pedida !== undefined && !refValida(pedida)) throw new ErrorGithub('ref_invalida', 'Nombre de rama o tag inválido.');
  const cupo: Cupo = { restantes: MAX_SUBPETICIONES_META, usadas: 0 };
  const conToken = Boolean(deps.githubToken);

  const res = await pedir(deps, `${API}/repos/${nombre}`, 'application/vnd.github+json', cupo, true);
  if (!res.ok) { await descartar(res); throw errorDeEstado(res.status, 'repo', conToken, res, deps); }
  const datos = await leerJson(res, MAX_BYTES_JSON);
  if (!esObjeto(datos) || typeof datos.default_branch !== 'string' || !refValida(datos.default_branch)) {
    throw new ErrorGithub('respuesta_invalida', 'GitHub devolvió metadatos del repo incompletos.');
  }
  // Repo renombrado: se sigue con el nombre canónico para no gastar otra redirección.
  const full_name = typeof datos.full_name === 'string' && RepoFullName.safeParse(datos.full_name).success
    ? datos.full_name : nombre;
  const branch = pedida ?? datos.default_branch;
  const commit_sha = await resolverSha(full_name, branch, deps, cupo, conToken);
  return {
    full_name, description: textoONulo(datos.description), language: textoONulo(datos.language),
    private: datos.private === true, default_branch: datos.default_branch, branch, commit_sha,
  };
}

async function resolverSha(full_name: string, branch: string, deps: Deps, cupo: Cupo, conToken: boolean): Promise<string> {
  // El tipo vnd.github.sha devuelve solo los 40 caracteres: nada de parsear el commit entero con su lista de cambios.
  const res = await pedir(deps, `${API}/repos/${full_name}/commits/${codificarRuta(branch)}`,
    'application/vnd.github.sha', cupo, false);
  if (!res.ok) { await descartar(res); throw errorDeEstado(res.status, 'ref', conToken, res, deps); }
  const cuerpo = await leerAcotado(res, 1_000);
  const sha = cuerpo ? decodificar(cuerpo).trim().toLowerCase() : '';
  if (RE_SHA.test(sha)) return sha;
  // Plan B si el tipo de medio no se respetó: la lista de commits con uno solo (sin diffs).
  if (cupo.restantes <= 0) throw new ErrorGithub('respuesta_invalida', 'GitHub no devolvió el commit de la rama.');
  const res2 = await pedir(deps, `${API}/repos/${full_name}/commits?sha=${encodeURIComponent(branch)}&per_page=1`,
    'application/vnd.github+json', cupo, false);
  if (!res2.ok) { await descartar(res2); throw errorDeEstado(res2.status, 'ref', conToken, res2, deps); }
  const lista = await leerJson(res2, MAX_BYTES_JSON);
  const primero: unknown = Array.isArray(lista) ? lista[0] : null;
  const sha2 = esObjeto(primero) && typeof primero.sha === 'string' ? primero.sha.toLowerCase() : '';
  if (!RE_SHA.test(sha2)) throw new ErrorGithub('respuesta_invalida', 'GitHub no devolvió el commit de la rama.');
  return sha2;
}

function validarMeta(meta: MetaRepo): void {
  validarRepo(meta.full_name);
  if (!RE_SHA.test(meta.commit_sha)) throw new ErrorGithub('respuesta_invalida', 'Commit inválido en los metadatos.');
}

type NodoArbol = { path: string; type: string; size?: number; sha?: string };

// Solo nodos bien formados; las rutas de una subcarpeta llegan relativas y se les antepone `prefijo`.
function nodosDe(datos: unknown): { nodos: NodoArbol[]; truncado: boolean } {
  if (!esObjeto(datos) || !Array.isArray(datos.tree)) throw new ErrorGithub('respuesta_invalida', 'GitHub devolvió un árbol ilegible.');
  const nodos: NodoArbol[] = [];
  for (const n of datos.tree) {
    if (!esObjeto(n) || typeof n.path !== 'string' || typeof n.type !== 'string') continue;
    nodos.push({ path: n.path, type: n.type, size: typeof n.size === 'number' ? n.size : undefined,
      sha: typeof n.sha === 'string' ? n.sha : undefined });
  }
  return { nodos, truncado: datos.truncated === true };
}

function agregarBlobs(destino: EntradaArbol[], nodos: NodoArbol[], prefijo: string): void {
  for (const n of nodos) {
    if (n.type !== 'blob') continue;
    const e: EntradaArbol = { path: prefijo + n.path, type: 'blob' };
    if (n.size !== undefined) e.size = n.size;
    destino.push(e);
  }
}

// Árbol del commit. Normal: 1 subpetición recursiva. Si el cuerpo pasa de MAX_BYTES_ARBOL o GitHub lo trunca, no se
// parsea: árbol superficial (raíz + hasta 20 carpetas de primer nivel, cada una recursiva si cabe en lo que queda del
// presupuesto de bytes y, si no, solo su primer nivel). Devuelve solo blobs. <= MAX_SUBPETICIONES_ARBOL subpeticiones.
export async function leerArbol(meta: MetaRepo, deps: Deps,
  opciones: { maxBytes?: number; maxCarpetas?: number } = {}): Promise<ArbolRepo> {
  validarMeta(meta);
  const maxBytes = opciones.maxBytes ?? MAX_BYTES_ARBOL;
  const maxCarpetas = opciones.maxCarpetas ?? MAX_CARPETAS_SUPERFICIAL;
  const cupo: Cupo = { restantes: MAX_SUBPETICIONES_ARBOL, usadas: 0 };
  const conToken = Boolean(deps.githubToken);
  const base = `${API}/repos/${meta.full_name}/git/trees/`;
  const accept = 'application/vnd.github+json';

  const res = await pedir(deps, `${base}${meta.commit_sha}?recursive=1`, accept, cupo, true);
  if (!res.ok) { await descartar(res); throw errorDeEstado(res.status, 'arbol', conToken, res, deps); }
  const cuerpo = await leerAcotado(res, maxBytes);
  if (cuerpo) {
    const { nodos, truncado } = nodosDe(parsear(cuerpo));
    if (!truncado) {
      const entradas: EntradaArbol[] = [];
      agregarBlobs(entradas, nodos, '');
      return { entradas, truncado: false, subpeticiones: cupo.usadas };
    }
  }

  // Árbol superficial. El presupuesto de bytes es acumulado: el CPU de JSON.parse crece con los bytes.
  let restante = maxBytes;
  const resRaiz = await pedir(deps, `${base}${meta.commit_sha}`, accept, cupo, true);
  if (!resRaiz.ok) { await descartar(resRaiz); throw errorDeEstado(resRaiz.status, 'arbol', conToken, resRaiz, deps); }
  const cuerpoRaiz = await leerAcotado(resRaiz, restante);
  if (!cuerpoRaiz) throw new ErrorGithub('respuesta_invalida', 'La raíz del repo es demasiado grande para leerla.');
  restante -= cuerpoRaiz.byteLength;
  const raiz = nodosDe(parsear(cuerpoRaiz)).nodos;
  const entradas: EntradaArbol[] = [];
  agregarBlobs(entradas, raiz, '');

  const carpetas = raiz.filter((n) => n.type === 'tree' && n.sha && /^[0-9a-f]{40}$/.test(n.sha) && !carpetaExcluida(n.path));
  const fuente = carpetas.filter((n) => CARPETAS_FUENTE.has(n.path.toLowerCase()));
  const otras = carpetas.filter((n) => !CARPETAS_FUENTE.has(n.path.toLowerCase()));
  for (const c of [...fuente, ...otras].slice(0, maxCarpetas)) {
    if (cupo.restantes <= 0 || restante <= 0) break;
    const prefijo = `${c.path}/`;
    const leida = await leerCarpeta(deps, `${base}${c.sha}?recursive=1`, restante, cupo, conToken)
      ?? (cupo.restantes > 0 ? await leerCarpeta(deps, `${base}${c.sha}`, restante, cupo, conToken) : null);
    if (!leida) continue;
    restante -= leida.bytes;
    agregarBlobs(entradas, leida.nodos, prefijo);
  }
  return { entradas, truncado: true, subpeticiones: cupo.usadas };
}

function parsear(cuerpo: Uint8Array): unknown {
  try { return JSON.parse(decodificar(cuerpo)); } catch {
    throw new ErrorGithub('respuesta_invalida', 'GitHub devolvió un árbol ilegible.');
  }
}

// null si la carpeta no cabe en el presupuesto o GitHub falla con algo que no sea límite/token.
async function leerCarpeta(deps: Deps, url: string, max: number, cupo: Cupo, conToken: boolean)
  : Promise<{ nodos: NodoArbol[]; bytes: number } | null> {
  const res = await pedir(deps, url, 'application/vnd.github+json', cupo, true);
  if (!res.ok) {
    await descartar(res);
    if (res.status === 401 || res.status === 403 || res.status === 429) throw errorDeEstado(res.status, 'arbol', conToken, res, deps);
    return null;
  }
  const cuerpo = await leerAcotado(res, max);
  if (!cuerpo) return null;
  return { nodos: nodosDe(parsear(cuerpo)).nodos, bytes: cuerpo.byteLength };
}

export type LecturaArchivos = { archivos: ArchivoLeido[]; fallidos: number };

// Descarga archivos crudos del commit exacto (raw.githubusercontent.com), 5 a la vez, en el orden pedido. Se descarta
// sin error lo que pase de maxBytesArchivo, lo binario, lo inexistente (404), lo redirigido (LFS) y las rutas
// inseguras; 401/403/429 lanzan ErrorGithub porque el resto fallaría igual. Un 5xx o un fallo de red es transitorio:
// se reintenta una vez mientras quede `reintentos` (subpeticiones de sobra en el paso). Si aun así no se leyó nada o
// falló más de la mitad, lanza github_red para que la cola reintente el paso: una wiki degradada por una caída
// momentánea quedaría guardada en la caché del commit. `fallidos` cuenta los transitorios que se perdieron.
// Una subpetición por ruta más los reintentos: quien llama decide cuántas caben.
// El contenido NO viene redactado: hay que pasarlo por la redacción antes de armar cualquier prompt.
export async function leerArchivosDetalle(meta: MetaRepo, paths: readonly string[], deps: Deps,
  limites: Pick<Limites, 'maxBytesArchivo'>, opciones: { reintentos?: number } = {}): Promise<LecturaArchivos> {
  validarMeta(meta);
  const conToken = Boolean(deps.githubToken);
  const unicas = [...new Set(paths)].filter((p) => !rutaInsegura(p));
  const reintentos = Math.max(0, Math.floor(opciones.reintentos ?? 0));
  const resultados: (ArchivoLeido | null)[] = new Array<ArchivoLeido | null>(unicas.length).fill(null);
  const transitorio: boolean[] = new Array<boolean>(unicas.length).fill(false);
  const cupo: Cupo = { restantes: unicas.length + reintentos, usadas: 0 };
  // Objeto y no `let`: lo escriben los trabajadores y el análisis de flujo de TS no ve esas escrituras.
  const corte: { fallo: ErrorGithub | null } = { fallo: null };

  const leerUno = async (i: number) => {
    const path = unicas[i] as string;
    const url = `${RAW}/${meta.full_name}/${meta.commit_sha}/${codificarRuta(path)}`;
    transitorio[i] = false;
    try {
      const res = await pedir(deps, url, null, cupo, false);
      if (!res.ok) {
        await descartar(res);
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          throw errorDeEstado(res.status, 'archivo', conToken, res, deps);
        }
        if (res.status >= 500) transitorio[i] = true;
        return;
      }
      const cuerpo = await leerAcotado(res, limites.maxBytesArchivo);
      if (!cuerpo || cuerpo.byteLength === 0 || cuerpo.indexOf(0) >= 0) return; // grande, vacío o binario
      resultados[i] = { path, contenido: decodificar(cuerpo), bytes: cuerpo.byteLength };
    } catch (e) {
      // Límite/token: se corta todo. Red caída o tiempo agotado: transitorio. Redirección a otro host o cupo
      // agotado: se omite el archivo.
      if (e instanceof ErrorGithub && (e.codigo === 'limite_github' || e.codigo === 'token_invalido')) corte.fallo ??= e;
      else if (e instanceof ErrorGithub && e.codigo === 'github_red') transitorio[i] = true;
    }
  };
  const correr = async (indices: readonly number[]) => {
    let k = 0;
    const trabajador = async () => {
      while (corte.fallo === null && k < indices.length) await leerUno(indices[k++] as number);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCIA_ARCHIVOS, indices.length) }, trabajador));
    if (corte.fallo) throw corte.fallo;
  };

  await correr(unicas.map((_, i) => i));
  const otraVez = transitorio.flatMap((t, i) => (t ? [i] : [])).slice(0, reintentos);
  if (otraVez.length > 0) await correr(otraVez);
  const archivos = resultados.filter((r): r is ArchivoLeido => r !== null);
  const fallidos = transitorio.reduce((n, t) => n + (t ? 1 : 0), 0);
  if (fallidos > 0 && (archivos.length === 0 || fallidos * 2 > unicas.length)) {
    throw new ErrorGithub('github_red', `GitHub no entregó ${fallidos} de ${unicas.length} archivos (falla momentánea); `
      + 'conviene reintentar el paso.');
  }
  return { archivos, fallidos };
}

// Atajo sin reintentos ni detalle (pruebas y herramientas; el paso `area` usa leerArchivosDetalle).
export async function leerArchivos(meta: MetaRepo, paths: readonly string[], deps: Deps,
  limites: Pick<Limites, 'maxBytesArchivo'>): Promise<ArchivoLeido[]> {
  return (await leerArchivosDetalle(meta, paths, deps, limites)).archivos;
}
