import { ipCanonica } from '@vanguard/core';
import { withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { pedir, ProviderError } from '../lib/http.ts';
import { log } from '../lib/log.ts';

// «Bloquear IP» en Cloudflare (S15 15.10, §08.8, §12.9). executeBlock corre tras un canje (E21 o el botón ok de E31);
// deshacerBloqueos sirve a E22, a E10 y a la caducidad de housekeeping. IP Access Rules de la ZONA con el token de la
// conexión kind:'action' (withSecret: el token solo vive dentro de la llamada). Marca en notes «VanGUARD #<code> ·
// <regla> · hasta <ISO>», sin datos personales; solo se deshace lo que creó una fila de actions. Una regla tiene un solo
// dueño: al adoptar una regla VanGUARD ya puesta, la fila anterior que la apuntaba queda undone. Nada de IP completas,
// tokens ni cuerpos de Cloudflare en los logs ni en los errores.

export const CF_API = 'https://api.cloudflare.com/client/v4';
export const PLAZO_CF_MS = 20_000;
export const TTL_BLOQUEO_S = 3600;
/** Un actions proposed más joven que esto es un executeBlock en marcha (POST + GET de reconciliación ≤ 2 × PLAZO_CF_MS). */
export const EN_CURSO_MS = 2 * 60_000;
export const ERROR_SIN_PERMISO = 'Te falta el permiso Firewall Services · Edit en el token de acciones';
const ERROR_TOKEN = 'El token de acciones ya no es válido. Vuelve a conectarlo.';
const ERROR_CREDENCIAL = 'No pudimos abrir el token de acciones. Vuelve a conectarlo.';
const ERROR_SIN_REGLA = 'Cloudflare dice que esa IP ya tiene una regla, pero no pudimos leerla: revísala en Cloudflare';
/** Regla del cliente para esa IP en otro modo (whitelist, challenge…): no se da por bloqueada ni se toca. */
export const errorModo = (mode: string) => `Esa IP tiene una regla tuya en modo ${mode} en Cloudflare: cámbiala a mano`;
const MODO = /^[a-z_]{1,24}$/;
// 408, 429 y 5xx son pasajeros; el resto de 4xx no se arregla reintentando.
const caidoHttp = (s: number) => s === 408 || s === 429 || s >= 500;

// Rangos de Cloudflare (E20 → 422 cloudflare_ip): copia de https://www.cloudflare.com/ips/ (GET /client/v4/ips)
// [no verificado hoy: revisar si Cloudflare publica rangos nuevos].
export const RANGOS_CLOUDFLARE: readonly string[] = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZONA = /^[a-f0-9]{32}$/;
const ID_REGLA = /^[A-Za-z0-9]{1,64}$/;
const uuid = (x: unknown) => { const s = str(x); return s && UUID.test(s) ? s : null; };

/** params de una aprobación block_ip (E20, S15: {target, incident_id, group, connection_id, zone_id, zone_name,
 *  target_kind, mode, ttl_s} + incident_code, regla y requested_by, que ahorran lecturas al ejecutar). */
export type ParamsBloqueo = {
  target: string; target_kind: 'ip' | 'ip6'; incident_id: string | null; group: string | null; connection_id: string;
  zone_id: string; zone_name: string | null; ttl_s: number; incident_code: string | null; regla: string | null;
  requested_by: string | null;
};

export function leerParams(x: unknown): ParamsBloqueo | null {
  const p = obj(x);
  const target = ipCanonica(str(p.target) ?? '');
  const kind = target ? (target.includes(':') ? 'ip6' : 'ip') : null;
  const connection_id = uuid(p.connection_id), zone_id = str(p.zone_id);
  if (!target || !kind || p.target_kind !== kind || !connection_id || !zone_id || !ZONA.test(zone_id)) return null;
  if (p.mode !== undefined && p.mode !== 'block') return null;              // managed_challenge es P1
  const ttl = typeof p.ttl_s === 'number' && Number.isInteger(p.ttl_s) ? Math.min(Math.max(p.ttl_s, 300), 86_400) : TTL_BLOQUEO_S;
  return { target, target_kind: kind, incident_id: uuid(p.incident_id), group: uuid(p.group), connection_id, zone_id,
    zone_name: str(p.zone_name), ttl_s: ttl, incident_code: str(p.incident_code), regla: str(p.regla),
    requested_by: uuid(p.requested_by) };
}

/** «VanGUARD #A1F3C9 · CF_UA_TOOL · hasta 2026-10-24T22:41:00Z» (§08.8): código, regla y hora; nada personal. */
export function notasBloqueo(code: string | null, regla: string | null, hasta: Date): string {
  const c = code && /^[A-Z0-9]{6}$/.test(code) ? code : '------';
  const r = regla && /^[A-Z][A-Z0-9_]{1,40}$/.test(regla) ? regla : 'manual';
  return `VanGUARD #${c} · ${r} · hasta ${hasta.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

/** Fila de approvals tal como la devuelve vg_redeem_approval (setof approvals). */
export type AprobacionCanjeada = {
  id: string; org_id: string; incident_id?: string | null; action_kind: string; channel: string; recipient: string; params: unknown;
};

export type ResultadoBloqueo =
  | { tipo: 'ejecutado'; action_id: string; en: string; resultado: string; existia: boolean; repetido: boolean }
  | { tipo: 'rechazado'; action_id: string | null; error: string; status: number | null }   // 4xx (403 = sin permiso): 200 ok:false
  | { tipo: 'caido'; action_id: string | null; status: number | null }                     // red, plazo, 429 o 5xx: 502
  | { tipo: 'en_curso'; action_id: string }                                                // otra ejecución de la misma aprobación
  | { tipo: 'invalido' };                                                                   // params ilegibles: no se toca nada

const RESULTADO_OK = 'IP bloqueada 1 h';
const RESULTADO_EXISTIA = 'Ya estaba bloqueada por una regla tuya';
const COLUMNAS_ACCION = 'id, approval_id, incident_id, status, previous, expires_at, created_at';

function interno(rid: string, evento: string, code: string | null | undefined): never {
  log('error', evento, { rid, code: code ?? null });
  throw new ApiError('internal', 'No pudimos registrar el bloqueo');
}

// Una fila de actions ya existente → resultado sin tocar Cloudflare.
function desdeFila(f: Obj): ResultadoBloqueo {
  const id = String(f.id);
  const existia = obj(f.previous).existed === true;
  const en = new Date(str(f.created_at) ?? Date.now()).toISOString();
  if (f.status === 'executed') return { tipo: 'ejecutado', action_id: id, en, resultado: existia ? RESULTADO_EXISTIA : RESULTADO_OK, existia, repetido: true };
  if (f.status === 'undone') return { tipo: 'ejecutado', action_id: id, en, resultado: 'El bloqueo ya se retiró', existia, repetido: true };
  if (f.status === 'proposed') return { tipo: 'en_curso', action_id: id };
  return { tipo: 'rechazado', action_id: id, error: 'Ese bloqueo ya falló: vuelve a proponerlo', status: null };
}

// existia: regla block del cliente (no se borrará nunca); adoptada: regla block con marca VanGUARD que ya estaba.
type Creada = { tipo: 'creada'; id: string | null; existia: boolean; adoptada: boolean };
type OtroModo = { tipo: 'modo'; mode: string | null };          // null: Cloudflare dice que existe pero la lista no la trae
type FalloCf = { tipo: 'error'; status: number | null; caido: boolean };

const leerJson = (t: string): Obj => { try { return obj(JSON.parse(t)); } catch { return {}; } };
// firewallaccessrules.api.duplicate_of_existing (§08.8, verificado en KUADRA): solo se comprueba, nunca se guarda ni se registra.
const esDuplicado = (j: Obj) => (Array.isArray(j.errors) ? j.errors : []).some((e) => /duplicate_of_existing/.test(String(obj(e).message ?? '')));
const cabeceras = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' });
const falloRed = (e: unknown): FalloCf => ({ tipo: 'error', status: e instanceof ProviderError ? e.status ?? null : null, caido: true });

// La regla de esa IP en la zona. mode block con notes «VanGUARD…» → se adopta su id; mode block del cliente → existed:true
// y «Deshacer» no tocará Cloudflare; otro modo (whitelist, challenge…) → no cuenta como bloqueada. null = no está.
async function buscarExistente(token: string, p: ParamsBloqueo): Promise<Creada | OtroModo | FalloCf | null> {
  const q = `configuration.target=${p.target_kind}&configuration.value=${encodeURIComponent(p.target)}&per_page=20`;
  let r: Response;
  try {
    r = await pedir(`${CF_API}/zones/${p.zone_id}/firewall/access_rules/rules?${q}`, { method: 'GET', headers: cabeceras(token) }, PLAZO_CF_MS);
  } catch (e) {
    return falloRed(e);
  }
  const j = leerJson(await r.text().catch(() => ''));
  if (!r.ok || !Array.isArray(j.result)) return { tipo: 'error', status: r.status, caido: r.ok || caidoHttp(r.status) };
  const reglas = j.result.map(obj).filter((x) => ipCanonica(str(obj(x.configuration).value) ?? '') === p.target);
  const bloqueo = reglas.find((x) => x.mode === 'block');
  if (bloqueo) {
    const id = str(bloqueo.id);
    const legible = id !== null && ID_REGLA.test(id);
    const nuestra = legible && (str(bloqueo.notes) ?? '').startsWith('VanGUARD');
    return { tipo: 'creada', id: legible ? id : null, existia: !nuestra, adoptada: nuestra };
  }
  const modo = str(reglas[0]?.mode);
  return reglas[0] ? { tipo: 'modo', mode: modo && MODO.test(modo) ? modo : null } : null;
}

// POST sin respuesta clara (red, plazo, 429, 5xx): Cloudflare pudo crearla igual. Si la lista ya trae una regla block de
// esa IP, cuenta como creada (con su provider_ref) y no queda una regla sin fila que la deshaga.
async function reconciliar(token: string, p: ParamsBloqueo, fallo: FalloCf): Promise<Creada | FalloCf> {
  const x = await buscarExistente(token, p);
  return x?.tipo === 'creada' ? x : fallo;
}

async function crearRegla(token: string, p: ParamsBloqueo, notes: string): Promise<Creada | OtroModo | FalloCf> {
  let r: Response;
  try {
    r = await pedir(`${CF_API}/zones/${p.zone_id}/firewall/access_rules/rules`, {
      method: 'POST', headers: cabeceras(token),
      body: JSON.stringify({ mode: 'block', configuration: { target: p.target_kind, value: p.target }, notes }),
    }, PLAZO_CF_MS);
  } catch (e) {
    return reconciliar(token, p, falloRed(e));
  }
  const j = leerJson(await r.text().catch(() => ''));
  const id = str(obj(j.result).id);
  if (r.ok && j.success === true && id && ID_REGLA.test(id)) return { tipo: 'creada', id, existia: false, adoptada: false };
  if (!r.ok && esDuplicado(j)) return (await buscarExistente(token, p)) ?? { tipo: 'modo', mode: null };
  const fallo: FalloCf = { tipo: 'error', status: r.status, caido: r.ok || caidoHttp(r.status) };
  return fallo.caido ? reconciliar(token, p, fallo) : fallo;
}

// DELETE de una access rule de la zona: devuelve el status (lanza ProviderError si no hay respuesta).
async function borrarRegla(token: string, zone: string, ref: string): Promise<number> {
  const r = await pedir(`${CF_API}/zones/${zone}/firewall/access_rules/rules/${encodeURIComponent(ref)}`,
    { method: 'DELETE', headers: cabeceras(token) }, PLAZO_CF_MS);
  await r.body?.cancel();
  return r.status;
}

const mensajeRechazo = (status: number | null) => (status === 403 ? ERROR_SIN_PERMISO : status === 401 ? ERROR_TOKEN
  : `Cloudflare rechazó el bloqueo (código ${status ?? 'desconocido'})`);

/** S15 15.10 · executeBlock(approval): (1) idempotencia por approval_id o por una executed vigente o proposed reciente
 *  del mismo incident_id y target (otra aprobación del mismo group), marcando usadas las hermanas; (2) actions proposed;
 *  (3) POST de la access rule con el token de params.connection_id (duplicado → la regla block existente; otro modo →
 *  rechazo; sin respuesta → reconciliación por la lista); (4) executed con provider_ref, previous {connection_id,
 *  zone_id, existed} y expires_at = +ttl_s, e incidente mitigated; (5) 4xx → failed y ok:false; red/5xx → failed y 502.
 *  Lanza ApiError internal solo si la base falla. */
export async function executeBlock(env: CloudflareBindings, approval: AprobacionCanjeada,
  o: { rid: string; ahora?: number }): Promise<ResultadoBloqueo> {
  const p = leerParams(approval.params);
  if (approval.action_kind !== 'block_ip' || !p || !UUID.test(approval.org_id)) return { tipo: 'invalido' };
  const admin = db(env);
  const org = approval.org_id;
  const ahora = o.ahora ?? Date.now();
  const enIso = new Date(ahora).toISOString();
  const incidentId = uuid(approval.incident_id) ?? p.incident_id;
  const registro = { rid: o.rid, incidente: p.incident_code };

  // (1) Pocas filas por IP y org: una lectura y el filtro en memoria. Una proposed reciente del mismo incidente es la
  // aprobación hermana canjeada a la vez (código de la app y botón ok): en curso, sin segundo POST.
  const previas = await admin.from('actions').select(COLUMNAS_ACCION).eq('org_id', org).eq('target', p.target)
    .order('created_at', { ascending: false }).limit(20);
  if (previas.error) interno(o.rid, 'bloqueo.lectura_error', previas.error.code);
  const filas = ((previas.data ?? []) as Obj[]);
  const hit = filas.find((f) => f.approval_id === approval.id)
    ?? filas.find((f) => incidentId !== null && f.incident_id === incidentId && (
      (f.status === 'executed' && Date.parse(str(f.expires_at) ?? '') > ahora)
      || (f.status === 'proposed' && Date.parse(str(f.created_at) ?? '') > ahora - EN_CURSO_MS)));
  if (hit) {
    await marcarHermanas(admin, org, p.group, enIso, o.rid);
    log('info', 'bloqueo.repetido', { ...registro, action_id: hit.id, status: hit.status });
    return desdeFila(hit);
  }

  // (2) proposed. 23505 = otra ejecución de esta misma aprobación ganó la carrera: se devuelve la suya.
  const requested_by = p.requested_by ?? (approval.channel === 'in_app' ? uuid(approval.recipient) : null);
  const ins = await admin.from('actions').insert({ org_id: org, incident_id: incidentId, approval_id: approval.id,
    kind: 'block_ip', target: p.target, status: 'proposed', requested_by }).select('id').single();
  if (ins.error?.code === '23505') {
    const otra = await admin.from('actions').select(COLUMNAS_ACCION).eq('org_id', org).eq('approval_id', approval.id).maybeSingle();
    if (otra.error || !otra.data) interno(o.rid, 'bloqueo.carrera_error', otra.error?.code);
    return desdeFila(otra.data as Obj);
  }
  const actionId = str(obj(ins.data).id);
  if (ins.error || !actionId) return interno(o.rid, 'bloqueo.insert_error', ins.error?.code);
  // Antes de Cloudflare: así la otra vía del group (código o botón) ya no puede canjear.
  await marcarHermanas(admin, org, p.group, enIso, o.rid);

  // (3) Cloudflare.
  const expira = new Date(ahora + p.ttl_s * 1000);
  const conexion = { orgId: org, connectionId: p.connection_id, provider: 'cloudflare', kind: 'action' } as const;
  let cf: Creada | OtroModo | FalloCf;
  try {
    cf = await withSecret(env, admin, conexion, (token) => crearRegla(token, p, notasBloqueo(p.incident_code, p.regla, expira)));
  } catch (e) {
    cf = e instanceof ProviderError ? falloRed(e) : { tipo: 'error', status: null, caido: false };   // sin credencial o sobre ilegible
    if (!(e instanceof ProviderError)) log('warn', 'bloqueo.credencial_error', { ...registro, name: e instanceof Error ? e.name : typeof e });
  }

  if (cf.tipo !== 'creada') {
    // (5) failed + approvals.result {error:'cf_<status>' | 'cf_modo'}; la aprobación queda usada (se vuelve a proponer).
    const codigo = cf.tipo === 'modo' ? 'cf_modo' : `cf_${cf.status ?? (cf.caido ? 'red' : 'credencial')}`;
    const [a, b] = await Promise.all([
      admin.from('actions').update({ status: 'failed' }).eq('id', actionId).eq('org_id', org),
      admin.from('approvals').update({ result: { error: codigo } }).eq('id', approval.id).eq('org_id', org),
    ]);
    if (a.error || b.error) log('error', 'bloqueo.fallo_sin_registro', { ...registro, code: a.error?.code ?? b.error?.code ?? null });
    log('warn', 'bloqueo.fallido', { ...registro, action_id: actionId, codigo });
    if (cf.tipo === 'modo') return { tipo: 'rechazado', action_id: actionId, status: null, error: cf.mode ? errorModo(cf.mode) : ERROR_SIN_REGLA };
    if (cf.caido) return { tipo: 'caido', action_id: actionId, status: cf.status };
    return { tipo: 'rechazado', action_id: actionId, status: cf.status, error: cf.status === null ? ERROR_CREDENCIAL : mensajeRechazo(cf.status) };
  }

  // (4) Regla adoptada (marca VanGUARD de otra fila: caducada y aún sin retirar, o una carrera): pasa a esta fila y la
  // otra queda undone, así su caducidad o su «Deshacer» no quitan este bloqueo. Esta fila aún es proposed: no se toca.
  if (cf.adoptada && cf.id) {
    const { error } = await admin.from('actions').update({ status: 'undone', undone_at: enIso })
      .eq('org_id', org).eq('provider_ref', cf.id).eq('status', 'executed');
    if (error) log('warn', 'bloqueo.traspaso_error', { ...registro, code: error.code ?? null });
  }
  const up = await admin.from('actions').update({ status: 'executed', provider_ref: cf.id,
    previous: { connection_id: p.connection_id, zone_id: p.zone_id, existed: cf.existia }, expires_at: expira.toISOString() })
    .eq('id', actionId).eq('org_id', org);
  if (up.error) {
    // Sin fila executed nadie retiraría la regla: si la creó esta llamada, se borra antes de responder 500.
    if (cf.id && !cf.existia && !cf.adoptada) await retirarHuerfana(env, admin, conexion, p.zone_id, cf.id, o.rid);
    interno(o.rid, 'bloqueo.executed_error', up.error.code);
  }
  if (incidentId) {
    const inc = await admin.from('incidents').update({ status: 'mitigated', mitigated_at: enIso })
      .eq('id', incidentId).eq('org_id', org).in('status', ['open', 'ack']);
    if (inc.error) log('warn', 'bloqueo.incidente_error', { ...registro, code: inc.error.code ?? null });
  }
  log('info', 'bloqueo.ejecutado', { ...registro, action_id: actionId, existia: cf.existia, canal: approval.channel });
  return { tipo: 'ejecutado', action_id: actionId, en: enIso, resultado: cf.existia ? RESULTADO_EXISTIA : RESULTADO_OK,
    existia: cf.existia, repetido: false };
}

// Las demás aprobaciones vivas del group (código de la app, ok/no de WhatsApp) quedan usadas: un solo bloqueo por propuesta.
async function marcarHermanas(admin: ReturnType<typeof db>, org: string, group: string | null, enIso: string, rid: string) {
  if (!group) return;
  const { error } = await admin.from('approvals').update({ used_at: enIso })
    .eq('org_id', org).eq('params->>group', group).gt('expires_at', enIso);
  if (error) log('warn', 'bloqueo.hermanas_error', { rid, code: error.code ?? null });
}

// El UPDATE a executed falló tras crear la regla: se intenta borrarla (lo que pase queda en el log, sin la IP).
async function retirarHuerfana(env: CloudflareBindings, admin: ReturnType<typeof db>,
  conexion: { orgId: string; connectionId: string; provider: 'cloudflare'; kind: 'action' }, zone: string, ref: string, rid: string) {
  try {
    const status = await withSecret(env, admin, conexion, (token) => borrarRegla(token, zone, ref));
    log(delStatus(status) === 'deshecho' ? 'warn' : 'error', 'bloqueo.huerfana', { rid, status });
  } catch (e) {
    log('error', 'bloqueo.huerfana', { rid, status: null, name: e instanceof Error ? e.name : typeof e });
  }
}

// ── Deshacer (E22, E10 y caducidad en housekeeping) ─────────────────────────────────────────────────────────────────
export type AccionBloqueo = { id: string; org_id: string; provider_ref?: string | null; previous?: unknown };
/** deshecho = la regla ya no está (DELETE 2xx o 404, o previous.existed). Los permanentes no se arreglan reintentando;
 *  caido (red, plazo, 408, 429, 5xx, material de claves sin leer) sí. */
export type ResultadoDeshacer = 'deshecho' | 'sin_permiso' | 'token_invalido' | 'rechazado' | 'sin_credencial' | 'caido' | 'invalido';
export const PERMANENTES: ReadonlySet<ResultadoDeshacer> = new Set(['sin_permiso', 'token_invalido', 'rechazado', 'sin_credencial', 'invalido']);
export const MENSAJE_DESHACER: Record<Exclude<ResultadoDeshacer, 'deshecho'>, string> = {
  sin_permiso: ERROR_SIN_PERMISO,
  token_invalido: ERROR_TOKEN,
  rechazado: 'Cloudflare no dejó retirar la regla: quítala a mano en Cloudflare',
  sin_credencial: 'La conexión de acciones ya no tiene credencial: quita la regla a mano en Cloudflare',
  caido: 'Cloudflare no respondió. Vuelve a intentarlo.',
  invalido: 'No sabemos qué regla quitar: hazlo a mano en Cloudflare',
};

// 2xx o 404 = ya no está; 401/403 = el token; 408, 429 y 5xx = pasajero; otro 4xx (p. ej. 400 de una zona borrada) = rechazado.
const delStatus = (s: number): ResultadoDeshacer => ((s >= 200 && s < 300) || s === 404 ? 'deshecho'
  : s === 403 ? 'sin_permiso' : s === 401 ? 'token_invalido' : caidoHttp(s) ? 'caido' : 'rechazado');

/** DELETE /zones/{previous.zone_id}/firewall/access_rules/rules/{provider_ref} con el token de previous.connection_id
 *  (un sobre por conexión), 404 = ya no estaba, previous.existed = no se toca Cloudflare. Las deshechas pasan a undone
 *  en UNA escritura (executed o failed: E22 reintenta las que la caducidad no pudo retirar) y, si hubo DELETE, otra
 *  escritura pasa a undone cualquier otra executed con ese provider_ref (ya no bloquea nada). Subpeticiones ≈ 2 por
 *  conexión + 1 por regla + 2. Lanza ApiError internal si la base falla. */
export async function deshacerBloqueos(env: CloudflareBindings, acciones: readonly AccionBloqueo[],
  o: { rid: string; ahora?: number }): Promise<{ resultados: Map<string, ResultadoDeshacer>; subpeticiones: number }> {
  const resultados = new Map<string, ResultadoDeshacer>();
  let subpeticiones = 0;
  const grupos = new Map<string, { org: string; conn: string; xs: { id: string; zone: string; ref: string }[] }>();
  for (const a of acciones) {
    const prev = obj(a.previous);
    const conn = uuid(prev.connection_id), zone = str(prev.zone_id), ref = str(a.provider_ref);
    // previous.scope = fila de bajo ataque (modo-bajo-ataque.md D10): su regla no es una access rule; un DELETE aquí daría
    // 404, la daría por deshecha y la regla seguiría en Cloudflare. Sin tocar nada: la retira deshacerBajoAtaque.
    if (prev.scope !== undefined) { resultados.set(a.id, 'invalido'); continue; }
    if (prev.existed === true) { resultados.set(a.id, 'deshecho'); continue; }
    if (!UUID.test(a.org_id) || !conn || !zone || !ZONA.test(zone) || !ref || !ID_REGLA.test(ref)) { resultados.set(a.id, 'invalido'); continue; }
    const k = `${a.org_id}|${conn}`;
    const g = grupos.get(k) ?? { org: a.org_id, conn, xs: [] };
    g.xs.push({ id: a.id, zone, ref });
    grupos.set(k, g);
  }
  const admin = db(env);
  const borradas = new Set<string>();          // provider_ref que ya no están en Cloudflare tras un DELETE
  for (const g of grupos.values()) {
    subpeticiones += 2;
    try {
      await withSecret(env, admin, { orgId: g.org, connectionId: g.conn, provider: 'cloudflare', kind: 'action' }, async (token) => {
        for (const x of g.xs) {
          subpeticiones++;
          try {
            const r = delStatus(await borrarRegla(token, x.zone, x.ref));
            resultados.set(x.id, r);
            if (r === 'deshecho') borradas.add(x.ref);
          } catch {
            resultados.set(x.id, 'caido');
          }
        }
      });
    } catch (e) {
      // Sin credencial o sobre ilegible no se arreglan reintentando; el material de claves (vg_crypto_material) sí vuelve.
      const r: ResultadoDeshacer = e instanceof Error && !(e instanceof ApiError) && e.message === 'CRYPTO_MATERIAL_UNAVAILABLE'
        ? 'caido' : 'sin_credencial';
      for (const x of g.xs) if (!resultados.has(x.id)) resultados.set(x.id, r);
    }
  }
  const hechos = acciones.filter((a) => resultados.get(a.id) === 'deshecho');
  if (hechos.length) {
    const t = new Date(o.ahora ?? Date.now()).toISOString();
    const orgs = [...new Set(hechos.map((a) => a.org_id))];
    const refs = [...borradas];
    subpeticiones += refs.length ? 2 : 1;
    const [a, b] = await Promise.all([
      admin.from('actions').update({ status: 'undone', undone_at: t }).in('id', hechos.map((x) => x.id)).in('org_id', orgs)
        .in('status', ['executed', 'failed']),
      refs.length ? admin.from('actions').update({ status: 'undone', undone_at: t }).in('provider_ref', refs).in('org_id', orgs)
        .eq('status', 'executed') : null,
    ]);
    if (a.error) interno(o.rid, 'bloqueo.undone_error', a.error.code);
    if (b?.error) log('warn', 'bloqueo.undone_ref_error', { rid: o.rid, code: b.error.code ?? null });
  }
  for (const [id, r] of resultados) if (r !== 'deshecho') log('warn', 'bloqueo.deshacer_fallido', { rid: o.rid, action_id: id, resultado: r });
  return { resultados, subpeticiones };
}
