import { UnderAttackOffer, UnderAttackProposal, type UnderAttackMotivo } from '@vanguard/contracts';
import {
  CADUCIDAD_EN_REGLA, CUPO_REGLAS_CONFIG, hostCanonico, notasBajoAtaque, ofreceBajoAtaque, otpHashParam,
  pasosManualesBajoAtaque, pasosRetirarBajoAtaque, refBajoAtaque, reglaBajoAtaque, simularBajoAtaque, sixDigitCode,
  textoCodigoBajoAtaque, TTL_BAJO_ATAQUE_S, type ReglaBajoAtaque,
} from '@vanguard/core';
import { withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { pedir, ProviderError } from '../lib/http.ts';
import { activeKid, getKeys } from '../lib/keyring.ts';
import { log } from '../lib/log.ts';
import { ventanaAbierta } from '../lib/verificacion.ts';
import { cuerpoTexto, enmascararTelefono, enviarKapso, KapsoError, kapsoConfigurado } from '../notify/kapso.ts';
import { elegirConexion, VIDA_BOTON_MS, type IncidenteBloqueo, type SinEntrega } from './approvals.ts';
import {
  CF_API, EN_CURSO_MS, MENSAJE_DESHACER, PLAZO_CF_MS, type AprobacionCanjeada, type ResultadoDeshacer,
} from './block-ip.ts';
import { cabecerasCf, mutarEnSeco } from './cf-seco.ts';

// «Modo bajo ataque» de Cloudflare (asignaciones/modo-bajo-ataque.md §5 y §8): una Configuration Rule (set_config,
// security_level under_attack) SOLO para el host del incidente, con la caducidad dentro de su expresión. Aquí están las
// lecturas de E55 (oferta, solo base), la propuesta de E56 (guardas, dry_run por mutarEnSeco y aprobación de 10 min),
// executeUnderAttack (tras el canje de E21; el «Sí, activar» del botón de WhatsApp lo llamará igual que ok llama a
// executeBlock), deshacerBajoAtaque (E22, E10 y caducidad de housekeeping) y la limpieza de una proposed huérfana.
// En Cloudflare solo se hace POST de UNA regla (o del ruleset de la fase si no existe) y DELETE por id de la nuestra;
// nunca PUT del entrypoint, que reemplazaría las reglas del cliente (D9). Anti-IDOR: todo por id Y org_id. Ni el token,
// ni el cuerpo de Cloudflare, ni el código de 6 dígitos van a los logs.

type Obj = Record<string, unknown>;
type Cliente = ReturnType<typeof db>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZONA_ID = /^[a-f0-9]{32}$/;
const ID_CF = /^[A-Za-z0-9]{1,64}$/;            // id de ruleset o de regla de Cloudflare (32 hex hoy)
const REF = /^vg_ua_[0-9a-f]{32}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const uuid = (x: unknown) => { const s = str(x); return s && UUID.test(s) ? s : null; };
const caidoHttp = (s: number) => s === 408 || s === 429 || s >= 500;
const minutos = (ttl_s: number) => Math.max(1, Math.round(ttl_s / 60));

export const FASE_CONFIG = 'http_config_settings';
/** La zona del producto (también la de la víctima): nunca se pone bajo ataque, aunque falte APP_ORIGIN. */
export const ZONA_PRODUCTO = 'officialvanguard.com';
/** E55 enseña una retirada fallida (failed con previous.deshacer_error) de las últimas 24 h. */
export const VENTANA_RETIRADA_FALLIDA_MS = 24 * 3600_000;
export const ERROR_SIN_PERMISO_CONFIG = 'Te falta el permiso Zone · Config Rules · Edit en el token de Modo blindaje';
const ERROR_TOKEN = 'El token de acciones ya no es válido. Vuelve a conectarlo.';
const ERROR_CREDENCIAL = 'No pudimos abrir el token de acciones. Vuelve a conectarlo.';
/** Entrega del código de E56 por WhatsApp de TEXTO con enviarKapso + cuerpoTexto, ya existentes (la misma regla que el
 *  respaldo de E20, D6). false: sin WhatsApp, solo la org de demo recibe el código en la respuesta. Los botones del modo
 *  bajo ataque y el 2.º aviso son otro trabajo (avisos-whatsapp-botones.md, pendiente de Giovanni). */
export const CODIGO_POR_WHATSAPP = true;
const NO_RESUELTOS = ['open', 'ack', 'mitigated'];
const COLUMNAS_FILA = 'id, approval_id, target, status, provider_ref, previous, created_at, expires_at';

/** host_protegido y zona_del_producto: el host de APP_ORIGIN y su www., más officialvanguard.com por si APP_ORIGIN falta
 *  o es local (defensa en profundidad: la víctima comparte zona con VanGUARD). */
export function hostsProtegidos(env: Pick<CloudflareBindings, 'APP_ORIGIN'>): { protegidos: string[]; zonaProducto: string } {
  let h: string | null = null;
  try { h = env.APP_ORIGIN ? hostCanonico(new URL(env.APP_ORIGIN).hostname) : null; } catch { h = null; }
  const base = [...new Set([ZONA_PRODUCTO, ...(h ? [h] : [])])];
  return { protegidos: base.flatMap((x) => [x, `www.${x}`]), zonaProducto: h ?? ZONA_PRODUCTO };
}

// ── params de la aprobación (§4.2) ───────────────────────────────────────────────────────────────────────────────────
/** params de una aprobación under_attack_on (E56): {scope, target, zone_id, zone_name, connection_id, incident_id,
 *  incident_code, ttl_s, group, kid, requested_by, ref, ruleset_id} + plan (cupo de reglas, para no pasarse al confirmar). */
export type ParamsBajoAtaque = {
  scope: 'host'; target: string; zone_id: string; zone_name: string | null; connection_id: string; incident_id: string | null;
  incident_code: string | null; ttl_s: number; group: string | null; requested_by: string | null; ref: string;
  ruleset_id: string | null; plan: string | null;
};

export function leerParamsBajoAtaque(x: unknown): ParamsBajoAtaque | null {
  const p = obj(x);
  const target = hostCanonico(p.target), connection_id = uuid(p.connection_id), zone_id = str(p.zone_id), ref = str(p.ref);
  if (p.scope !== 'host' || !target || !connection_id || !zone_id || !ZONA_ID.test(zone_id) || !ref || !REF.test(ref)) return null;
  const ttl = typeof p.ttl_s === 'number' && Number.isInteger(p.ttl_s) ? Math.min(Math.max(p.ttl_s, 300), 3600) : TTL_BAJO_ATAQUE_S;
  const code = str(p.incident_code), rs = str(p.ruleset_id), plan = str(p.plan);
  return { scope: 'host', target, zone_id, zone_name: hostCanonico(p.zone_name), connection_id, incident_id: uuid(p.incident_id),
    incident_code: code && /^[A-Z0-9]{6}$/.test(code) ? code : null, ttl_s: ttl, group: uuid(p.group),
    requested_by: uuid(p.requested_by), ref, ruleset_id: rs && ID_CF.test(rs) ? rs : null,
    plan: plan && /^[a-z]{2,20}$/.test(plan) ? plan : null };
}

// ── Cloudflare: entrypoint de la fase y una regla ───────────────────────────────────────────────────────────────────
type Entrypoint = { tipo: 'ok'; id: string; reglas: Obj[] } | { tipo: 'no_existe' } | FalloCf;
type FalloCf = { tipo: 'fallo'; status: number | null; caido: boolean; codigo: number | null };
type Creada = { tipo: 'creada'; rulesetId: string; reglaId: string; creoRuleset: boolean };
type SinCupo = { tipo: 'sin_cupo'; cupo: number };

const leerJson = (t: string): Obj => { try { return obj(JSON.parse(t)); } catch { return {}; } };
const codigoCf = (j: Obj) => {
  const c = obj((Array.isArray(j.errors) ? j.errors : [])[0]).code;
  return typeof c === 'number' ? c : null;
};
const falloRed = (e: unknown): FalloCf => ({ tipo: 'fallo', status: e instanceof ProviderError ? e.status ?? null : null, caido: true,
  codigo: null });
const idDeRef = (reglas: unknown, ref: string) => {
  const r = (Array.isArray(reglas) ? reglas : []).map(obj).find((x) => x.ref === ref);
  return typeof r?.id === 'string' && ID_CF.test(r.id) ? r.id : null;
};

/** GET del entrypoint de http_config_settings: 404 = la fase no tiene ruleset (§1.3). 1 subpetición. */
async function leerEntrypoint(token: string, zone: string): Promise<Entrypoint> {
  let r: Response;
  try {
    r = await pedir(`${CF_API}/zones/${zone}/rulesets/phases/${FASE_CONFIG}/entrypoint`,
      { method: 'GET', headers: cabecerasCf(token) }, PLAZO_CF_MS);
  } catch (e) {
    return falloRed(e);
  }
  if (r.status === 404) { await r.body?.cancel(); return { tipo: 'no_existe' }; }
  const j = leerJson(await r.text().catch(() => ''));
  const res = obj(j.result);
  if (r.ok && typeof res.id === 'string' && ID_CF.test(res.id)) {
    return { tipo: 'ok', id: res.id, reglas: (Array.isArray(res.rules) ? res.rules : []).map(obj) };
  }
  return { tipo: 'fallo', status: r.status, caido: r.ok || caidoHttp(r.status), codigo: codigoCf(j) };
}

// POST real (sin dry_run): la respuesta trae el ruleset completo, cada regla con su id (§1.3).
async function postCf(token: string, ruta: string, cuerpo: unknown): Promise<{ tipo: 'ok'; result: Obj } | FalloCf> {
  let r: Response;
  try {
    r = await pedir(`${CF_API}${ruta}`, { method: 'POST', headers: cabecerasCf(token), body: JSON.stringify(cuerpo) }, PLAZO_CF_MS);
  } catch (e) {
    return falloRed(e);
  }
  const j = leerJson(await r.text().catch(() => ''));
  if (r.ok && j.result && typeof j.result === 'object') return { tipo: 'ok', result: obj(j.result) };
  return { tipo: 'fallo', status: r.status, caido: r.ok || caidoHttp(r.status), codigo: codigoCf(j) };
}

async function borrarReglaCf(token: string, zone: string, rulesetId: string, reglaId: string): Promise<number> {
  const r = await pedir(`${CF_API}/zones/${zone}/rulesets/${encodeURIComponent(rulesetId)}/rules/${encodeURIComponent(reglaId)}`,
    { method: 'DELETE', headers: cabecerasCf(token) }, PLAZO_CF_MS);
  await r.body?.cancel();
  return r.status;
}

const cupoDe = (plan: string | null) => (plan ? CUPO_REGLAS_CONFIG[plan] ?? null : null);
const cuerpoRuleset = (regla: ReglaBajoAtaque) => ({ name: 'default', kind: 'zone', phase: FASE_CONFIG, rules: [regla] });

// Sin respuesta clara al POST (red, plazo, 429, 5xx): Cloudflare pudo crearla igual. Si el entrypoint ya trae nuestro
// ref, cuenta como creada y no queda una regla sin fila que la deshaga.
async function reconciliar(token: string, p: ParamsBajoAtaque, fallo: FalloCf, creo: boolean): Promise<Creada | FalloCf> {
  const ep = await leerEntrypoint(token, p.zone_id);
  const id = ep.tipo === 'ok' ? idDeRef(ep.reglas, p.ref) : null;
  return ep.tipo === 'ok' && id ? { tipo: 'creada', rulesetId: ep.id, reglaId: id, creoRuleset: creo } : fallo;
}

async function anadirRegla(token: string, p: ParamsBajoAtaque, rulesetId: string, regla: ReglaBajoAtaque): Promise<Creada | FalloCf> {
  const r = await postCf(token, `/zones/${p.zone_id}/rulesets/${encodeURIComponent(rulesetId)}/rules`, regla);
  const id = r.tipo === 'ok' ? idDeRef(r.result.rules, p.ref) : null;
  if (id) return { tipo: 'creada', rulesetId, reglaId: id, creoRuleset: false };
  const fallo: FalloCf = r.tipo === 'fallo' ? r : { tipo: 'fallo', status: null, caido: true, codigo: null };   // 2xx ilegible
  return fallo.caido ? reconciliar(token, p, fallo, false) : fallo;
}

/** (5) de executeUnderAttack: GET del entrypoint (nuestro ref ya puesto → se adopta; reglas ≥ cupo del plan → sin_cupo);
 *  200 → POST de la regla al final del ruleset; 404 → POST del ruleset de la fase con la regla (un 4xx = otro lo creó a
 *  la vez: se relee y se añade); sin respuesta → reconciliación por el ref. ≤ 5 subpeticiones. */
async function crearRegla(token: string, p: ParamsBajoAtaque, regla: ReglaBajoAtaque): Promise<Creada | FalloCf | SinCupo> {
  const conRuleset = async (ep: Extract<Entrypoint, { tipo: 'ok' }>): Promise<Creada | FalloCf | SinCupo> => {
    const mia = idDeRef(ep.reglas, p.ref);
    if (mia) return { tipo: 'creada', rulesetId: ep.id, reglaId: mia, creoRuleset: false };
    const cupo = cupoDe(p.plan);
    if (cupo !== null && ep.reglas.length >= cupo) return { tipo: 'sin_cupo', cupo };
    return anadirRegla(token, p, ep.id, regla);
  };
  const ep = await leerEntrypoint(token, p.zone_id);
  if (ep.tipo === 'fallo') return ep;
  if (ep.tipo === 'ok') return conRuleset(ep);
  const c = await postCf(token, `/zones/${p.zone_id}/rulesets`, cuerpoRuleset(regla));
  if (c.tipo === 'ok') {
    const rs = str(c.result.id), id = idDeRef(c.result.rules, p.ref);
    if (rs && ID_CF.test(rs) && id) return { tipo: 'creada', rulesetId: rs, reglaId: id, creoRuleset: true };
    return reconciliar(token, p, { tipo: 'fallo', status: null, caido: true, codigo: null }, true);
  }
  if (c.caido) return reconciliar(token, p, c, true);
  if (c.status === 401 || c.status === 403) return c;
  const otra = await leerEntrypoint(token, p.zone_id);
  return otra.tipo === 'ok' ? conRuleset(otra) : otra.tipo === 'fallo' ? otra : c;
}

// ── Lecturas compartidas de E55 y E56 ───────────────────────────────────────────────────────────────────────────────
type ConexionBajoAtaque = { id: string; zone_id: string; zone_name: string; plan: string | null; config_rules_edit: boolean | null };

function conexionDe(filas: unknown, pedida: string | undefined, host: string | null): ConexionBajoAtaque | null {
  const c = elegirConexion(filas, pedida, host);
  if (!c) return null;
  const f = (Array.isArray(filas) ? filas : []).map(obj).find((x) => x.id === c.id) ?? {};
  const caps = obj(f.capabilities), plan = str(obj(f.meta).plan);
  return { ...c, plan: plan ? plan.toLowerCase() : null,
    config_rules_edit: typeof caps.config_rules_edit === 'boolean' ? caps.config_rules_edit : null };
}

type Lectura = { conexiones: unknown; filas: Obj[]; ips: number; contacto: Obj; demo: boolean };

/** En paralelo: conexiones Cloudflare action activas; las 3 filas under_attack_on más recientes de ese host (proposed,
 *  executed o failed); el conteo de CF_IP_FLOOD no resueltos de la org con el mismo details.host (tal cual); y, para
 *  E56, el contacto prioritario con WhatsApp y orgs.is_demo. Sin host solo se leen las conexiones. 0 llamadas a Cloudflare. */
async function leerHost(admin: Cliente, orgId: string, inc: IncidenteBloqueo, host: string | null, entrega: boolean,
  rid: string): Promise<Lectura> {
  const crudo = str(inc.details.host);
  const [cx, ac, n, ct, og] = await Promise.all([
    admin.from('connections').select('id, meta, capabilities').eq('org_id', orgId).eq('provider', 'cloudflare')
      .eq('kind', 'action').eq('status', 'active').order('created_at').limit(10),
    host ? admin.from('actions').select(COLUMNAS_FILA).eq('org_id', orgId).eq('kind', 'under_attack_on').eq('target', host)
      .in('status', ['proposed', 'executed', 'failed']).order('created_at', { ascending: false }).limit(3) : null,
    host && crudo ? admin.from('incidents').select('id', { count: 'exact', head: true }).eq('org_id', orgId)
      .in('status', NO_RESUELTOS).contains('rule_ids', ['CF_IP_FLOOD']).eq('details->>host', crudo) : null,
    entrega ? admin.from('contacts').select('phone_e164, verified_at, wa_last_inbound_at').eq('org_id', orgId).eq('whatsapp', true)
      .order('priority').limit(1).maybeSingle() : null,
    entrega ? admin.from('orgs').select('is_demo').eq('id', orgId).maybeSingle() : null,
  ]);
  const error = cx.error ?? ac?.error ?? n?.error ?? ct?.error ?? og?.error;
  if (error) {
    log('error', 'bajo_ataque.lectura_error', { rid, code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer el estado del modo bajo ataque');
  }
  return { conexiones: cx.data, filas: (Array.isArray(ac?.data) ? ac.data : []).map(obj),
    ips: Math.min(Math.max(n?.count ?? 0, 0), 1000), contacto: obj(ct?.data), demo: obj(og?.data).is_demo === true };
}

const fecha = (x: unknown): string | null => {
  const t = Date.parse(str(x) ?? '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** E55 · UnderAttackOffer (§5): solo lee la base (4 subpeticiones con host; 1 sin él). Orden del motivo, el mismo que
 *  los rechazos de E56: no_aplica · sin_host → en_curso (cualquier proposed de ese host) → cerrado · una_ip →
 *  sin_conexion → host_protegido · fuera_de_zona → sin_permiso (la sonda vio un 403) → null. activo: la executed de ese
 *  host (aunque haya vencido) o, si no, la última failed con previous.deshacer_error de las últimas 24 h. */
export async function leerOfertaBajoAtaque(env: CloudflareBindings, o: { orgId: string; incidente: IncidenteBloqueo; rid: string;
  ahora?: number }): Promise<UnderAttackOffer> {
  const ahora = o.ahora ?? Date.now();
  const host = hostCanonico(o.incidente.details.host);
  const l = await leerHost(db(env), o.orgId, o.incidente, host, false, o.rid);
  const base = ofreceBajoAtaque(o.incidente, l.ips);
  const conexion = conexionDe(l.conexiones, undefined, host);
  const { protegidos, zonaProducto } = hostsProtegidos(env);
  const enCurso = l.filas.find((f) => f.status === 'proposed');
  let motivo: UnderAttackMotivo | null = null;
  if (!base.ofrece && (base.motivo === 'no_aplica' || base.motivo === 'sin_host')) motivo = base.motivo;
  else if (enCurso) motivo = 'en_curso';
  else if (!base.ofrece) motivo = base.motivo;
  else if (!conexion) motivo = 'sin_conexion';
  else {
    const sim = simularBajoAtaque({ scope: 'host', host: base.host, zona: conexion.zone_name, protegidos, zonaProducto,
      plan: conexion.plan, reglasUsadas: null, ttl_s: TTL_BAJO_ATAQUE_S });
    if (!sim.ok) {
      motivo = sim.reason === 'host_protegido' ? 'host_protegido' : sim.reason === 'host_invalido' ? 'sin_host' : 'fuera_de_zona';
    }
    else if (conexion.config_rules_edit === false) motivo = 'sin_permiso';
  }

  const viva = l.filas.find((f) => f.status === 'executed');
  const fallida = viva ? undefined : l.filas.find((f) => f.status === 'failed' && str(obj(f.previous).deshacer_error)
    && Date.parse(str(f.created_at) ?? '') > ahora - VENTANA_RETIRADA_FALLIDA_MS);
  const fila = viva ?? fallida;
  const prev = obj(fila?.previous);
  const activo = fila && host ? { action_id: String(fila.id), scope: prev.scope === 'zone' ? 'zone' as const : 'host' as const,
    target: host, created_at: fecha(fila.created_at) ?? new Date(ahora).toISOString(), expires_at: fecha(fila.expires_at),
    retirada_fallida: !viva } : null;

  let copiar: string | null = null;
  if (activo?.retirada_fallida) {
    const caduco = prev.caduca_en_regla === true && activo.expires_at ? new Date(activo.expires_at) : null;
    copiar = pasosRetirarBajoAtaque(str(prev.descripcion) ?? '', hostCanonico(prev.zone_name) ?? conexion?.zone_name ?? null, caduco);
  } else if (host && (motivo === 'sin_conexion' || motivo === 'sin_permiso')) {
    copiar = pasosManualesBajoAtaque(host, conexion?.zone_name ?? null);
  }
  const permiso = !conexion ? null : conexion.config_rules_edit === true ? 'ok' : conexion.config_rules_edit === false ? 'falta'
    : 'sin_probar';
  return UnderAttackOffer.parse({ ofrece: base.ofrece, motivo, hostname: host, zone_name: conexion?.zone_name ?? null,
    connection_id: conexion?.id ?? null, ips: host ? l.ips : 0, scopes: motivo === null ? ['host'] : [], permiso,
    ttl_s: TTL_BAJO_ATAQUE_S, activo, copiar });
}

// ── E56 · propuesta (guardas + dry_run + aprobación de 10 min) ───────────────────────────────────────────────────────
/** details.reason de cada rechazo de E56 (tabla de §5): 422 los de la regla, el host, el alcance, el cupo y el dry_run;
 *  409 resolved, no_action_connection, sin_permiso, token_invalido, sin_credencial, already_active e in_progress;
 *  escrita (el dry_run devolvió un ruleset, ya borrado) → 500. */
export type MotivoPropuestaBajoAtaque = 'no_aplica' | 'una_ip' | 'sin_host' | 'host_protegido' | 'fuera_de_zona'
  | 'zona_del_producto' | 'alcance_no_disponible' | 'sin_cupo' | 'rechazada_por_cloudflare' | 'resolved' | 'no_action_connection'
  | 'sin_permiso' | 'token_invalido' | 'sin_credencial' | 'already_active' | 'in_progress' | 'escrita';
export type ResultadoPropuestaBajoAtaque =
  | { ok: true; respuesta: UnderAttackProposal; recipient_masked: string | null }
  | { ok: false; motivo: MotivoPropuestaBajoAtaque; host: string | null; zona: string | null; cupo?: number;
      codigo?: number | null; action_id?: string; copiar?: string }
  | { ok: false; motivo: 'sin_entrega'; detalle: SinEntrega };
export type OpcionesBajoAtaque = {
  orgId: string; incidente: IncidenteBloqueo; scope: 'host' | 'zone'; connectionId?: string | undefined; requestedBy: string;
  rid: string; ahora?: number;
};

type Validacion = { tipo: 'ok'; validado: boolean; rulesetId: string | null }
  | { tipo: 'rechazo'; motivo: MotivoPropuestaBajoAtaque; cupo?: number; codigo?: number | null };

/** (5) de E56 con el token de acciones: GET del entrypoint (cupo) y la MISMA regla que mandará E21 por mutarEnSeco
 *  (dry_run=true; nunca publica). Sin respuesta → validado:false («se comprobará al confirmar»). */
async function validarEnSeco(env: CloudflareBindings, admin: Cliente, o: OpcionesBajoAtaque, conexion: ConexionBajoAtaque,
  regla: ReglaBajoAtaque, reglasUsadas: (n: number) => number | null): Promise<Validacion> {
  const ctx = { orgId: o.orgId, connectionId: conexion.id, provider: 'cloudflare', kind: 'action' } as const;
  try {
    return await withSecret(env, admin, ctx, async (token): Promise<Validacion> => {
      const ep = await leerEntrypoint(token, conexion.zone_id);
      if (ep.tipo === 'fallo') {
        if (ep.status === 403) return { tipo: 'rechazo', motivo: 'sin_permiso' };
        if (ep.status === 401) return { tipo: 'rechazo', motivo: 'token_invalido' };
        if (ep.caido) return { tipo: 'ok', validado: false, rulesetId: null };
        return { tipo: 'rechazo', motivo: 'rechazada_por_cloudflare', codigo: ep.codigo ?? ep.status };
      }
      if (ep.tipo === 'ok') {
        const cupo = reglasUsadas(ep.reglas.length);
        if (cupo !== null) return { tipo: 'rechazo', motivo: 'sin_cupo', cupo };
      }
      const seco = ep.tipo === 'ok'
        ? await mutarEnSeco(token, conexion.zone_id, `/rulesets/${ep.id}/rules`, regla, regla.ref)
        : await mutarEnSeco(token, conexion.zone_id, '/rulesets', cuerpoRuleset(regla), regla.ref);
      const rulesetId = ep.tipo === 'ok' ? ep.id : null;
      if (seco.tipo === 'valida') return { tipo: 'ok', validado: true, rulesetId };
      if (seco.tipo === 'sin_respuesta') return { tipo: 'ok', validado: false, rulesetId };
      if (seco.tipo === 'sin_permiso') return { tipo: 'rechazo', motivo: 'sin_permiso' };
      if (seco.tipo === 'token_invalido') return { tipo: 'rechazo', motivo: 'token_invalido' };
      if (seco.tipo === 'rechazada') {
        return { tipo: 'rechazo', motivo: 'rechazada_por_cloudflare', codigo: seco.codigo ?? seco.status };
      }
      return { tipo: 'rechazo', motivo: 'escrita' };
    });
  } catch (e) {
    // Sin credencial o sobre ilegible: no se arregla reintentando. El material de claves (vg_crypto_material) sí vuelve.
    if (e instanceof Error && !(e instanceof ApiError) && e.message === 'CRYPTO_MATERIAL_UNAVAILABLE') {
      return { tipo: 'ok', validado: false, rulesetId: null };
    }
    log('warn', 'bajo_ataque.credencial_error', { rid: o.rid, name: e instanceof Error ? e.name : typeof e });
    return { tipo: 'rechazo', motivo: 'sin_credencial' };
  }
}

// TODO(WhatsApp, pendiente de Giovanni; docs/plan_maestro_trabajo/asignaciones/avisos-whatsapp-botones.md): el 2.º
// mensaje «Ataque desde {n} IPs en {host}…» con el botón uat («Modo bajo ataque») lo manda el despachador cuando
// ofreceBajoAtaque(incidente, ips) diga ofrece; uat → las mismas guardas y dry_run de proponerBajoAtaque con las filas
// ok/no (approvals.params = los de §4.2 + etapa, mismo group) en lugar de la in_app; ok → executeUnderAttack (canal
// whatsapp, requested_by de params) y responder con resultado y expires_at; no → hermanas usadas. Aquí no se toca nada.

/** E56 (§5). Reutilizable desde un botón de WhatsApp: la regla, las guardas y el dry_run no dependen del canal; aquí la
 *  entrega es la de la app (fila in_app con el HMAC del código y el código por WhatsApp de texto o, solo en la org de
 *  demo, en la respuesta). El botón «Modo bajo ataque» (avisos-whatsapp-botones.md, pendiente) creará en su lugar las
 *  filas ok/no del mismo group, y su «Sí, activar» llamará a executeUnderAttack. Nunca escribe en Cloudflare. Lanza
 *  ApiError internal si la base falla. ≈ 14–15 subpeticiones. */
export async function proponerBajoAtaque(env: CloudflareBindings, o: OpcionesBajoAtaque): Promise<ResultadoPropuestaBajoAtaque> {
  const admin = db(env);
  const ahora = o.ahora ?? Date.now();
  const host = hostCanonico(o.incidente.details.host);
  const no = (motivo: MotivoPropuestaBajoAtaque, extra: { zona?: string | null; cupo?: number; codigo?: number | null;
    action_id?: string; copiar?: string } = {}): ResultadoPropuestaBajoAtaque => ({ ok: false, motivo, host, zona: extra.zona ?? null,
    ...(extra.cupo !== undefined ? { cupo: extra.cupo } : {}), ...(extra.codigo !== undefined ? { codigo: extra.codigo } : {}),
    ...(extra.action_id ? { action_id: extra.action_id } : {}), ...(extra.copiar ? { copiar: extra.copiar } : {}) });

  // (1–3) La regla y lo que ya hay en ese host.
  const l = await leerHost(admin, o.orgId, o.incidente, host, true, o.rid);
  const base = ofreceBajoAtaque(o.incidente, l.ips);
  if (!base.ofrece && (base.motivo === 'no_aplica' || base.motivo === 'sin_host')) return no(base.motivo);
  const viva = l.filas.find((f) => f.status === 'executed');
  if (viva) return no('already_active', { action_id: String(viva.id) });
  if (l.filas.some((f) => f.status === 'proposed')) return no('in_progress');
  if (!base.ofrece) return no(base.motivo === 'cerrado' ? 'resolved' : base.motivo);

  // (4) Conexión y guardas puras (sin cupo todavía).
  const conexion = conexionDe(l.conexiones, o.connectionId, base.host);
  if (!conexion) return no('no_action_connection');
  const zona = conexion.zone_name;
  const { protegidos, zonaProducto } = hostsProtegidos(env);
  const sim = (reglasUsadas: number | null, scope: 'host' | 'zone' = 'host') => simularBajoAtaque({ scope, host: base.host, zona,
    protegidos, zonaProducto, plan: conexion.plan, reglasUsadas, ttl_s: TTL_BAJO_ATAQUE_S });
  if (o.scope === 'zone') {
    const z = sim(null, 'zone');
    return no(!z.ok && z.reason === 'zona_del_producto' ? 'zona_del_producto' : 'alcance_no_disponible', { zona });   // zone es P1
  }
  const previa = sim(null);
  if (!previa.ok) return no(previa.reason === 'host_invalido' ? 'sin_host' : previa.reason, { zona });

  // Entrega antes de tocar Cloudflare: fuera de la demo, sin WhatsApp no hay código fuera de banda (§06.7) → 502.
  const tel = str(l.contacto.phone_e164);
  const sinWa: SinEntrega | null = !CODIGO_POR_WHATSAPP ? 'sin_config' : !tel || !E164.test(tel) ? 'sin_contacto'
    : !str(l.contacto.verified_at) ? 'sin_verificar' : !ventanaAbierta(env, l.contacto.wa_last_inbound_at, ahora) ? 'ventana'
    : env.VG_ENV !== 'production' ? 'dry_run' : !kapsoConfigurado(env) ? 'sin_config' : null;
  if (sinWa && !l.demo) return { ok: false, motivo: 'sin_entrega', detalle: sinWa };

  // (5) dry_run con la MISMA regla que mandará E21 (hasta = ahora + vida de la aprobación + ttl; solo para validar).
  const approvalId = crypto.randomUUID();
  const ref = refBajoAtaque(approvalId);
  const hastaValidar = new Date(ahora + VIDA_BOTON_MS + TTL_BAJO_ATAQUE_S * 1000);
  const regla = reglaBajoAtaque(base.host, ref, notasBajoAtaque(o.incidente.code, approvalId, hastaValidar),
    CADUCIDAD_EN_REGLA ? hastaValidar : null);
  const v = await validarEnSeco(env, admin, o, conexion, regla, (n) => {
    const s = sim(n);
    return !s.ok && s.reason === 'sin_cupo' ? cupoDe(conexion.plan) : null;
  });
  if (v.tipo === 'rechazo') {
    if (v.motivo === 'escrita') log('error', 'bajo_ataque.propuesta_escrita', { rid: o.rid, incidente: o.incidente.code });
    return no(v.motivo, { zona, ...(v.cupo !== undefined ? { cupo: v.cupo } : {}),
      ...(v.codigo !== undefined ? { codigo: v.codigo } : {}),
      ...(v.motivo === 'sin_permiso' ? { copiar: pasosManualesBajoAtaque(base.host, zona) } : {}) });
  }

  // (6) Aprobación in_app (id = group = approval_id) y entrega del código.
  const code = sixDigitCode();
  const keys = await getKeys(env, admin, await activeKid(admin));
  const expires_at = new Date(ahora + VIDA_BOTON_MS).toISOString();
  const params = { scope: 'host', target: base.host, zone_id: conexion.zone_id, zone_name: zona, connection_id: conexion.id,
    incident_id: o.incidente.id, incident_code: o.incidente.code, ttl_s: TTL_BAJO_ATAQUE_S, group: approvalId, kid: keys.kid,
    requested_by: o.requestedBy, ref, ruleset_id: v.rulesetId, plan: conexion.plan };
  const { error } = await admin.from('approvals').insert({ id: approvalId, org_id: o.orgId, incident_id: o.incidente.id,
    action_kind: 'under_attack_on', channel: 'in_app', recipient: o.requestedBy, expires_at,
    nonce_hash: await otpHashParam(keys, approvalId, code), params });
  if (error) {
    log('error', 'bajo_ataque.aprobacion_error', { rid: o.rid, code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos guardar la aprobación');
  }
  const avisos = [...previa.avisos, v.validado ? 'Cloudflare validó la regla sin publicarla'
    : 'No pudimos validarla con Cloudflare: se comprobará al confirmar'];
  const respuesta = (delivery: 'whatsapp' | 'in_app', codigo: string | null) => UnderAttackProposal.parse({ approval_id: approvalId,
    efecto: previa.efecto, avisos, expires_at, delivery, code: codigo, scope: 'host', target: base.host, zone_name: zona,
    ttl_s: TTL_BAJO_ATAQUE_S, validado: v.validado });
  const registro = { rid: o.rid, incidente: o.incidente.code, validado: v.validado };

  if (!sinWa && tel) {
    let enviado = false;
    try {
      await enviarKapso(env, cuerpoTexto(tel, textoCodigoBajoAtaque(code, base.host)));
      enviado = true;
    } catch (e) {
      log('warn', 'bajo_ataque.envio_error', { rid: o.rid, code: e instanceof KapsoError ? e.detalle ?? e.code : 'unavailable' });
    }
    const recipient_masked = enmascararTelefono(tel);
    if (enviado) {
      log('info', 'bajo_ataque.propuesta', { ...registro, delivery: 'whatsapp', recipient_masked });
      return { ok: true, respuesta: respuesta('whatsapp', null), recipient_masked };
    }
    if (!l.demo) {
      const { error: eb } = await admin.from('approvals').delete().eq('id', approvalId).eq('org_id', o.orgId);
      if (eb) log('warn', 'bajo_ataque.borrado_error', { rid: o.rid, code: eb.code ?? null });
      return { ok: false, motivo: 'sin_entrega', detalle: 'kapso' };
    }
  }
  // Solo la org de demo: sin WhatsApp utilizable, el código viaja en la respuesta (como E20).
  log('info', 'bajo_ataque.propuesta', { ...registro, delivery: 'in_app', motivo: sinWa ?? 'kapso' });
  return { ok: true, respuesta: respuesta('in_app', code), recipient_masked: null };
}

// ── E21 · executeUnderAttack ─────────────────────────────────────────────────────────────────────────────────────────
export type ResultadoBajoAtaque =
  | { tipo: 'ejecutado'; action_id: string; en: string; resultado: string; repetido: boolean; expires_at: string | null }
  | { tipo: 'rechazado'; action_id: string | null; error: string; status: number | null }   // 4xx o cupo: 200 ok:false
  | { tipo: 'caido'; action_id: string | null; status: number | null }                     // red, plazo, 429 o 5xx: 502
  | { tipo: 'en_curso'; action_id: string }                                                // otra ejecución de ese host
  | { tipo: 'invalido' };                                                                   // params ilegibles: no se toca nada

function interno(rid: string, evento: string, code: string | null | undefined): never {
  log('error', evento, { rid, code: code ?? null });
  throw new ApiError('internal', 'No pudimos registrar el modo bajo ataque');
}

const textoActivo = (host: string, ttl_s: number) => `Modo bajo ataque activo ${minutos(ttl_s)} min en ${host}`;

// Una fila de actions ya existente → resultado sin tocar Cloudflare.
function desdeFila(f: Obj, host: string): ResultadoBajoAtaque {
  const id = String(f.id);
  const en = new Date(str(f.created_at) ?? Date.now()).toISOString();
  if (f.status === 'executed') {
    return { tipo: 'ejecutado', action_id: id, en, resultado: `El modo bajo ataque ya estaba activo en ${host}`, repetido: true,
      expires_at: fecha(f.expires_at) };
  }
  if (f.status === 'undone') {
    return { tipo: 'ejecutado', action_id: id, en, resultado: 'El modo bajo ataque ya se desactivó', repetido: true,
      expires_at: null };
  }
  if (f.status === 'proposed') return { tipo: 'en_curso', action_id: id };
  return { tipo: 'rechazado', action_id: id, error: 'Esa activación ya falló: vuelve a proponerla', status: null };
}

// Las demás aprobaciones vivas del group (hoy ninguna: group = approval_id; mañana, ok/no del botón) quedan usadas.
async function marcarHermanas(admin: Cliente, org: string, group: string | null, enIso: string, rid: string) {
  if (!group) return;
  const { error } = await admin.from('approvals').update({ used_at: enIso })
    .eq('org_id', org).eq('params->>group', group).gt('expires_at', enIso);
  if (error) log('warn', 'bajo_ataque.hermanas_error', { rid, code: error.code ?? null });
}

const mensajeRechazo = (cf: FalloCf | SinCupo) => (cf.tipo === 'sin_cupo' ? `Tu plan ya usa sus ${cf.cupo} reglas de configuración`
  : cf.status === 403 ? ERROR_SIN_PERMISO_CONFIG : cf.status === 401 ? ERROR_TOKEN : cf.status === null ? ERROR_CREDENCIAL
  : `Cloudflare no aceptó la regla (código ${cf.codigo ?? cf.status})`);

/** §8 · executeUnderAttack(approval): (1) idempotencia por approval_id; (2) actions proposed con previous {connection_id,
 *  zone_id, zone_name, scope, ref, descripcion, caduca_en_regla} (23505 = otro modo vivo de ese host o esta misma
 *  aprobación a la vez: se devuelve esa fila sin tocar Cloudflare, D7); (3) hermanas usadas; (4) la regla con
 *  expires_at = ahora + ttl_s DENTRO de la expresión (crearRegla); (5) executed con provider_ref = id de la regla y el
 *  previous completo, e incidente mitigated (si el UPDATE falla, se borra la regla antes del 500); (6) 4xx o cupo →
 *  failed y ok:false; red/5xx → failed y 502. Lanza ApiError internal solo si la base falla. */
export async function executeUnderAttack(env: CloudflareBindings, approval: AprobacionCanjeada,
  o: { rid: string; ahora?: number }): Promise<ResultadoBajoAtaque> {
  const p = leerParamsBajoAtaque(approval.params);
  if (approval.action_kind !== 'under_attack_on' || !p || !UUID.test(approval.org_id) || !UUID.test(approval.id)
    || p.ref !== refBajoAtaque(approval.id)) return { tipo: 'invalido' };
  const admin = db(env);
  const org = approval.org_id;
  const ahora = o.ahora ?? Date.now();
  const enIso = new Date(ahora).toISOString();
  const incidentId = uuid(approval.incident_id) ?? p.incident_id;
  const registro = { rid: o.rid, incidente: p.incident_code };

  // (1) Idempotencia por approval_id.
  const previa = await admin.from('actions').select(COLUMNAS_FILA).eq('org_id', org).eq('approval_id', approval.id).maybeSingle();
  if (previa.error) interno(o.rid, 'bajo_ataque.lectura_error', previa.error.code);
  if (previa.data) {
    await marcarHermanas(admin, org, p.group, enIso, o.rid);
    log('info', 'bajo_ataque.repetido', { ...registro, action_id: obj(previa.data).id, status: obj(previa.data).status });
    return desdeFila(obj(previa.data), p.target);
  }

  // (2) proposed: ya sabe deshacerse (D8). 23505 = el índice de 0017 (un modo vivo por host) o esta misma aprobación.
  const hasta = new Date(ahora + p.ttl_s * 1000);
  const descripcion = notasBajoAtaque(p.incident_code, approval.id, hasta);
  const previous = { connection_id: p.connection_id, zone_id: p.zone_id, zone_name: p.zone_name, scope: 'host', ref: p.ref,
    descripcion, caduca_en_regla: CADUCIDAD_EN_REGLA };
  const requested_by = p.requested_by ?? (approval.channel === 'in_app' ? uuid(approval.recipient) : null);
  const ins = await admin.from('actions').insert({ org_id: org, incident_id: incidentId, approval_id: approval.id,
    kind: 'under_attack_on', target: p.target, status: 'proposed', requested_by, expires_at: hasta.toISOString(), previous })
    .select('id').single();
  if (ins.error?.code === '23505') {
    const [a, b] = await Promise.all([
      admin.from('actions').select(COLUMNAS_FILA).eq('org_id', org).eq('approval_id', approval.id).maybeSingle(),
      admin.from('actions').select(COLUMNAS_FILA).eq('org_id', org).eq('kind', 'under_attack_on').eq('target', p.target)
        .in('status', ['proposed', 'executed']).limit(1),
    ]);
    if (a.error || b.error) interno(o.rid, 'bajo_ataque.carrera_error', a.error?.code ?? b.error?.code);
    const fila = a.data ? obj(a.data) : (Array.isArray(b.data) && b.data[0] ? obj(b.data[0]) : null);
    await marcarHermanas(admin, org, p.group, enIso, o.rid);
    if (!fila) {
      return { tipo: 'rechazado', action_id: null, status: null,
        error: 'Otra activación de ese host acaba de terminar: vuelve a proponerlo' };
    }
    log('info', 'bajo_ataque.repetido', { ...registro, action_id: fila.id, status: fila.status });
    return desdeFila(fila, p.target);
  }
  const actionId = str(obj(ins.data).id);
  if (ins.error || !actionId) return interno(o.rid, 'bajo_ataque.insert_error', ins.error?.code);
  // (3) Antes de Cloudflare: así otra vía del group (código o botón) ya no puede canjear.
  await marcarHermanas(admin, org, p.group, enIso, o.rid);

  // (4) Cloudflare.
  const regla = reglaBajoAtaque(p.target, p.ref, descripcion, CADUCIDAD_EN_REGLA ? hasta : null);
  const conexion = { orgId: org, connectionId: p.connection_id, provider: 'cloudflare', kind: 'action' } as const;
  let cf: Creada | FalloCf | SinCupo;
  try {
    cf = await withSecret(env, admin, conexion, (token) => crearRegla(token, p, regla));
  } catch (e) {
    const material = e instanceof Error && !(e instanceof ApiError) && e.message === 'CRYPTO_MATERIAL_UNAVAILABLE';
    cf = e instanceof ProviderError ? falloRed(e) : { tipo: 'fallo', status: null, caido: material, codigo: null };
    if (!(e instanceof ProviderError)) {
      log('warn', 'bajo_ataque.credencial_error', { ...registro, name: e instanceof Error ? e.name : typeof e });
    }
  }

  if (cf.tipo !== 'creada') {
    // (6) failed + approvals.result {error:'cf_<status>' | 'cf_cupo'}; la aprobación queda usada (se vuelve a proponer).
    const codigo = cf.tipo === 'sin_cupo' ? 'cf_cupo' : `cf_${cf.status ?? (cf.caido ? 'red' : 'credencial')}`;
    const [a, b] = await Promise.all([
      admin.from('actions').update({ status: 'failed' }).eq('id', actionId).eq('org_id', org),
      admin.from('approvals').update({ result: { error: codigo } }).eq('id', approval.id).eq('org_id', org),
    ]);
    if (a.error || b.error) {
      log('error', 'bajo_ataque.fallo_sin_registro', { ...registro, code: a.error?.code ?? b.error?.code ?? null });
    }
    log('warn', 'bajo_ataque.fallido', { ...registro, action_id: actionId, codigo });
    if (cf.tipo === 'fallo' && cf.caido) return { tipo: 'caido', action_id: actionId, status: cf.status };
    return { tipo: 'rechazado', action_id: actionId, status: cf.tipo === 'fallo' ? cf.status : null, error: mensajeRechazo(cf) };
  }

  // (5) executed con el previous completo (§4.3).
  const creada = cf;
  const up = await admin.from('actions').update({ status: 'executed', provider_ref: creada.reglaId, expires_at: hasta.toISOString(),
    previous: { ...previous, ruleset_id: creada.rulesetId, creo_ruleset: creada.creoRuleset } }).eq('id', actionId).eq('org_id', org);
  if (up.error) {
    // Sin fila executed nadie la retiraría antes de que caduque: se borra antes de responder 500.
    try {
      const s = await withSecret(env, admin, conexion, (t) => borrarReglaCf(t, p.zone_id, creada.rulesetId, creada.reglaId));
      log((s >= 200 && s < 300) || s === 404 ? 'warn' : 'error', 'bajo_ataque.huerfana', { rid: o.rid, status: s });
    } catch (e) {
      log('error', 'bajo_ataque.huerfana', { rid: o.rid, status: null, name: e instanceof Error ? e.name : typeof e });
    }
    interno(o.rid, 'bajo_ataque.executed_error', up.error.code);
  }
  if (incidentId) {
    const inc = await admin.from('incidents').update({ status: 'mitigated', mitigated_at: enIso })
      .eq('id', incidentId).eq('org_id', org).in('status', ['open', 'ack']);
    if (inc.error) log('warn', 'bajo_ataque.incidente_error', { ...registro, code: inc.error.code ?? null });
  }
  log('info', 'bajo_ataque.ejecutado', { ...registro, action_id: actionId, creo_ruleset: creada.creoRuleset,
    canal: approval.channel });
  return { tipo: 'ejecutado', action_id: actionId, en: enIso, resultado: textoActivo(p.target, p.ttl_s), repetido: false,
    expires_at: hasta.toISOString() };
}

// ── Deshacer (E22, E10 y caducidad de housekeeping) ─────────────────────────────────────────────────────────────────
export type AccionBajoAtaque = { id: string; org_id: string; provider_ref?: string | null; previous?: unknown };
/** Los textos de MENSAJE_DESHACER con el permiso de Config Rules. */
export const MENSAJE_DESHACER_BAJO_ATAQUE: Record<Exclude<ResultadoDeshacer, 'deshecho'>, string> = {
  ...MENSAJE_DESHACER,
  sin_permiso: ERROR_SIN_PERMISO_CONFIG,
  rechazado: 'Cloudflare no dejó retirar la regla: bórrala a mano en Rules → Configuration Rules',
};

// 2xx o 404 = ya no está; 401/403 = el token; 408, 429 y 5xx = pasajero; otro 4xx = rechazado.
const delStatus = (s: number): ResultadoDeshacer => ((s >= 200 && s < 300) || s === 404 ? 'deshecho'
  : s === 403 ? 'sin_permiso' : s === 401 ? 'token_invalido' : caidoHttp(s) ? 'caido' : 'rechazado');

/** DELETE /zones/{previous.zone_id}/rulesets/{previous.ruleset_id}/rules/{provider_ref} con el token de
 *  previous.connection_id (un sobre por conexión); 2xx o 404 = ya no está. El ruleset nunca se borra (D9: pudo ganar
 *  reglas del cliente). Alcance zone (P1) → invalido por ahora. Las deshechas pasan a undone en UNA escritura (executed o
 *  failed: E22 reintenta las que la caducidad no pudo retirar). Subpeticiones = 2 por conexión + 1 por regla + 1.
 *  Lanza ApiError internal si la base falla. */
export async function deshacerBajoAtaque(env: CloudflareBindings, acciones: readonly AccionBajoAtaque[],
  o: { rid: string; ahora?: number }): Promise<{ resultados: Map<string, ResultadoDeshacer>; subpeticiones: number }> {
  const resultados = new Map<string, ResultadoDeshacer>();
  let subpeticiones = 0;
  const grupos = new Map<string, { org: string; conn: string; xs: { id: string; zone: string; rs: string; ref: string }[] }>();
  for (const a of acciones) {
    const prev = obj(a.previous);
    const conn = uuid(prev.connection_id), zone = str(prev.zone_id), rs = str(prev.ruleset_id), ref = str(a.provider_ref);
    if (prev.scope !== 'host' || !UUID.test(a.org_id) || !conn || !zone || !ZONA_ID.test(zone) || !rs || !ID_CF.test(rs) || !ref
      || !ID_CF.test(ref)) { resultados.set(a.id, 'invalido'); continue; }
    const k = `${a.org_id}|${conn}`;
    const g = grupos.get(k) ?? { org: a.org_id, conn, xs: [] };
    g.xs.push({ id: a.id, zone, rs, ref });
    grupos.set(k, g);
  }
  const admin = db(env);
  for (const g of grupos.values()) {
    subpeticiones += 2;
    try {
      await withSecret(env, admin, { orgId: g.org, connectionId: g.conn, provider: 'cloudflare', kind: 'action' }, async (token) => {
        for (const x of g.xs) {
          subpeticiones++;
          try {
            resultados.set(x.id, delStatus(await borrarReglaCf(token, x.zone, x.rs, x.ref)));
          } catch {
            resultados.set(x.id, 'caido');
          }
        }
      });
    } catch (e) {
      const r: ResultadoDeshacer = e instanceof Error && !(e instanceof ApiError) && e.message === 'CRYPTO_MATERIAL_UNAVAILABLE'
        ? 'caido' : 'sin_credencial';
      for (const x of g.xs) if (!resultados.has(x.id)) resultados.set(x.id, r);
    }
  }
  const hechos = acciones.filter((a) => resultados.get(a.id) === 'deshecho');
  if (hechos.length) {
    subpeticiones++;
    const undone_at = new Date(o.ahora ?? Date.now()).toISOString();
    const { error } = await admin.from('actions').update({ status: 'undone', undone_at }).in('id', hechos.map((x) => x.id)).in('org_id', [...new Set(hechos.map((a) => a.org_id))]).eq('kind', 'under_attack_on')
      .in('status', ['executed', 'failed']);
    if (error) interno(o.rid, 'bajo_ataque.undone_error', error.code);
  }
  for (const [id, r] of resultados) {
    if (r !== 'deshecho') log('warn', 'bajo_ataque.deshacer_fallido', { rid: o.rid, action_id: id, resultado: r });
  }
  return { resultados, subpeticiones };
}

// ── Propuesta huérfana (D8, housekeeping) ───────────────────────────────────────────────────────────────────────────
export type ResultadoHuerfana = 'retirada' | 'no_estaba' | 'sin_comprobar' | 'pendiente' | null;

/** Una proposed de bajo ataque de hace más de EN_CURSO_MS es un executeUnderAttack que murió entre el POST y el UPDATE
 *  (o antes): ocupa el host (índice de 0017) y pudo dejar la regla puesta. Se lee UNA (la más vieja); con su conexión,
 *  GET del entrypoint y, si una regla trae previous.ref, DELETE. La fila queda failed con previous.huerfana:
 *  'retirada' | 'no_estaba'; con un fallo permanente (permiso, token, credencial) o uno pasajero cuando ya pasó su
 *  expires_at (la regla ya no actúa), 'sin_comprobar' con previous.deshacer_error (E55 la enseña con los pasos); con uno
 *  pasajero antes de expires_at no se escribe y se reintenta el minuto siguiente. ≤ 6 subpeticiones. Nunca lanza. */
export async function retirarHuerfanaBajoAtaque(env: CloudflareBindings, o: { rid: string; ahora?: number })
  : Promise<{ resultado: ResultadoHuerfana; subpeticiones: number }> {
  const ahora = o.ahora ?? Date.now();
  let subpeticiones = 1;
  try {
    const admin = db(env);
    const { data, error } = await admin.from('actions').select('id, org_id, previous, expires_at').eq('kind', 'under_attack_on')
      .eq('status', 'proposed').lt('created_at', new Date(ahora - EN_CURSO_MS).toISOString()).order('created_at').limit(1);
    if (error) {
      log('warn', 'bajo_ataque.huerfana_lectura_error', { rid: o.rid, code: error.code ?? null });
      return { resultado: null, subpeticiones };
    }
    const f = obj(Array.isArray(data) ? data[0] : null);
    const id = str(f.id), org = uuid(f.org_id);
    if (!id || !org) return { resultado: null, subpeticiones };
    const prev = obj(f.previous);
    const conn = uuid(prev.connection_id), zone = str(prev.zone_id), ref = str(prev.ref);
    let r: ResultadoDeshacer | 'no_estaba';
    if (!conn || !zone || !ZONA_ID.test(zone) || !ref || !REF.test(ref)) r = 'invalido';
    else {
      subpeticiones += 2;
      try {
        r = await withSecret(env, admin, { orgId: org, connectionId: conn, provider: 'cloudflare', kind: 'action' },
          async (token): Promise<ResultadoDeshacer | 'no_estaba'> => {
            subpeticiones++;
            const ep = await leerEntrypoint(token, zone);
            if (ep.tipo === 'no_existe') return 'no_estaba';
            if (ep.tipo === 'fallo') return ep.status === null || ep.caido ? 'caido' : delStatus(ep.status);
            const regla = idDeRef(ep.reglas, ref);
            if (!regla) return 'no_estaba';
            subpeticiones++;
            try { return delStatus(await borrarReglaCf(token, zone, ep.id, regla)); } catch { return 'caido'; }
          });
      } catch (e) {
        const material = e instanceof Error && !(e instanceof ApiError) && e.message === 'CRYPTO_MATERIAL_UNAVAILABLE';
        r = material ? 'caido' : 'sin_credencial';
      }
    }
    const vencida = Date.parse(str(f.expires_at) ?? '') <= ahora;
    if (r === 'caido' && !vencida) {
      log('warn', 'bajo_ataque.huerfana', { rid: o.rid, action_id: id, resultado: 'pendiente' });
      return { resultado: 'pendiente', subpeticiones };
    }
    const resultado: ResultadoHuerfana = r === 'deshecho' ? 'retirada' : r === 'no_estaba' ? 'no_estaba' : 'sin_comprobar';
    const cambio = resultado === 'sin_comprobar' ? { ...prev, huerfana: resultado, deshacer_error: r }
      : { ...prev, huerfana: resultado };
    subpeticiones++;
    const u = await admin.from('actions').update({ status: 'failed', previous: cambio }).eq('id', id).eq('org_id', org)
      .eq('status', 'proposed');
    if (u.error) log('warn', 'bajo_ataque.huerfana_update_error', { rid: o.rid, code: u.error.code ?? null });
    log(resultado === 'sin_comprobar' ? 'error' : 'warn', 'bajo_ataque.huerfana', { rid: o.rid, action_id: id, resultado,
      ...(resultado === 'sin_comprobar' ? { motivo: r } : {}) });
    return { resultado, subpeticiones };
  } catch (e) {
    log('warn', 'bajo_ataque.huerfana_error', { rid: o.rid, name: e instanceof Error ? e.name : typeof e });
    return { resultado: null, subpeticiones };
  }
}

