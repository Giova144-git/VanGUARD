// Acciones de Cloudflare EN SECO para la sandbox de «Ver demo» (0026_sandbox_demo.sql). El flujo es el mismo que el real
// (E20/E56 proponen con un código de 6 dígitos de 10 min, E21 lo canjea con vg_redeem_approval, E22 deshace y la
// caducidad de housekeeping retira a la hora), pero la ejecución NUNCA llama a Cloudflare: escribe en actions una fila
// executed con provider_ref 'simulado:<uuid>' y previous.simulado = true. Quien decide es el servidor: orgMember lee
// orgs.sandbox_of y las rutas desvían aquí; el cliente no puede pedir «en seco» ni «de verdad». Además la base impide
// conexiones kind 'action' en una sandbox (trigger de 0026), así que executeBlock y executeUnderAttack tampoco tendrían
// con qué. Como en la org de demo, el código viaja en la respuesta: aquí no hay WhatsApp (S15 E20).
import { ProposeResponse, UnderAttackOffer, UnderAttackProposal, type UnderAttackMotivo } from '@vanguard/contracts';
import {
  hostCanonico, ipCanonica, ofreceBajoAtaque, otpHashParam, reglaPrincipal, simularBajoAtaque, simularBloqueo, sixDigitCode,
  TTL_BAJO_ATAQUE_S, type MotivoRechazoIp,
} from '@vanguard/core';
import { Severity } from '@vanguard/contracts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { activeKid, getKeys } from '../lib/keyring.ts';
import { log } from '../lib/log.ts';
import { VIDA_BOTON_MS, type IncidenteBloqueo } from './approvals.ts';
import { RANGOS_CLOUDFLARE, TTL_BLOQUEO_S } from './block-ip.ts';
import { hostsProtegidos } from './under-attack.ts';

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (x: unknown) => { const s = str(x); return s && UUID.test(s) ? s : null; };
const minutos = (ttl_s: number) => Math.max(1, Math.round(ttl_s / 60));
const NO_RESUELTOS = ['open', 'ack', 'mitigated'];

export const PREFIJO_SIMULADO = 'simulado:';
export const AVISO_SIMULADO = 'Demo: se simula sin tocar Cloudflare';
/** ¿Fila de actions en seco? (copiada de la demo por vg_clone_demo o ejecutada aquí). */
export const esSimulada = (previous: unknown) => obj(previous).simulado === true;

const zonaDe = (inc: IncidenteBloqueo) => hostCanonico(inc.details.host) ?? 'tu zona';

async function aprobacion(env: CloudflareBindings, o: { orgId: string; incidentId: string; kind: 'block_ip' | 'under_attack_on';
  requestedBy: string; params: Obj; rid: string }): Promise<{ id: string; code: string; expires_at: string }> {
  const admin = db(env);
  const id = crypto.randomUUID();
  const code = sixDigitCode();
  const expires_at = new Date(Date.now() + VIDA_BOTON_MS).toISOString();
  const keys = await getKeys(env, admin, await activeKid(admin));
  const { error } = await admin.from('approvals').insert({ id, org_id: o.orgId, incident_id: o.incidentId, action_kind: o.kind,
    channel: 'in_app', recipient: o.requestedBy, expires_at, nonce_hash: await otpHashParam(keys, id, code),
    params: { ...o.params, group: id, kid: keys.kid, requested_by: o.requestedBy, simulado: true } });
  if (error) {
    log('error', 'sandbox.aprobacion_error', { rid: o.rid, code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos guardar la aprobación');
  }
  return { id, code, expires_at };
}

// ── E20 en seco ───────────────────────────────────────────────────────────────────────────────────────────────────────
export type PropuestaSandbox =
  | { ok: true; respuesta: ProposeResponse }
  | { ok: false; motivo: 'ip'; reason: MotivoRechazoIp }
  | { ok: false; motivo: 'ya_bloqueada'; action_id: string };

/** Mismas guardas de IP que E20 salvo una: las IP de documentación (TEST-NET, las del simulador de ataques) se admiten,
 *  porque aquí no se bloquea nada real. Sin conexión de acciones: la zona es el host del incidente. */
export async function proponerBloqueoSandbox(env: CloudflareBindings, o: { orgId: string; incidente: IncidenteBloqueo;
  target: string; requestedBy: string; ipOperador: string | null; rid: string }): Promise<PropuestaSandbox> {
  const zona = zonaDe(o.incidente);
  let sim = simularBloqueo(o.target, { zona, ipOperador: o.ipOperador, cloudflare: RANGOS_CLOUDFLARE, host: zona });
  if (!sim.ok && sim.reason === 'documentation_range') {
    const v = ipCanonica(o.target.trim().split('/')[0] ?? '');
    if (v) sim = { ok: true, target: v.includes(':') ? 'ip6' : 'ip', value: v,
      efecto: `Bloquear ${v} en la zona ${zona} durante 1 h`, avisos: ['Solo afecta a esta IP'] };
  }
  if (!sim.ok) return { ok: false, motivo: 'ip', reason: sim.reason };
  const { data, error } = await db(env).from('actions').select('id').eq('org_id', o.orgId).eq('target', sim.value)
    .eq('status', 'executed').gt('expires_at', new Date().toISOString()).limit(1);
  if (error) {
    log('error', 'sandbox.propuesta_lectura_error', { rid: o.rid, code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos preparar el bloqueo');
  }
  const previo = str(obj((Array.isArray(data) ? data : [])[0]).id);
  if (previo) return { ok: false, motivo: 'ya_bloqueada', action_id: previo };
  const sev = Severity.safeParse(o.incidente.severity);
  const a = await aprobacion(env, { orgId: o.orgId, incidentId: o.incidente.id, kind: 'block_ip', requestedBy: o.requestedBy,
    rid: o.rid, params: { target: sim.value, target_kind: sim.target, incident_id: o.incidente.id, zone_name: zona, mode: 'block',
      ttl_s: TTL_BLOQUEO_S, incident_code: o.incidente.code,
      regla: reglaPrincipal(o.incidente.rule_ids, sev.success ? sev.data : 'high') } });
  log('info', 'sandbox.propuesta', { rid: o.rid, incidente: o.incidente.code, kind: 'block_ip' });
  return { ok: true, respuesta: ProposeResponse.parse({ approval_id: a.id, efecto: sim.efecto,
    avisos: [...sim.avisos, AVISO_SIMULADO], expires_at: a.expires_at, delivery: 'in_app', code: a.code }) };
}

// ── E55 y E56 en seco ─────────────────────────────────────────────────────────────────────────────────────────────────
type LecturaHost = { host: string | null; filas: Obj[]; ips: number };

async function leerHost(env: CloudflareBindings, orgId: string, inc: IncidenteBloqueo, rid: string): Promise<LecturaHost> {
  const host = hostCanonico(inc.details.host);
  const crudo = str(inc.details.host);
  if (!host) return { host, filas: [], ips: 0 };
  const admin = db(env);
  const [ac, n] = await Promise.all([
    admin.from('actions').select('id, status, previous, created_at, expires_at').eq('org_id', orgId).eq('kind', 'under_attack_on')
      .eq('target', host).in('status', ['proposed', 'executed']).order('created_at', { ascending: false }).limit(3),
    crudo ? admin.from('incidents').select('id', { count: 'exact', head: true }).eq('org_id', orgId).in('status', NO_RESUELTOS)
      .contains('rule_ids', ['CF_IP_FLOOD']).eq('details->>host', crudo) : null,
  ]);
  const error = ac.error ?? n?.error;
  if (error) {
    log('error', 'sandbox.bajo_ataque_lectura_error', { rid, code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer el estado del modo bajo ataque');
  }
  return { host, filas: (Array.isArray(ac.data) ? ac.data : []).map(obj), ips: Math.min(Math.max(n?.count ?? 0, 0), 1000) };
}

const fecha = (x: unknown): string | null => {
  const t = Date.parse(str(x) ?? '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** E55 en una sandbox: la misma oferta, sin conexión de acciones (zona = host del incidente, permiso ok). */
export async function ofertaBajoAtaqueSandbox(env: CloudflareBindings, o: { orgId: string; incidente: IncidenteBloqueo;
  rid: string }): Promise<UnderAttackOffer> {
  const l = await leerHost(env, o.orgId, o.incidente, o.rid);
  const base = ofreceBajoAtaque(o.incidente, l.ips);
  let motivo: UnderAttackMotivo | null = null;
  if (!base.ofrece && (base.motivo === 'no_aplica' || base.motivo === 'sin_host')) motivo = base.motivo;
  else if (l.filas.some((f) => f.status === 'proposed')) motivo = 'en_curso';
  else if (!base.ofrece) motivo = base.motivo;
  else {
    const { protegidos, zonaProducto } = hostsProtegidos(env);
    const sim = simularBajoAtaque({ scope: 'host', host: base.host, zona: base.host, protegidos, zonaProducto, plan: null,
      reglasUsadas: null, ttl_s: TTL_BAJO_ATAQUE_S });
    if (!sim.ok) motivo = sim.reason === 'host_protegido' ? 'host_protegido' : sim.reason === 'host_invalido' ? 'sin_host' : 'fuera_de_zona';
  }
  const viva = l.filas.find((f) => f.status === 'executed');
  const activo = viva && l.host ? { action_id: String(viva.id), scope: 'host' as const, target: l.host,
    created_at: fecha(viva.created_at) ?? new Date().toISOString(), expires_at: fecha(viva.expires_at), retirada_fallida: false } : null;
  return UnderAttackOffer.parse({ ofrece: base.ofrece, motivo, hostname: l.host, zone_name: l.host, connection_id: null,
    ips: l.host ? l.ips : 0, scopes: motivo === null ? ['host'] : [], permiso: 'ok', ttl_s: TTL_BAJO_ATAQUE_S, activo, copiar: null });
}

export type PropuestaBajoAtaqueSandbox =
  | { ok: true; respuesta: UnderAttackProposal }
  | { ok: false; motivo: 'no_aplica' | 'una_ip' | 'sin_host' | 'host_protegido' | 'fuera_de_zona' | 'resolved'
      | 'already_active' | 'in_progress' | 'alcance_no_disponible'; action_id?: string };

/** E56 en una sandbox: mismas guardas de la regla y del host, sin dry_run ni WhatsApp (el código va en la respuesta). */
export async function proponerBajoAtaqueSandbox(env: CloudflareBindings, o: { orgId: string; incidente: IncidenteBloqueo;
  scope: 'host' | 'zone'; requestedBy: string; rid: string }): Promise<PropuestaBajoAtaqueSandbox> {
  const l = await leerHost(env, o.orgId, o.incidente, o.rid);
  const base = ofreceBajoAtaque(o.incidente, l.ips);
  if (!base.ofrece && (base.motivo === 'no_aplica' || base.motivo === 'sin_host')) return { ok: false, motivo: base.motivo };
  const viva = l.filas.find((f) => f.status === 'executed');
  if (viva) return { ok: false, motivo: 'already_active', action_id: String(viva.id) };
  if (l.filas.some((f) => f.status === 'proposed')) return { ok: false, motivo: 'in_progress' };
  if (!base.ofrece) return { ok: false, motivo: base.motivo === 'cerrado' ? 'resolved' : base.motivo };
  if (o.scope === 'zone') return { ok: false, motivo: 'alcance_no_disponible' };
  const { protegidos, zonaProducto } = hostsProtegidos(env);
  const sim = simularBajoAtaque({ scope: 'host', host: base.host, zona: base.host, protegidos, zonaProducto, plan: null,
    reglasUsadas: null, ttl_s: TTL_BAJO_ATAQUE_S });
  if (!sim.ok) return { ok: false, motivo: sim.reason === 'host_protegido' ? 'host_protegido' : sim.reason === 'host_invalido' ? 'sin_host' : 'fuera_de_zona' };
  const a = await aprobacion(env, { orgId: o.orgId, incidentId: o.incidente.id, kind: 'under_attack_on', requestedBy: o.requestedBy,
    rid: o.rid, params: { scope: 'host', target: base.host, zone_name: base.host, incident_id: o.incidente.id,
      incident_code: o.incidente.code, ttl_s: TTL_BAJO_ATAQUE_S } });
  log('info', 'sandbox.propuesta', { rid: o.rid, incidente: o.incidente.code, kind: 'under_attack_on' });
  return { ok: true, respuesta: UnderAttackProposal.parse({ approval_id: a.id, efecto: sim.efecto,
    avisos: [...sim.avisos, AVISO_SIMULADO], expires_at: a.expires_at, delivery: 'in_app', code: a.code, scope: 'host',
    target: base.host, zone_name: base.host, ttl_s: TTL_BAJO_ATAQUE_S, validado: true }) };
}

// ── E21 en seco ───────────────────────────────────────────────────────────────────────────────────────────────────────
export type EjecucionSandbox =
  | { tipo: 'ejecutado'; action_id: string; en: string; resultado: string }
  | { tipo: 'invalido' };

/** Tras el canje de E21 en una sandbox: la fila de actions executed sin llamar a nadie, y el incidente mitigated. La
 *  aprobación debe ser de las nuestras (params.simulado); approval_id es único, así que un doble canje no duplica. */
export async function ejecutarEnSeco(env: CloudflareBindings, fila: Obj, rid: string): Promise<EjecucionSandbox> {
  const p = obj(fila.params);
  const kind = fila.action_kind;
  const org = uuid(fila.org_id), approvalId = uuid(fila.id);
  if (p.simulado !== true || !org || !approvalId || (kind !== 'block_ip' && kind !== 'under_attack_on')) return { tipo: 'invalido' };
  const bloqueo = kind === 'block_ip';
  const target = bloqueo ? ipCanonica(str(p.target) ?? '') : hostCanonico(p.target);
  if (!target) return { tipo: 'invalido' };
  const ttl = bloqueo ? TTL_BLOQUEO_S
    : typeof p.ttl_s === 'number' && Number.isInteger(p.ttl_s) ? Math.min(Math.max(p.ttl_s, 300), 3600) : TTL_BAJO_ATAQUE_S;
  const zona = str(p.zone_name) ?? target;
  const ahora = new Date();
  const en = ahora.toISOString();
  const resultado = bloqueo ? 'IP bloqueada 1 h (demo: simulado, sin tocar Cloudflare)'
    : `Modo bajo ataque activo ${minutos(ttl)} min en ${target} (demo: simulado, sin tocar Cloudflare)`;
  const incidentId = uuid(p.incident_id);
  const admin = db(env);
  const { data, error } = await admin.from('actions').insert({ org_id: org, incident_id: incidentId, approval_id: approvalId, kind,
    target, status: 'executed', provider_ref: PREFIJO_SIMULADO + crypto.randomUUID(), requested_by: uuid(p.requested_by),
    previous: bloqueo ? { simulado: true, zone_name: zona }
      : { simulado: true, connection_id: null, zone_id: 'simulado', zone_name: zona, scope: 'host' },
    expires_at: new Date(ahora.getTime() + ttl * 1000).toISOString() }).select('id').single();
  if (error?.code === '23505') {
    // Ya hay una ejecución de esta aprobación (doble canje) o un modo bajo ataque vivo en ese host: se devuelve esa.
    const { data: f } = await admin.from('actions').select('id, created_at').eq('org_id', org).eq('kind', kind).eq('target', target)
      .eq('status', 'executed').order('created_at', { ascending: false }).limit(1).maybeSingle();
    const id = uuid(obj(f).id);
    if (id) return { tipo: 'ejecutado', action_id: id, en: fecha(obj(f).created_at) ?? en, resultado };
  }
  const id = uuid(obj(data).id);
  if (error || !id) {
    log('error', 'sandbox.ejecutar_error', { rid, code: error?.code ?? null });
    throw new ApiError('internal', 'No pudimos registrar la acción');
  }
  if (incidentId) {
    const inc = await admin.from('incidents').update({ status: 'mitigated', mitigated_at: en })
      .eq('id', incidentId).eq('org_id', org).in('status', ['open', 'ack']);
    if (inc.error) log('warn', 'sandbox.incidente_error', { rid, code: inc.error.code ?? null });
  }
  log('info', 'sandbox.ejecutado', { rid, kind, action_id: id });
  return { tipo: 'ejecutado', action_id: id, en, resultado };
}

// ── E22 y caducidad en seco ───────────────────────────────────────────────────────────────────────────────────────────
/** Retira acciones en seco (E22 en una sandbox y la caducidad de housekeeping): undone sin llamar a nadie. Devuelve los
 *  ids que pasaron a undone. */
export async function deshacerEnSeco(env: CloudflareBindings, acciones: readonly { id: string; org_id: string }[],
  rid: string): Promise<Set<string>> {
  const hechas = new Set<string>();
  if (!acciones.length) return hechas;
  const admin = db(env);
  const t = new Date().toISOString();
  for (const a of acciones) {
    const { error } = await admin.from('actions').update({ status: 'undone', undone_at: t })
      .eq('id', a.id).eq('org_id', a.org_id).in('status', ['executed', 'failed']);
    if (error) log('warn', 'sandbox.deshacer_error', { rid, code: error.code ?? null });
    else hechas.add(a.id);
  }
  return hechas;
}
