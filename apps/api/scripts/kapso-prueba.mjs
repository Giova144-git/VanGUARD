// Primer envío real por Kapso (aprobado por Giovanni: 1 o 2 mensajes a su teléfono del sandbox). Desde apps/api:
//   node --env-file-if-exists=../../.env --env-file=.dev.vars scripts/kapso-prueba.mjs [--seco] [--sin-cabecera]
// Usa el código del producto (notify/kapso.ts: cuerpoInteractivo + enviarKapso, que pasa por pedir() y la lista de
// salida) con la alerta incident_v1 de §12.6 y datos de ejemplo, y botones de verdad («Lo estoy viendo» / «Silenciar 1 h»)
// con ids ack|snz:PRUEBA:<nonce>, que E31 registra al pulsarlos. Deja la fila en notifications (org de demo, template
// test_v1, queued → sent con el wamid) para que E31 la pase a delivered/read.
// Destino: KAPSO_TEST_TO (E.164) del .env de la raíz; sin esa línea, aborta sin enviar. Nunca imprime el teléfono, las
// claves ni el wamid entero. --seco arma el mensaje y no envía. --sin-cabecera quita header y footer (si Kapso los rechaza).
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { cuerpoInteractivo, enmascararTelefono, enviarKapso, KapsoError } from '../src/notify/kapso.ts';

// Norton intercepta HTTPS en el equipo de Giovanni: confiar también en la CA del sistema.
if (typeof tls.setDefaultCACertificates === 'function') {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
}

const ORG_DEMO = '00000000-0000-4000-a000-00000000de00';
const seco = process.argv.includes('--seco');
const sinCabecera = process.argv.includes('--sin-cabecera');
const tel = (process.env.KAPSO_TEST_TO ?? '').trim();
if (!/^\+[1-9][0-9]{7,14}$/.test(tel)) {
  console.log('ABORTO: falta KAPSO_TEST_TO (E.164, p. ej. +58…) en el .env de la raíz; no se envía nada.');
  process.exit(1);
}
const { KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID, SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!KAPSO_API_KEY || !KAPSO_PHONE_NUMBER_ID) { console.log('ABORTO: faltan KAPSO_API_KEY o KAPSO_PHONE_NUMBER_ID'); process.exit(1); }

const masked = enmascararTelefono(tel);
const nonce = () => randomBytes(16).toString('base64url');
const hora = new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const mensaje = cuerpoInteractivo(tel, {
  ...(sinCabecera ? {} : { header: 'ALERTA ALTA · Cloudflare (prueba)', footer: 'Incidente #PRUEBA · VanGUARD' }),
  body: 'Prueba de VanGUARD. Una IP hizo 1820 peticiones en 60 s (82% del trafico) contra demo.officialvanguard.com. '
    + `Posible ataque de volumen. Accion propuesta: bloquear la IP.\n\nRecurso: ip:186.92.x.x\nHora: ${hora}`
    + (sinCabecera ? '\nIncidente #PRUEBA' : ''),
  botones: [{ id: `ack:PRUEBA:${nonce()}`, title: 'Lo estoy viendo' }, { id: `snz:PRUEBA:${nonce()}`, title: 'Silenciar 1 h' }],
});
console.log(`Destino ${masked} · ${mensaje.interactive.action.buttons.length} botones · cabecera ${sinCabecera ? 'no' : 'sí'} · body ${mensaje.interactive.body.text.length} car.`);
if (seco) { console.log('SECO: no se envía.'); process.exit(0); }

const admin = SUPABASE_URL && SUPABASE_SECRET_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
let fila = null;
if (admin) {
  const { data, error } = await admin.from('notifications')
    .insert({ org_id: ORG_DEMO, channel: 'whatsapp', template: 'test_v1', recipient_masked: masked, status: 'queued' })
    .select('id').single();
  console.log(error ? `AVISO: sin fila en notifications (${error.code}); envío igual` : 'Fila queued registrada');
  fila = data?.id ?? null;
}
try {
  const { provider_id } = await enviarKapso({ KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID }, mensaje);
  console.log(`OK Kapso aceptó el mensaje · wamid …${provider_id.slice(-6)}`);
  if (admin && fila) {
    const { error } = await admin.from('notifications').update({ status: 'sent', provider_id, sent_at: new Date().toISOString() })
      .eq('id', fila).eq('status', 'queued');
    console.log(error ? `AVISO: la fila no pasó a sent (${error.code})` : 'Fila → sent con el wamid');
  }
} catch (e) {
  const code = e instanceof KapsoError ? `${e.code}${e.status ? ' ' + e.status : ''}${e.detalle ? ' · ' + e.detalle : ''}` : (e?.name ?? 'error');
  console.log(`MAL Kapso rechazó el envío: ${code}`);
  if (admin && fila) await admin.from('notifications').update({ status: 'failed', error: e?.detalle ?? e?.code ?? 'failed' }).eq('id', fila);
  process.exit(1);
}
