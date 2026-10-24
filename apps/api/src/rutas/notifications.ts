import { Hono, type Context } from 'hono';
import { NotificationTest, NotificationTestResult } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError, fail } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';
import { requireProdHost } from '../mw/prod-host.ts';
import { enmascararTelefono, enviarTexto, KapsoError, kapsoConfigurado } from '../notify/kapso.ts';

// E27 · POST /api/orgs/:org/notifications/test · admin · solo officialvanguard.com · P0 (S15 15.4). WhatsApp al
// contacto prioritario con whatsapp=true; solo si está verificado (§06.9). No pasa por el despachador ni mira la ventana
// de la demo (§02.5.1). La voz es P1: 409 voice_disabled.
export const notifications = new Hono<AppEnv>();

export const PLANTILLA_PRUEBA = 'test_v1';
// Topes de WhatsApp reales por org y hora (§06.9): 10, y 30 en la org de demo. Las filas failed y skipped_cap no cuentan.
const TOPE_WHATSAPP_HORA = 10;
const TOPE_WHATSAPP_HORA_DEMO = 30;
const CUENTAN = ['queued', 'sent', 'delivered', 'read'];

export const textoPrueba = (org: string) =>
  `Prueba de VanGUARD: este WhatsApp recibira las alertas de seguridad de ${org.trim().slice(0, 80)}. No hace falta responder.`;

type Fila = { recipient_masked: string; status: 'queued' | 'failed' | 'skipped_cap'; error?: string };
type Cierre = { status: 'sent'; provider_id: string; sent_at: string } | { status: 'failed'; error: string };

// Fila sin incidente: incident_id nulo solo vale con la plantilla de prueba (0008g). Devuelve su id, o null si no se
// pudo escribir (queda el log).
async function registrar(c: Context<AppEnv>, fila: Fila): Promise<string | null> {
  const { data, error } = await db(c.env).from('notifications')
    .insert({ org_id: c.get('orgId'), channel: 'whatsapp', template: PLANTILLA_PRUEBA, ...fila }).select('id').single();
  const id = (data as { id?: unknown } | null)?.id;
  if (error || typeof id !== 'string') {
    log('warn', 'notificacion.prueba_sin_fila', { rid: c.get('rid'), code: error?.code ?? null, status: fila.status });
    return null;
  }
  return id;
}

// queued → sent | failed sobre la fila propia (id + org) y solo si sigue queued. Si falla, la fila se queda queued (que
// cuenta para los topes) y solo queda el log: el mensaje ya salió o ya falló, la respuesta no cambia.
async function cerrar(c: Context<AppEnv>, id: string, cambio: Cierre) {
  const { error } = await db(c.env).from('notifications').update(cambio)
    .eq('id', id).eq('org_id', c.get('orgId')).eq('status', 'queued');
  if (error) log('warn', 'notificacion.prueba_sin_cierre', { rid: c.get('rid'), code: error.code, status: cambio.status });
}

notifications.post('/orgs/:org/notifications/test', requireAdmin, requireProdHost, async (c) => {
  const { channel } = await cuerpo(c, NotificationTest);
  if (channel === 'voice') throw new ApiError('conflict', 'La llamada de prueba todavía no está activa', { reason: 'voice_disabled' });

  // RL_COSTLY (§06.9): 10 por minuto y usuario.
  const { success } = await c.env.RL_COSTLY.limit({ key: `u:${c.get('userId')}` });
  if (!success) {
    c.header('Retry-After', '60');
    return fail(c, 'rate_limited', 'Demasiadas pruebas seguidas. Espera un minuto.');
  }

  const admin = db(c.env);
  const orgId = c.get('orgId');
  const rid = c.get('rid');
  const { data: contacto, error: ec } = await admin.from('contacts').select('id, phone_e164, verified_at')
    .eq('org_id', orgId).eq('whatsapp', true).order('priority').limit(1).maybeSingle();
  if (ec) {
    log('error', 'notificacion.prueba_contacto_error', { rid, code: ec.code });
    throw new ApiError('internal', 'No pudimos leer los contactos');
  }
  if (!contacto) throw new ApiError('conflict', 'No hay ningún contacto con WhatsApp activo', { reason: 'no_contact' });
  const telefono = String(contacto.phone_e164);
  const recipient_masked = enmascararTelefono(telefono);

  if (!contacto.verified_at) {
    await registrar(c, { recipient_masked, status: 'failed', error: 'unverified' });
    log('info', 'notificacion.prueba_sin_verificar', { rid, recipient_masked });
    throw new ApiError('conflict', 'Ese contacto aún no está verificado: no le enviamos nada real', { reason: 'unverified' });
  }

  const desde = new Date(Date.now() - 3600_000).toISOString();
  const [{ data: org, error: eo }, { count, error: en }] = await Promise.all([
    admin.from('orgs').select('name, is_demo').eq('id', orgId).maybeSingle(),
    admin.from('notifications').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('channel', 'whatsapp')
      .gte('created_at', desde).in('status', CUENTAN),
  ]);
  if (eo || en || !org) {
    log('error', 'notificacion.prueba_tope_error', { rid, code: eo?.code ?? en?.code ?? null });
    throw new ApiError('internal', 'No pudimos comprobar el tope de avisos');
  }
  const tope = org.is_demo === true ? TOPE_WHATSAPP_HORA_DEMO : TOPE_WHATSAPP_HORA;
  if ((count ?? 0) >= tope) {
    await registrar(c, { recipient_masked, status: 'skipped_cap', error: 'cap' });
    throw new ApiError('budget_exceeded', `Llegaste al tope de ${tope} WhatsApp por hora`, { reason: 'cap', cap: tope });
  }

  if (!kapsoConfigurado(c.env)) {
    log('error', 'notificacion.prueba_sin_config', { rid });
    throw new ApiError('provider_unavailable', 'El envío por WhatsApp no está configurado en el servidor', { provider_code: 'sin_config' });
  }
  // §12.6: la fila queued va ANTES del envío, para que el tope la cuente y E31 tenga qué marcar. Sin fila no se envía:
  // un WhatsApp real sin registro escaparía al tope por hora.
  const fila = await registrar(c, { recipient_masked, status: 'queued' });
  if (!fila) throw new ApiError('internal', 'No pudimos registrar el aviso de prueba; no enviamos nada');
  let provider_id: string;
  try {
    ({ provider_id } = await enviarTexto(c.env, telefono, textoPrueba(String(org.name ?? 'tu organizacion'))));
  } catch (e) {
    const code = e instanceof KapsoError ? e.detalle ?? e.code : 'unavailable';
    await cerrar(c, fila, { status: 'failed', error: code });
    log('warn', 'notificacion.prueba_error', { rid, recipient_masked, code, status: e instanceof KapsoError ? e.status ?? null : null });
    throw new ApiError('provider_unavailable', 'WhatsApp no aceptó el mensaje de prueba', { provider_code: code });
  }
  // provider_id solo existe tras el 200 de Kapso: un estado de E31 que llegue antes de este update no encuentra la fila
  // (ventana de una ida y vuelta a la base).
  await cerrar(c, fila, { status: 'sent', provider_id, sent_at: new Date().toISOString() });
  log('info', 'notificacion.prueba_enviada', { rid, recipient_masked });
  return c.json(NotificationTestResult.parse({ ok: true, provider_id }));
});
