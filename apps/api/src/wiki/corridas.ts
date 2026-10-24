import type { SupabaseClient } from '@supabase/supabase-js';
import { WikiDoc, WikiModelos, WikiRun, WikiRunStep, type WikiPaso } from '@vanguard/contracts';
import type { HallazgoBreve } from '@vanguard/deepwiki';
import type { MsgWiki } from '../jobs.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { MODELOS_POR_DEFECTO, motor } from './motor.ts';

// Filas de wiki_runs (0010) y caché de la wiki (packages/deepwiki/LEEME.md, «Integración en el BACK», puntos 1–3). Lo
// usan E40–E44 (rutas/wiki.ts); los pasos 'wiki' de la cola viven en wiki/pasos.ts. Toda consulta lleva
// .eq('org_id', …) (anti-IDOR).

// Columnas de WikiRun (E42/E43): sin state ni doc, que pesan y no salen nunca en esas respuestas.
export const COLUMNAS_RUN = 'id, repo_full_name, branch, commit_sha, status, progress, steps, est_usd, cost_usd, models, cached, error, created_at, started_at, finished_at';
// Una corrida queued/running que avanzó o se reprogramó (updated_at: lo pone vg_wiki_avanzar en cada avance y en cada
// espera, wiki/pasos.ts) hace menos de esto sigue viva: E41 la devuelve en vez de pagar otra igual. El hueco más largo
// entre dos toques de una corrida viva es una espera (≤ MAX_ESPERA_S = 480 s de wiki/pasos.ts) más la entrega y el paso
// (la síntesis marca antes de pagar y tarda < 7 min). Más tiempo sin tocar es un mensaje perdido o un Worker caído: el
// vigilante del housekeeping por minuto (engine/housekeeping.ts) la deja failed y, si E41 llega antes, la marca failed
// (su compare-and-set ya no avanza ni paga) y crea otra. Es el mismo umbral que usa el vigilante.
export const SIN_AVANCE_MS = 10 * 60_000;
// Texto de wiki_runs.error de esa corrida perdida.
export const ERROR_PARADA = 'Se detuvo sin avanzar y se reemplazó por una generación nueva.';
// max_usd si E41 no lo trae: el default de la columna. El techo práctico de una corrida ronda US$ 0,10 (LEEME, Costos)
// y E41 no estima (eso lo hace el paso arbol de la cola): 1 deja margen de sobra sin pasar de 5, y cada llamada al
// modelo sigue pasando por los topes diarios de ia/claude.ts.
export const MAX_USD_POR_DEFECTO = 1;
export const LIMITE_HISTORIAL = 50;                   // E43: las más nuevas primero
export const MAX_HALLAZGOS = 200;                     // los que acepta el motor (CLI --hallazgos)
const LIMITE_LLAVE = 50;                              // corridas propias (no copias) de un mismo commit: de sobra
// Subpeticiones de cacheDeEstimacion en E40: wiki_runs (1) + hallazgosDelRepo (≤ 4).
export const SUBPETICIONES_CACHE = 5;

// Mensaje de vg-jobs que arranca una corrida: el MsgWiki de jobs.ts con el primer paso, 'arbol'.
export type MsgWikiInicio = MsgWiki & { paso: 'arbol'; area?: never };
export const mensajeInicio = (orgId: string, runId: string): MsgWikiInicio =>
  ({ v: 1, kind: 'wiki', org_id: orgId, wiki_run_id: runId, paso: 'arbol' });

const PASOS: WikiPaso[] = ['arbol', 'triage', 'area', 'sintesis', 'fin'];
export const pasosIniciales = (): WikiRunStep[] => PASOS.map((name) => ({ name, status: 'pending' }));
// Corrida servida desde la caché (LEEME, punto 3): los cuatro pasos skipped y fin done, como el fixture wikiRunCache.
export const pasosCache = (commitSha: string): WikiRunStep[] => PASOS.map((name) => (name === 'fin'
  ? { name, status: 'done', detalle: `Reutiliza la wiki del commit ${commitSha.slice(0, 7)}` }
  : { name, status: 'skipped' }));

const obj = (x: unknown): Record<string, unknown> | null =>
  (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null);
const lista = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
// Sin la tabla (0010 sin aplicar: 42P01 de Postgres, PGRST205 de PostgREST) la Wiki degrada en silencio en vez de quedar
// en rojo: un solo aviso por isolate, historial vacío, sin caché, 404 al leer y «se está actualizando» al generar (503).
export const faltaTabla = (code: string | undefined) => code === '42P01' || code === 'PGRST205';
let avisadoSinTabla = false;
export function avisarSinTabla() {
  if (avisadoSinTabla) return;
  avisadoSinTabla = true;
  log('warn', 'wiki.sin_tabla', {});
}
export const SIN_TABLA = 'La Wiki se está actualizando; vuelve a intentarlo en unos minutos';
function fallaBase(evento: string, code: string | undefined, texto: string): never {
  if (faltaTabla(code)) {
    avisarSinTabla();
    throw new ApiError('provider_unavailable', SIN_TABLA, { reason: 'sin_tabla' }, 503);
  }
  log('error', evento, { code: code ?? null });
  throw new ApiError('internal', texto);
}

// ── Hallazgos de la auditoría y huella ─────────────────────────────────────────────────────────────────────────

export type HallazgosRepo = { hallazgos?: HallazgoBreve[]; auditoria_at?: string };
const RANGO: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };   // = findings.severity_rank
const INFRA = ['supabase', 'cloudflare'];
const COLUMNAS_HALLAZGO = 'rule_id, severity, title, module, connection_id, dedupe_key, path:evidence->>path';

// Hallazgos para el motor (LEEME, punto 7): rule_id, severity, title y path = evidence.path sin «:línea», nunca la
// evidencia. Lo usan E40/E41 para la huella y la síntesis de la cola (wiki/pasos.ts) para el motor: así la llave
// describe lo que de verdad recibe el motor. «La auditoría de ese repo» = la foto que dejaron las auditorías de la org
// en las que el paso repo leyó ESE repo (una conexión GitHub de la org con meta.repo_full_name igual, sin distinguir
// mayúsculas): los hallazgos abiertos de código de esas conexiones más los de Supabase y Cloudflare de la org, que son
// la infraestructura del producto (activar RLS cambia la huella sin cambiar el commit, LEEME, punto 2). Una auditoría
// sin params.connection_id usó la conexión GitHub activa más nueva y se da por de ese repo. Si el repo nunca se auditó:
// {} (hallazgos undefined, el documento lo dice); auditado y limpio: []. auditoria_at = la más nueva de esas
// auditorías. 2 subpeticiones (+ 2 si el repo se auditó).
export async function hallazgosDelRepo(admin: SupabaseClient, orgId: string, repo: string): Promise<HallazgosRepo> {
  const [cx, sc] = await Promise.all([
    admin.from('connections').select('id, meta').eq('org_id', orgId).eq('provider', 'github').limit(50),
    admin.from('scan_runs').select('steps, params, finished_at').eq('org_id', orgId).eq('status', 'succeeded')
      .in('kind', ['full_audit', 'repo', 'supabase', 'cloudflare']).order('created_at', { ascending: false }).limit(20),
  ]);
  if (cx.error || sc.error) fallaBase('wiki.hallazgos_error', cx.error?.code ?? sc.error?.code, 'No pudimos leer la auditoría del repo');
  const nombre = repo.toLowerCase();
  const ids = new Set(lista(cx.data).map(obj)
    .filter((c) => typeof c?.id === 'string' && String(obj(c.meta)?.repo_full_name ?? '').toLowerCase() === nombre)
    .map((c) => String(c?.id)));
  if (!ids.size) return {};

  const deEseRepo = (params: unknown) => {
    const pedida = obj(params)?.connection_id;
    return typeof pedida === 'string' ? ids.has(pedida) : true;
  };
  let repoAuditado = false;
  let ultima: string | null = null;
  for (const s of lista(sc.data).map(obj)) {
    const hechos = lista(s?.steps).map(obj).filter((p) => p?.status === 'done').map((p) => p?.name);
    const delRepo = hechos.includes('repo') && deEseRepo(s?.params);
    if (delRepo) repoAuditado = true;
    const fin = typeof s?.finished_at === 'string' ? s.finished_at : null;
    if ((delRepo || hechos.includes('supabase') || hechos.includes('cloudflare')) && fin
      && (!ultima || Date.parse(fin) > Date.parse(ultima))) ultima = fin;
  }
  if (!repoAuditado) return {};

  // Filtrado en SQL (la infraestructura de la org y el código de ESE repo, nunca el de otros repos) y con orden total
  // (dedupe_key es único por org): el corte de MAX_HALLAZGOS es siempre el mismo y con él la huella.
  const abiertos = () => admin.from('findings').select(COLUMNAS_HALLAZGO).eq('org_id', orgId).eq('status', 'open');
  const [infra, codigo] = await Promise.all([
    abiertos().in('module', INFRA)
      .order('severity_rank', { ascending: false }).order('dedupe_key', { ascending: true }).limit(MAX_HALLAZGOS),
    abiertos().eq('module', 'codebase').in('connection_id', [...ids])
      .order('severity_rank', { ascending: false }).order('dedupe_key', { ascending: true }).limit(MAX_HALLAZGOS),
  ]);
  if (infra.error || codigo.error) {
    fallaBase('wiki.hallazgos_error', infra.error?.code ?? codigo.error?.code, 'No pudimos leer la auditoría del repo');
  }
  const filas = [
    ...lista(infra.data).map(obj).filter((f) => INFRA.includes(String(f?.module))),
    ...lista(codigo.data).map(obj)
      .filter((f) => f?.module === 'codebase' && typeof f.connection_id === 'string' && ids.has(f.connection_id)),
  ].filter((f): f is Record<string, unknown> => !!f && typeof f.rule_id === 'string' && typeof f.title === 'string'
    && RANGO[String(f.severity)] !== undefined);
  // Mismo orden que en SQL, para que el corte de las dos consultas juntas también sea fijo.
  const clave = (f: Record<string, unknown>) => String(f.dedupe_key ?? '');
  filas.sort((a, b) => (RANGO[String(b.severity)]! - RANGO[String(a.severity)]!)
    || (clave(a) < clave(b) ? -1 : clave(a) > clave(b) ? 1 : 0));

  const hallazgos = filas.slice(0, MAX_HALLAZGOS).map((f) => {
    const h: HallazgoBreve = { rule_id: String(f.rule_id), severity: f.severity as HallazgoBreve['severity'],
      title: String(f.title).slice(0, 200) };
    const ruta = typeof f.path === 'string' ? f.path.replace(/:\d+(?::\d+)?$/, '').slice(0, 300) : '';
    if (ruta) h.path = ruta;
    return h;
  });
  return ultima ? { hallazgos, auditoria_at: iso(ultima) } : { hallazgos };
}

// Huella de la llave: la de huellaHallazgos, o null si no hubo auditoría (huellaHallazgos daría 'sin-auditoria', que no
// es una huella de 64 hex).
export async function huellaDe(h: HallazgosRepo): Promise<string | null> {
  return h.hallazgos ? (await motor()).huellaHallazgos(h.hallazgos) : null;
}

// ── Llave de la caché: (org_id, repo_full_name, commit_sha, huella) ────────────────────────────────────────────────

export type Llave = { orgId: string; repo: string; commitSha: string };
// updated_at tal como lo devuelve la base: el cierre de una corrida parada lo usa de compare-and-set.
export type FilaLlave = { id: string; status: string; huella: string | null; created_at: string; updated_at: string };
const enCurso = (f: FilaLlave) => f.status === 'queued' || f.status === 'running';

// Corridas vivas o terminadas de ese commit, sin las copias cached (cada acierto de la caché deja una y no deben
// desplazar a la original). Con la huella ya calculada se filtra también por ella; null («sin auditoría») se compara
// en elegir. 1 subpetición.
export async function corridasDeLlave(admin: SupabaseClient, k: Llave, huella?: string | null): Promise<FilaLlave[]> {
  let q = admin.from('wiki_runs').select('id, status, huella, created_at, updated_at').eq('org_id', k.orgId)
    .eq('repo_full_name', k.repo).eq('commit_sha', k.commitSha).eq('cached', false)
    .in('status', ['queued', 'running', 'succeeded']);
  if (typeof huella === 'string') q = q.eq('huella', huella);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(LIMITE_LLAVE);
  if (error) fallaBase('wiki.cache_error', error.code, 'No pudimos leer las wikis anteriores');
  return lista(data).map(obj).filter((f): f is Record<string, unknown> => typeof f?.id === 'string')
    .map((f) => ({ id: String(f.id), status: String(f.status), huella: typeof f.huella === 'string' ? f.huella : null,
      created_at: String(f.created_at), updated_at: String(f.updated_at ?? f.created_at) }));
}

// cache: la terminada más nueva con esa huella. enCurso: la queued/running con esa huella (wiki_runs_en_curso_uidx deja
// una) si avanzó hace < SIN_AVANCE_MS; si no, es parada: E41 la cierra antes de crear otra.
export function elegir(filas: FilaLlave[], huella: string | null, ahora = Date.now()) {
  const misma = filas.filter((f) => f.huella === huella);
  const viva = misma.find(enCurso) ?? null;
  const avanza = viva !== null && Date.parse(viva.updated_at) > ahora - SIN_AVANCE_MS;
  return {
    cache: misma.find((f) => f.status === 'succeeded')?.id ?? null,
    enCurso: avanza ? viva.id : null,
    parada: avanza ? null : viva,
  };
}

// E40 (LEEME, punto 1): si no hay ninguna terminada de ese commit, ni siquiera calcula la huella (1 subpetición en vez
// de 4).
export async function cacheDeEstimacion(admin: SupabaseClient, k: Llave): Promise<string | null> {
  const filas = await corridasDeLlave(admin, k);
  if (!filas.some((f) => f.status === 'succeeded')) return null;
  return elegir(filas, await huellaDe(await hallazgosDelRepo(admin, k.orgId, k.repo))).cache;
}

// ── E41: crear la corrida ──────────────────────────────────────────────────────────────────────────────────────

export type Pedido = Llave & {
  userId: string;
  branch: string;
  connectionId?: string | undefined;
  maxUsd: number;
  force: boolean;
};
export type Creada =
  | { tipo: 'en_curso'; id: string }   // ya se está generando esa misma wiki: no se paga dos veces
  | { tipo: 'cache'; id: string }      // fila nueva cached:true con el doc copiado; no se encola nada
  | { tipo: 'nueva'; id: string };     // fila queued: falta encolar el paso arbol

const DocSinId = WikiDoc.omit({ run_id: true });

// No paga dos veces la misma wiki: una en curso de esa llave se devuelve, y si otra E41 igual inserta entre la lectura
// y el insert (doble clic, dos pestañas, un reintento del front), wiki_runs_en_curso_uidx hace fallar el segundo insert
// con 23505 y se devuelve la que ganó. Huella (≤ 4) + llave (1) + [doc de la caché (1)] + [cierre de una parada (1)] +
// insert (1) + [relectura tras 23505 (1)]: ≤ 9 subpeticiones.
export async function crearCorrida(admin: SupabaseClient, p: Pedido): Promise<Creada> {
  const huella = await huellaDe(await hallazgosDelRepo(admin, p.orgId, p.repo));
  const { cache, enCurso: viva, parada } = elegir(await corridasDeLlave(admin, p, huella), huella);
  if (viva) return { tipo: 'en_curso', id: viva };
  const fila = { org_id: p.orgId, connection_id: p.connectionId ?? null, requested_by: p.userId, repo_full_name: p.repo,
    branch: p.branch, commit_sha: p.commitSha, huella, max_usd: p.maxUsd };

  if (cache && !p.force) {
    const { data: fuente, error } = await admin.from('wiki_runs').select('doc').eq('id', cache).eq('org_id', p.orgId)
      .eq('status', 'succeeded').maybeSingle();
    if (error) fallaBase('wiki.cache_error', error.code, 'No pudimos leer la wiki anterior');
    const doc = DocSinId.safeParse(obj(fuente)?.doc);
    if (doc.success) {
      const ahora = new Date().toISOString();
      const { data, error: ei } = await admin.from('wiki_runs').insert({ ...fila, status: 'succeeded', progress: 100,
        steps: pasosCache(p.commitSha), est_usd: 0, cost_usd: 0, models: doc.data.models, cached: true, doc: doc.data,
        started_at: ahora, finished_at: ahora }).select('id').single();
      const id = obj(data)?.id;
      if (ei || typeof id !== 'string') fallaBase('wiki.crear_error', ei?.code, 'No pudimos crear la wiki');
      return { tipo: 'cache', id: String(id) };
    }
    // Un doc guardado que ya no cumple el contrato no se sirve: se genera de nuevo.
    log('warn', 'wiki.cache_doc_invalido', { run: cache });
  }

  if (parada) await cerrarParada(admin, p.orgId, parada);
  const { data, error } = await admin.from('wiki_runs').insert({ ...fila, status: 'queued', progress: 0,
    steps: pasosIniciales(), models: MODELOS_POR_DEFECTO, cached: false }).select('id').single();
  if (error?.code === '23505') {
    const otra = (await corridasDeLlave(admin, p, huella)).find((f) => f.huella === huella && enCurso(f));
    log('info', 'wiki.crear_concurrente', { encontrada: otra !== undefined });
    if (otra) return { tipo: 'en_curso', id: otra.id };
    // La que ganó ya cerró (p. ej. no se pudo encolar): que el usuario lo intente otra vez.
    throw new ApiError('conflict', 'Esta wiki acaba de cambiar de estado. Vuelve a intentarlo.');
  }
  const id = obj(data)?.id;
  if (error || typeof id !== 'string') fallaBase('wiki.crear_error', error?.code, 'No pudimos crear la wiki');
  return { tipo: 'nueva', id: String(id) };
}

// Corrida parada (SIN_AVANCE_MS sin avanzar): failed antes de crear la nueva, para que deje libre la llave y su
// compare-and-set ya no avance ni pague. Compare-and-set sobre updated_at: si avanzó justo ahora no se toca (el insert
// chocará con ella y E41 la devolverá).
async function cerrarParada(admin: SupabaseClient, orgId: string, f: FilaLlave) {
  const ahora = new Date().toISOString();
  const { error } = await admin.from('wiki_runs').update({ status: 'failed', error: ERROR_PARADA, finished_at: ahora,
    updated_at: ahora }).eq('id', f.id).eq('org_id', orgId).in('status', ['queued', 'running']).eq('updated_at', f.updated_at);
  if (error) fallaBase('wiki.parada_error', error.code, 'No pudimos cerrar la wiki anterior');
  log('warn', 'wiki.parada_cerrada', { run: f.id });
}

// Si el send a vg-jobs falla, la fila no se queda en cola para siempre (como E11).
export async function marcarNoEncolada(admin: SupabaseClient, orgId: string, id: string) {
  const steps = pasosIniciales().map((s) => (s.name === 'arbol' ? { ...s, status: 'failed', error_code: 'no_encolado' } : s));
  const { error } = await admin.from('wiki_runs').update({ status: 'failed', error: 'No se pudo encolar', steps,
    finished_at: new Date().toISOString() }).eq('id', id).eq('org_id', orgId).eq('status', 'queued');
  if (error) log('error', 'wiki.marcar_error', { code: error.code });
}

// ── E42–E44: lectura ───────────────────────────────────────────────────────────────────────────────────────────

const usd = (x: unknown): number | null => {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const fecha = (x: unknown) => (typeof x === 'string' && x ? iso(x) : null);

// Pasos tal como los escribe la cola, acotados al contrato (detalle ≤ 80); uno ilegible se omite en vez de romper E42.
function pasosDe(x: unknown): WikiRunStep[] {
  const r: WikiRunStep[] = [];
  for (const s of lista(x).map(obj)) {
    if (!s) continue;
    const p = WikiRunStep.safeParse({ name: s.name, status: s.status,
      ...(typeof s.detalle === 'string' ? { detalle: s.detalle.slice(0, 80) } : {}),
      ...(typeof s.error_code === 'string' ? { error_code: s.error_code.slice(0, 60) } : {}) });
    if (p.success) r.push(p.data);
  }
  return r;
}

// Fila de wiki_runs → WikiRun. models '{}' (default de la columna) → los modelos por defecto del motor.
export function aWikiRun(f: Record<string, unknown>): WikiRun {
  const models = WikiModelos.safeParse(f.models);
  const progress = Math.round(Number(f.progress));
  return WikiRun.parse({
    id: f.id, repo_full_name: f.repo_full_name,
    branch: typeof f.branch === 'string' ? f.branch : null,
    commit_sha: typeof f.commit_sha === 'string' ? f.commit_sha : null,
    status: f.status, progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0,
    steps: pasosDe(f.steps), est_usd: usd(f.est_usd), cost_usd: usd(f.cost_usd) ?? 0,
    models: models.success ? models.data : MODELOS_POR_DEFECTO, cached: f.cached === true,
    error: typeof f.error === 'string' ? f.error.slice(0, 300) : null,
    created_at: iso(String(f.created_at)), started_at: fecha(f.started_at), finished_at: fecha(f.finished_at),
  });
}

export type DocDeCorrida = { status: string; doc: WikiDoc | null };

// E44: el documento con run_id = la fila pedida (también en una corrida cached: su doc es la copia). null si no existe
// en esa org; doc null si la fila existe pero el doc guardado no cumple el contrato.
export async function leerDoc(admin: SupabaseClient, orgId: string, id: string): Promise<DocDeCorrida | null> {
  const { data, error } = await admin.from('wiki_runs').select('id, status, doc').eq('id', id).eq('org_id', orgId).maybeSingle();
  if (error) fallaBase('wiki.leer_error', error.code, 'No pudimos leer la wiki');
  const f = obj(data);
  if (!f) return null;
  const d = DocSinId.safeParse(f.doc);
  return { status: String(f.status), doc: d.success ? WikiDoc.parse({ ...d.data, run_id: id }) : null };
}
