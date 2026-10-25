import type { PermCheck, ProviderErrorCode } from '@vanguard/contracts';
import type { ArchivoTexto } from '@vanguard/core';
import { ProviderError, codigoHttp, pedir } from '../lib/http.ts';
import { sondeoFallido, type Sondeo } from './sondeo.ts';

// GitHub (§09.2): PAT fine-grained de un solo repo. Obligatorios metadata:read y contents:read; Dependabot no bloquea.
const GH = 'https://api.github.com';
const UA = 'VanGUARD/1.0 (+https://officialvanguard.com)';   // GitHub exige User-Agent
const PLAZO = 10_000;
export const ghHeaders = (t: string) => ({ Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA });

const fallo = (permission: string, required: boolean, e: unknown): PermCheck =>
  ({ permission, ok: false, required, error_code: e instanceof ProviderError ? e.code : 'unavailable' });

export async function probarGithub(token: string, repo: string): Promise<Sondeo> {
  let r: Response;
  try { r = await pedir(`${GH}/repos/${repo}`, { headers: ghHeaders(token) }, PLAZO); } catch (e) {
    return sondeoFallido('caido', [fallo('metadata:read', true, e)], { mensaje: 'GitHub no respondió. Vuelve a intentarlo.' });
  }
  if (!r.ok) {
    await r.body?.cancel();
    const c: PermCheck[] = [{ permission: 'metadata:read', ok: false, required: true, error_code: codigoHttp(r.status) }];
    if (r.status === 401) return sondeoFallido('rechazado', c, { motivo: 'unauthorized', faltan: ['metadata:read'],
      mensaje: 'El token no es válido o caducó.' });
    if (r.status === 403 || r.status === 404) return sondeoFallido('rechazado', c, { faltan: ['metadata:read'],
      mensaje: `Tu token no ve ${repo}. Revisa que lo marcaste en Only select repositories. Si el repo es de una organización, puede que un admin tenga que aprobar el token.` });
    return sondeoFallido('caido', c, { mensaje: 'GitHub no respondió. Vuelve a intentarlo.' });
  }
  const j = (await r.json()) as { id: number; full_name: string; default_branch: string; private: boolean };
  const exp = r.headers.get('github-authentication-token-expiration');           // [no verificado: cabecera y formato]
  const checks: PermCheck[] = [{ permission: 'metadata:read', ok: true, required: true }];
  const [c, d] = await Promise.all([
    pedir(`${GH}/repos/${repo}/commits?sha=${encodeURIComponent(j.default_branch)}&per_page=1`, { headers: ghHeaders(token) }, PLAZO)
      .then(async (x) => { await x.body?.cancel(); return x.status; }).catch((e: unknown) => e),
    pedir(`${GH}/repos/${repo}/dependabot/alerts?per_page=1`, { headers: ghHeaders(token) }, PLAZO)
      .then(async (x) => { await x.body?.cancel(); return x.status; }).catch((e: unknown) => e),
  ]);
  const aCheck = (permission: string, required: boolean, s: unknown): PermCheck => typeof s === 'number'
    ? (s >= 200 && s < 300 ? { permission, ok: true, required } : { permission, ok: false, required, error_code: codigoHttp(s) })
    : fallo(permission, required, s);
  checks.push(aCheck('contents:read', true, c), aCheck('dependabot_alerts:read', false, d));
  const contents = checks[1]!;
  const estado = contents.ok ? 'ok' : contents.error_code === 'forbidden' || contents.error_code === 'not_found' ? 'rechazado' : 'caido';
  return {
    estado,
    faltan: estado === 'rechazado' ? ['contents:read'] : [],
    ...(estado === 'rechazado' ? { mensaje: 'Falta el permiso Contents: Read-only.' } : {}),
    ...(estado === 'caido' ? { mensaje: 'GitHub no respondió. Vuelve a intentarlo.' } : {}),
    checks,
    capabilities: { metadata: true, contents: contents.ok, dependabot_alerts: checks[2]?.ok === true },
    scopes: checks.filter((x) => x.ok).map((x) => x.permission),
    meta: { repo_full_name: j.full_name, default_branch: j.default_branch, private: j.private, repo_id: j.id },
    label: `GitHub · ${j.full_name}`.slice(0, 80),
    expiresAt: exp && !Number.isNaN(Date.parse(exp)) ? new Date(exp).toISOString() : null,
  };
}

// ── Token de acciones de GitHub (bloqueo de merge, asignaciones/bloqueo-merge-criticos.md §2.8 y §4.1; anexo de cierre
// de PR). Solo lecturas y sondeos sin efecto: nunca escribe. La rama va siempre con encodeURIComponent. ─────────────
type Respuesta = { status: number } | { code: ProviderErrorCode };
// El código HTTP, con el 403 de límite como rate_limited (codigoGithub); red o plazo como código. El cuerpo no se lee.
async function respuestaGh(url: string, init: RequestInit): Promise<Respuesta> {
  try {
    const r = await pedir(url, init, PLAZO);
    await r.body?.cancel();
    return r.status === 403 && codigoGithub(r) === 'rate_limited' ? { code: 'rate_limited' } : { status: r.status };
  } catch (e) {
    return { code: e instanceof ProviderError ? e.code : 'unavailable' };
  }
}
const caida = (x: Respuesta) => 'code' in x || x.status === 429 || x.status >= 500;

/** E9 con la conexión GitHub `action`: GET /commits/{rama}/status (Commit statuses: read, que trae write). 200 → active;
 *  401 → revoked; 403 o 404 → error. Un solo check: E9 no reescribe capabilities (pull_requests e issues los fija E53). */
export async function probarEstadosGithub(token: string, repo: string, rama: string): Promise<Sondeo> {
  if (!NOMBRE_REPO.test(repo) || !rama) {
    return sondeoFallido('rechazado', [{ permission: 'statuses:read', ok: false, required: true, error_code: 'invalid' }],
      { faltan: ['statuses:read'], mensaje: 'La conexión de estados no tiene repo o rama: vuelve a guardar el token.' });
  }
  const x = await respuestaGh(`${GH}/repos/${repo}/commits/${encodeURIComponent(rama)}/status`, { headers: ghHeaders(token) });
  if ('status' in x && x.status >= 200 && x.status < 300) {
    return { estado: 'ok', faltan: [], checks: [{ permission: 'statuses:read', ok: true, required: true }],
      capabilities: {}, scopes: [], meta: {}, label: '', expiresAt: null };
  }
  const error_code = 'code' in x ? x.code : codigoHttp(x.status);
  const c: PermCheck[] = [{ permission: 'statuses:read', ok: false, required: true, error_code }];
  if (caida(x)) return sondeoFallido('caido', c, { mensaje: 'GitHub no respondió. Vuelve a intentarlo.' });
  if ('status' in x && x.status === 401) {
    return sondeoFallido('rechazado', c, { motivo: 'unauthorized', faltan: ['statuses:read'],
      mensaje: 'El token de estados no es válido o caducó.' });
  }
  return sondeoFallido('rechazado', c, { faltan: ['statuses:read'],
    mensaje: `El token de estados no ve ${repo}: márcalo en Only select repositories con Commit statuses.` });
}

/** El último commit de la rama vigilada con el token de LECTURA (Contents: read): GET /branches/{rama} (≤ 64 KB). */
export type Rama = { tipo: 'ok'; sha: string } | { tipo: 'sin_rama' } | { tipo: 'token' } | { tipo: 'caido' };
export async function leerRama(token: string, repo: string, rama: string): Promise<Rama> {
  let r: Response;
  try { r = await pedir(`${GH}/repos/${repo}/branches/${encodeURIComponent(rama)}`, { headers: ghHeaders(token) }, PLAZO); }
  catch { return { tipo: 'caido' }; }
  if (!r.ok) {
    await r.body?.cancel();
    const code = codigoGithub(r);
    return r.status === 404 ? { tipo: 'sin_rama' } : code === 'unauthorized' || code === 'forbidden' ? { tipo: 'token' }
      : { tipo: 'caido' };
  }
  try {
    const { texto, cortado } = await leerAcotado(r, 64_000);
    const sha = cortado ? null : (JSON.parse(texto) as { commit?: { sha?: unknown } }).commit?.sha;
    return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? { tipo: 'ok', sha } : { tipo: 'caido' };
  } catch { return { tipo: 'caido' }; }
}

/** Sondeo NEGATIVO del token de acciones antes de escribir nada (§4.1 paso 5): GET /keys (Administration: read) y, solo
 *  en un repo privado, GET /branches/{rama} (Contents: read; en uno público responde 200 con cualquier token). Un 200 →
 *  ese permiso sobra. 5xx, 429 o plazo en alguno → caido (falla cerrado: nada se guarda). No usa …/protection: con la
 *  rama sin proteger responde 404 aunque el token tenga Administration. */
export async function sondeoNegativoEstados(token: string, repo: string, rama: string, privado: boolean):
  Promise<{ sobra: string[]; caido: boolean }> {
  const [keys, rama200] = await Promise.all([
    respuestaGh(`${GH}/repos/${repo}/keys`, { headers: ghHeaders(token) }),
    privado ? respuestaGh(`${GH}/repos/${repo}/branches/${encodeURIComponent(rama)}`, { headers: ghHeaders(token) }) : null,
  ]);
  const ok = (x: Respuesta | null) => !!x && 'status' in x && x.status >= 200 && x.status < 300;
  const sobra = [...(ok(keys) ? ['administration'] : []), ...(ok(rama200) ? ['contents'] : [])];
  return { sobra, caido: caida(keys) || (rama200 !== null && caida(rama200)) };
}

/** Anexo de cierre de PR y botón «Crear issue»: ¿puede el token cerrar PR y crear issues? Sin efecto: POST /pulls y POST
 *  /issues con un cuerpo vacío. Con el permiso, GitHub valida el cuerpo y responde 422 (faltan head/base o title): no
 *  crea nada. Sin él, 403 (o 404/410 si no ve el repo o tiene los issues apagados). 5xx, 429 o plazo → caido. */
export async function sondeoEscrituraPr(token: string, repo: string):
  Promise<{ pull_requests: boolean; issues: boolean; caido: boolean }> {
  const post = { method: 'POST', headers: { ...ghHeaders(token), 'Content-Type': 'application/json' }, body: '{}' };
  const [pr, iss] = await Promise.all([respuestaGh(`${GH}/repos/${repo}/pulls`, post),
    respuestaGh(`${GH}/repos/${repo}/issues`, post)]);
  const puede = (x: Respuesta) => 'status' in x && x.status === 422;
  return { pull_requests: puede(pr), issues: puede(iss), caido: caida(pr) || caida(iss) };
}

// ── Paso repo de la auditoría (§09.4): árbol por sha, archivos de riesgo acotados y contenido solo en memoria ──
export type EntradaArbol = { path: string; size: number };
export const LIM_REPO = { archivos: 20, bytesArchivo: 1_000_000, bytesTotal: 3_000_000, lockfiles: 6, envs: 5 };
export const MAX_ARBOL = 2_000_000;   // §09.4: un árbol de más de 2 MB no se parsea en el Worker
const FUERA = /(^|\/)(node_modules|vendor|dist|build|\.git)\//;
const BINARIO = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|woff2?|ttf|eot|mp[34]|mov|exe|dll|so|dylib|wasm|bin)$/i;
const LOCK = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|composer\.lock|package\.json|composer\.json)$/;
const ES_LOCK = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|composer\.lock)$/;
const LOCKFILE = /(^|\/)(package-lock\.json|composer\.lock|pnpm-lock\.yaml|yarn\.lock)$/;
const LOCK_LEGIBLE = /(^|\/)(package-lock\.json|composer\.lock)$/;   // los que leerLockfiles sabe leer en P0
const ENV = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_EJEMPLO = /\.(example|sample|template)$/i;
const CONFIG = /(^|\/)(wrangler\.(toml|json|jsonc)|\.npmrc|\.pypirc|docker-compose[^/]*\.ya?ml|Dockerfile|vercel\.json|netlify\.toml|firebase\.json)$|^supabase\/config\.toml$|^\.github\/workflows\/[^/]+\.ya?ml$/;
const CODIGO_RIESGO = /(supabase|admin|secret|key|token|cred|config|client|firebase|stripe|auth|env)/i;
const CODIGO = /\.(ts|tsx|js|jsx|mjs|cjs|php|py|go|rb|java|kt|cs|rs|vue|svelte)$/i;

const carpeta = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
const hondura = (p: string) => p.split('/').length - 1;

// Lockfiles y manifiestos (§09.4 (1)): primero los de la raíz (lockfile y luego su manifiesto), después los anidados de
// menos a más hondo, lockfiles antes que manifiestos y el manifiesto con lockfile hermano antes que el suelto. En el
// orden del árbol (preorden alfabético) los package.json de apps/ y packages/ llenaban el cupo antes del lockfile raíz.
function ordenLock(xs: EntradaArbol[]): EntradaArbol[] {
  const conLock = new Set(xs.filter((e) => ES_LOCK.test(e.path)).map((e) => carpeta(e.path)));
  const grupo = (p: string) => (hondura(p) === 0 ? (ES_LOCK.test(p) ? 0 : 1) : ES_LOCK.test(p) ? 2 : conLock.has(carpeta(p)) ? 3 : 4);
  return [...xs].sort((a, b) => grupo(a.path) - grupo(b.path) || hondura(a.path) - hondura(b.path)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// elegirArchivosRiesgo (§09.4): en este orden hasta 20 archivos y 3 MB; nunca uno > 1 MB (el tamaño sale del árbol).
// Los lockfiles dejan sitio (un hueco y sus bytes) al .gitignore de la raíz: si llenaran el cupo, no se sabría si cubre
// .env (CB_GITIGNORE_NO_ENV ni se afirma ni se auto-verifica) y el cierre quedaría parcial por eso.
export function elegirArchivosRiesgo(arbol: EntradaArbol[], lim = LIM_REPO): string[] {
  const validos = arbol.filter((e) => !FUERA.test(e.path) && !BINARIO.test(e.path) && e.size <= lim.bytesArchivo);
  const elegidos: EntradaArbol[] = [];
  let total = 0;
  const tomar = (xs: EntradaArbol[], max = Infinity, reserva?: EntradaArbol) => {
    const huecos = lim.archivos - (reserva ? 1 : 0);
    const bytes = lim.bytesTotal - (reserva?.size ?? 0);
    let n = 0;
    for (const e of xs) {
      if (elegidos.length >= huecos || n >= max) return;
      if (elegidos.some((x) => x.path === e.path) || total + e.size > bytes) continue;
      elegidos.push(e); total += e.size; n++;
    }
  };
  tomar(ordenLock(validos.filter((e) => LOCK.test(e.path))), lim.lockfiles, validos.find((e) => e.path === '.gitignore'));
  tomar(validos.filter((e) => e.path === '.gitignore'));
  tomar(validos.filter((e) => ENV.test(e.path) && !ENV_EJEMPLO.test(e.path)), lim.envs);
  tomar(validos.filter((e) => CONFIG.test(e.path)));
  tomar(validos.filter((e) => CODIGO.test(e.path) && CODIGO_RIESGO.test(e.path)).sort((a, b) => a.size - b.size));
  return elegidos.map((e) => e.path);
}

// Lockfiles del árbol (fuera de node_modules, vendor…): `legibles` los lee leerLockfiles; `otros` (pnpm, yarn) aún no.
export function lockfilesDe(arbol: readonly EntradaArbol[]): { legibles: string[]; otros: string[] } {
  const legibles: string[] = [];
  const otros: string[] = [];
  for (const { path } of arbol) {
    if (!LOCKFILE.test(path) || FUERA.test(path)) continue;
    (LOCK_LEGIBLE.test(path) ? legibles : otros).push(path);
  }
  return { legibles, otros };
}

// Solo las rutas que mira reglasEnv (.gitignore y .env*): así no ordena ni deduplica el árbol entero (CPU).
export function rutasEnv(arbol: readonly EntradaArbol[]): string[] {
  const out: string[] = [];
  for (const { path } of arbol) if (path === '.gitignore' || /(^|\/)\.env/.test(path)) out.push(path);
  return out;
}

// GitHub responde 403 (no 429) al agotar el límite primario o el secundario: con esas cabeceras es transitorio.
export function codigoGithub(r: Response): ProviderErrorCode {
  if (r.status === 403 && (r.headers.get('x-ratelimit-remaining') === '0' || r.headers.has('retry-after'))) return 'rate_limited';
  return codigoHttp(r.status);
}

const deRed = (e: unknown): ProviderErrorCode => ((e as Error)?.name === 'TimeoutError' ? 'timeout' : 'unavailable');

// Lee el cuerpo con un reader y para en `max` bytes (y en lo que quede de `bolsa`, compartida entre lecturas paralelas):
// nunca carga más del tope, aunque Content-Length mienta o falte (respuesta comprimida, enlace simbólico). Por defecto,
// un Content-Length mayor que el tope devuelve '' sin leer (la auditoría no quiere medio lockfile). ignorarLargo (diff de
// la revisión de código, revision-codigo.md §2.2): lee igual hasta el tope y corta ahí; lo leído se escanea.
export async function leerAcotado(r: Response, max: number, bolsa?: { restante: number },
  o: { ignorarLargo?: boolean } = {}): Promise<{ texto: string; cortado: boolean }> {
  const largo = Number(r.headers.get('content-length') ?? '');
  if (!o.ignorarLargo && largo > Math.min(max, bolsa?.restante ?? Infinity)) {
    await r.body?.cancel();
    return { texto: '', cortado: true };
  }
  if (!r.body) return { texto: '', cortado: false };
  const lector = r.body.getReader();
  const dec = new TextDecoder();
  const partes: string[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) return { texto: partes.join('') + dec.decode(), cortado: false };
      const cabe = Math.min(max - n, bolsa?.restante ?? Infinity);
      const toma = Math.min(value.byteLength, Math.max(0, cabe));
      if (toma) partes.push(dec.decode(value.subarray(0, toma), { stream: true }));
      n += toma;
      if (bolsa) bolsa.restante -= toma;
      if (toma < value.byteLength) {
        await lector.cancel().catch(() => {});
        return { texto: partes.join('') + dec.decode(), cortado: true };
      }
    }
  } catch (e) {
    throw new ProviderError(deRed(e));   // red caída o plazo vencido a mitad del cuerpo
  }
}

// Un cuerpo que se corta a mitad, vence el plazo o no es JSON es el mismo fallo transitorio que un 5xx (la cola reintenta).
async function ghJson<T>(token: string, url: string): Promise<T> {
  const r = await pedir(url, { headers: ghHeaders(token) }, 30_000);
  if (!r.ok) { await r.body?.cancel(); throw new ProviderError(codigoGithub(r), r.status); }
  try { return (await r.json()) as T; } catch (e) { throw new ProviderError(deRed(e), r.status); }
}

type ArbolGh = { tree?: { path: string; type: string; mode?: string; size?: number }[]; truncated?: boolean };
// Blobs sin enlaces simbólicos (mode 120000: su size es el largo de la ruta destino y contents devuelve el destino).
const aEntradas = (t: ArbolGh): EntradaArbol[] =>
  (t.tree ?? []).filter((e) => e.type === 'blob' && e.mode !== '120000').map((e) => ({ path: e.path, size: e.size ?? 0 }));

// null si pasa de MAX_ARBOL: no se parsea (JSON.parse de 4–7 MB se come los 10 ms de CPU del mensaje).
async function arbolGh(token: string, url: string): Promise<ArbolGh | null> {
  const r = await pedir(url, { headers: ghHeaders(token) }, 30_000);
  if (!r.ok) { await r.body?.cancel(); throw new ProviderError(codigoGithub(r), r.status); }
  const { texto, cortado } = await leerAcotado(r, MAX_ARBOL);
  if (cortado) return null;
  try { return JSON.parse(texto) as ArbolGh; } catch { throw new ProviderError('unavailable', r.status); }
}

// pedir (lib/http.ts) sigue hasta 3 redirecciones al mismo host y cada salto es otra subpetición (§A7).
export const SALTOS_MAX = 3;
const NOMBRE_REPO = /^[A-Za-z0-9_-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;   // dueño/nombre de GitHub; nunca . ni .. en la ruta

export type Arbol = { sha: string; rama: string; arbol: EntradaArbol[]; truncado: boolean; vacio: boolean; repo: string;
  subpeticiones: number };

// rama → sha → árbol (3 subpeticiones; 4 si el árbol es grande, y las devuelve para el presupuesto del paso). El árbol
// truncado deja la cobertura parcial: lo dice coverage.detail y el cierre no auto-verifica. Si el recursivo pasa de 2 MB,
// solo la raíz (lockfiles, .gitignore, .env).
// Repo renombrado o transferido: GitHub da 301 a /repositories/<id>/… en CADA llamada con el nombre viejo de la conexión.
// Commits, árbol y contenidos (`repo` devuelto) van con el full_name canónico y solo la primera paga los saltos, contados
// como el máximo que sigue pedir (nunca por debajo del gasto real). Repo sin commits: GitHub da 409 en /commits; es un
// árbol vacío (`vacio`), no un fallo del paso.
export async function arbolRepo(token: string, repo: string): Promise<Arbol> {
  const info = await ghJson<{ default_branch: string; full_name?: unknown }>(token, `${GH}/repos/${repo}`);
  const nombre = typeof info.full_name === 'string' && NOMBRE_REPO.test(info.full_name) ? info.full_name : repo;
  const canon = nombre.toLowerCase() === repo.toLowerCase() ? repo : nombre;
  let sub = 1 + (canon === repo ? 0 : SALTOS_MAX);
  const base = { rama: info.default_branch, repo: canon };
  let commits: { sha: string }[];
  sub++;
  try {
    commits = await ghJson<{ sha: string }[]>(token,
      `${GH}/repos/${canon}/commits?sha=${encodeURIComponent(info.default_branch)}&per_page=1`);
  } catch (e) {
    if (e instanceof ProviderError && e.status === 409) {
      return { ...base, sha: '', arbol: [], truncado: false, vacio: true, subpeticiones: sub };
    }
    throw e;
  }
  const sha = commits[0]?.sha;
  if (!sha) throw new ProviderError('not_found');
  sub++;
  const t = await arbolGh(token, `${GH}/repos/${canon}/git/trees/${sha}?recursive=1`);
  if (t) return { ...base, sha, arbol: aEntradas(t), truncado: t.truncated === true, vacio: false, subpeticiones: sub };
  sub++;
  const raiz = await arbolGh(token, `${GH}/repos/${canon}/git/trees/${sha}`);
  return { ...base, sha, arbol: raiz ? aEntradas(raiz) : [], truncado: true, vacio: false, subpeticiones: sub };
}

// 401, 429, 5xx, límite de GitHub, red o plazo: el mensaje entero vuelve a la cola (§09.4), nunca se omite en silencio.
const SE_OMITE = new Set<ProviderErrorCode>(['forbidden', 'not_found', 'invalid']);

// Contenido crudo de las rutas elegidas, 5 en paralelo y solo en memoria, cortado a bytesArchivo por archivo y a
// bytesTotal entre todos (1 subpetición por ruta). `incompletos` = los que no se leyeron enteros (403/404 de ese archivo,
// redirección rechazada o cortados): el paso los cuenta como lectura parcial y no auto-verifica. Un archivo vacío leído
// entero también va en `archivos` (content ''): un .gitignore vacío no cubre .env y un lockfile vacío no tiene deps.
export async function leerContenidos(token: string, repo: string, sha: string, rutas: string[], lim = LIM_REPO):
  Promise<{ archivos: ArchivoTexto[]; incompletos: string[] }> {
  const archivos: ArchivoTexto[] = [];
  const incompletos: string[] = [];
  const bolsa = { restante: lim.bytesTotal };
  let k = 0;
  let parar = false;
  const hilo = async () => {
    while (!parar && k < rutas.length) {
      const path = rutas[k++]!;
      const url = `${GH}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`;
      try {
        const r = await pedir(url, { headers: { ...ghHeaders(token), Accept: 'application/vnd.github.raw+json' } }, 30_000);
        if (!r.ok) {
          await r.body?.cancel();
          const code = codigoGithub(r);
          if (!SE_OMITE.has(code)) throw new ProviderError(code, r.status);
          incompletos.push(path);
          continue;
        }
        const { texto, cortado } = await leerAcotado(r, lim.bytesArchivo, bolsa);
        if (cortado) incompletos.push(path);
        if (texto || !cortado) archivos.push({ path, content: texto });
      } catch (e) {
        if (e instanceof ProviderError && e.code === 'invalid') { incompletos.push(path); continue; }   // salida bloqueada
        parar = true;   // los demás hilos no piden más: el mensaje se reintenta entero
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, rutas.length) }, hilo));
  const orden = new Map(rutas.map((p, i) => [p, i]));
  archivos.sort((a, b) => orden.get(a.path)! - orden.get(b.path)!);
  return { archivos, incompletos };
}
