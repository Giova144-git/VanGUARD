import { WikiModelos, type WikiRunStep } from '@vanguard/contracts';
import { costoMaximoPaso, detalleInicio, ErrorGithub, ErrorWiki, ESPERA_SINTESIS_MS, estimar, marcarSintesis,
  MODELOS_POR_DEFECTO, pasoArbol, pasoArea, pasoSintesis, pasoTriage, progreso, siguientePaso, sintesisEnCurso,
  type EstadoWiki, type ResultadoWiki, type SiguientePaso } from '@vanguard/deepwiki';
import type { MsgWiki, PasoWiki } from '../jobs.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { hallazgosDelRepo } from './corridas.ts';
import { conTokenGithub, depsWiki, salidaGithub, TOPE_SUBPETICIONES } from './deps.ts';
import { ErrorLlmWiki, llmWiki } from './llm.ts';

// Pasos 'wiki' de la cola vg-jobs (packages/deepwiki/LEEME.md, «Integración en el BACK», puntos 4–7). Un mensaje = un
// paso = una invocación: arbol → triage → area (una por área) → sintesis. Entre pasos solo viaja wiki_runs.state
// (EstadoWiki: rutas, resúmenes y consumo; nunca código ni el PAT), guardado con vg_wiki_avanzar (0010), que hace
// compare-and-set sobre state.n y aplica en la misma escritura steps, progress, cost_usd y el resto del parche.
//
// Subpeticiones por invocación (tope del equipo: 40). Fila 1; PAT 3 (connections, connection_secrets y
// vg_crypto_material si el keyring no está en caché); IA 4 (vg_ai_status, vg_ai_reserve, Anthropic, vg_ai_settle);
// cada escritura y cada envío llevan 1 reintento inmediato si fallan (2 + 2). Así:
//   arbol    1 + 3 + 2 + 2 = 8 fijas → GitHub ≤ 32 (pasoArbol usa ≤ 25, 33 con redirecciones del repo)
//   triage   1 + 4 + 2 + 2 = 9, sin GitHub
//   area     1 + 3 + 4 + 2 + 2 = 12 fijas → GitHub ≤ 28 (25 descargas y 3 reintentos)
//   sintesis 1 + 3 (hallazgos) + 2 (marca) + 4 + 2 = 12, sin GitHub
// Un paso que se reprograma por un error (no de la base) no escribe ni envía: el toque de updated_at (1, sin reintento)
// cabe en esas 4. Con la base o la cola caídas no se toca: ya gastó sus reintentos y tampoco saldría.
// CPU: el motor está medido para 10 ms por paso; aquí solo hay armado de objetos y JSON (la espera de red no cuenta).

export type RespuestaCola = 'ack' | { retry: number };

// = MAX_REINTENTOS_COLA de jobs.ts (max_retries de vg-jobs): un transitorio se reintenta mientras la entrega no sea la
// última; en la última la corrida falla con su código en vez de caer a la DLQ con un 'dlq' que no explica nada.
export const REINTENTOS_WIKI = 3;
const FIJAS_ARBOL = 8;
const FIJAS_AREA = 12;
// Tope de cada espera que se pide a la cola (reintentarEnS de GitHub, el ritmo de la IA, la marca de la síntesis). El
// vigilante del housekeeping (engine/housekeeping.ts) cierra la corrida que lleva SIN_AVANCE_MS (10 min, wiki/corridas.ts)
// sin tocar updated_at; cada reprogramación lo toca, así que 480 s de espera más la entrega y el paso caben con margen.
// Si GitHub pide más (su límite por hora), cada entrega espera 480 s y vuelve a chocar: agotados los REINTENTOS_WIKI, la
// corrida falla con limite_github (~24 min en total). Nunca queda colgada ni la mata el vigilante mientras espera.
export const MAX_ESPERA_S = 480;
const MARGEN_SINTESIS_S = 5;          // tras vencer la marca de otra entrega
const MAX_AVISOS_DOC = 10;            // WikiDoc.avisos
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const PASOS = new Set<string>(['arbol', 'triage', 'area', 'sintesis']);
const COLUMNAS = 'id, org_id, connection_id, repo_full_name, branch, commit_sha, status, est_usd, max_usd, models, state';

type FilaWiki = { id: string; org_id: string; connection_id: string | null; repo_full_name: string; branch: string | null;
  commit_sha: string | null; status: string; est_usd: number | string | null; max_usd: number | string | null;
  models: unknown; state: unknown };

type Ctx = {
  env: CloudflareBindings; m: MsgWiki; fila: FilaWiki; intento: number; modelos: WikiModelos; maxUsd: number;
  n: number;                        // state.n que hay en la base ahora: el compare-and-set de un fallo usa este
  estado: EstadoWiki | null;        // y este el estado que lo lleva
  github: { usadas: () => number } | null;
};

// Lectura o escritura de la base (o del envío a la cola) que no salió: se reintenta siempre; si se agota, la DLQ.
class ErrorBase extends Error {
  constructor(donde: string) { super(donde); this.name = 'ErrorBase'; }
}

// Texto corto de wiki_runs.error por código (texto propio, nunca el del proveedor ni del repo). El código va en
// steps[i].error_code.
const TEXTO_FALLO: Record<string, string> = {
  repo_invalido: 'El nombre del repositorio no es válido.',
  ref_invalida: 'El nombre de la rama o tag no es válido.',
  repo_no_encontrado: 'El repositorio no existe o la conexión de GitHub no tiene acceso a él.',
  ref_no_encontrada: 'Esa rama, tag o commit no existe en el repositorio.',
  limite_github: 'GitHub siguió frenando las peticiones tras varios intentos. Vuelve a intentarlo más tarde.',
  token_invalido: 'El token de GitHub no es válido o venció. Vuelve a conectar tu GitHub.',
  repo_vacio: 'El repositorio está vacío: todavía no hay nada que explicar.',
  github_error: 'GitHub no respondió como esperábamos.',
  github_red: 'No pudimos contactar a GitHub tras varios intentos.',
  respuesta_invalida: 'GitHub devolvió una respuesta que no pudimos leer.',
  conexion_no_encontrada: 'La conexión de GitHub ya no está activa. Vuelve a conectarla.',
  estado_invalido: 'El estado guardado de esta generación no es válido.',
  sin_llm: 'La IA está apagada o no está configurada: no se generó la wiki.',
  sin_archivos: 'No hay archivos que documentar tras los filtros de seguridad.',
  area_desconocida: 'Se pidió una parte del repositorio que no existe en esta generación.',
  pasos_pendientes: 'Faltan pasos por completar antes del documento final.',
  sin_resumenes: 'No se pudo resumir ninguna parte del repositorio.',
  ia_sin_presupuesto: 'Se alcanzó el tope de gasto en IA. Vuelve a intentarlo más tarde.',
  ia_ritmo: 'La IA recibió demasiadas peticiones seguidas. Vuelve a intentarlo en unos minutos.',
  ia_no_disponible: 'El servicio de IA no respondió tras varios intentos.',
  ia_invalida: 'El servicio de IA rechazó la petición.',
  dlq: 'La generación falló varias veces seguidas y se detuvo.',
  error: 'Algo falló al generar la wiki.',
};
const textoDe = (codigo: string) => TEXTO_FALLO[codigo] ?? TEXTO_FALLO.error!;
const NOMBRE_PASO: Record<SiguientePaso['paso'], string> = { triage: 'de selección de archivos',
  area: 'de resumen por área', sintesis: 'del documento final' };

// ── Entrada desde jobs.ts ───────────────────────────────────────────────────────────────────────────────────────────

// `intento` = m.attempts (1 en la primera entrega). Nunca lanza: devuelve ack o el retraso del reintento.
export async function pasoWiki(env: CloudflareBindings, m: MsgWiki, intento = 1): Promise<RespuestaCola> {
  if (!mensajeValido(m)) {
    const p = (m as { paso?: unknown } | null)?.paso;
    log('warn', 'wiki.mensaje_invalido', { paso: typeof p === 'string' ? p.slice(0, 20) : null });
    return 'ack';
  }
  const t0 = Date.now();
  let fila: FilaWiki | null;
  try {
    fila = await leerFila(env, m);
  } catch {
    log('warn', 'wiki.leer_error', { run: m.wiki_run_id, paso: m.paso, intento });
    return { retry: escalonado(intento) };
  }
  if (!fila || cerrada(fila)) return 'ack';
  const ctx: Ctx = { env, m, fila, intento, modelos: modelosDe(fila), maxUsd: maxUsdDe(fila), n: nDe(fila.state),
    estado: null, github: null };
  try {
    ctx.estado = estadoDe(fila.state);
    const r = await correr(ctx);
    log('info', 'wiki.paso', { run: m.wiki_run_id, paso: m.paso, intento, n: ctx.n, ms: Date.now() - t0,
      github: ctx.github?.usadas() ?? 0, cost_usd: ctx.estado?.consumo.cost_usd ?? 0,
      ...(typeof r === 'object' ? { retry_s: r.retry } : {}) });
    return r;
  } catch (e) {
    return alFallar(ctx, e);
  }
}

// Consumidor de vg-jobs-dlq: la corrida queda failed con 'dlq'. No pisa una síntesis que otra entrega sigue pagando, ni
// una corrida cuyo paso ya estaba hecho (un duplicado que se agotó); si ese paso es el último hecho, el envío del
// siguiente pudo ser lo que falló y se reencola para que la corrida no se quede parada.
export async function cierreWikiDlq(env: CloudflareBindings, m: MsgWiki): Promise<RespuestaCola> {
  if (!mensajeValido(m)) return 'ack';
  let fila: FilaWiki | null;
  try { fila = await leerFila(env, m); } catch { return { retry: 30 }; }
  if (!fila || cerrada(fila)) return 'ack';
  const ctx: Ctx = { env, m, fila, intento: REINTENTOS_WIKI + 1, modelos: modelosDe(fila), maxUsd: maxUsdDe(fila),
    n: nDe(fila.state), estado: null, github: null };
  try {
    try { ctx.estado = estadoDe(fila.state); } catch { ctx.estado = null; }
    const e = ctx.estado;
    if (e && m.paso === 'sintesis' && sintesisEnCurso(e)) return { retry: esperaMarca(e) };
    if (e && yaHecho(m, e)) {
      if (esUltimoHecho(m, e)) await encolar(ctx, siguientePaso(e));
      return 'ack';
    }
    await fallar(ctx, 'dlq');
    return 'ack';
  } catch (e) {
    log('error', 'wiki.dlq_error', { run: m.wiki_run_id, name: (e as Error)?.name });
    return { retry: 30 };
  }
}

// ── Pasos ───────────────────────────────────────────────────────────────────────────────────────────────────────────

async function correr(ctx: Ctx): Promise<RespuestaCola> {
  if (ctx.m.paso === 'arbol') return correrArbol(ctx);
  const estado = ctx.estado;
  if (!estado) throw new ErrorWiki('estado_invalido', 'Falta el estado del paso árbol.');
  if (ctx.m.paso === 'triage') return correrTriage(ctx, estado);
  if (ctx.m.paso === 'area') return correrArea(ctx, estado);
  return correrSintesis(ctx, estado);
}

async function correrArbol(ctx: Ctx): Promise<RespuestaCola> {
  const { env, m, fila } = ctx;
  if (ctx.estado) return repetido(ctx, ctx.estado);
  // Sin IA no hay wiki: se corta antes de gastar el cupo de GitHub.
  if (env.IA_CORTE === '1' || !env.ANTHROPIC_API_KEY) throw new ErrorLlmWiki('sin_llm');
  // E41 guardó el commit que resolvió (llave de la caché): se documenta ESE commit aunque la rama haya avanzado, y la
  // rama que se muestra es la de la fila (pasoArbol con un sha como ref pondría el sha como rama).
  const fijo = typeof fila.commit_sha === 'string' && SHA.test(fila.commit_sha) ? fila.commit_sha : null;
  const pedida = fijo ?? fila.branch;
  const ref = { repo_full_name: fila.repo_full_name, ...(pedida ? { ref: pedida } : {}),
    ...(fila.connection_id ? { connection_id: fila.connection_id } : {}) };
  const salida = salidaGithub(TOPE_SUBPETICIONES - FIJAS_ARBOL);
  ctx.github = salida;
  // El PAT solo existe dentro de esta función: va a deps.githubToken y de ahí a la cabecera de GitHub.
  const leido = await conTokenGithub(env, db(env), m.org_id, fila.connection_id ?? undefined, fila.repo_full_name,
    (githubToken) => pasoArbol(ref, depsWiki({ fetch: salida.fetch, githubToken })));
  const estado: EstadoWiki = fijo && fila.branch ? { ...leido, meta: { ...leido.meta, branch: fila.branch } } : leido;
  const s = siguientePaso(estado);
  const parche: Record<string, unknown> = { ...parcheAvance(estado, s), commit_sha: estado.meta.commit_sha,
    branch: estado.meta.branch };
  if (fila.est_usd === null || fila.est_usd === undefined) parche.est_usd = estimar(estado, { modelos: ctx.modelos }).est.usd;
  if (!WikiModelos.safeParse(fila.models).success) parche.models = ctx.modelos;
  return guardarYEncolar(ctx, estado, parche, s);
}

async function correrTriage(ctx: Ctx, estado: EstadoWiki): Promise<RespuestaCola> {
  if (estado.areas.length > 0) return repetido(ctx, estado);
  cortarSiTope(ctx, estado, { paso: 'triage' });
  const nuevo = await pasoTriage(estado, depsSinGithub(ctx));
  if (nuevo === estado) return 'ack';
  // Sin áreas, siguientePaso volvería a pedir el triage: bucle.
  if (nuevo.areas.length === 0) throw new ErrorWiki('sin_archivos', 'El triage no dejó ningún área.');
  const s = siguientePaso(nuevo);
  return guardarYEncolar(ctx, nuevo, parcheAvance(nuevo, s), s);
}

async function correrArea(ctx: Ctx, estado: EstadoWiki): Promise<RespuestaCola> {
  const { env, m, fila } = ctx;
  const nombre = m.area ?? '';
  if (!estado.areas.some((a) => a.nombre === nombre)) throw new ErrorWiki('area_desconocida', 'Área inexistente.');
  if (!estado.pendientes.includes(nombre)) return repetido(ctx, estado);
  cortarSiTope(ctx, estado, { paso: 'area', area: nombre });
  const salida = salidaGithub(TOPE_SUBPETICIONES - FIJAS_AREA);
  ctx.github = salida;
  const llm = llmWiki(env, m.org_id, ctx.modelos);
  const nuevo = await conTokenGithub(env, db(env), m.org_id, fila.connection_id ?? undefined, fila.repo_full_name,
    (githubToken) => pasoArea(estado, nombre, { ...depsWiki({ fetch: salida.fetch, githubToken, llm }), modelos: ctx.modelos }));
  if (nuevo === estado) return 'ack';
  const s = siguientePaso(nuevo);
  return guardarYEncolar(ctx, nuevo, parcheAvance(nuevo, s), s);
}

// LEEME, punto 5: antes de pagar, marcarSintesis con el mismo compare-and-set. Con una marca de otra entrega de hace
// menos de 5 minutos no se corre: se reintenta cuando venza (si esa entrega termina, la reentrega ve succeeded; si se
// cayó, la paga esta). Esa espera no toca updated_at: la marca lo tocó al ponerse y vence en ≤ 5 min, dentro del margen
// del vigilante. Un transitorio tras marcar desmarca para que el reintento no espere los 5 minutos. El documento
// generado se guarda siempre, con un aviso si el pensamiento del modelo pasó el tope.
async function correrSintesis(ctx: Ctx, estado: EstadoWiki): Promise<RespuestaCola> {
  const { env, m, fila } = ctx;
  if (estado.areas.length === 0 || estado.pendientes.length > 0) {
    throw new ErrorWiki('pasos_pendientes', 'Faltan áreas antes de la síntesis.');
  }
  const ahora = new Date();
  if (sintesisEnCurso(estado, ahora)) {
    log('info', 'wiki.sintesis_en_curso', { run: m.wiki_run_id, intento: ctx.intento });
    return { retry: esperaMarca(estado, ahora) };
  }
  cortarSiTope(ctx, estado, { paso: 'sintesis' });
  // Los mismos hallazgos con los que E41 calculó la huella de la caché (wiki/corridas.ts); 3 subpeticiones.
  const { hallazgos, auditoria_at } = await hallazgosDelRepo(db(env), m.org_id, fila.repo_full_name);
  const marcado = marcarSintesis(estado, ahora);
  if (!(await avanzar(ctx, marcado, { status: 'running' }))) return casPerdido(ctx);

  let doc: ResultadoWiki;
  try {
    doc = await pasoSintesis(marcado, { ...depsWiki({ fetch: salidaGithub(0).fetch, llm: llmWiki(env, m.org_id, ctx.modelos),
      hallazgos, auditoria_at }), modelos: ctx.modelos });
  } catch (e) {
    if (clasificar(e).reintentar && ctx.intento <= REINTENTOS_WIKI) await desmarcar(ctx, marcado);
    throw e;
  }
  const final: EstadoWiki = { ...marcado, consumo: { input_tokens: doc.stats.input_tokens,
    output_tokens: doc.stats.output_tokens, cost_usd: doc.stats.cost_usd }, n: nDe(marcado) + 1 };
  const guardado = conAvisoTope(doc, ctx.maxUsd);
  const ok = await avanzar(ctx, final, { status: 'succeeded', progress: 100, steps: vistaFin(final, guardado),
    cost_usd: guardado.stats.cost_usd, doc: guardado, commit_sha: guardado.commit_sha, branch: guardado.branch });
  if (!ok) return casPerdido(ctx);
  log('info', 'wiki.terminada', { run: m.wiki_run_id, cost_usd: guardado.stats.cost_usd, paginas: guardado.paginas.length,
    mermaid: guardado.mermaid !== null });
  return 'ack';
}

// ── Guardado, encolado y repetidos ──────────────────────────────────────────────────────────────────────────────────

// LEEME, punto 4: compare-and-set sobre n; si otra entrega ya avanzó (false), no se encola nada.
async function guardarYEncolar(ctx: Ctx, nuevo: EstadoWiki, parche: Record<string, unknown>, s: SiguientePaso) {
  if (!(await avanzar(ctx, nuevo, parche))) return casPerdido(ctx);
  await encolar(ctx, s);
  return 'ack' as const;
}

function casPerdido(ctx: Ctx): RespuestaCola {
  log('info', 'wiki.cas_perdido', { run: ctx.m.wiki_run_id, paso: ctx.m.paso, n: ctx.n });
  return 'ack';
}

// vg_wiki_avanzar(p_run, p_org, p_n, p_state, p_patch) → true si actualizó la fila (id, org, n y corrida abierta).
// Un error de la base se reintenta una vez en el acto; si sigue, lanza (sin escritura no hay ack).
async function avanzar(ctx: Ctx, state: EstadoWiki | null, parche: Record<string, unknown>): Promise<boolean> {
  const args = { p_run: ctx.m.wiki_run_id, p_org: ctx.m.org_id, p_n: ctx.n, p_state: state, p_patch: parche };
  for (let i = 1; i <= 2; i++) {
    const { data, error } = await db(ctx.env).rpc('vg_wiki_avanzar', args);
    if (!error) {
      if (data === true && state) { ctx.estado = state; ctx.n = nDe(state); }
      return data === true;
    }
    log('warn', 'wiki.avanzar_error', { run: ctx.m.wiki_run_id, code: error.code ?? null, vez: i });
  }
  throw new ErrorBase('avanzar');
}

async function encolar(ctx: Ctx, s: SiguientePaso) {
  const body: MsgWiki = { v: 1, kind: 'wiki', org_id: ctx.m.org_id, wiki_run_id: ctx.m.wiki_run_id, paso: s.paso,
    ...(s.paso === 'area' ? { area: s.area } : {}) };
  for (let i = 1; i <= 2; i++) {
    try { await ctx.env.JOBS_Q.send(body); return; } catch { log('warn', 'wiki.encolar_error', { run: ctx.m.wiki_run_id, vez: i }); }
  }
  throw new ErrorBase('encolar');
}

// Entrega repetida: el paso ya está en el estado, así que no se guarda ni se encola (LEEME, punto 4). Excepción: una
// REentrega (intento > 1) del último paso hecho, o una corrida aún queued con el estado ya puesto, encola el siguiente:
// el envío pudo fallar después de guardar y sin esto la corrida se quedaría parada. El siguiente paso detecta a su vez
// si ya estaba hecho.
async function repetido(ctx: Ctx, estado: EstadoWiki): Promise<RespuestaCola> {
  const queued = ctx.fila.status === 'queued';
  if (!esUltimoHecho(ctx.m, estado) || (ctx.intento <= 1 && !queued)) {
    log('info', 'wiki.repetido', { run: ctx.m.wiki_run_id, paso: ctx.m.paso, intento: ctx.intento });
    return 'ack';
  }
  const s = siguientePaso(estado);
  if (queued && !(await avanzar(ctx, null, parcheAvance(estado, s)))) return casPerdido(ctx);
  await encolar(ctx, s);
  log('info', 'wiki.reencolado', { run: ctx.m.wiki_run_id, paso: ctx.m.paso, siguiente: s.paso, intento: ctx.intento });
  return 'ack';
}

function yaHecho(m: MsgWiki, e: EstadoWiki): boolean {
  if (m.paso === 'arbol') return true;
  if (m.paso === 'triage') return e.areas.length > 0;
  if (m.paso === 'area') return e.areas.some((a) => a.nombre === m.area) && !e.pendientes.includes(m.area ?? '');
  return false;                                       // la síntesis hecha deja la corrida succeeded (cerrada)
}

// Las áreas se resumen en el orden de estado.areas (siguientePaso toma pendientes[0]): la última hecha es la k-ésima.
function esUltimoHecho(m: MsgWiki, e: EstadoWiki): boolean {
  if (m.paso === 'arbol') return e.areas.length === 0;
  if (m.paso === 'triage') return e.areas.length > 0 && e.pendientes.length === e.areas.length;
  if (m.paso === 'area') {
    const k = e.areas.length - e.pendientes.length;
    return k > 0 && e.areas[k - 1]?.nombre === m.area && !e.pendientes.includes(m.area ?? '');
  }
  return false;
}

async function desmarcar(ctx: Ctx, marcado: EstadoWiki) {
  const { sintesis_iniciada: _marca, ...resto } = marcado;
  try {
    await avanzar(ctx, { ...resto, n: nDe(marcado) + 1 }, { status: 'running' });
  } catch {
    // Sin desmarcar, la marca vence sola a los 5 minutos y el reintento espera hasta entonces.
  }
}

// ── Errores ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Clase = { reintentar: boolean; codigo: string; texto: string; esperaS?: number };

// LEEME, punto 6: limite_github → reintento con su espera; github_red y 5xx → reintento normal; IA caída o con el ritmo
// lleno → reintento; base o cola → reintento; el resto falla la corrida con su código.
function clasificar(e: unknown): Clase {
  if (e instanceof ErrorWiki) {
    // El texto de tope_usd lo arma cortarSiTope (cifras nuestras); los demás, de la tabla.
    return { reintentar: false, codigo: e.codigo, texto: e.codigo === 'tope_usd' ? e.message : textoDe(e.codigo) };
  }
  if (e instanceof ErrorGithub) {
    if (e.codigo === 'limite_github') {
      return { reintentar: true, codigo: e.codigo, texto: textoDe(e.codigo),
        esperaS: Math.max(1, Math.ceil(e.reintentarEnS ?? 60)) };
    }
    const transitorio = e.codigo === 'github_red' || (e.status !== null && e.status >= 500);
    return { reintentar: transitorio, codigo: e.codigo, texto: textoDe(e.codigo) };
  }
  if (e instanceof ErrorLlmWiki) {
    return { reintentar: e.reintentable, codigo: e.codigo, texto: textoDe(e.codigo),
      ...(e.esperaS !== null ? { esperaS: e.esperaS } : {}) };
  }
  // conTokenGithub: conexión de otra org, revocada, de otro repo o sin credencial → not_found; lectura fallida → internal.
  if (e instanceof ApiError) {
    return e.code === 'not_found'
      ? { reintentar: false, codigo: 'conexion_no_encontrada', texto: textoDe('conexion_no_encontrada') }
      : { reintentar: true, codigo: 'base', texto: textoDe('error') };
  }
  if (e instanceof ErrorBase) return { reintentar: true, codigo: 'base', texto: textoDe('error') };
  return { reintentar: false, codigo: 'error', texto: textoDe('error') };
}

async function alFallar(ctx: Ctx, e: unknown): Promise<RespuestaCola> {
  const c = clasificar(e);
  const base = { run: ctx.m.wiki_run_id, paso: ctx.m.paso, codigo: c.codigo, intento: ctx.intento };
  // La base o la cola caídas se reintentan siempre: no se podría ni escribir el fallo (la DLQ es el respaldo).
  if (c.reintentar && (c.codigo === 'base' || ctx.intento <= REINTENTOS_WIKI)) {
    const retry = Math.min(MAX_ESPERA_S, c.esperaS ?? escalonado(ctx.intento));
    log('warn', 'wiki.reintento', { ...base, retry_s: retry });
    if (c.codigo !== 'base') await tocar(ctx);
    return { retry };
  }
  log('warn', 'wiki.fallo', { ...base, name: e instanceof Error ? e.name : null });
  try {
    await fallar(ctx, c.codigo, c.texto);
  } catch {
    return { retry: escalonado(ctx.intento) };
  }
  return 'ack';
}

// Reprogramado por una espera: updated_at = now() sin cambiar nada más (vg_wiki_avanzar con p_state null y un parche
// vacío, mismo compare-and-set sobre n), para que el vigilante cuente desde la última espera y no desde el último avance.
// Si otra entrega ya avanzó, su avance ya lo tocó. Mejor esfuerzo, una sola llamada: si falla, el reintento sigue igual.
async function tocar(ctx: Ctx) {
  try {
    const { data, error } = await db(ctx.env).rpc('vg_wiki_avanzar', { p_run: ctx.m.wiki_run_id, p_org: ctx.m.org_id,
      p_n: ctx.n, p_state: null, p_patch: {} });
    if (error || data !== true) log('info', 'wiki.toque_omitido', { run: ctx.m.wiki_run_id, code: error?.code ?? null });
  } catch {
    log('info', 'wiki.toque_omitido', { run: ctx.m.wiki_run_id, code: null });
  }
}

// failed con su código en steps[i] y el texto corto en error, con el mismo compare-and-set: si otra entrega ya avanzó
// (o la corrida cerró), este fallo es viejo y no pisa nada.
async function fallar(ctx: Ctx, codigo: string, texto = textoDe(codigo)) {
  const ok = await avanzar(ctx, null, { status: 'failed', error: texto.slice(0, 300),
    steps: vistaFallo(ctx.estado, ctx.m.paso, codigo) });
  if (!ok) log('info', 'wiki.fallo_viejo', { run: ctx.m.wiki_run_id, paso: ctx.m.paso, codigo });
}

// LEEME, punto 4: ANTES de pagar el paso, lo gastado más lo máximo que puede costar no pasa de max_usd.
function cortarSiTope(ctx: Ctx, estado: EstadoWiki, s: SiguientePaso) {
  const techo = costoMaximoPaso(estado, s, { modelos: ctx.modelos });
  const gastado = estado.consumo.cost_usd;
  if (gastado + techo > ctx.maxUsd) {
    throw new ErrorWiki('tope_usd', `El paso ${NOMBRE_PASO[s.paso]} podía costar hasta US$ ${techo.toFixed(4)} y, con lo `
      + `ya gastado (US$ ${gastado.toFixed(4)}), pasaba el tope de US$ ${ctx.maxUsd.toFixed(4)}. Se detuvo antes de pagarlo.`);
  }
}

function conAvisoTope(doc: ResultadoWiki, maxUsd: number): ResultadoWiki {
  if (!(doc.stats.cost_usd > maxUsd)) return doc;
  const aviso = `El costo final (US$ ${doc.stats.cost_usd.toFixed(4)}) pasó el tope de US$ ${maxUsd.toFixed(4)}: `
    + 'el modelo razonó más de lo previsto.';
  return { ...doc, avisos: [aviso, ...doc.avisos.filter((a) => a !== aviso)].slice(0, MAX_AVISOS_DOC) };
}

// ── Vista de steps (WikiRunStep) ────────────────────────────────────────────────────────────────────────────────────

const ORDEN: WikiRunStep['name'][] = ['arbol', 'triage', 'area', 'sintesis', 'fin'];
const corto = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
const paso = (name: WikiRunStep['name'], status: WikiRunStep['status'], detalle?: string, error_code?: string): WikiRunStep =>
  ({ name, status, ...(detalle ? { detalle: corto(detalle) } : {}), ...(error_code ? { error_code } : {}) });

// Solo cifras: los nombres de áreas (carpetas del repo) solo van en el detalle del paso en curso, como texto plano.
function detalleHecho(name: WikiRunStep['name'], e: EstadoWiki | null): string | undefined {
  if (!e) return undefined;
  if (name === 'arbol') return `${e.files_total} archivos; ${e.candidatos.length} candidatos`;
  if (name === 'triage') return e.areas.length === 1 ? '1 área' : `${e.areas.length} áreas`;
  if (name === 'area') return `${e.resumenes.length} de ${e.areas.length} áreas resumidas`;
  if (name === 'sintesis') return 'Documento generado';
  return undefined;
}

// Tras guardar un paso: los anteriores done, el que sigue running con detalleInicio y el resto pending.
function vistaEnCurso(e: EstadoWiki, s: SiguientePaso): WikiRunStep[] {
  const i = ORDEN.indexOf(s.paso);
  return ORDEN.map((n, k) => (k < i ? paso(n, 'done', detalleHecho(n, e))
    : k === i ? paso(n, 'running', detalleInicio(s, e)) : paso(n, 'pending')));
}

function vistaFin(e: EstadoWiki, doc: ResultadoWiki): WikiRunStep[] {
  const fin = doc.mermaid ? 'Documento y diagrama listos'
    : doc.mermaid_descartado ? 'Documento listo; diagrama descartado' : 'Documento listo; sin diagrama';
  return ORDEN.map((n) => paso(n, 'done', n === 'fin' ? fin : detalleHecho(n, e)));
}

function vistaFallo(e: EstadoWiki | null, en: PasoWiki, codigo: string): WikiRunStep[] {
  const i = ORDEN.indexOf(en);
  return ORDEN.map((n, k) => (k < i ? paso(n, 'done', detalleHecho(n, e))
    : k === i ? paso(n, 'failed', undefined, codigo) : paso(n, 'skipped')));
}

function parcheAvance(e: EstadoWiki, s: SiguientePaso): Record<string, unknown> {
  return { status: 'running', progress: progreso(e, s.paso === 'area'), steps: vistaEnCurso(e, s),
    cost_usd: e.consumo.cost_usd };
}

// ── Auxiliares ──────────────────────────────────────────────────────────────────────────────────────────────────────

function mensajeValido(m: unknown): m is MsgWiki {
  if (!m || typeof m !== 'object') return false;
  return esMsgWiki(m as MsgWiki);
}
function esMsgWiki(m: MsgWiki): boolean {
  return !!m && m.v === 1 && m.kind === 'wiki' && typeof m.org_id === 'string' && UUID.test(m.org_id)
    && typeof m.wiki_run_id === 'string' && UUID.test(m.wiki_run_id) && PASOS.has(m.paso)
    && (m.paso !== 'area' || (typeof m.area === 'string' && m.area.length > 0 && m.area.length <= 300));
}

async function leerFila(env: CloudflareBindings, m: MsgWiki): Promise<FilaWiki | null> {
  const { data, error } = await db(env).from('wiki_runs').select(COLUMNAS)
    .eq('id', m.wiki_run_id).eq('org_id', m.org_id).maybeSingle();
  if (error) throw new ErrorBase('leer');
  return (data as FilaWiki | null) ?? null;
}

const cerrada = (f: FilaWiki) => f.status === 'succeeded' || f.status === 'failed';

// El mismo n que compara vg_wiki_avanzar: coalesce((state->>'n')::int, 0).
function nDe(state: unknown): number {
  const n = (state as { n?: unknown } | null | undefined)?.n;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0;
}

// El estado viene de la base: se revisa la forma antes de mirar áreas o consumo (el motor lo vuelve a revisar).
function estadoDe(raw: unknown): EstadoWiki | null {
  if (raw === null || raw === undefined) return null;
  const e = raw as Partial<EstadoWiki>;
  if (typeof e !== 'object' || e.version !== 1 || !e.meta || typeof e.meta.commit_sha !== 'string'
    || !Array.isArray(e.candidatos) || !Array.isArray(e.areas) || !Array.isArray(e.pendientes)
    || !Array.isArray(e.resumenes) || !Array.isArray(e.avisos) || typeof e.consumo?.cost_usd !== 'number'
    || !Number.isFinite(e.consumo.cost_usd)) {
    throw new ErrorWiki('estado_invalido', 'El estado guardado no tiene la forma esperada.');
  }
  return e as EstadoWiki;
}

function modelosDe(f: FilaWiki): WikiModelos {
  const r = WikiModelos.safeParse(f.models);
  return r.success && r.data.fast && r.data.smart ? r.data : MODELOS_POR_DEFECTO;
}

// max_usd: 0 < x ≤ 5 por el check de la tabla; si llega raro, 1 (el default de la columna).
function maxUsdDe(f: FilaWiki): number {
  const v = Number(f.max_usd);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 5) : 1;
}

function depsSinGithub(ctx: Ctx) {
  return { ...depsWiki({ fetch: salidaGithub(0).fetch, llm: llmWiki(ctx.env, ctx.m.org_id, ctx.modelos) }), modelos: ctx.modelos };
}

const escalonado = (intento: number) => Math.min(300, 10 * 2 ** Math.max(0, intento - 1));

function esperaMarca(e: EstadoWiki, ahora = new Date()): number {
  const vence = Date.parse(e.sintesis_iniciada ?? '') + ESPERA_SINTESIS_MS;
  const s = Number.isFinite(vence) ? Math.ceil((vence - ahora.getTime()) / 1000) : 0;
  return Math.min(MAX_ESPERA_S, Math.max(1, s) + MARGEN_SINTESIS_S);
}
