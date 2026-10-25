import { CodeReviewEvent, Severity } from '@vanguard/contracts';
import {
  botonesRevision, codigoRevision, fueraDeVentanaDemo, mensajeRevision, planAvisoRevision, TOPES_REVISION,
  type ContactoAviso, type Planned, type UmbralAviso,
} from '@vanguard/core';
import { filasBotonesRevision, nuevoNonce } from '../actions/approvals.ts';
import type { MsgRevision } from '../jobs.ts';
import { db } from '../lib/db.ts';
import { log } from '../lib/log.ts';
import { ventanaAbierta } from '../lib/verificacion.ts';
import { conexionAccion } from '../revision/acciones-pr.ts';
import type { RespuestaCola } from '../wiki/pasos.ts';
import {
  cuerpoInteractivo, cuerpoTexto, enmascararTelefono, enviarKapso, KapsoError, kapsoConfigurado, type MensajeKapso,
} from './kapso.ts';

// Paso 'aviso' de la revisión de código (asignaciones/revision-codigo.md §2.8, §5). Lo encola el paso 'diff' cuando
// vg_review_findings deja alert_state = 'pending'. Lee la revisión, las preferencias (alert_prefs o los valores por
// defecto), los contactos, la org, el cupo propio (revisiones avisadas en la última hora, aparte del tope de los ataques),
// el silencio del repo (code_review_configs.muted_until, botón rvs) y la ventana de la demo; planAvisoRevision de core
// decide. Por WhatsApp: fila queued ANTES de enviar (el unique por revisión, canal y destinatario da 23505 si ya se avisó
// y entonces no sale nada), el interactivo con el texto fijo de mensajeRevision y los botones «Enviarme el arreglo» (fix,
// si hay hallazgos nuevos), «Crear issue» (iss, con hallazgos nuevos y el token de escritura del bloqueo del mismo repo
// con «Issues: Read and write») y «Silenciar repo 1 h» (rvs), una fila de approvals por botón con sha256(nonce) como el
// despachador (anexo avisos-whatsapp-botones.md), y cierre a sent | failed. Si approvals falla, sale el texto sin botones.
// Lo que no sale deja su fila failed o skipped_cap con su motivo y no llama a Kapso: tope, ventana de demo, sin
// verificar, ventana de 24 h cerrada, fuera de producción (dry_run) o sin Kapso. Repo silenciado: ninguna fila y cierre
// not_sent/silenciado. Cierre CAS de la revisión where alert_state = 'pending': sent si algún envío salió; si no,
// not_sent con el motivo. Subpeticiones: 7 de lectura + conexiones del bloqueo 1 + ≤ 5 por contacto (≤ 5) + cierre ≈ 34
// de 40.

type Obj = Record<string, unknown>;
type Contacto = ContactoAviso & { phone: string; wa_last_inbound_at: string | null };
type Revision = {
  id: string; config_id: string | null; event: CodeReviewEvent; branch: string; head_sha: string; pr_number: number | null;
  partial: boolean; counts: Record<Severity, number>; max: Severity | null; reglas: string[]; alert_state: string;
};
type Resultado = { sent_at: string } | { motivo: string };
type Cierre = { status: 'sent'; provider_id: string; sent_at: string } | { status: 'failed'; error: string };

const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const E164 = /^\+[1-9][0-9]{7,14}$/;
const UMBRALES: readonly UmbralAviso[] = ['critical', 'high', 'medium', 'low', 'off'];
const umbral = (x: unknown, defecto: UmbralAviso): UmbralAviso =>
  ((UMBRALES as readonly unknown[]).includes(x) ? x as UmbralAviso : defecto);
const escalonado = (intento: number) => 10 * 2 ** Math.max(0, intento - 1);
// Motivo de una revisión que no avisó a nadie: primero lo que vale para todos (entorno, servidor, demo, cupo); después,
// el contacto que más cerca estuvo (Kapso falló, ventana de 24 h, sin verificar).
const PRIORIDAD_MOTIVO = ['dry_run', 'sin_config', 'fuera_de_ventana_demo', 'cap', 'envio', 'window_closed', 'unverified'];
const ENTREGADO = new Set(['sent', 'delivered', 'read']);

function leerRevision(x: unknown): Revision | null {
  const o = obj(x);
  const id = str(o.id), branch = str(o.branch), head = str(o.head_sha), alert = str(o.alert_state);
  const ev = CodeReviewEvent.safeParse(o.event);
  if (!id || !branch || !head || !alert || !ev.success) return null;
  const c = obj(o.counts);
  const n = (s: Severity) => (typeof c[s] === 'number' ? c[s] as number : 0);
  const max = Severity.safeParse(o.max_severity);
  return { id, config_id: str(o.config_id), event: ev.data, branch, head_sha: head,
    pr_number: typeof o.pr_number === 'number' ? o.pr_number : null,
    partial: o.partial === true, alert_state: alert, max: max.success ? max.data : null,
    counts: { critical: n('critical'), high: n('high'), medium: n('medium'), low: n('low'), info: n('info') },
    reglas: (Array.isArray(o.new_findings) ? o.new_findings : []).map((f) => str(obj(f).rule_id)).filter((r): r is string => !!r) };
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
const codigoError = (e: unknown) =>
  (e instanceof KapsoError ? e.detalle ?? e.code : e instanceof RangeError ? 'invalid' : 'unavailable');

type Aviso = {
  env: CloudflareBindings; admin: ReturnType<typeof db>; orgId: string; rev: Revision; texto: string; ahora: number;
  issue: boolean;   // «Crear issue» se puede ofrecer (puedeCrearIssue)
  sandbox: boolean; // org sandbox de «Ver demo» (0026): fila skipped con el texto (preview), nunca Kapso
};

// Fila que ya existía (23505): un intento anterior llegó hasta aquí y cayó antes de cerrar la revisión. Lo que diga esa
// fila decide el cierre; no se vuelve a enviar. Una queued pudo haber salido: cuenta como ya avisado.
async function yaRegistrada(d: Aviso, recipient_masked: string): Promise<Resultado> {
  const { data, error } = await d.admin.from('notifications').select('status, error, sent_at')
    .eq('org_id', d.orgId).eq('code_review_id', d.rev.id).eq('channel', 'whatsapp').eq('recipient_masked', recipient_masked)
    .maybeSingle();
  const f = obj(data);
  if (error || !data) return { motivo: 'envio' };
  if (ENTREGADO.has(String(f.status)) || f.status === 'queued') return { sent_at: str(f.sent_at) ?? new Date(d.ahora).toISOString() };
  const e = str(f.error);
  return { motivo: e && PRIORIDAD_MOTIVO.includes(e) ? e : 'envio' };
}

// «Crear issue» solo si se puede hacer (anexo: «solo si el token de escritura del bloqueo tiene Issues: Read and write»):
// la conexión GitHub kind 'action' activa de la org, del MISMO repo que la config de la revisión, con capabilities.issues
// = true. Ese permiso lo sondea E53 al conectar el token (sondeoEscrituraPr: POST /issues vacío → 422 = puede) y lo guarda;
// aquí no se llama a GitHub (crearIssue lo vuelve a comprobar al confirmar y, si GitHub lo niega, lo dice). 1
// subpetición; si la base falla, sin el botón.
async function puedeCrearIssue(admin: ReturnType<typeof db>, orgId: string, lecturaId: string, review: string):
  Promise<boolean> {
  try {
    const c = await conexionAccion(admin, orgId, lecturaId);
    return c.ok && c.accion.caps.issues === true;
  } catch {
    log('warn', 'revision.conexion_accion_error', { review });
    return false;
  }
}

// El interactivo del aviso: el texto fijo de mensajeRevision y «Enviarme el arreglo» (solo con hallazgos nuevos: no se
// ofrece lo que no se puede hacer), «Crear issue» (si d.issue) y «Silenciar repo 1 h», un nonce nuevo por botón y su
// sha256 en approvals (colgado de la revisión, 0018). Si approvals falla, el aviso sale igual como texto: el aviso
// importa más que los botones.
async function armarMensaje(d: Aviso, contacto: Contacto, registro: Obj): Promise<MensajeKapso> {
  const conHallazgos = d.rev.reglas.length > 0;
  const nonces = { fix: conHallazgos ? nuevoNonce() : null, iss: conHallazgos && d.issue ? nuevoNonce() : null,
    rvs: nuevoNonce() };
  const botones = botonesRevision(codigoRevision(d.rev.id), nonces);   // valida código y nonces antes de escribir nada
  const filas = await filasBotonesRevision({ org_id: d.orgId, code_review_id: d.rev.id, recipient: contacto.phone.slice(1),
    nonces, ahora: d.ahora });
  const { error } = await d.admin.from('approvals').insert(filas);
  if (error) {
    log('warn', 'revision.sin_botones', { ...registro, code: error.code ?? null });
    return cuerpoTexto(contacto.phone, d.texto);
  }
  return cuerpoInteractivo(contacto.phone, { body: d.texto, botones });
}

async function enviarUno(d: Aviso, p: Planned, contacto: Contacto): Promise<Resultado> {
  const { admin, env, orgId } = d;
  const recipient_masked = enmascararTelefono(contacto.phone);
  const base = { org_id: orgId, code_review_id: d.rev.id, channel: 'whatsapp', template: 'code_review_v1', recipient_masked };
  const registro = { review: d.rev.id, recipient_masked };
  try {
    // Ventana de 24 h de Meta: fuera de ella el texto no llega (131047) y no hay plantillas aprobadas → no se llama a
    // Kapso. Fuera de producción nunca se envía nada real (S15 15.3).
    const omitida = p.status !== 'queued' ? { status: p.status, error: p.error ?? 'cap' }
      : d.sandbox ? { status: 'skipped', error: 'sandbox', preview: d.texto.slice(0, 2000) }
      : !ventanaAbierta(env, contacto.wa_last_inbound_at, d.ahora) ? { status: 'failed', error: 'window_closed' }
      : env.VG_ENV !== 'production' ? { status: 'failed', error: 'dry_run' }
      : !kapsoConfigurado(env) ? { status: 'failed', error: 'sin_config' }
      : null;
    if (omitida) {
      const { error } = await admin.from('notifications').insert({ ...base, ...omitida });
      if (error?.code === '23505') return yaRegistrada(d, recipient_masked);
      if (error) log('warn', 'revision.aviso_sin_fila', { ...registro, code: error.code ?? null, status: omitida.status });
      else log('info', 'revision.aviso_omitido', { ...registro, status: omitida.status, error: omitida.error });
      return { motivo: omitida.error };
    }

    const { data, error } = await admin.from('notifications').insert({ ...base, status: 'queued' }).select('id').single();
    if (error?.code === '23505') {
      log('info', 'revision.ya_avisado', registro);
      return yaRegistrada(d, recipient_masked);
    }
    const id = str(obj(data).id);
    if (error || !id) {
      // Sin fila no se envía: un WhatsApp real sin registro escaparía al cupo y E31 no tendría qué marcar.
      log('warn', 'revision.aviso_sin_fila', { ...registro, code: error?.code ?? null, status: 'queued' });
      return { motivo: 'envio' };
    }
    // Un fallo armando los botones (no debería: el id es un uuid) no deja sin aviso: sale el texto de siempre.
    const mensaje = await armarMensaje(d, contacto, registro).catch((e: unknown) => {
      log('warn', 'revision.sin_botones', { ...registro, name: e instanceof Error ? e.name : typeof e });
      return cuerpoTexto(contacto.phone, d.texto);
    });
    let cierre: Cierre;
    try {
      const { provider_id } = await enviarKapso(env, mensaje);
      cierre = { status: 'sent', provider_id, sent_at: new Date().toISOString() };
    } catch (e) {
      cierre = { status: 'failed', error: codigoError(e) };
    }
    // queued → sent | failed sobre la fila propia y solo si sigue queued (E31 puede haberla movido ya).
    const { error: ec } = await admin.from('notifications').update(cierre).eq('id', id).eq('org_id', orgId).eq('status', 'queued');
    if (ec) log('warn', 'revision.aviso_sin_cierre', { ...registro, code: ec.code ?? null, status: cierre.status });
    if (cierre.status === 'failed') {
      log('warn', 'revision.aviso_error', { ...registro, code: cierre.error });
      return { motivo: 'envio' };
    }
    log('info', 'revision.aviso_enviado', registro);
    return { sent_at: cierre.sent_at };
  } catch (e) {
    log('error', 'revision.aviso_excepcion', { ...registro, name: e instanceof Error ? e.name : typeof e });
    return { motivo: 'envio' };
  }
}

// Cierre CAS: solo una revisión de esa org con el aviso aún pendiente. Si no se puede escribir, retry: el reintento ve
// sus filas (23505) y cierra con lo que digan, sin reenviar.
async function cerrar(d: Pick<Aviso, 'admin' | 'orgId' | 'rev'>, cambio: Obj, intento: number): Promise<RespuestaCola> {
  const { error } = await d.admin.from('code_reviews').update(cambio).eq('id', d.rev.id).eq('org_id', d.orgId)
    .eq('alert_state', 'pending');
  if (error) {
    log('error', 'revision.aviso_cierre_error', { review: d.rev.id, code: error.code ?? null, intento });
    return { retry: escalonado(intento) };
  }
  log('info', 'revision.aviso', { review: d.rev.id, alert_state: cambio.alert_state, motivo: cambio.alert_reason ?? null, intento });
  return 'ack';
}

/** Paso 'aviso' (jobs.ts → revision/pasos.ts). Nunca lanza sin decidir: ack o retry. */
export async function avisarRevision(env: CloudflareBindings, m: MsgRevision, intento = 1): Promise<RespuestaCola> {
  const admin = db(env);
  const orgId = m.org_id;
  const ahora = Date.now();
  const { data, error } = await admin.from('code_reviews')
    .select('id, config_id, event, branch, head_sha, pr_number, partial, counts, max_severity, new_findings, alert_state')
    .eq('id', m.review_id).eq('org_id', orgId).maybeSingle();
  if (error) return { retry: escalonado(intento) };
  const rev = leerRevision(data);
  if (!rev || rev.alert_state !== 'pending') {
    log('info', 'revision.aviso_omitido', { review: m.review_id, alert_state: rev?.alert_state ?? null, intento });
    return 'ack';
  }

  const [p, c, o, n, s] = await Promise.all([
    admin.from('alert_prefs').select('review_whatsapp_min, review_voice_min').eq('org_id', orgId).maybeSingle(),
    admin.from('contacts').select('id, phone_e164, whatsapp, voice, priority, verified_at, wa_last_inbound_at')
      .eq('org_id', orgId).order('priority').limit(10),
    admin.from('orgs').select('is_demo, sandbox_of').eq('id', orgId).maybeSingle(),
    // Cupo propio (§5): revisiones de la org avisadas en la última hora (cuenta revisiones, no filas).
    admin.from('code_reviews').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('alert_state', 'sent')
      .gte('notified_at', new Date(ahora - 3600_000).toISOString()),
    // «Silenciar repo 1 h» (botón rvs, 0018): la configuración de ESTA revisión, en su org.
    rev.config_id ? admin.from('code_review_configs').select('muted_until, connection_id').eq('id', rev.config_id)
      .eq('org_id', orgId).maybeSingle() : null,
  ]);
  if (p.error || c.error || o.error || n.error || !o.data) {
    // Sin el cupo o los contactos no se decide nada: nada escrito, retry (agotado, la DLQ deja not_sent/dlq).
    log('error', 'revision.aviso_lectura_error', { review: rev.id,
      code: p.error?.code ?? c.error?.code ?? o.error?.code ?? n.error?.code ?? null, intento });
    return { retry: escalonado(intento) };
  }
  // Sin el silencio legible (p. ej. 0018 aún sin aplicar) se avisa: falla hacia avisar, el aviso importa más.
  if (s?.error) log('warn', 'revision.silencio_lectura_error', { review: rev.id, code: s.error.code ?? null, intento });
  const silencioHasta = Date.parse(str(obj(s?.data).muted_until) ?? '');
  const silenciado = Number.isFinite(silencioHasta) && silencioHasta > ahora;
  const org = { is_demo: obj(o.data).is_demo === true };
  // M10 de §02.5.1: la ventana de alertas de la org de demo; si no se puede leer, cerrada (falla hacia no avisar).
  let hasta: string | null = null;
  if (org.is_demo) {
    const { data: cfg } = await admin.from('app_config').select('value').eq('key', 'demo_alertas_hasta').maybeSingle();
    hasta = str(obj(cfg).value);
  }
  const prefs = { whatsapp: umbral(obj(p.data).review_whatsapp_min, 'high'), voice: umbral(obj(p.data).review_voice_min, 'critical') };
  // Sandbox de «Ver demo» (0026): no se envía nada real, así que sus contactos cuentan como verificados.
  const sandbox = typeof obj(o.data).sandbox_of === 'string';
  const contactos = leerContactos(c.data).map((x) => (sandbox && !x.verified_at ? { ...x, verified_at: new Date(ahora).toISOString() } : x));
  const plan = planAvisoRevision({ max: rev.max, parcial: rev.partial }, prefs, contactos, n.count ?? 0,
    org.is_demo ? TOPES_REVISION.demo : TOPES_REVISION.normal,
    { fueraDeVentanaDemo: fueraDeVentanaDemo(org, hasta, new Date(ahora)), vozDisponible: false });

  // Las preferencias pudieron cambiar desde el cierre del diff: lo que ya no pasa el umbral queda como lo dejaría la RPC.
  // voice_pending (§5) va en todo cierre sent o not_sent: un aviso pedido no se pierde aunque no salga ningún WhatsApp. En
  // los 'none' no hace falta: el umbral efectivo es el más permisivo, así que si pasa la voz no puede quedar bajo_umbral.
  const base = { admin, orgId, rev };
  const voz = { voice_pending: plan.voz_pendiente };
  if (plan.motivo === 'sin_contactos') {
    return cerrar(base, { alert_state: 'not_sent', alert_reason: 'sin_contactos', ...voz }, intento);
  }
  if (plan.motivo) return cerrar(base, { alert_state: 'none', alert_reason: plan.motivo === 'bajo_umbral' ? plan.motivo : null },
    intento);
  if (silenciado) {
    // Repo silenciado: la revisión y sus hallazgos quedan en la app (el ✗ y el cierre de PR no pasan por aquí). Sin filas
    // ni Kapso, y sin llamada pendiente: el silencio vale para todo aviso de revisión de esa configuración.
    log('info', 'revision.aviso_silenciado', { review: rev.id, hasta: new Date(silencioHasta).toISOString(), intento });
    return cerrar(base, { alert_state: 'not_sent', alert_reason: 'silenciado', voice_pending: false }, intento);
  }

  const origen = (env.APP_ORIGIN ?? '').replace(/\/+$/, '');
  const url = origen ? `${origen}/o/${orgId}/codebase?revision=${rev.id}` : '';
  const texto = mensajeRevision({ evento: rev.event, rama: rev.branch, sha: rev.head_sha, pr: rev.pr_number, counts: rev.counts,
    reglas: rev.reglas, parcial: rev.partial, url });
  const lectura = str(obj(s?.data).connection_id);
  const issue = rev.reglas.length > 0 && !!lectura && await puedeCrearIssue(admin, orgId, lectura, rev.id);
  const d: Aviso = { env, admin, orgId, rev, texto, ahora, issue, sandbox };
  const porId = new Map(contactos.map((x) => [x.id, x]));
  // ≤ 5 contactos (E26): en paralelo, cada uno con su propia fila y su propio manejo de errores.
  const res = await Promise.all(plan.envios.filter((e) => e.channel === 'whatsapp' && !e.p1).map(async (e) => {
    const contacto = porId.get(e.contact_id);
    return contacto ? enviarUno(d, e, contacto) : { motivo: 'sin_contactos' };
  }));
  const salidas = res.flatMap((r) => ('sent_at' in r ? [r.sent_at] : [])).sort();
  if (salidas.length) {
    return cerrar(d, { alert_state: 'sent', alert_reason: null, notified_at: salidas[0], ...voz }, intento);
  }
  const motivos = new Set(res.flatMap((r) => ('motivo' in r ? [r.motivo] : [])));
  const motivo = PRIORIDAD_MOTIVO.find((x) => motivos.has(x)) ?? (motivos.has('sin_contactos') ? 'sin_contactos' : 'envio');
  return cerrar(d, { alert_state: 'not_sent', alert_reason: motivo, ...voz }, intento);
}
