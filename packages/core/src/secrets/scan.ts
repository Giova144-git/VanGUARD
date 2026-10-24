// Escáner de secretos y reglas de `.env` (S09 09.8–09.9, 09.11). Puro: recibe archivos ya leídos en memoria y devuelve
// borradores de hallazgo `codebase` con la evidencia enmascarada. Corre igual en el Worker, la Edge Function y el navegador.
// El valor en claro solo vive dentro de este módulo: ni el borrador, ni el snippet, ni el título lo llevan.
import type { CodebaseEvidence, Severity } from '@vanguard/contracts';
import { redactString } from '../redact.ts';
import { porSeveridad } from '../severity.ts';
import { entropia } from './entropy.ts';
import { REGLAS_SECRETO, PERMITIDOS, MARCADORES, HOSTS_PG_LOCALES, RUTA_PRUEBAS, valorGenerico, finColaGenerica, finComillas,
  type ReglaSecreto, type ReglaSecretoId } from './rules.ts';

export type ArchivoTexto = { path: string; content: string };
/** FindingDraft de S15 15.9 para el módulo codebase; `evidence` ya enmascarada y redactada. */
export type BorradorCodebase = {
  module: 'codebase'; rule_id: string; severity: Severity; confirmed: boolean; origin: 'rule';
  title: string; resource: string; evidence: CodebaseEvidence; dedupe_input: string;
};

// ── Enmascarado y JWT (literal de 09.9; `!` por noUncheckedIndexedAccess: si falta el payload, el catch da null) ──
export const enmascarar = (v: string, rule: string) =>
  rule === 'CB_SECRET_PRIVATE_KEY' ? '-----BEGIN … PRIVATE KEY-----'
  : rule === 'CB_SECRET_POSTGRES_URL'                                  // = fixture de A9: postgresql://postgres:••••@db.•••.supabase.co (≤ 48 car.)
    ? v.replace(/:\/\/([^:\s\/]+):[^@\s\/]+@([^:\/\s]+).*$/, (_, u, h) => `://${u}:••••@${h.replace(/^db\.[^.]+\./, 'db.•••.')}`).slice(0, 48)
  : v.length >= 24 ? `${v.slice(0, 4)}…${v.slice(-4)}`                 // 4+4 como 15.10 (JWT, PAT, sb_secret_…)
  : v.length >= 12 ? `${v.slice(0, 4)}…` : '…';                        // corto: 4+4 revelaría media clave
export function rolJwt(tok: string): string | null {             // solo clasifica; no verifica firma
  try { const b = tok.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
        return (JSON.parse(atob(b + '='.repeat((4 - b.length % 4) % 4))) as { role?: string }).role ?? null; } catch { return null; }
}

// ── Recorrido por archivo ─────────────────────────────────────────────────────────────────────────────────────────
/** Coincidencia en bruto. Lleva el VALOR en claro: no se registra, no se guarda y no sale del paso que la produce
 *  (solo la usan escanearSecretos() y el tripwire de zip-result, 09.3). */
export type Coincidencia = { rule_id: ReglaSecretoId; valor: string; path: string; line: number; snippet: string; severity: Severity };

const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'composer.lock']);
/** Lo que no se escanea por extensión. También en revision/diff.ts: un binario con una de estas no corta la revisión, y
 *  un TEXTO con una de estas sí (aquí se saltaría aunque git diga que es texto). */
export const EXT_BINARIA = /\.(png|jpe?g|gif|webp|avif|ico|bmp|pdf|zip|gz|tgz|bz2|7z|rar|woff2?|ttf|otf|eot|mp[34]|mov|webm|wasm|exe|dll|so|dylib|class|jar|bin|sqlite3?)$/i;
const nombre = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** Lockfiles fuera: sus hashes de integridad solo dan ruido (09.9). */
export const esLockfile = (path: string) => LOCKFILES.has(nombre(path)) || nombre(path).endsWith('.lock');
/** Binario por extensión o por un NUL en los primeros 8000 caracteres. */
export const esBinario = (path: string, texto: string) => EXT_BINARIA.test(path) || texto.slice(0, 8000).includes('\u0000');
const SNIPPET_MAX = 160, ANTES = 60, MARGEN = 400, MAX_REPETIDOS = 32, MAX_LARGO_REPETIDO = 512;

function hostPostgres(url: string): string {
  return (/^postgres(?:ql)?:\/\/[^:\s\/]+:[^@\s\/]+@([^:\/\s?#'"\x60]+)/.exec(url)?.[1] ?? '').toLowerCase();
}
/** Severidad si la coincidencia vale; null si se descarta (permitidos, entropía, rol del JWT, host local). */
function validar(r: ReglaSecreto, valor: string, m: RegExpMatchArray): Severity | null {
  if (r.rule_id === 'CB_SECRET_POSTGRES_URL') {                          // aquí los permitidos miran solo la contraseña
    const host = hostPostgres(valor);
    if (PERMITIDOS.test(m[2] ?? '') || HOSTS_PG_LOCALES.has(host)) return null;
    return /supabase\.co|pooler\.supabase\.com/.test(host) ? 'critical' : 'high';
  }
  if (PERMITIDOS.test(valor)) return null;
  if (r.entropiaMin !== undefined && entropia(valor) < r.entropiaMin) return null;
  if (r.rule_id === 'CB_SECRET_SUPABASE_SERVICE_ROLE') return rolJwt(valor) === 'service_role' ? r.severity : null;   // anon: pública por diseño
  return r.severity;
}
/** Coincidencia antes del snippet: [idx, fin) es el tramo que tapa el marcador, dentro de la línea del valor (la clave
 *  privada ocupa varias: solo su primera línea). En la genérica sigue por la cola del valor, como en redactString. */
type Cruda = { rule_id: ReglaSecretoId; valor: string; idx: number; fin: number; severity: Severity };
const primeraLinea = (v: string) => (v.split('\n')[0] ?? '').replace(/\r$/, '');
/** Cuántos saltos de línea (posiciones ordenadas) hay antes de idx: búsqueda binaria. */
function saltosAntes(saltos: readonly number[], idx: number): number {
  let lo = 0, hi = saltos.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if ((saltos[mid] ?? 0) < idx) lo = mid + 1; else hi = mid; }
  return lo;
}
/** Snippet de cada coincidencia, en su orden. Los valores del archivo se funden en bloques donde se solapan (la cola de
 *  un secreto largo puede llevar otros dentro). Se toma la línea del bloque (si es larga, MARGEN car. a cada lado), se
 *  cambia el bloque entero por [SECRET:<regla>] y todo otro bloque por [REDACTADO] (por posición y, hasta MAX_REPETIDOS
 *  valores, también donde se repitan), se pasa por redactString y se recorta DESPUÉS a 160 car. alrededor del marcador, o
 *  desde la columna 0 si redact se lo comió. Recortar antes podía separar la clave de otro secreto de su valor y dejarlo
 *  en claro. Lineal: cada bloque solo mira los bloques de su ventana, y los valores de un mismo bloque comparten snippet. */
function snippets(t: string, cs: readonly Cruda[], saltos: readonly number[]): string[] {
  const orden = cs.map((_, i) => i).sort((a, b) => cs[a]!.idx - cs[b]!.idx);
  const bloques: Array<{ ini: number; fin: number }> = [];                 // ordenados y disjuntos; nunca cruzan un salto
  const bloque: number[] = [];
  for (const i of orden) {
    const c = cs[i]!, b = bloques[bloques.length - 1];
    if (b && c.idx < b.fin) b.fin = Math.max(b.fin, c.fin); else bloques.push({ ini: c.idx, fin: c.fin });
    bloque[i] = bloques.length - 1;
  }
  // Tope de largo para los repetidos: así un valor enorme no se copia ni se busca entero (de uno así se busca el principio).
  const repetidos = [...new Set(cs.map((c) => t.slice(c.idx, Math.min(c.fin, c.idx + MAX_LARGO_REPETIDO))))]
    .filter((v) => v.length >= 8).sort((a, b) => b.length - a.length).slice(0, MAX_REPETIDOS);
  const sinRepetidos = (s: string) => { for (const v of repetidos) if (s.includes(v)) s = s.split(v).join('[REDACTADO]'); return s; };
  const hechos = new Map<string, string>();
  return cs.map((c, i) => {
    const nb = bloque[i]!, b = bloques[nb]!, marca = `[SECRET:${c.rule_id}]`, clave = `${nb}${marca}`;
    const hecho = hechos.get(clave);
    if (hecho !== undefined) return hecho;
    const n = saltosAntes(saltos, b.ini);                                   // límites de la línea sin recorrerla (minificado)
    const il = n === 0 ? 0 : saltos[n - 1]! + 1;
    let fl = n < saltos.length ? saltos[n]! : t.length;
    if (fl > b.fin && t[fl - 1] === '\r') fl--;
    const w0 = Math.max(il, b.ini - MARGEN), w1 = Math.min(fl, b.fin + MARGEN);
    let a = nb, z = nb;                                                     // bloques que pisan la ventana
    while (a > 0 && bloques[a - 1]!.fin > w0) a--;
    while (z + 1 < bloques.length && bloques[z + 1]!.ini < w1) z++;
    const partes: string[] = [];
    let pos = w0;
    for (let q = a; q <= z; q++) {
      const o = bloques[q]!;
      partes.push(sinRepetidos(t.slice(pos, Math.max(o.ini, w0))), q === nb ? marca : '[REDACTADO]');
      pos = Math.min(o.fin, w1);
    }
    partes.push(sinRepetidos(t.slice(pos, w1)));
    const propio = 2 * (nb - a) + 1;                                        // índice del marcador en partes
    const r = redactString(partes.join('')).trim();
    let k = r.indexOf(marca);
    // Si redact se comió el marcador (`token=`, Authorization, postgres://u:…@ lo tapan enteros), su sitio aproximado es
    // lo que mide lo de antes ya redactado; sin eso, la columna 0 de una ventana larga caería lejos del valor.
    if (k < 0) k = Math.min(r.length, redactString(partes.slice(0, propio).join('')).trimStart().length);
    const d = Math.max(0, Math.min(k - ANTES, r.length - SNIPPET_MAX));
    const sn = r.slice(d, d + SNIPPET_MAX).replace(/\0/g, ' ').trim();     // ni un NUL en la evidencia (jsonb no lo admite)
    hechos.set(clave, sn);
    return sn;
  });
}

/** ¿Algún valor de una específica pisa [ini, fin)? Antes se comparaba cada genérica con todas las específicas del archivo
 *  (`e.includes(valor) || valor.includes(e)`): con miles de cada en un mismo archivo (un diff de 512 KB) eran cientos de
 *  ms. Lo que importa es el mismo sitio: un valor repetido en otro sitio también lo casa ahí la específica. Ordenadas por
 *  inicio y con el fin máximo acumulado, cada genérica es una búsqueda binaria. Se arma al llegar la genérica, la última
 *  regla: para entonces ya están todas las específicas del archivo. */
function pisaEspecifica(es: readonly Cruda[]): (ini: number, fin: number) => boolean {
  const orden = [...es].sort((a, b) => a.idx - b.idx);
  const inicios = orden.map((c) => c.idx), finMax: number[] = [];
  let m = -1;
  for (const c of orden) finMax.push(m = Math.max(m, c.idx + c.valor.length));
  return (ini, fin) => { const j = saltosAntes(inicios, fin); return j > 0 && (finMax[j - 1] ?? -1) > ini; };
}

/** (1) salta lockfiles y binarios; (2) cambia nuestros marcadores por un NUL; (3) prefiltro por clave; (4) matchAll;
 *  (5) validación. Línea = saltos de línea antes del valor + 1. */
export function scanArchivo(path: string, texto: string): Coincidencia[] {
  if (esLockfile(path) || esBinario(path, texto)) return [];
  // Un NUL: no mueve líneas ni casa en ninguna clave ni valor, igual que el relleno con el que redactString ve los
  // marcadores (con un espacio, `TOKEN=[REDACTADO] x…` daba `x…` como valor de TOKEN y redact no lo tapaba). El snippet
  // lo vuelve a dejar en un espacio.
  const t = texto.replace(MARCADORES, '\0');
  let minus: string | undefined;
  const crudas: Cruda[] = [];
  let pisa: ((ini: number, fin: number) => boolean) | undefined;
  for (const r of REGLAS_SECRETO) {
    // Prefiltro siempre en minúsculas: es solo un atajo, y la genérica no lleva la `i` (distingue mayúsculas por clases).
    const base = (minus ??= t.toLowerCase());
    if (!r.claves.some((k) => base.includes(k.toLowerCase()))) continue;
    let hasta = 0;
    for (const m of t.matchAll(r.re)) {
      const valor = m[r.grupo];
      if (!valor) continue;
      const idx = (m.index ?? 0) + m[0].lastIndexOf(valor);
      // Genérica: el filtro compartido con redact (dígito, no JWT…; fuera `env.SUPABASE_SECRET_KEY`,
      // `body.read_token.trim`, `actions_org_id_fkey`: falsos positivos de nuestro repo) y fuera lo que en ese sitio ya
      // dio una específica (`GITHUB_TOKEN=ghp_…`). crudas solo trae específicas cuando llega la genérica.
      if (r.rule_id === 'CB_SECRET_GENERIC'
        && (!valorGenerico(valor) || (pisa ??= pisaEspecifica(crudas))(idx, idx + valor.length))) continue;
      const severity = validar(r, valor, m);
      if (!severity) continue;
      let fin = idx + primeraLinea(valor).length;
      // La cola entera del valor (más de 150 car., contraseña con símbolos, hasta la comilla de cierre si va entre
      // comillas): el marcador no deja en claro el resto. hasta crece en cada coincidencia, así que cada carácter de cola
      // se mira una vez; las comillas, como mucho 256 car. por valor.
      if (r.rule_id === 'CB_SECRET_GENERIC') fin = hasta = Math.max(finColaGenerica(t, Math.max(fin, hasta)), finComillas(t, idx, fin));
      crudas.push({ rule_id: r.rule_id, valor, idx, fin, severity });
    }
  }
  if (!crudas.length) return [];
  const saltos = [...t.matchAll(/\n/g)].map((m) => m.index ?? 0);
  const sn = snippets(t, crudas, saltos);                                 // con todos los valores del archivo a la vista
  return crudas.map((c, i) => ({ rule_id: c.rule_id, valor: c.valor, path, line: saltosAntes(saltos, c.idx) + 1, snippet: sn[i] ?? '',
    severity: c.severity }));
}

// ── Agrupado: un hallazgo por secreto con hasta 20 ubicaciones (09.9 paso 6, 09.11) ──────────────────────────────
export type OpcionesSecretos = {
  /** Huella del valor. En el Worker: (v) => fingerprint(keys, orgId, v) de @vanguard/core/crypto (05.7), la MISMA de
   *  connection_secrets.fingerprint; en el navegador, un SHA-256 local. Sin ella se agrupa por valor en memoria y no hay
   *  `fingerprint_short`. La huella completa nunca va en la evidencia. */
  huella?: (valor: string) => Promise<string> | string;
  /** Prefijo del `resource` para el ZIP: `zip:<filename>/` (09.11). */
  prefijo?: string;
  /** Baja a low el secreto que solo aparece en rutas de prueba. Por defecto true (la auditoría). La revisión de código
   *  pasa false: allí la ruta la elige quien empuja y solo la genérica baja (asignaciones/revision-codigo.md §2.4). */
  rebajarPruebas?: boolean;
};
export type ResultadoSecretos = {
  hallazgos: BorradorCodebase[];
  /** huella completa → resource, solo con `opts.huella`: para CB_KEY_REUSE (P1). No se guarda ni se envía. */
  huellas: Map<string, string>;
};

const ES_ENV = /(^|\/)\.env[^/]*$/;
const RESOURCE_MAX = 300, MAX_TITULO = 120, EN_PRUEBAS = ' (en pruebas)';
// Títulos con los mismos textos que templates/titles.ts (tituloSecreto, tituloEnvSubido, tituloGitignoreSinEnv), sin
// depender de ese archivo; una línea y ≤ 120 car. aunque la ruta traiga saltos de línea o caracteres de control.
const unaLinea = (s: string, max = MAX_TITULO) => {
  const l = s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
};
const TIPO_SECRETO: Readonly<Record<ReglaSecretoId, string>> = {
  CB_SECRET_SUPABASE_SERVICE_ROLE: 'Clave service_role de Supabase', CB_SECRET_SB_SECRET: 'Clave secreta de Supabase',
  CB_SECRET_AWS: 'Clave de acceso de AWS', CB_SECRET_STRIPE_LIVE: 'Clave live de Stripe', CB_SECRET_ANTHROPIC: 'Clave de la API de Anthropic',
  CB_SECRET_OPENAI: 'Clave de la API de OpenAI', CB_SECRET_GITHUB_PAT: 'Token de GitHub', CB_SECRET_PRIVATE_KEY: 'Clave privada',
  CB_SECRET_POSTGRES_URL: 'Cadena de conexión a Postgres con contraseña', CB_SECRET_GENERIC: 'Posible credencial',
};
/** «… en .env» si el archivo es un .env; si no, «… en el código» (la ruta va en `resource`). */
const tituloSecreto = (rule: ReglaSecretoId, path: string) => {
  const archivo = nombre(path);
  return unaLinea(`${TIPO_SECRETO[rule]} ${/^\.env/.test(archivo) ? `en ${archivo}` : 'en el código'}`);
};
const tituloEnvSubido = (path: string) => unaLinea(`Archivo ${path || '.env'} subido al repositorio`);
const tituloGitignoreSinEnv = (existe: boolean) => (existe ? 'El .gitignore no excluye .env' : 'El repositorio no tiene .gitignore en la raíz');
const recortarIzq = (s: string, max: number) => (s.length > max ? '…' + s.slice(s.length - max + 1) : s);
/** Ubicación principal primero: archivos que no son `.env*` antes que `.env*`; luego path y línea. */
const porUbicacion = (a: { path: string; line: number }, b: { path: string; line: number }) =>
  Number(ES_ENV.test(a.path)) - Number(ES_ENV.test(b.path)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line;
/** `resource` de un hallazgo: prefijo + `ruta[:línea]`, recortado por la izquierda a 300 car. (también revision/diff.ts). */
export const recurso = (prefijo: string, s: string) => recortarIzq(prefijo + s, RESOURCE_MAX);

export async function escanearSecretos(archivos: readonly ArchivoTexto[], opts: OpcionesSecretos = {}): Promise<ResultadoSecretos> {
  const grupos = new Map<string, { cs: Coincidencia[]; huella?: string }>();
  const cache = new Map<string, string>();
  for (const a of archivos)
    for (const c of scanArchivo(a.path, a.content)) {
      let h: string | undefined;
      if (opts.huella) { h = cache.get(c.valor); if (h === undefined) { h = await opts.huella(c.valor); cache.set(c.valor, h); } }
      const k = c.rule_id + '|' + (h ?? c.valor);
      const g = grupos.get(k);
      if (g) g.cs.push(c); else grupos.set(k, { cs: [c], huella: h });
    }
  const prefijo = opts.prefijo ?? '';
  const hallazgos: BorradorCodebase[] = [];
  const huellas = new Map<string, string>();
  for (const { cs, huella } of grupos.values()) {
    cs.sort(porUbicacion);
    const p = cs[0]!;
    const vistas = new Set<string>();
    const ubicaciones = cs.filter((c) => { const k = c.path + ':' + c.line; if (vistas.has(k)) return false; vistas.add(k); return true; })
      .slice(0, 20).map((c) => ({ path: c.path, line: c.line, origen: 'head' as const }));
    const enPruebas = cs.every((c) => RUTA_PRUEBAS.test(c.path));
    const resource = recurso(prefijo, `${p.path}:${p.line}`);
    const evidence: CodebaseEvidence = { path: p.path, line: p.line, preview: enmascarar(p.valor, p.rule_id), snippet: p.snippet, ubicaciones };
    if (huella && /^[0-9a-f]{8}/i.test(huella)) evidence.fingerprint_short = huella.slice(0, 8).toLowerCase();
    if (enPruebas) evidence.en_pruebas = true;
    // Sin rebajarPruebas, una clave live en `pagos.test.ts` sigue critical; en_pruebas y el sufijo del título se quedan.
    const baja = enPruebas && (opts.rebajarPruebas !== false || p.rule_id === 'CB_SECRET_GENERIC');
    hallazgos.push({ module: 'codebase', rule_id: p.rule_id, severity: baja ? 'low' : p.severity, confirmed: true,
      origin: 'rule',
      title: enPruebas ? unaLinea(tituloSecreto(p.rule_id, p.path), MAX_TITULO - EN_PRUEBAS.length) + EN_PRUEBAS : tituloSecreto(p.rule_id, p.path),
      resource, evidence, dedupe_input: resource });
    if (huella) huellas.set(huella, resource);
  }
  hallazgos.sort((a, b) => porSeveridad(a.severity, b.severity) || (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0));
  return { hallazgos, huellas };
}

// ── `.env` subido y `.gitignore` (09.8, canónicas A9.2) ───────────────────────────────────────────────────────────
const RE_ENV = /(^|\/)\.env(\.[\w-]+)?$/;
const RE_ENV_PLANTILLA = /\.env\.(example|sample|template)$/;
const RE_VARIABLE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm;
export const esEnvSubido = (path: string) => RE_ENV.test(path) && !RE_ENV_PLANTILLA.test(path);
/** Canónica: alguna línea (sin comentarios `#` ni negaciones `!`) casa `^/?\.env`. Acepta `.env.local` como si cubriera
 *  `.env` (falso negativo aceptado en P0, 09.8). */
export const gitignoreCubreEnv = (txt: string) =>
  txt.split(/\r?\n/).some((l) => { const s = l.trim(); return s !== '' && !s.startsWith('#') && !s.startsWith('!') && /^\/?\.env/.test(s); });
/** Solo nombres de variables (≤ 30), nunca valores. */
export function variablesEnv(txt: string): string[] {
  const out = new Set<string>();
  for (const m of txt.matchAll(RE_VARIABLE)) { const v = m[1]; if (v && v.length <= 64) out.add(v); if (out.size >= 30) break; }
  return [...out];
}

/** CB_ENV_COMMITTED (critical) por cada `.env*` del inventario que no sea plantilla y CB_GITIGNORE_NO_ENV (medium) si el
 *  `.gitignore` de la raíz falta o no lo cubre. `rutas` = el inventario entero (el árbol); `archivos` = lo leído. */
export function reglasEnv(rutas: readonly string[], archivos: readonly ArchivoTexto[], opts: Pick<OpcionesSecretos, 'prefijo'> = {}): BorradorCodebase[] {
  const prefijo = opts.prefijo ?? '';
  const leido = new Map(archivos.map((a) => [a.path, a.content]));
  const todas = [...new Set([...rutas, ...leido.keys()])].sort();
  const gi = leido.get('.gitignore');
  const existeGitignore = todas.includes('.gitignore');
  const cubre = gi !== undefined && gitignoreCubreEnv(gi);
  const out: BorradorCodebase[] = [];
  for (const path of todas.filter(esEnvSubido)) {
    const txt = leido.get(path);
    const evidence: CodebaseEvidence = { path, gitignore_lo_lista: cubre };
    if (txt !== undefined) evidence.variables = variablesEnv(txt);
    const resource = recurso(prefijo, path);
    // gitignore_lo_lista = true: la corrección debe decir que el .gitignore no saca lo ya commiteado (git rm --cached).
    out.push({ module: 'codebase', rule_id: 'CB_ENV_COMMITTED', severity: 'critical', confirmed: true, origin: 'rule',
      title: tituloEnvSubido(path), resource, evidence, dedupe_input: resource });
  }
  if (!cubre) {
    const resource = recurso(prefijo, '.gitignore');
    out.push({ module: 'codebase', rule_id: 'CB_GITIGNORE_NO_ENV', severity: 'medium', confirmed: true, origin: 'rule',
      title: tituloGitignoreSinEnv(existeGitignore),
      resource, evidence: { path: '.gitignore', existe_gitignore: existeGitignore }, dedupe_input: resource });
  }
  return out;
}
