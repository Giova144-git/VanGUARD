import { Severity, type Module } from '@vanguard/contracts';
import {
  botonesAlerta, botonOfertaBajoAtaque, contextoLlamada, ESTADOS_QUE_CUENTAN, estadoTormenta, fueraDeVentanaDemo, ipCanonica,
  mensajeIncidente, MIN_IPS_BAJO_ATAQUE, moduloDeRegla, ofreceBajoAtaque, ofreceBloqueo, planAvisos, simularBloqueo,
  textoOfertaBajoAtaque, textoTormenta, topesDeOrg, TORMENTA_VENTANA_MS, type ContactoAviso, type IncidenteAviso,
  type Planned, type Tormenta,
} from '@vanguard/core';
import {
  ACCION_APROBACION_ESCRITURA, ETAPA_BOTON, filasBotones, hashNonce, nuevoNonce, VIDA_BOTON_MS,
} from '../actions/approvals.ts';
import { RANGOS_CLOUDFLARE } from '../actions/block-ip.ts';
import { leerOfertaBajoAtaque } from '../actions/under-attack.ts';
import { db } from '../lib/db.ts';
import { log } from '../lib/log.ts';
import { ventanaAbierta } from '../lib/verificacion.ts';
import {
  cuerpoBotonLlamada, cuerpoInteractivo, cuerpoTexto, enmascararTelefono, enviarKapso, KapsoError, kapsoConfigurado,
  type MensajeKapso,
} from './kapso.ts';
import { esperarLlamada, vozConfigurada } from './voz.ts';

// Despachador de avisos externos (S12 12.4–12.6, S15 15.9 y 15.10). Lo llama la evaluación en vivo tras cada
// vg_upsert_incident que lo requiera (nuevo, subida de severidad o reapertura). Lee el incidente (id + org), los
// contactos, el uso de la última hora, la ventana de la demo y la tormenta; planAvisos de core decide; aquí solo se
// escribe y se envía. Por cada WhatsApp: fila queued ANTES de enviar (el unique da 23505 si ya se avisó y entonces no
// sale nada), una fila de approvals por botón con sha256(nonce), el interactivo por Kapso y cierre a sent | failed.
// Lo que no sale (tope, ventana de demo, sin verificar) deja su fila con status y error y no llama a Kapso. Llamada de
// Guardia (asignaciones/llamada-ataque.md §B1): con VOZ_URL y VOZ_OPERATOR_TOKEN, la entrada voice/call_v1 del plan sale
// DESPUÉS del WhatsApp del incidente: attack/expect y el botón «Llamar a Guardia» (llamarUno; Meta no deja iniciarla);
// sin esas variables se ignora sin fila, como antes. Subpeticiones: 5–8 de lectura (+2 del uso de la voz si está
// configurada) + ~4 por WhatsApp enviado + 3 por llamada.
// Tercer botón blk «Bloquear IP» (§12.6): solo si el incidente es CF_ con resource ip:<ip> bloqueable y la org tiene una
// conexión Cloudflare kind:'action' activa (no se ofrece lo que no se puede hacer); su canje lo hace canjearBotonBloqueo (E31).
// Tras el aviso del incidente, que no cambia, el 2.º mensaje de bajo ataque cuando la oferta aplica (ofrecerBajoAtaque).

type Obj = Record<string, unknown>;
type Cliente = ReturnType<typeof db>;
export type RespuestaAviso = { is_new: boolean; prev_severity: string | null; reopened: boolean };
/** Lo que hizo cada canal (SimulateAttackOut de E57): queued = salió; failed = se intentó y falló al primer intento;
 *  skipped = no aplica (sin contacto, tope, ventana de la demo, sin configurar). */
export type CanalResumen = 'queued' | 'skipped' | 'failed';
export type ResumenAviso = { whatsapp: CanalResumen; voice: CanalResumen };
const SIN_AVISO: ResumenAviso = Object.freeze({ whatsapp: 'skipped', voice: 'skipped' });
type Salida = 'enviado' | 'fallido' | 'omitido';
const resumir = (xs: readonly Salida[]): CanalResumen =>
  (xs.includes('enviado') ? 'queued' : xs.includes('fallido') ? 'failed' : 'skipped');
type Incidente = {
  code: string; severity: Severity; rule_ids: string[]; resource: string; status: string; details: Obj;
  last_event_at: string; muted_until: string | null; notified_at: string | null; event_count: number | null;
};
type Contacto = ContactoAviso & { phone: string; wa_last_inbound_at: string | null };
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
    muted_until: str(o.muted_until), notified_at: str(o.notified_at),
    event_count: typeof o.event_count === 'number' ? o.event_count : null };
}

function leerContactos(x: unknown): Contacto[] {
  return (Array.isArray(x) ? x : []).map(obj).flatMap((c) => {
    const id = str(c.id), phone = str(c.phone_e164);
    if (!id || !phone || !E164.test(phone)) return [];
    return [{ id, phone, whatsapp: c.whatsapp === true, voice: c.voice === true,
      priority: typeof c.priority === 'number' ? c.priority : 9, verified_at: str(c.verified_at),
      wa_last_inbound_at: str(c.wa_last_inbound_at) }];
  });
}

// Código corto para notifications.error y el log: el de Meta/nuestro de KapsoError, nunca un mensaje del proveedor.
const codigoError = (e: unknown) => (e instanceof KapsoError ? e.detalle ?? e.code : e instanceof RangeError ? 'invalid' : 'unavailable');

/** Nunca lanza: todo error va al log (corre en waitUntil detrás de la ingesta). Devuelve lo que hizo cada canal. */
export async function avisarIncidente(env: CloudflareBindings, orgId: string, incidentId: string, r: RespuestaAviso,
  rid: string): Promise<ResumenAviso> {
  try {
    return await despachar(env, orgId, incidentId, r, rid);
  } catch (e) {
    log('error', 'despacho.error', { rid, name: e instanceof Error ? e.name : typeof e });
    return SIN_AVISO;
  }
}

async function despachar(env: CloudflareBindings, orgId: string, incidentId: string, r: RespuestaAviso, rid: string)
  : Promise<ResumenAviso> {
  const admin = db(env);
  const ahora = Date.now();
  const { data, error } = await admin.from('incidents')
    .select('id, code, severity, rule_ids, resource, status, details, last_event_at, muted_until, notified_at, event_count')
    .eq('id', incidentId).eq('org_id', orgId).maybeSingle();
  const inc = leerIncidente(data);
  if (error || !inc) {
    log('warn', 'despacho.sin_incidente', { rid, code: error?.code ?? null });
    return SIN_AVISO;
  }
  if (inc.status === 'resolved') {
    log('info', 'despacho.sin_avisos', { rid, incidente: inc.code, motivo: 'resuelto' });
    return SIN_AVISO;
  }
  const prev = Severity.safeParse(r.prev_severity);
  // Severidad y silencio frescos de la fila; el motivo (nuevo, subida, reapertura) es el de la respuesta del upsert.
  const aviso: IncidenteAviso = { severity: inc.severity, prev_severity: prev.success ? prev.data : null,
    is_new: r.is_new === true, reopened: r.reopened === true, muted_until: inc.muted_until };

  // Corte barato antes de leer contactos y topes: sin cambio, silenciado o severidad < high no avisan nunca.
  const corte = planAvisos(aviso, [], { whatsapp: 0, voice: 0 }, { whatsapp: 0, voice: 0 }, 'none', new Date(ahora));
  if (corte.motivo !== 'sin_contactos') {
    log('info', 'despacho.sin_avisos', { rid, incidente: inc.code, motivo: corte.motivo });
    return SIN_AVISO;
  }

  const desde2m = new Date(ahora - TORMENTA_VENTANA_MS).toISOString();
  // La consulta de la conexión de acciones solo se gasta si el incidente admite el botón blk y E20 aceptaría su IP (ni
  // privada, ni de documentación, ni de Cloudflare; own_ip no aplica al botón).
  const ipIncidente = ofreceBloqueo(inc, true) ? ipCanonica(inc.resource.slice(3)) : null;
  const ipBloqueo = ipIncidente && simularBloqueo(ipIncidente, { zona: '-', cloudflare: RANGOS_CLOUDFLARE }).ok ? ipIncidente : null;
  // Uso de la voz en la última hora (de la org y de todas, TOPE_GLOBAL_LLAMADAS_HORA): solo si se puede llamar.
  const conVoz = vozConfigurada(env);
  const desde1h = new Date(ahora - 3600_000).toISOString();
  const [c, o, u, t, accion, vo, vg] = await Promise.all([
    admin.from('contacts').select('id, phone_e164, whatsapp, voice, priority, verified_at, wa_last_inbound_at')
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
    conVoz ? admin.from('notifications').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('channel', 'voice')
      .gte('created_at', desde1h).in('status', ESTADOS_CUENTAN) : Promise.resolve(null),
    conVoz ? admin.from('notifications').select('id', { count: 'exact', head: true }).eq('channel', 'voice')
      .gte('created_at', desde1h).in('status', ESTADOS_CUENTAN) : Promise.resolve(null),
  ]);
  if (c.error || o.error || u.error || t.error || !o.data) {
    // Sin el uso de la hora no se puede aplicar el tope: no se envía nada.
    log('error', 'despacho.lectura_error', { rid, incidente: inc.code,
      code: c.error?.code ?? o.error?.code ?? u.error?.code ?? t.error?.code ?? null });
    return SIN_AVISO;
  }
  // Sin el uso de la voz no se puede aplicar su tope: no hay llamada (el WhatsApp sale igual).
  const vozLeida = conVoz && vo !== null && vg !== null && !vo.error && !vg.error;
  if (conVoz && !vozLeida) {
    log('warn', 'despacho.uso_voz_error', { rid, incidente: inc.code, code: vo?.error?.code ?? vg?.error?.code ?? null });
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
  const plan = planAvisos(aviso, contactos, { whatsapp: u.count ?? 0, voice: vozLeida ? vo?.count ?? 0 : 0 }, topesDeOrg(org),
    storm, new Date(ahora), { fueraDeVentanaDemo: fueraDeVentanaDemo(org, hasta, new Date(ahora)),
      ...(vozLeida ? { usoGlobal: { voice: vg?.count ?? 0 } } : {}) });
  if (plan.motivo) {
    log('info', 'despacho.sin_avisos', { rid, incidente: inc.code, motivo: plan.motivo });
    return SIN_AVISO;
  }

  const porId = new Map(contactos.map((x) => [x.id, x]));
  const porModulo: Partial<Record<Module, number>> = {};
  for (const ids of recientes) {
    const m = moduloDeRegla(Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : undefined);
    if (m) porModulo[m] = (porModulo[m] ?? 0) + 1;
  }
  const ctx: Despacho = { env, admin, orgId, incidentId, inc, rid, ahora, k, porModulo, notificado: inc.notified_at !== null,
    ipBloqueo: accion ? ipBloqueo : null,
    // Lo que queda del tope de WhatsApp de la hora tras los avisos que el plan deja salir (el 2.º mensaje también gasta).
    cupoWhatsapp: topesDeOrg(org).whatsapp - (u.count ?? 0)
      - plan.envios.filter((x) => x.channel === 'whatsapp' && x.status === 'queued').length };
  // ≤ 5 contactos (E26): en paralelo, cada uno con su propia fila y su propio manejo de errores.
  const salieron = await Promise.all(plan.envios.filter((p) => p.channel === 'whatsapp' && !p.p1).map(async (p) => {
    const contacto = porId.get(p.contact_id);
    if (!contacto) return null;
    const salida = await enviarUno(ctx, p, contacto);
    return { salida, contacto: salida === 'enviado' && p.template !== 'storm_v1' ? contacto : null };
  }));
  // 2.º mensaje, DESPUÉS del aviso del incidente y solo a quien le salió.
  const conAviso = salieron.flatMap((x) => (x?.contacto ? [x.contacto] : [])).sort((a, b) => a.priority - b.priority);
  if (conAviso.length) await ofrecerBajoAtaque(ctx, conAviso);
  // La llamada, al final: Guardia menciona el WhatsApp. Sin la voz configurada o sin su uso leído, nada (ni fila).
  const llamadas: Salida[] = [];
  if (vozLeida) {
    for (const p of plan.envios.filter((x) => x.channel === 'voice')) {
      const contacto = porId.get(p.contact_id);
      if (contacto) llamadas.push(await llamarUno(ctx, p, contacto));
    }
  }
  return { whatsapp: resumir(salieron.flatMap((x) => (x ? [x.salida] : []))), voice: resumir(llamadas) };
}

type Despacho = {
  env: CloudflareBindings; admin: Cliente; orgId: string; incidentId: string; inc: Incidente; rid: string; ahora: number;
  k: number; porModulo: Partial<Record<Module, number>>; notificado: boolean;
  ipBloqueo: string | null;   // IP del botón blk, o null si no se ofrece
  cupoWhatsapp: number;       // WhatsApp que aún caben en el tope de la hora de la org
};

// ¿Tiene la org una conexión Cloudflare kind:'action' activa? Un error de lectura cuenta como no (sin botón blk).
async function hayConexionAccion(admin: Cliente, orgId: string, rid: string): Promise<boolean> {
  const { data, error } = await admin.from('connections').select('id').eq('org_id', orgId).eq('provider', 'cloudflare')
    .eq('kind', 'action').eq('status', 'active').limit(1);
  if (error) log('warn', 'despacho.conexion_accion_error', { rid, code: error.code ?? null });
  return !error && Array.isArray(data) && data.length > 0;
}

// 'enviado' si el aviso salió (Kapso lo aceptó): el 2.º mensaje solo va detrás de un aviso enviado. 'fallido' si se
// intentó y falló; 'omitido' si no se intentó (tope, ventana, sin verificar, dry_run, ya avisado).
async function enviarUno(d: Despacho, p: Planned, contacto: Contacto): Promise<Salida> {
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
      return fila.error === 'sin_config' ? 'fallido' : 'omitido';
    }

    // §12.6: la fila queued va ANTES del envío. 23505 = ya avisado a este contacto con esta plantilla: no se repite.
    const { data, error } = await admin.from('notifications').insert({ ...base, status: 'queued' }).select('id').single();
    if (error?.code === '23505') {
      log('info', 'despacho.ya_avisado', registro);
      return 'omitido';
    }
    const id = str(obj(data).id);
    if (error || !id) {
      // Sin fila no se envía: un WhatsApp real sin registro escaparía al tope por hora.
      log('warn', 'despacho.sin_fila', { ...registro, code: error?.code ?? null, status: 'queued' });
      return 'fallido';
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
      return 'fallido';
    }
    log('info', 'despacho.enviado', registro);
    await marcarNotificado(d, cierre.sent_at);
    return 'enviado';
  } catch (e) {
    log('error', 'despacho.envio_excepcion', { ...registro, name: e instanceof Error ? e.name : typeof e });
    return 'fallido';
  }
}

// incidents.notified_at = primer envío externo sent (cronómetro de §12.10). Una vez por incidente y llamada.
async function marcarNotificado(d: Despacho, sentAt: string) {
  if (d.notificado) return;
  d.notificado = true;
  const { error } = await d.admin.from('incidents').update({ notified_at: sentAt }).eq('id', d.incidentId).eq('org_id', d.orgId);
  if (error) log('warn', 'despacho.sin_notified_at', { rid: d.rid, incidente: d.inc.code, code: error.code ?? null });
}

// ── Botón «Llamar a Guardia» (asignaciones/llamada-ataque.md §B1) ────────────────────────────────────────────────────
// Meta no deja a esta cuenta iniciar llamadas (138013): la entrada voice/call_v1 del plan se hace botón. Como enviarUno:
// lo que el plan no deja salir (tope, tope global, ventana de la demo, sin verificar), fuera de producción, sin Kapso o
// con la ventana de 24 h cerrada deja su fila (failed window_closed…) y no llama a nadie; si sale, fila queued ANTES
// (23505 = ya se le ofreció a ese contacto por este incidente), UN POST attack/expect al servidor de voz con el contexto
// (contextoLlamada) y el ticket vg:<código>, y solo con su 200 el interactivo voice_call por Kapso: sent con el wamid;
// expect fallido → failed voz_no_disponible sin botón; Kapso fallido → failed con su código. Sin reintentos.
export const PLANTILLA_BOTON_LLAMADA = 'call_button_v1';
async function llamarUno(d: Despacho, p: Planned, contacto: Contacto): Promise<Salida> {
  const recipient_masked = enmascararTelefono(contacto.phone);
  const base = { org_id: d.orgId, incident_id: d.incidentId, channel: 'voice', template: PLANTILLA_BOTON_LLAMADA, recipient_masked };
  const registro = { rid: d.rid, incidente: d.inc.code, recipient_masked };
  try {
    const fila = p.status !== 'queued' ? { status: p.status, error: p.error ?? 'cap' }
      : d.env.VG_ENV !== 'production' ? { status: 'failed', error: 'dry_run' }
      : !kapsoConfigurado(d.env) ? { status: 'failed', error: 'sin_config' }
      : !ventanaAbierta(d.env, contacto.wa_last_inbound_at, d.ahora) ? { status: 'failed', error: 'window_closed' } : null;
    if (fila) {
      const { error } = await d.admin.from('notifications').insert({ ...base, ...fila });
      if (error && error.code !== '23505') log('warn', 'despacho.sin_fila', { ...registro, canal: 'voice', code: error.code ?? null });
      else log('info', 'voz.omitida', { ...registro, status: fila.status, error: fila.error });
      return 'omitido';
    }
    const { data, error } = await d.admin.from('notifications').insert({ ...base, status: 'queued' }).select('id').single();
    if (error?.code === '23505') {
      log('info', 'voz.ya_llamado', registro);
      return 'omitido';
    }
    const id = str(obj(data).id);
    if (error || !id) {
      // Sin fila no se llama: una llamada sin registro escaparía al tope por hora.
      log('warn', 'despacho.sin_fila', { ...registro, canal: 'voice', code: error?.code ?? null });
      return 'fallido';
    }
    const ticket = `vg:${d.inc.code}`;
    const espera = await esperarLlamada(d.env, contacto.phone.slice(1), contextoLlamada(d.inc), ticket);
    let cierre: Cierre;
    if (espera.tipo !== 'ok') {
      log('warn', 'voz.espera_fallida', { ...registro, status: espera.status });
      cierre = { status: 'failed', error: 'voz_no_disponible' };
    } else {
      try {
        const { provider_id } = await enviarKapso(d.env, cuerpoBotonLlamada(contacto.phone, ticket));
        cierre = { status: 'sent', provider_id, sent_at: new Date().toISOString() };
      } catch (e) {
        cierre = { status: 'failed', error: codigoError(e) };
      }
    }
    const { error: ec } = await d.admin.from('notifications').update(cierre).eq('id', id).eq('org_id', d.orgId).eq('status', 'queued');
    if (ec) log('warn', 'despacho.sin_cierre', { ...registro, canal: 'voice', code: ec.code ?? null, status: cierre.status });
    if (cierre.status === 'sent') {
      log('info', 'voz.boton_enviado', { ...registro, minutos: espera.tipo === 'ok' ? espera.minutos : null });
      await marcarNotificado(d, cierre.sent_at);
      return 'enviado';
    }
    log('warn', 'voz.boton_fallido', { ...registro, error: cierre.error });
    return 'fallido';
  } catch (e) {
    log('error', 'voz.llamada_excepcion', { ...registro, name: e instanceof Error ? e.name : typeof e });
    return 'fallido';
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

// ── 2.º mensaje: la oferta del modo bajo ataque (modo-bajo-ataque.md y avisos-whatsapp-botones.md) ────────────────────
/** Plantilla de su fila en notifications (cabe en el check ^[a-z0-9_]{3,40}$ de 0005). */
export const PLANTILLA_OFERTA_BAJO_ATAQUE = 'bajo_ataque_v1';

// Tras el aviso del incidente (que no cambia y ya usa sus 3 botones), si la oferta aplica con la MISMA regla que E55
// (leerOfertaBajoAtaque: CF_IP_FLOOD no resuelto con host canónico, ≥ 2 incidentes de inundación de ese host, conexión
// Cloudflare action de su zona, host no protegido, sin otro modo vivo o en curso y sin un 403 de Config Rules): «Ataque
// desde {n} IPs en {host}. Puedes poner ese host en modo bajo ataque 30 min.» con «Modo bajo ataque» (uat → su
// confirmación «Sí, activar» / «Cancelar», actions/botones-escritura.ts). A UN contacto: el de mayor prioridad al que le
// salió el aviso y con la ventana de 24 h abierta (fuera de ella no se manda: queda en la app); el aviso ya pasó el cupo
// y la ventana de la demo. Fila en notifications (cuenta en el cupo de incidentes y su unique evita repetir la oferta si
// el incidente sube de severidad), una fila de approvals (under_attack_on, etapa 'proponer', solo el sha256) y cierre
// sent | failed. Fuera de producción o sin Kapso, nada. Subpeticiones: oferta 3 + fila 1 + approvals 1 + envío ≤ 2 +
// cierre 1 ≤ 8 (COSTE_OFERTA_BAJO_ATAQUE, que el motor reserva para los incidentes con CF_IP_FLOOD). Nunca lanza.
async function ofrecerBajoAtaque(d: Despacho, conAviso: readonly Contacto[]) {
  const registro = { rid: d.rid, incidente: d.inc.code };
  try {
    // Corte puro antes de leer nada: sin CF_IP_FLOOD, resuelto o sin host canónico no se ofrece nunca.
    if (!ofreceBajoAtaque(d.inc, MIN_IPS_BAJO_ATAQUE).ofrece) return;
    if (d.env.VG_ENV !== 'production' || !kapsoConfigurado(d.env)) return;
    // El 2.º mensaje gasta del mismo tope por hora que los avisos (TOPES_AVISOS.whatsapp): sin cupo, no sale.
    if (d.cupoWhatsapp <= 0) {
      log('info', 'despacho.oferta_omitida', { ...registro, motivo: 'cap' });
      return;
    }
    const contacto = conAviso.find((c) => ventanaAbierta(d.env, c.wa_last_inbound_at, d.ahora));
    if (!contacto) {
      log('info', 'despacho.oferta_omitida', { ...registro, motivo: 'window_closed' });
      return;
    }
    const oferta = await leerOfertaBajoAtaque(d.env, { orgId: d.orgId, rid: d.rid, ahora: d.ahora, incidente: {
      id: d.incidentId, code: d.inc.code, rule_ids: d.inc.rule_ids, severity: d.inc.severity, resource: d.inc.resource,
      status: d.inc.status, details: d.inc.details } });
    if (!oferta.ofrece || oferta.motivo !== null || !oferta.hostname) {
      log('info', 'despacho.oferta_omitida', { ...registro, motivo: oferta.motivo ?? 'no_aplica' });
      return;
    }
    const texto = textoOfertaBajoAtaque(oferta.ips, oferta.hostname);
    const nonce = nuevoNonce();
    const botones = botonOfertaBajoAtaque(d.inc.code, nonce);   // valida código y nonce antes de escribir nada
    const recipient_masked = enmascararTelefono(contacto.phone);
    const base = { org_id: d.orgId, incident_id: d.incidentId, channel: 'whatsapp', template: PLANTILLA_OFERTA_BAJO_ATAQUE,
      recipient_masked };
    const reg = { ...registro, plantilla: PLANTILLA_OFERTA_BAJO_ATAQUE, recipient_masked };
    const { data, error } = await d.admin.from('notifications').insert({ ...base, status: 'queued' }).select('id').single();
    if (error?.code === '23505') {
      log('info', 'despacho.ya_avisado', reg);
      return;
    }
    const id = str(obj(data).id);
    if (error || !id) {
      log('warn', 'despacho.sin_fila', { ...reg, code: error?.code ?? null, status: 'queued' });
      return;
    }
    const { error: ea } = await d.admin.from('approvals').insert({ org_id: d.orgId, incident_id: d.incidentId,
      action_kind: ACCION_APROBACION_ESCRITURA.uat, channel: 'whatsapp', recipient: contacto.phone.slice(1),
      nonce_hash: await hashNonce(nonce), expires_at: new Date(d.ahora + VIDA_BOTON_MS).toISOString(),
      params: { etapa: ETAPA_BOTON.blk } });
    let cierre: Cierre;
    if (ea) {
      // Sin su botón la oferta no sirve de nada: no sale (el modo sigue en la tarjeta del incidente, E55).
      log('warn', 'despacho.sin_botones', { ...reg, code: ea.code ?? null });
      cierre = { status: 'failed', error: 'sin_botones' };
    } else {
      try {
        const { provider_id } = await enviarKapso(d.env, cuerpoInteractivo(contacto.phone, {
          header: 'Modo bajo ataque · Cloudflare', body: texto, footer: `Incidente #${d.inc.code} · VanGUARD`, botones }));
        cierre = { status: 'sent', provider_id, sent_at: new Date().toISOString() };
      } catch (e) {
        cierre = { status: 'failed', error: codigoError(e) };
      }
    }
    const { error: ec } = await d.admin.from('notifications').update(cierre).eq('id', id).eq('org_id', d.orgId)
      .eq('status', 'queued');
    if (ec) log('warn', 'despacho.sin_cierre', { ...reg, code: ec.code ?? null, status: cierre.status });
    if (cierre.status === 'failed') log('warn', 'despacho.envio_error', { ...reg, code: cierre.error });
    else log('info', 'despacho.enviado', { ...reg, ips: oferta.ips });
  } catch (e) {
    log('error', 'despacho.oferta_error', { ...registro, name: e instanceof Error ? e.name : typeof e });
  }
}
