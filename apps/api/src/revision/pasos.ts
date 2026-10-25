import {
  archivoCompacto, envDelDiff, LIM_DIFF, parsearDiff, secretosDelDiff, tituloEnvSubido, tituloSecreto, type ArchivoCompacto,
  type ArchivoDiff,
} from '@vanguard/core';
import { fingerprint } from '@vanguard/core/crypto';
import type { MsgRevision } from '../jobs.ts';
import { withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { sha256Hex } from '../lib/hmac.ts';
import { pedir, ProviderError } from '../lib/http.ts';
import { activeKid, getKeys } from '../lib/keyring.ts';
import { log } from '../lib/log.ts';
import { avisarRevision } from '../notify/revision.ts';
import { aFila, claveDeRepo, PARECE_SECRETO, type Borrador, type Fila } from '../scans/comun.ts';
import { recortar } from '../scans/repo-paso.ts';
import { codigoGithub, ghHeaders, leerAcotado } from '../scans/repo.ts';
import type { RespuestaCola } from '../wiki/pasos.ts';

// Revisión de código en cada push y PR (asignaciones/revision-codigo.md §2): mensajes {kind:'review'} de vg-jobs. Paso
// 'diff' (§2.2–2.5): claim CAS → config y conexión (el repo sale de connections.meta, nunca del payload) → compare
// base...head con el PAT en formato diff → solo las líneas AÑADIDAS, en compacto → reglas (secretos y .env) →
// aFila → ocultarRutas → vg_review_findings (decide «nuevo» y alert_state en una transacción; p_write solo en un
// push, y un PR de fork va con sin_aviso) → si queda 'pending', encola el paso 'aviso' (notify/revision.ts). Como la
// wiki, decide ack o retry: un transitorio (429, 403 con límite, 5xx, red, plazo) se reintenta 2 veces y después la
// revisión queda failed con su código; lo que agota la CPU llega a la DLQ (failed/dlq).
// Subpeticiones (§2.7): claim 1 + config y conexión 2 + PAT y llaves ≤ 6 + compare ≤ 4 + last_error 'token' ≤ 1 +
// vg_review_findings 1 (+1 de rescate si la base rechaza el lote, 23514) + encolar 1 ≤ 17 de 40.

export const LIM_REVISION: Readonly<{ diffBytes: number; archivos: number; bytesAnadidos: number; filas: number }> =
  Object.freeze({ diffBytes: 1_000_000, archivos: LIM_DIFF.archivos, bytesAnadidos: LIM_DIFF.bytesAnadidos, filas: 200 });
export const REINTENTOS_REVISION = 2;
const GH = 'https://api.github.com';
const PLAZO_MS = 30_000;
const TRANSITORIO = new Set(['unavailable', 'timeout', 'rate_limited']);
const SHA = /^[0-9a-f]{40}$/;
const CODIGO = /^[a-z_]{2,40}$/;   // check de code_reviews.error_code
// Copias de scans/repo.ts (allí sin exportar): dueño/nombre de GitHub sin . ni .. y los medios que no se escanean.
const NOMBRE_REPO = /^[A-Za-z0-9_-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const MEDIO = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|woff2?|ttf|eot|mp[34]|mov|exe|dll|so|dylib|wasm|bin)$/i;
const RUTA_CITADA = /^diff --git [^\n]*"/m;   // git cita las rutas con espacios o no ASCII: parsearDiff las salta (P0)
const escalonado = (intento: number) => 10 * 2 ** Math.max(0, intento - 1);
const obj = (x: unknown): Record<string, unknown> =>
  (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {});

// alert_reason: 'fork' lo pone E47 en un PR de un fork de alguien de fuera (§1.3); viaja como sin_aviso a la RPC.
type FilaRevision = {
  id: string; config_id: string; event: string; base_sha: string; head_sha: string; alert_reason: string | null;
};
// Lo que sale de withSecret: nunca el token. 'grande' = 406/422 (diff demasiado grande para GitHub).
type Leido = { tipo: 'diff'; texto: string; cortado: boolean } | { tipo: 'grande' }
  | { tipo: 'fallo'; code: string; token: boolean };

/** Entrada de la cola para kind 'review' (jobs.ts). `intento` = m.attempts. Nunca lanza sin decidir: ack o retry. */
export async function pasoRevision(env: CloudflareBindings, m: MsgRevision, intento = 1): Promise<RespuestaCola> {
  const paso: string = m.paso;
  if (paso === 'diff') return pasoDiff(env, m, intento);
  if (paso === 'aviso') return avisarRevision(env, m, intento);
  log('warn', 'revision.paso_desconocido', { review: m.review_id });
  return 'ack';
}

// ── ocultarRutas (§2.5): la revisión NO usa prefiltrar ──────────────────────────────────────────────────────────────
// prefiltrar descarta la fila entera si title o resource casan con el cable trampa, y la ruta la elige quien empuja: con
// una clave real en lib/x_ghp_…/pagos.ts, redact() no tapa la ruta (exige \b) y el hallazgo desaparecería sin aviso.
// Aquí la ruta se oculta con un hash y se conservan rule_id, severidad y la dedupe_key que ya calculó aFila. Si solo
// casa la evidencia, evidence = {redacted:true} como prefiltrar. Nada se descarta; `ocultas` solo informa (tripwire).
// En los dos casos (y en el rescate del 23514) la evidencia tapada conserva fingerprint_short si son 8 hex (HMAC de la
// org; ni el cable trampa ni looks_like_secret casan): sin ella, vg_review_findings no distingue otro valor en la misma
// línea («sin huella» = no es nuevo) y una ruta con forma de token dejaría que un ignored tapara una clave distinta (§7).
const HUELLA = /^[0-9a-f]{8}$/;
const tituloSinRuta = (ruleId: string) => (ruleId === 'CB_ENV_COMMITTED' ? tituloEnvSubido('') : tituloSecreto(ruleId, ''));
function tapada(f: Fila): Record<string, unknown> {
  const huella = obj(f.evidence).fingerprint_short;
  return typeof huella === 'string' && HUELLA.test(huella) ? { redacted: true, fingerprint_short: huella } : { redacted: true };
}
async function ocultarFila(f: Fila): Promise<Fila> {
  return { ...f, resource: `[ruta oculta]#${(await sha256Hex(f.resource)).slice(0, 8)}`, title: tituloSinRuta(f.rule_id),
    evidence: tapada(f) };
}
export async function ocultarRutas(filas: readonly Fila[]): Promise<{ filas: Fila[]; ocultas: number }> {
  let ocultas = 0;
  const out = await Promise.all(filas.map(async (f) => {
    if (PARECE_SECRETO.test(`${f.title} ${f.resource}`)) {
      ocultas++;
      log('warn', 'TRIPWIRE', { rule_id: f.rule_id, ruta_oculta: true });
      return ocultarFila(f);
    }
    if (PARECE_SECRETO.test(JSON.stringify(f.evidence))) {
      ocultas++;
      log('warn', 'TRIPWIRE', { rule_id: f.rule_id });
      return { ...f, evidence: tapada(f) };
    }
    return f;
  }));
  return { filas: out, ocultas };
}

// ── Paso 'diff' ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Claim CAS queued → running (started_at). Una reentrega (attempts > 1) retoma la que sigue running: la entrega anterior
// cayó (CPU, red) sin cerrar. Con attempts = 1, una running es de otra entrega en curso y no se toca.
async function reclamar(env: CloudflareBindings, m: MsgRevision, intento: number): Promise<FilaRevision | null> {
  const { data, error } = await db(env).from('code_reviews').update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', m.review_id).eq('org_id', m.org_id).in('status', intento > 1 ? ['queued', 'running'] : ['queued'])
    .select('id, config_id, event, base_sha, head_sha, alert_reason').maybeSingle();
  if (error) throw new ProviderError('unavailable');
  return (data as FilaRevision | null) ?? null;
}

const encolarAviso = (env: CloudflareBindings, m: MsgRevision) =>
  env.JOBS_Q.send({ v: 1, kind: 'review', org_id: m.org_id, review_id: m.review_id, paso: 'aviso' });

// No se pudo reclamar: ya la hizo otra entrega. Si quedó done con el aviso pendiente (vg_review_findings cerró pero falló
// encolar el aviso), solo se reencola el aviso; si no, nada.
async function yaReclamada(env: CloudflareBindings, m: MsgRevision, intento: number): Promise<RespuestaCola> {
  const { data, error } = await db(env).from('code_reviews').select('status, alert_state')
    .eq('id', m.review_id).eq('org_id', m.org_id).maybeSingle();
  if (error) return { retry: escalonado(intento) };
  const f = obj(data);
  if (f.status === 'done' && f.alert_state === 'pending') {
    try { await encolarAviso(env, m); } catch { return { retry: escalonado(intento) }; }
    log('info', 'revision.aviso_reencolado', { review: m.review_id, intento });
    return 'ack';
  }
  log('info', 'revision.repetida', { review: m.review_id, status: typeof f.status === 'string' ? f.status : null, intento });
  return 'ack';
}

// failed con su código, solo sobre una revisión running de esa org. Si no se puede escribir, retry.
async function fallar(env: CloudflareBindings, m: MsgRevision, code: string, intento: number): Promise<RespuestaCola> {
  const error_code = CODIGO.test(code) ? code : 'error';
  const { error } = await db(env).from('code_reviews').update({ status: 'failed', error_code, finished_at: new Date().toISOString() })
    .eq('id', m.review_id).eq('org_id', m.org_id).eq('status', 'running');
  if (error) {
    log('error', 'revision.fallar_error', { review: m.review_id, code: error.code ?? null });
    return { retry: escalonado(intento) };
  }
  log('warn', 'revision.fallida', { review: m.review_id, error_code, intento });
  return 'ack';
}

// 401, o 403 sin cabeceras de límite: el PAT ya no ve el repo. La tarjeta lo dice (last_error 'token'). Mejor esfuerzo.
async function marcarToken(env: CloudflareBindings, orgId: string, configId: string) {
  const { error } = await db(env).from('code_review_configs').update({ last_error: 'token', last_error_at: new Date().toISOString() })
    .eq('id', configId).eq('org_id', orgId);
  if (error) log('warn', 'revision.token_sin_marcar', { config: configId, code: error.code ?? null });
}

// Compare con el PAT (§2.2): una subpetición (+3 saltos si el repo se renombró: pedir solo sigue al mismo host). Formato
// diff: sin el JSON.parse del compare y se puede cortar a mitad. Se lee hasta 1 MB aunque Content-Length diga más.
async function leerDiff(token: string, repo: string, base: string, head: string): Promise<Leido> {
  const r = await pedir(`${GH}/repos/${repo}/compare/${base}...${head}`,
    { headers: { ...ghHeaders(token), Accept: 'application/vnd.github.diff' } }, PLAZO_MS);
  if (r.ok) return { tipo: 'diff', ...(await leerAcotado(r, LIM_REVISION.diffBytes, undefined, { ignorarLargo: true })) };
  await r.body?.cancel();
  if (r.status === 406 || r.status === 422) return { tipo: 'grande' };
  const code = codigoGithub(r);
  if (TRANSITORIO.has(code)) throw new ProviderError(code, r.status);   // 429, 403 con límite, 5xx: la cola reintenta
  return { tipo: 'fallo', code, token: code === 'unauthorized' || code === 'forbidden' };
}

// Por qué quedó parcial (§2.2): topes de bytes, archivos o texto añadido → diff_grande; binario que no es multimedia o
// ruta entre comillas → binario. parsearDiff solo dice `cortado`: lo que no explican el tope de archivos, un binario raro
// ni una ruta citada es el tope de texto añadido.
function motivoCorte(archivos: readonly ArchivoDiff[], texto: string): 'diff_grande' | 'binario' {
  if (archivos.length >= LIM_REVISION.archivos) return 'diff_grande';
  if (archivos.some((a) => a.binario && a.estado !== 'deleted' && !MEDIO.test(a.path)) || RUTA_CITADA.test(texto)) return 'binario';
  return 'diff_grande';
}

async function pasoDiff(env: CloudflareBindings, m: MsgRevision, intento: number): Promise<RespuestaCola> {
  let rev: FilaRevision | null;
  try {
    rev = await reclamar(env, m, intento);
  } catch {
    log('warn', 'revision.claim_error', { review: m.review_id, intento });
    return { retry: escalonado(intento) };
  }
  if (!rev) return yaReclamada(env, m, intento);
  try {
    return await revisar(env, m, rev, intento);
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : 'error';
    const reintentable = TRANSITORIO.has(code) || !(e instanceof ProviderError);   // lo desconocido (llaves, base) también
    if (reintentable && intento <= REINTENTOS_REVISION) {
      log('warn', 'revision.reintento', { review: m.review_id, code, name: (e as Error)?.name, intento });
      return { retry: escalonado(intento) };
    }
    return fallar(env, m, code, intento);
  }
}

async function revisar(env: CloudflareBindings, m: MsgRevision, rev: FilaRevision, intento: number): Promise<RespuestaCola> {
  const t0 = Date.now();
  const admin = db(env);
  if (!SHA.test(rev.base_sha) || !SHA.test(rev.head_sha)) return fallar(env, m, 'sha_invalido', intento);
  const { data: cfg, error: ec } = await admin.from('code_review_configs').select('id, connection_id, enabled')
    .eq('id', rev.config_id).eq('org_id', m.org_id).maybeSingle();
  if (ec) throw new ProviderError('unavailable');
  if (!cfg) return fallar(env, m, 'sin_config', intento);
  // Apagada entre el webhook y este paso: ni findings ni WhatsApp (el aviso solo existe si este paso cierra en pending).
  if (cfg.enabled !== true) return fallar(env, m, 'desactivada', intento);
  const { data: conn, error: en } = await admin.from('connections').select('id, status, meta')
    .eq('id', cfg.connection_id).eq('org_id', m.org_id).eq('provider', 'github').eq('kind', 'read').maybeSingle();
  if (en) throw new ProviderError('unavailable');
  if (!conn) return fallar(env, m, 'no_connection', intento);
  if (conn.status !== 'active') return fallar(env, m, 'conexion_inactiva', intento);
  const repo = String(obj(conn.meta).repo_full_name ?? '');
  if (!NOMBRE_REPO.test(repo)) return fallar(env, m, 'repo_invalido', intento);

  let leido: Leido;
  try {
    leido = await withSecret(env, admin, { orgId: m.org_id, connectionId: String(conn.id), provider: 'github', kind: 'read' },
      (token) => leerDiff(token, repo, rev.base_sha, rev.head_sha));
  } catch (e) {
    // withSecret lanza la MISMA ApiError('not_found') si falta el secreto y si falla la base (08006, plazo): se reintenta
    // como lo desconocido y solo agotados los reintentos queda failed sin_credencial (la fila sigue running).
    if (!(e instanceof ApiError)) throw e;
    if (intento <= REINTENTOS_REVISION) {
      log('warn', 'revision.reintento', { review: m.review_id, code: 'sin_credencial', intento });
      return { retry: escalonado(intento) };
    }
    return fallar(env, m, 'sin_credencial', intento);
  }
  if (leido.tipo === 'fallo') {
    if (leido.token) await marcarToken(env, m.org_id, String(cfg.id));
    return fallar(env, m, leido.code, intento);
  }

  // 406/422: RPC sin filas, parcial con diff_grande (avisa como incompleta; la UI propone la auditoría completa).
  const texto = leido.tipo === 'diff' ? leido.texto : '';
  const p = leido.tipo === 'diff' ? parsearDiff(texto, LIM_REVISION) : { archivos: [], cortado: false };
  const compactos = p.archivos.map((a) => archivoCompacto(a)).filter((c): c is ArchivoCompacto => c !== null);
  let secretos: Borrador[] = [];
  if (compactos.length) {
    const keys = await getKeys(env, admin, await activeKid(admin));
    secretos = await secretosDelDiff(compactos, { huella: (v) => fingerprint(keys, m.org_id, v) });
  }
  const borradores: Borrador[] = [...secretos, ...envDelDiff(p.archivos, compactos)]
    .map((b) => ({ ...b, evidence: { ...b.evidence, fuente: 'github', sha: rev.head_sha } }));
  const { dentro, fuera } = recortar(borradores, LIM_REVISION.filas);
  // La misma clave que la auditoría (varias-codebases.md §2.2): un secreto visto en un push y luego en la auditoría de
  // ese repo sigue siendo la misma fila.
  const clave = claveDeRepo(obj(conn.meta));
  const oc = await ocultarRutas(await Promise.all(dentro.map((b) => aFila(m.org_id, clave(b)))));

  const motivo = leido.tipo === 'grande' || leido.cortado ? 'diff_grande' : p.cortado ? motivoCorte(p.archivos, texto)
    : fuera.length ? 'hallazgos_truncados' : null;
  let anadidas = 0;
  for (const a of p.archivos) for (const l of a.lineas) if (l.t === '+') anadidas++;
  // PR (§2.5): p_write false, nada va a findings (el código aún no está en la rama). Fork: sin_aviso, solo en la app.
  const fork = rev.alert_reason === 'fork';
  const p_meta = { files_changed: p.archivos.length, lines_added: anadidas, partial: motivo !== null,
    error_code: motivo ?? (oc.ocultas ? 'tripwire' : null), ...(fork ? { sin_aviso: 'fork' } : {}) };
  const llamar = (rows: Fila[], meta: typeof p_meta) => admin.rpc('vg_review_findings',
    { p_org: m.org_id, p_review: rev.id, p_rows: rows, p_write: rev.event === 'push', p_meta: meta });
  let r = await llamar(oc.filas, p_meta);
  if (r.error?.code === '23514') {
    // La base vio un secreto que el cable trampa en JS no vio (deriva de la regex): todas las filas ocultas, sin descartar.
    log('warn', 'TRIPWIRE', { review: m.review_id, lote: oc.filas.length });
    r = await llamar(await Promise.all(oc.filas.map(ocultarFila)), { ...p_meta, error_code: p_meta.error_code ?? 'tripwire' });
    if (r.error?.code === '23514') return fallar(env, m, 'tripwire', intento);
  }
  if (r.error) throw new ProviderError('unavailable');
  const res = obj(r.data);
  if (res.applied !== true) {
    log('info', 'revision.cas_perdido', { review: m.review_id, intento });   // ya no estaba running: otra entrega la cerró
    return 'ack';
  }
  // Tras cerrar: si encolar falla, la reentrega no puede reclamarla (está done) y yaReclamada reencola el aviso.
  if (res.alert_state === 'pending') {
    try { await encolarAviso(env, m); } catch {
      log('warn', 'revision.aviso_sin_encolar', { review: m.review_id, intento });
      return { retry: escalonado(intento) };
    }
  }
  log('info', 'revision.fin', { review: m.review_id, evento: rev.event, sha7: rev.head_sha.slice(0, 7), ms: Date.now() - t0,
    archivos: p.archivos.length, anadidas, filas: oc.filas.length, omitidas: fuera.length, ocultas: oc.ocultas,
    nuevos: res.nuevos ?? null, parcial: p_meta.partial, error_code: p_meta.error_code, fork,
    alert_state: res.alert_state ?? null, intento });
  return 'ack';
}

// ── DLQ ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 'diff' agotado (CPU o lo que reventó sin decidir): failed/dlq si sigue queued o running. Si ya cerró done con el aviso
// pendiente y lo que no salió fue encolar el aviso, ese aviso queda not_sent/dlq. 'aviso' agotado: not_sent/dlq. Solo
// sobre filas de esa org; si no se puede escribir, retry.
export async function cierreRevisionDlq(env: CloudflareBindings, m: MsgRevision): Promise<RespuestaCola> {
  const admin = db(env);
  const filas = () => admin.from('code_reviews');
  const noEnviado = { alert_state: 'not_sent', alert_reason: 'dlq' };
  const paso: string = m.paso;
  const errores = paso === 'aviso'
    ? [(await filas().update(noEnviado).eq('id', m.review_id).eq('org_id', m.org_id).eq('alert_state', 'pending')).error]
    : (await Promise.all([
      filas().update({ status: 'failed', error_code: 'dlq', finished_at: new Date().toISOString() })
        .eq('id', m.review_id).eq('org_id', m.org_id).in('status', ['queued', 'running']),
      filas().update(noEnviado).eq('id', m.review_id).eq('org_id', m.org_id).eq('status', 'done').eq('alert_state', 'pending'),
    ])).map((x) => x.error);
  const error = errores.find((e) => e);
  if (error) {
    log('error', 'revision.dlq_error', { review: m.review_id, paso, code: error.code ?? null });
    return { retry: 10 };
  }
  log('warn', 'revision.dlq', { review: m.review_id, paso });
  return 'ack';
}
