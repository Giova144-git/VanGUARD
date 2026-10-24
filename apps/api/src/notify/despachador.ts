import { Severity, type Module } from '@vanguard/contracts';
import {
  botonesAlerta, ESTADOS_QUE_CUENTAN, estadoTormenta, fueraDeVentanaDemo, ipCanonica, mensajeIncidente, moduloDeRegla,
  ofreceBloqueo, planAvisos, simularBloqueo, textoTormenta, topesDeOrg, TORMENTA_VENTANA_MS, type ContactoAviso,
  type IncidenteAviso, type Planned, type Tormenta,
} from '@vanguard/core';
import { filasBotones, nuevoNonce } from '../actions/approvals.ts';
import { RANGOS_CLOUDFLARE } from '../actions/block-ip.ts';
import { db } from '../lib/db.ts';
import { log } from '../lib/log.ts';
import {
  cuerpoInteractivo, cuerpoTexto, enmascararTelefono, enviarKapso, KapsoError, kapsoConfigurado, type MensajeKapso,
} from './kapso.ts';

// Despachador de avisos externos (S12 12.4–12.6, S15 15.9 y 15.10). Lo llama la evaluación en vivo tras cada
// vg_upsert_incident que lo requiera (nuevo, subida de severidad o reapertura). Lee el incidente (id + org), los
// contactos, el uso de la última hora, la ventana de la demo y la tormenta; planAvisos de core decide; aquí solo se
// escribe y se envía. Por cada WhatsApp: fila queued ANTES de enviar (el unique da 23505 si ya se avisó y entonces no
// sale nada), una fila de approvals por botón con sha256(nonce), el interactivo por Kapso y cierre a sent | failed.
// Lo que no sale (tope, ventana de demo, sin verificar) deja su fila con status y error y no llama a Kapso. La voz es
// P1: sus entradas del plan se ignoran sin fila. Subpeticiones: 5–8 de lectura + ~4 por WhatsApp enviado.
// Tercer botón blk «Bloquear IP» (§12.6): solo si el incidente es CF_ con resource ip:<ip> bloqueable y la org tiene una
// conexión Cloudflare kind:'action' activa (no se ofrece lo que no se puede hacer); su canje lo hace canjearBotonBloqueo (E31).

type Obj = Record<string, unknown>;
type Cliente = ReturnType<typeof db>;
export type RespuestaAviso = { is_new: boolean; prev_severity: string | null; reopened: boolean };
type Incidente = {
  code: string; severity: Severity; rule_ids: string[]; resource: string; status: string; details: Obj;
  last_event_at: string; muted_until: string | null; notified_at: string | null;
};
type Contacto = ContactoAviso & { phone: string };
type Cierre = { status: 'sent'; provider_id: string; sent_at: string } | { status: 'failed'; error: string };

const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const E164 = /^\+[1-9][0-9]{7,14}$/;
const ESTADOS_CUENTAN = [...ESTADOS_QUE_CUENTAN];

function leerIncidente(x: unknown): Incidente | null {
  const o = obj(x);
  const sev = Severity.safeParse(o.severity);
  const code = str(o.code), resource = str(o.resource), status = str(o.status);
  if (!sev.success || !code || !resource || !status || !Array.isArray(o.rule_ids)) return null;
  return { code, severity: sev.data, rule_ids: o.rule_ids.filter((r): r is string => typeof r === 'string'), resource, status,
    details: obj(o.details), last_event_at: str(o.last_event_at) ?? new Date().toISOString(),
    muted_until: str(o.muted_until), notified_at: str(o.notified_at) };
}

function leerContactos(x: unknown): Contacto[] {
  return (Array.isArray(x) ? x : []).map(obj).flatMap((c) => {
    const id = str(c.id), phone = str(c.phone_e164);
    if (!id || !phone || !E164.test(phone)) return [];
    return [{ id, phone, whatsapp: c.whatsapp === true, voice: c.voice === true,
      priority: typeof c.priority === 'number' ? c.priority : 9, verified_at: str(c.verified_at) }];
  });
}

// Código corto para notifications.error y el log: el de Meta/nuestro de KapsoError, nunca un mensaje del proveedor.
const codigoError = (e: unknown) => (e instanceof KapsoError ? e.detalle ?? e.code : e instanceof RangeError ? 'invalid' : 'unavailable');

/** Nunca lanza: todo error va al log (corre en waitUntil detrás de la ingesta). */
export async function avisarIncidente(env: CloudflareBindings, orgId: string, incidentId: string, r: RespuestaAviso,
  rid: string): Promise<void> {
  try {
    await despachar(env, orgId, incidentId, r, rid);
  } catch (e) {
    log('error', 'despacho.error', { rid, name: e instanceof Error ? e.name : typeof e });
  }
}

async function despachar(env: CloudflareBindings, orgId: string, incidentId: string, r: RespuestaAviso, rid: string) {
  const admin = db(env);
  const ahora = Date.now();
  const { data, error } = await admin.from('incidents')
    .select('id, code, severity, rule_ids, resource, status, details, last_event_at, muted_until, notified_at')
    .eq('id', incidentId).eq('org_id', orgId).maybeSingle();
  const inc = leerIncidente(data);
  if (error || !inc) {
    log('warn', 'despacho.sin_incidente', { rid, code: error?.code ?? null });
    return;
  }
  if (inc.status === 'resolved') {
    log('info', 'despacho.sin_avisos', { rid, incidente: inc.code, motivo: 'resuelto' });
    return;
  }
  const prev = Severity.safeParse(r.prev_severity);
  // Severidad y silencio frescos de la fila; el motivo (nuevo, subida, reapertura) es el de la respuesta del upsert.
  const aviso: IncidenteAviso = { severity: inc.severity, prev_severity: prev.success ? prev.data : null,
    is_new: r.is_new === true, reopened: r.reopened === true, muted_until: inc.muted_until };

  // Corte barato antes de leer contactos y topes: sin cambio, silenciado o severidad < high no avisan nunca.
  const corte = planAvisos(aviso, [], { whatsapp: 0, voice: 0 }, { whatsapp: 0, voice: 0 }, 'none', new Date(ahora));
  if (corte.motivo !== 'sin_contactos') {
    log('info', 'despacho.sin_avisos', { rid, incidente: inc.code, motivo: corte.motivo });
    return;
  }

  const desde2m = new Date(ahora - TORMENTA_VENTANA_MS).toISOString();
  // La consulta de la conexión de acciones solo se gasta si el incidente admite el botón blk y E20 aceptaría su IP (ni
  // privada, ni de documentación, ni de Cloudflare; own_ip no aplica al botón).
  const ipIncidente = ofreceBloqueo(inc, true) ? ipCanonica(inc.resource.slice(3)) : null;
  const ipBloqueo = ipIncidente && simularBloqueo(ipIncidente, { zona: '-', cloudflare: RANGOS_CLOUDFLARE }).ok ? ipIncidente : null;
  const [c, o, u, t, accion] = await Promise.all([
    admin.from('contacts').select('id, phone_e164, whatsapp, voice, priority, verified_at')
      .eq('org_id', orgId).order('priority').limit(10),
    admin.from('orgs').select('is_demo').eq('id', orgId).maybeSingle(),
    // used1h de 15.9: un aviso failed o skipped_cap no gasta tope. Los de la revisión de código tampoco (tienen su cupo,
    // TOPES_REVISION): unos pocos pushes no pueden dejar sin aviso un ataque real (revision-codigo.md §5).
    admin.from('notifications').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('channel', 'whatsapp')
      .gte('created_at', new Date(ahora - 3600_000).toISOString()).in('status', ESTADOS_CUENTAN).is('code_review_id', null),
    // Tormenta: incidentes high y critical de la org con started_at en los últimos 2 min (incidents no tiene created_at),
    // este incluido. Los low/medium del ruido de internet no degradan el aviso del ataque (decisión del ORQUESTADOR).
    admin.from('incidents').select('rule_ids', { count: 'exact' }).eq('org_id', orgId).gte('started_at', desde2m)
      .in('severity', ['high', 'critical']).limit(50),
    ipBloqueo ? hayConexionAccion(admin, orgId, rid) : Promise.resolve(false),
  ]);
  if (c.error || o.error || u.error || t.error || !o.data) {
    // Sin el uso de la hora no se puede aplicar el tope: no se envía nada.
    log('error', 'despacho.lectura_error', { rid, incidente: inc.code,
      code: c.error?.code ?? o.error?.code ?? u.error?.code ?? t.error?.code ?? null });
    return;
  }
  const org = { is_demo: obj(o.data).is_demo === true };
  // M10 de §02.5.1: la ventana de alertas de la org de demo; si no se puede leer, cerrada (falla hacia no avisar).
  let hasta: string | null = null;
  if (org.is_demo) {
    const { data: cfg } = await admin.from('app_config').select('value').eq('key', 'demo_alertas_hasta').maybeSingle();
    hasta = str(obj(cfg).value);
  }
  const recientes = (Array.isArray(t.data) ? t.data : []).map((x) => obj(x).rule_ids);
  const k = Math.max(t.count ?? 0, recientes.length);
  let storm: Tormenta = estadoTormenta(k, false);
  if (storm !== 'none') {
    const s = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('org_id', orgId)
      .eq('template', 'storm_v1').gte('created_at', desde2m);
    storm = estadoTormenta(k, s.error ? true : (s.count ?? 0) > 0);   // sin saber, suprimida: nada de ráfagas
  }

  const contactos = leerContactos(c.data);
  const plan = planAvisos(aviso, contactos, { whatsapp: u.count ?? 0, voice: 0 }, topesDeOrg(org), storm, new Date(ahora),
    { fueraDeVentanaDemo: fueraDeVentanaDemo(org, hasta, new Date(ahora)) });
  if (plan.motivo) {
    log('info', 'despacho.sin_avisos', { rid, incidente: inc.code, motivo: plan.motivo });
    return;
  }

  const porId = new Map(contactos.map((x) => [x.id, x]));
  const porModulo: Partial<Record<Module, number>> = {};
  for (const ids of recientes) {
    const m = moduloDeRegla(Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : undefined);
    if (m) porModulo[m] = (porModulo[m] ?? 0) + 1;
  }
  const ctx: Despacho = { env, admin, orgId, incidentId, inc, rid, ahora, k, porModulo, notificado: inc.notified_at !== null,
    ipBloqueo: accion ? ipBloqueo : null };
  // ≤ 5 contactos (E26): en paralelo, cada uno con su propia fila y su propio manejo de errores.
  await Promise.all(plan.envios.filter((p) => p.channel === 'whatsapp' && !p.p1).map(async (p) => {
    const contacto = porId.get(p.contact_id);
    if (contacto) await enviarUno(ctx, p, contacto);
  }));
}

type Despacho = {
  env: CloudflareBindings; admin: Cliente; orgId: string; incidentId: string; inc: Incidente; rid: string; ahora: number;
  k: number; porModulo: Partial<Record<Module, number>>; notificado: boolean;
  ipBloqueo: string | null;   // IP del botón blk, o null si no se ofrece
};

// ¿Tiene la org una conexión Cloudflare kind:'action' activa? Un error de lectura cuenta como no (sin botón blk).
async function hayConexionAccion(admin: Cliente, orgId: string, rid: string): Promise<boolean> {
  const { data, error } = await admin.from('connections').select('id').eq('org_id', orgId).eq('provider', 'cloudflare')
    .eq('kind', 'action').eq('status', 'active').limit(1);
  if (error) log('warn', 'despacho.conexion_accion_error', { rid, code: error.code ?? null });
  return !error && Array.isArray(data) && data.length > 0;
}

async function enviarUno(d: Despacho, p: Planned, contacto: Contacto) {
  const { admin, orgId, rid } = d;
  const recipient_masked = enmascararTelefono(contacto.phone);
  const base = { org_id: orgId, incident_id: d.incidentId, channel: 'whatsapp', template: p.template, recipient_masked };
  const registro = { rid, incidente: d.inc.code, plantilla: p.template, recipient_masked };
  try {
    // Fuera de producción (local, previews, *.workers.dev) nunca se envía nada real (S15 15.3): fila failed dry_run.
    const real = d.env.VG_ENV === 'production';
    const fila = p.status !== 'queued' ? { status: p.status, error: p.error ?? 'cap' }
      : !real ? { status: 'failed', error: 'dry_run' }
      : !kapsoConfigurado(d.env) ? { status: 'failed', error: 'sin_config' }
      : null;
    if (fila) {
      const { error } = await admin.from('notifications').insert({ ...base, ...fila });
      if (error && error.code !== '23505') log('warn', 'despacho.sin_fila', { ...registro, code: error.code ?? null, status: fila.status });
      else log('info', 'despacho.omitido', { ...registro, status: fila.status, error: fila.error, repetido: error?.code === '23505' });
      return;
    }

    // §12.6: la fila queued va ANTES del envío. 23505 = ya avisado a este contacto con esta plantilla: no se repite.
    const { data, error } = await admin.from('notifications').insert({ ...base, status: 'queued' }).select('id').single();
    if (error?.code === '23505') {
      log('info', 'despacho.ya_avisado', registro);
      return;
    }
    const id = str(obj(data).id);
    if (error || !id) {
      // Sin fila no se envía: un WhatsApp real sin registro escaparía al tope por hora.
      log('warn', 'despacho.sin_fila', { ...registro, code: error?.code ?? null, status: 'queued' });
      return;
    }

    let cierre: Cierre;
    try {
      const mensaje = await armarMensaje(d, p, contacto);
      const { provider_id } = await enviarKapso(d.env, mensaje);
      cierre = { status: 'sent', provider_id, sent_at: new Date().toISOString() };
    } catch (e) {
      cierre = { status: 'failed', error: codigoError(e) };
    }
    // queued → sent | failed sobre la fila propia y solo si sigue queued (E31 puede haberla movido ya).
    const { error: ec } = await admin.from('notifications').update(cierre).eq('id', id).eq('org_id', orgId).eq('status', 'queued');
    if (ec) log('warn', 'despacho.sin_cierre', { ...registro, code: ec.code ?? null, status: cierre.status });
    if (cierre.status === 'failed') {
      log('warn', 'despacho.envio_error', { ...registro, code: cierre.error });
      return;
    }
    log('info', 'despacho.enviado', registro);
    // incidents.notified_at = primer envío externo sent (cronómetro de §12.10). Una vez por incidente y llamada.
    if (!d.notificado) {
      d.notificado = true;
      const { error: en } = await admin.from('incidents').update({ notified_at: cierre.sent_at })
        .eq('id', d.incidentId).eq('org_id', orgId);
      if (en) log('warn', 'despacho.sin_notified_at', { rid, incidente: d.inc.code, code: en.code ?? null });
    }
  } catch (e) {
    log('error', 'despacho.envio_excepcion', { ...registro, name: e instanceof Error ? e.name : typeof e });
  }
}

// storm_v1: un texto sin botones. incident_v1 / incident_up_v1 / reopened_v1: el interactivo de §12.6 con ack, snz y, si
// aplica, blk, un nonce nuevo por botón y su sha256 en approvals. Si approvals falla, la alerta sale igual como texto (la
// alerta importa más que los botones; el ack queda en la app).
async function armarMensaje(d: Despacho, p: Planned, contacto: Contacto): Promise<MensajeKapso> {
  if (p.template === 'storm_v1') return cuerpoTexto(contacto.phone, textoTormenta(d.k, d.porModulo));
  if (p.template !== 'incident_v1' && p.template !== 'incident_up_v1' && p.template !== 'reopened_v1') throw new RangeError('PLANTILLA');
  const m = mensajeIncidente(d.inc, p.template);
  const nonces = { ack: nuevoNonce(), snz: nuevoNonce(), blk: d.ipBloqueo ? nuevoNonce() : null };
  const botones = botonesAlerta(d.inc.code, nonces);   // valida código y nonces antes de escribir nada
  const filas = await filasBotones({ org_id: d.orgId, incident_id: d.incidentId, recipient: contacto.phone.slice(1), nonces,
    target: d.ipBloqueo, ahora: d.ahora });
  const { error } = await d.admin.from('approvals').insert(filas);
  if (error) {
    log('warn', 'despacho.sin_botones', { rid: d.rid, incidente: d.inc.code, code: error.code ?? null });
    return cuerpoTexto(contacto.phone, `${m.header}\n\n${m.body}\n\n${m.footer}`);
  }
  return cuerpoInteractivo(contacto.phone, { header: m.header, body: m.body, footer: m.footer, botones });
}
