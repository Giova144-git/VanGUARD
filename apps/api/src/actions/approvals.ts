// Botones de WhatsApp (S12 12.6 y 12.9, S15 15.10): parser del id, nonces de un solo uso, canje de ack/snz y, para
// «Bloquear IP», la propuesta (E20 y el botón blk) y el canje de ok/no/blk que llamará E31. Cada botón es una fila de
// approvals con SOLO sha256(nonce) (el nonce viaja en el id del botón y no se guarda), recipient = teléfono sin '+' y
// 10 min de vida; el código de 6 dígitos de la app se guarda como HMAC con la FPK (otpHash, §06.7). El canje es atómico
// con vg_redeem_approval (0005).
import { ProposeResponse, Severity } from '@vanguard/contracts';
import {
  botonesAprobacion, ipCorta, otpHashParam, reglaPrincipal, simularBloqueo, sixDigitCode, TEXTO_CODIGO_VENCIDO,
  textoBloqueada, textoCodigoBloqueo, textoSeguro, type MotivoRechazoIp,
} from '@vanguard/core';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { sha256Hex } from '../lib/hmac.ts';
import { activeKid, getKeys } from '../lib/keyring.ts';
import { log } from '../lib/log.ts';
import { ventanaAbierta } from '../lib/verificacion.ts';
import {
  cuerpoInteractivo, cuerpoTexto, enmascararTelefono, enviarKapso, KapsoError, kapsoConfigurado, type MensajeKapso,
} from '../notify/kapso.ts';
import { executeBlock, RANGOS_CLOUDFLARE, TTL_BLOQUEO_S, type AprobacionCanjeada } from './block-ip.ts';

export type AccionBoton = 'ack' | 'snz' | 'ok' | 'no' | 'blk';
export type Boton = { accion: AccionBoton; codigo: string; nonce: string };

// Misma regex que S15 15.10. Nonce de 16–43 car. base64url. blk lanza un propose (E20), nunca un bloqueo directo.
const BOTON = /^(ack|snz|ok|no|blk):([A-Z0-9]{6}):([A-Za-z0-9_-]{16,43})$/;

export function parsearBoton(p: string): Boton | null {
  const m = BOTON.exec(p);
  return m ? { accion: m[1] as AccionBoton, codigo: m[2]!, nonce: m[3]! } : null;
}

/** Vida de un botón de alerta (S15 15.10: expires_at = now() + 10 min, igual que el default de approvals). */
export const VIDA_BOTON_MS = 10 * 60_000;
/** «Silenciar 1 h» (S12 12.3). */
export const SILENCIO_BOTON_MS = 60 * 60_000;
/** approvals.action_kind de cada botón de la alerta (check de 0005: 'ack' y 'mute'). */
export const ACCION_APROBACION = { ack: 'ack', snz: 'mute' } as const;

/** 16 bytes aleatorios en base64url sin relleno (22 car.), como pide §12.6. */
export function nuevoNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** bytea por supabase-js: texto hex con prefijo \x (formato de entrada de bytea en PostgREST, S15 E20). */
export const aBytea = (hex: string) => '\\x' + hex;
export const hashNonce = async (nonce: string) => aBytea(await sha256Hex(nonce));

export type FilaBoton = {
  org_id: string; incident_id: string; action_kind: 'ack' | 'mute' | 'block_ip'; channel: 'whatsapp'; recipient: string;
  nonce_hash: string; expires_at: string; params: Record<string, unknown>;
};

/** Etapa de cada botón de bloqueo en approvals.params.etapa: el canje exige que el prefijo del botón case con la fila
 *  canjeada (un nonce de blk no sirve como ok). */
export const ETAPA_BOTON = { blk: 'proponer', ok: 'confirmar', no: 'cancelar' } as const;

/** Las filas de approvals de los botones de UN mensaje: ack y snz y, si se pasan su nonce y la IP (el despachador solo lo
 *  hace cuando ofreceBloqueo), blk con action_kind block_ip y params {etapa:'proponer', target, incident_id}.
 *  `recipient` = E.164 sin '+' (el `from` del webhook). */
export async function filasBotones(o: { org_id: string; incident_id: string; recipient: string;
  nonces: { ack: string; snz: string; blk?: string | null }; target?: string | null; ahora?: number }): Promise<FilaBoton[]> {
  const expires_at = new Date((o.ahora ?? Date.now()) + VIDA_BOTON_MS).toISOString();
  const filas: FilaBoton[] = await Promise.all((['ack', 'snz'] as const).map(async (b) => ({
    org_id: o.org_id, incident_id: o.incident_id, action_kind: ACCION_APROBACION[b], channel: 'whatsapp' as const,
    recipient: o.recipient, nonce_hash: await hashNonce(o.nonces[b]), expires_at, params: {},
  })));
  if (o.nonces.blk && o.target) {
    filas.push({ org_id: o.org_id, incident_id: o.incident_id, action_kind: 'block_ip', channel: 'whatsapp', recipient: o.recipient,
      nonce_hash: await hashNonce(o.nonces.blk), expires_at,
      params: { etapa: ETAPA_BOTON.blk, target: o.target, incident_id: o.incident_id } });
  }
  return filas;
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const REMITENTE = /^[1-9][0-9]{7,14}$/;

/** Por qué un botón ack/snz tuvo o no efecto (va al log; ninguno se contesta por WhatsApp en este hito). */
export type ResultadoBoton = 'aplicado' | 'sin_canje' | 'tipo_distinto' | 'otro_incidente' | 'no_contacto' | 'resuelto'
  | 'ya_ack' | 'remitente_invalido' | 'error';

/** E31 · ack/snz (S15 15.10): canje atómico del nonce (sha256, un solo uso, no caducado, recipient = remitente) y luego,
 *  con la org de la fila canjeada: el incidente debe ser de esa org y tener el código del botón, y el remitente un
 *  contacto verificado de esa org. Solo entonces ack → status 'ack', acked_at, acked_via 'whatsapp'; snz → muted_until
 *  = ahora + 1 h y details.muted_at. Cualquier otra cosa no tiene efecto. Nunca lanza. */
export async function canjearBotonAlerta(env: CloudflareBindings, b: Boton, remitente: string, rid: string,
  ahora = Date.now()): Promise<ResultadoBoton> {
  if (b.accion !== 'ack' && b.accion !== 'snz') return 'tipo_distinto';
  if (!REMITENTE.test(remitente)) return 'remitente_invalido';
  try {
    const admin = db(env);
    const { data, error } = await admin.rpc('vg_redeem_approval',
      { p_approval: null, p_nonce_hash: await hashNonce(b.nonce), p_recipient: remitente });
    if (error) {
      log('error', 'kapso.canje_error', { rid, code: error.code ?? null });
      return 'error';
    }
    // setof approvals: 0 filas = vencido, ya usado, de otro remitente o inexistente.
    const fila = obj(Array.isArray(data) ? data[0] : data);
    const org = str(fila.org_id), incidente = str(fila.incident_id);
    if (!org) return 'sin_canje';
    if (fila.channel !== 'whatsapp' || fila.action_kind !== ACCION_APROBACION[b.accion] || !incidente) return 'tipo_distinto';

    const [i, c] = await Promise.all([
      admin.from('incidents').select('id, code, status, acked_at, muted_until, details')
        .eq('id', incidente).eq('org_id', org).maybeSingle(),
      admin.from('contacts').select('id, verified_at').eq('org_id', org).eq('phone_e164', `+${remitente}`).maybeSingle(),
    ]);
    if (i.error || c.error) {
      log('error', 'kapso.boton_lectura_error', { rid, code: i.error?.code ?? c.error?.code ?? null });
      return 'error';
    }
    const inc = obj(i.data);
    if (str(inc.code) !== b.codigo) return 'otro_incidente';
    if (!str(obj(c.data).verified_at)) return 'no_contacto';
    const status = str(inc.status);
    if (!status || status === 'resolved') return 'resuelto';

    const t = new Date(ahora).toISOString();
    let cambio: Obj;
    if (b.accion === 'ack') {
      if (str(inc.acked_at)) return 'ya_ack';   // el primer ack es el del cronómetro: no se pisa
      // mitigated no retrocede a ack (open → ack → mitigated); solo gana acked_at.
      cambio = { status: status === 'open' ? 'ack' : status, acked_at: t, acked_via: 'whatsapp' };
    } else {
      // Un silencio más largo ya puesto (E19 admite hasta 24 h) no se acorta.
      const previo = Date.parse(str(inc.muted_until) ?? '');
      const hasta = Math.max(ahora + SILENCIO_BOTON_MS, Number.isFinite(previo) ? previo : 0);
      cambio = { muted_until: new Date(hasta).toISOString(), details: { ...obj(inc.details), muted_at: t } };
    }
    // Guarda por status: si housekeeping o E21 lo cambiaron entre la lectura y aquí, no se pisa.
    const { error: eu } = await admin.from('incidents').update(cambio)
      .eq('id', incidente).eq('org_id', org).eq('status', status);
    if (eu) {
      log('error', 'kapso.boton_update_error', { rid, code: eu.code ?? null });
      return 'error';
    }
    return 'aplicado';
  } catch (e) {
    log('error', 'kapso.boton_error', { rid, name: e instanceof Error ? e.name : typeof e });
    return 'error';
  }
}

// ── «Bloquear IP»: propuesta (E20 y botón blk) y canje de ok/no/blk (E31) ────────────────────────────────────────────
export const MAX_INTENTOS = 5;                 // approvals.attempts: al 5.º código malo la aprobación queda quemada
export const COLUMNAS_INCIDENTE_BLOQUEO = 'id, code, rule_ids, severity, resource, status, details';
const ZONA_ID = /^[a-f0-9]{32}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;

export type IncidenteBloqueo = {
  id: string; code: string; rule_ids: string[]; severity: string; resource: string; status: string; details: Obj;
};
export function leerIncidenteBloqueo(x: unknown): IncidenteBloqueo | null {
  const o = obj(x);
  const id = str(o.id), code = str(o.code), resource = str(o.resource), status = str(o.status);
  if (!id || !code || !resource || !status || !Array.isArray(o.rule_ids)) return null;
  return { id, code, rule_ids: o.rule_ids.filter((r): r is string => typeof r === 'string'), severity: str(o.severity) ?? 'high',
    resource, status, details: obj(o.details) };
}

/** Por qué no se pudo entregar el código o los botones (va al log y a details.reason del 502 de E20). */
export type SinEntrega = 'sin_contacto' | 'sin_verificar' | 'ventana' | 'dry_run' | 'sin_config' | 'kapso';
export type OpcionesPropuesta = {
  orgId: string; incidente: IncidenteBloqueo; target: string; connectionId?: string | undefined; rid: string; ahora?: number;
} & (
  | { entrega: 'app'; requestedBy: string; ipOperador: string | null }   // E20: código + botones al contacto prioritario
  | { entrega: 'whatsapp'; telefono: string }                           // botón blk: botones al que lo pulsó (sin own_ip)
);
export type ResultadoPropuesta =
  | { ok: true; respuesta: ProposeResponse; recipient_masked: string | null }
  | { ok: false; motivo: 'ip'; reason: MotivoRechazoIp }
  | { ok: false; motivo: 'sin_conexion' }
  | { ok: false; motivo: 'ya_bloqueada'; action_id: string }
  | { ok: false; motivo: 'sin_entrega'; detalle: SinEntrega };

type Conexion = { id: string; zone_id: string; zone_name: string };

/** §08.8: la conexión Cloudflare kind:'action' activa pedida; si no se pide, la única, o la cuya zona sea sufijo del host
 *  atacado (details.host). Ninguna → null (409). */
export function elegirConexion(filas: unknown, pedida: string | undefined, host: string | null): Conexion | null {
  const xs = (Array.isArray(filas) ? filas : []).map(obj).flatMap((f) => {
    const id = str(f.id), m = obj(f.meta), zone_id = str(m.zone_id);
    return id && zone_id && ZONA_ID.test(zone_id) ? [{ id, zone_id, zone_name: str(m.zone_name) ?? 'tu zona' }] : [];
  });
  if (pedida) return xs.find((x) => x.id === pedida) ?? null;
  if (xs.length === 1) return xs[0]!;
  const h = host?.trim().toLowerCase().replace(/\.$/, '');
  return (h && xs.find((x) => { const z = x.zone_name.toLowerCase(); return h === z || h.endsWith(`.${z}`); })) || null;
}

/** Cuerpo del interactivo ok/no (§12.9): la IP recortada y, en la propuesta de la app, el código de 6 dígitos. */
export function textoPropuesta(ip: string, zona: string, codigo: string | null): string {
  const pregunta = `¿Bloquear ${ipCorta(ip)} durante 1 h en ${textoSeguro(zona, 60)}?`;
  return codigo ? `${pregunta}\n\nCódigo para la app: ${codigo}. Vence en 10 min.` : `${pregunta}\n\nSolo afecta a esa IP. Vence en 10 min.`;
}

type Cliente = ReturnType<typeof db>;
async function insertarAprobaciones(admin: Cliente, filas: Obj[], rid: string) {
  const { error } = await admin.from('approvals').insert(filas);
  if (error) {
    log('error', 'propuesta.insert_error', { rid, code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos guardar la aprobación');
  }
}

// Un envío por Kapso; false si falla (el código corto va al log, nunca el texto del proveedor).
async function enviar(env: CloudflareBindings, m: MensajeKapso, rid: string, tipo: string): Promise<boolean> {
  try {
    await enviarKapso(env, m);
    return true;
  } catch (e) {
    log('warn', 'propuesta.envio_error', { rid, tipo, code: e instanceof KapsoError ? e.detalle ?? e.code : 'unavailable' });
    return false;
  }
}

/** E20 y botón blk (S15 E20, §12.9): valida el target con core/ip.ts (own_ip solo en la app), elige la conexión action
 *  (§08.8), descarta un bloqueo executed vigente de esa IP y crea las aprobaciones de 10 min sin tocar Cloudflare. App:
 *  fila in_app (id = approval_id = group, recipient = user_id, HMAC del código con la FPK y su kid en params) y, si el
 *  contacto prioritario está verificado, con la ventana de 24 h abierta y Kapso configurado, dos filas whatsapp ok/no y
 *  el interactivo con el código (o el texto con el código si el interactivo falla); sin WhatsApp, solo la org de demo
 *  recibe el código en la respuesta (las demás: sin_entrega → 502, sin crear nada). blk: solo las dos filas ok/no y el
 *  interactivo al teléfono que pulsó. Lanza ApiError internal si la base falla. */
export async function proponerBloqueo(env: CloudflareBindings, o: OpcionesPropuesta): Promise<ResultadoPropuesta> {
  const ipOperador = o.entrega === 'app' ? o.ipOperador : null;
  const previa = simularBloqueo(o.target, { zona: '-', ipOperador, cloudflare: RANGOS_CLOUDFLARE });
  if (!previa.ok) return { ok: false, motivo: 'ip', reason: previa.reason };
  const admin = db(env);
  const ahora = o.ahora ?? Date.now();
  const app = o.entrega === 'app';
  const [cx, ac, ct, og] = await Promise.all([
    admin.from('connections').select('id, meta').eq('org_id', o.orgId).eq('provider', 'cloudflare').eq('kind', 'action')
      .eq('status', 'active').order('created_at').limit(10),
    admin.from('actions').select('id').eq('org_id', o.orgId).eq('target', previa.value).eq('status', 'executed')
      .gt('expires_at', new Date(ahora).toISOString()).limit(1),
    app ? admin.from('contacts').select('phone_e164, verified_at, wa_last_inbound_at').eq('org_id', o.orgId).eq('whatsapp', true)
      .order('priority').limit(1).maybeSingle() : null,
    app ? admin.from('orgs').select('is_demo').eq('id', o.orgId).maybeSingle() : null,
  ]);
  const error = cx.error ?? ac.error ?? ct?.error ?? og?.error;
  if (error) {
    log('error', 'propuesta.lectura_error', { rid: o.rid, code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos preparar el bloqueo');
  }
  const host = str(o.incidente.details.host);
  const conexion = elegirConexion(cx.data, o.connectionId, host);
  if (!conexion) return { ok: false, motivo: 'sin_conexion' };
  const previo = str(obj((Array.isArray(ac.data) ? ac.data : [])[0]).id);
  if (previo) return { ok: false, motivo: 'ya_bloqueada', action_id: previo };
  const sim = simularBloqueo(o.target, { zona: conexion.zone_name, ipOperador, cloudflare: RANGOS_CLOUDFLARE, host });
  if (!sim.ok) return { ok: false, motivo: 'ip', reason: sim.reason };

  const sev = Severity.safeParse(o.incidente.severity);
  const expires_at = new Date(ahora + VIDA_BOTON_MS).toISOString();
  const base = { org_id: o.orgId, incident_id: o.incidente.id, action_kind: 'block_ip', expires_at };
  const params = { target: sim.value, target_kind: sim.target, incident_id: o.incidente.id, connection_id: conexion.id,
    zone_id: conexion.zone_id, zone_name: conexion.zone_name, mode: 'block', ttl_s: TTL_BLOQUEO_S, incident_code: o.incidente.code,
    regla: reglaPrincipal(o.incidente.rule_ids, sev.success ? sev.data : 'high'), requested_by: app ? o.requestedBy : null };
  const respuesta = (approval_id: string, delivery: 'whatsapp' | 'in_app', code: string | null) =>
    ProposeResponse.parse({ approval_id, efecto: sim.efecto, avisos: sim.avisos, expires_at, delivery, code });
  // Filas ok/no del mismo group (el id de cada fila se fija aquí para poder borrarlas si el envío falla).
  const filasWa = async (tel: string, group: string) => {
    const n = { ok: nuevoNonce(), no: nuevoNonce() };
    const botones = botonesAprobacion(o.incidente.code, n);
    const filas = await Promise.all((['ok', 'no'] as const).map(async (b) => ({ id: crypto.randomUUID(), ...base,
      channel: 'whatsapp', recipient: tel.slice(1), nonce_hash: await hashNonce(n[b]), params: { ...params, group, etapa: ETAPA_BOTON[b] } })));
    return { filas, botones };
  };
  const interactivo = (tel: string, botones: { id: string; title: string }[], codigo: string | null) => cuerpoInteractivo(tel,
    { header: 'Bloquear IP · Cloudflare', body: textoPropuesta(sim.value, conexion.zone_name, codigo),
      footer: `Incidente #${o.incidente.code} · VanGUARD`, botones });
  const borrar = async (ids: string[]) => {
    const { error: e } = await admin.from('approvals').delete().in('id', ids).eq('org_id', o.orgId);
    if (e) log('warn', 'propuesta.borrado_error', { rid: o.rid, code: e.code ?? null });
  };
  const registro = { rid: o.rid, incidente: o.incidente.code, entrega: o.entrega };

  if (o.entrega === 'whatsapp') {
    const tel = `+${o.telefono}`;
    const sinWa: SinEntrega | null = !E164.test(tel) ? 'sin_contacto' : env.VG_ENV !== 'production' ? 'dry_run'
      : !kapsoConfigurado(env) ? 'sin_config' : null;
    if (sinWa) return { ok: false, motivo: 'sin_entrega', detalle: sinWa };
    const wa = await filasWa(tel, crypto.randomUUID());
    await insertarAprobaciones(admin, wa.filas, o.rid);
    if (!await enviar(env, interactivo(tel, wa.botones, null), o.rid, 'interactivo')) {
      await borrar(wa.filas.map((f) => f.id));
      return { ok: false, motivo: 'sin_entrega', detalle: 'kapso' };
    }
    const recipient_masked = enmascararTelefono(tel);
    log('info', 'propuesta.creada', { ...registro, delivery: 'whatsapp', recipient_masked });
    return { ok: true, respuesta: respuesta(wa.filas[0]!.id, 'whatsapp', null), recipient_masked };
  }

  const contacto = obj(ct?.data);
  const tel = str(contacto.phone_e164);
  const sinWa: SinEntrega | null = !tel || !E164.test(tel) ? 'sin_contacto' : !str(contacto.verified_at) ? 'sin_verificar'
    : !ventanaAbierta(env, contacto.wa_last_inbound_at, ahora) ? 'ventana' : env.VG_ENV !== 'production' ? 'dry_run'
    : !kapsoConfigurado(env) ? 'sin_config' : null;
  const demo = obj(og?.data).is_demo === true;
  // Fuera de la demo, devolver el código en la respuesta quitaría el factor fuera de banda (§06.7): 502 sin crear nada.
  if (sinWa && !demo) return { ok: false, motivo: 'sin_entrega', detalle: sinWa };
  const approvalId = crypto.randomUUID();
  const code = sixDigitCode();
  const keys = await getKeys(env, admin, await activeKid(admin));
  const filaApp = { id: approvalId, ...base, channel: 'in_app', recipient: o.requestedBy,
    nonce_hash: await otpHashParam(keys, approvalId, code), params: { ...params, group: approvalId, kid: keys.kid } };
  const wa = !sinWa && tel ? await filasWa(tel, approvalId) : null;
  await insertarAprobaciones(admin, [filaApp, ...(wa?.filas ?? [])], o.rid);
  if (wa && tel) {
    const enviado = await enviar(env, interactivo(tel, wa.botones, code), o.rid, 'interactivo')
      || await enviar(env, cuerpoTexto(tel, textoCodigoBloqueo(code, sim.value, conexion.zone_name)), o.rid, 'texto');
    const recipient_masked = enmascararTelefono(tel);
    if (enviado) {
      log('info', 'propuesta.creada', { ...registro, delivery: 'whatsapp', recipient_masked });
      return { ok: true, respuesta: respuesta(approvalId, 'whatsapp', null), recipient_masked };
    }
    if (!demo) {
      await borrar([approvalId, ...wa.filas.map((f) => f.id)]);
      return { ok: false, motivo: 'sin_entrega', detalle: 'kapso' };
    }
  }
  // Solo la org de demo: sin WhatsApp utilizable, el código viaja en la respuesta (S15 E20; la demo no depende de Kapso).
  log('info', 'propuesta.creada', { ...registro, delivery: 'in_app', motivo: sinWa ?? 'kapso' });
  return { ok: true, respuesta: respuesta(approvalId, 'in_app', code), recipient_masked: null };
}

/** Por qué un botón ok/no/blk tuvo o no efecto (va al log de E31). */
export type ResultadoBotonBloqueo = 'ejecutado' | 'ya_estaba' | 'rechazado' | 'caido' | 'en_curso' | 'cancelado' | 'propuesto'
  | 'sin_conexion' | 'ya_bloqueada' | 'ip_no_valida' | 'sin_entrega' | 'sin_canje' | 'tipo_distinto' | 'otro_incidente'
  | 'no_contacto' | 'remitente_invalido' | 'dry_run' | 'error';
/** `texto`: la respuesta de servicio que E31 debe mandar al remitente (con su responder y su presupuesto), o null. */
export type CanjeBloqueo = { resultado: ResultadoBotonBloqueo; texto: string | null; action_id?: string };
/** Peor caso de subpeticiones de canjearBotonBloqueo: canje 1 + lecturas 2 + executeBlock ≤ 10 (con GET de duplicado o
 *  de reconciliación y traspaso de la regla; la propuesta de blk ≤ 6, la cancelación 3), más 1 de margen. E31 lo reserva
 *  antes de llamar y suma aparte el envío de `texto`. */
export const COSTE_BOTON_BLOQUEO = 14;

/** E31 · ok/no/blk (S15 15.10, §12.9). Canje atómico del nonce (sha256, un solo uso, no vencido, recipient = remitente);
 *  la fila debe ser block_ip de WhatsApp con la etapa del botón, de un incidente de su org con el código del botón, y el
 *  remitente un contacto verificado de esa org. Entonces: ok → executeBlock (el mismo de E21; la hermana in_app queda
 *  usada) · no → las aprobaciones vivas y sin usar del group quedan usadas con result {canceled:true} (si la confirmación
 *  ganó antes, se contesta el estado real de su action) · blk → proponerBloqueo
 *  con entrega por WhatsApp al remitente (nunca un bloqueo directo; sin own_ip). Fuera de producción no canjea nada
 *  (dry_run). Nunca lanza; E31 manda `texto` si no es null. */
export async function canjearBotonBloqueo(env: CloudflareBindings, b: Boton, remitente: string, rid: string,
  ahora = Date.now()): Promise<CanjeBloqueo> {
  const r = (resultado: ResultadoBotonBloqueo, texto: string | null = null, action_id?: string | null): CanjeBloqueo =>
    (action_id ? { resultado, texto, action_id } : { resultado, texto });
  if (b.accion !== 'ok' && b.accion !== 'no' && b.accion !== 'blk') return r('tipo_distinto');
  if (!REMITENTE.test(remitente)) return r('remitente_invalido');
  if (env.VG_ENV !== 'production') return r('dry_run');   // S15 15.3: fuera de producción no se toca Cloudflare
  try {
    const admin = db(env);
    const { data, error } = await admin.rpc('vg_redeem_approval',
      { p_approval: null, p_nonce_hash: await hashNonce(b.nonce), p_recipient: remitente });
    if (error) {
      log('error', 'kapso.canje_error', { rid, code: error.code ?? null });
      return r('error');
    }
    const fila = obj(Array.isArray(data) ? data[0] : data);
    const org = str(fila.org_id), incidente = str(fila.incident_id), id = str(fila.id);
    if (!org || !id) return r('sin_canje', TEXTO_CODIGO_VENCIDO);
    const params = obj(fila.params);
    if (fila.channel !== 'whatsapp' || fila.action_kind !== 'block_ip' || params.etapa !== ETAPA_BOTON[b.accion] || !incidente) {
      return r('tipo_distinto');
    }
    const [i, c] = await Promise.all([
      admin.from('incidents').select(COLUMNAS_INCIDENTE_BLOQUEO).eq('id', incidente).eq('org_id', org).maybeSingle(),
      admin.from('contacts').select('id, verified_at').eq('org_id', org).eq('phone_e164', `+${remitente}`).maybeSingle(),
    ]);
    if (i.error || c.error) {
      log('error', 'kapso.boton_lectura_error', { rid, code: i.error?.code ?? c.error?.code ?? null });
      return r('error');
    }
    const inc = leerIncidenteBloqueo(i.data);
    if (!inc || inc.code !== b.codigo) return r('otro_incidente');
    if (!str(obj(c.data).verified_at)) return r('no_contacto');
    const target = str(params.target) ?? '';

    if (b.accion === 'ok') {
      const x = await executeBlock(env, fila as unknown as AprobacionCanjeada, { rid, ahora });
      if (x.tipo === 'ejecutado') {
        return r(x.existia ? 'ya_estaba' : 'ejecutado', x.existia ? `${ipCorta(target)} ya estaba bloqueada por una regla tuya.`
          : textoBloqueada(target), x.action_id);
      }
      if (x.tipo === 'rechazado') return r('rechazado', `No pude bloquear ${ipCorta(target)}: ${x.error}.`, x.action_id);
      if (x.tipo === 'caido') return r('caido', 'Cloudflare no respondió. Vuelve a proponer el bloqueo desde la app.', x.action_id);
      if (x.tipo === 'en_curso') return r('en_curso', null, x.action_id);
      return r('error');
    }

    if (b.accion === 'no') {
      const t = new Date(ahora).toISOString();
      const group = str(params.group);
      // Las del group aún sin usar (la in_app incluida, así el código de la app ya no sirve) más la propia, por si no
      // tuviera group. Una ya canjeada (código de la app u ok) no se pisa: su bloqueo sigue su curso.
      const [g, p] = await Promise.all([
        group ? admin.from('approvals').update({ used_at: t, result: { canceled: true } }).eq('org_id', org)
          .eq('params->>group', group).is('used_at', null).gt('expires_at', t) : null,
        admin.from('approvals').update({ result: { canceled: true } }).eq('id', id).eq('org_id', org),
      ]);
      if (g?.error || p.error) log('warn', 'kapso.cancelar_error', { rid, code: g?.error?.code ?? p.error?.code ?? null });
      // Si la confirmación ganó antes, hay una action de esa IP de estos 10 min: se contesta su estado real.
      const a = await admin.from('actions').select('id, status').eq('org_id', org).eq('target', target)
        .gte('created_at', new Date(ahora - VIDA_BOTON_MS).toISOString()).order('created_at', { ascending: false }).limit(1);
      if (a.error) log('warn', 'kapso.cancelar_lectura_error', { rid, code: a.error.code ?? null });
      const previa = obj((Array.isArray(a.data) ? a.data : [])[0]);
      const previaId = str(previa.id);
      if (previaId && previa.status === 'executed') {
        return r('ya_bloqueada', `No cancelé: ${ipCorta(target)} ya quedó bloqueada. Puedes deshacerlo en la app.`, previaId);
      }
      if (previaId && previa.status === 'proposed') {
        return r('en_curso', `No cancelé: el bloqueo de ${ipCorta(target)} ya se está aplicando. Puedes deshacerlo en la app.`, previaId);
      }
      return r('cancelado', `Cancelado: no bloqueé ${ipCorta(target)}.`);
    }

    const x = await proponerBloqueo(env, { orgId: org, incidente: inc, target, entrega: 'whatsapp', telefono: remitente, rid, ahora });
    if (x.ok) return r('propuesto');                       // la respuesta es el propio interactivo ok/no
    if (x.motivo === 'ya_bloqueada') return r('ya_bloqueada', `${ipCorta(target)} ya está bloqueada. Lo ves en la app.`, x.action_id);
    if (x.motivo === 'sin_conexion') return r('sin_conexion', 'Activa el Modo blindaje con un token de acciones en la app.');
    if (x.motivo === 'ip') return r('ip_no_valida', 'Esa IP no se puede bloquear desde aquí. Revísala en la app.');
    return r('sin_entrega');
  } catch (e) {
    log('error', 'kapso.boton_bloqueo_error', { rid, name: e instanceof Error ? e.name : typeof e });
    return r('error');
  }
}
