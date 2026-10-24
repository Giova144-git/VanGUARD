// Prueba de humo (4) de §15.14: sesión anónima y Realtime privado. Desde apps/api:
//   SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=sb_publishable_… node scripts/humo-auth.mjs
// Solo usa la clave PUBLICABLE (pública por diseño, aplica RLS). Comprueba:
//   (1) signInAnonymously da un JWT con is_anonymous=true y rol authenticated;
//   (2) join_demo_org() une la sesión como viewer a la org de demo;
//   (3) el canal privado org:<demo> llega a SUBSCRIBED y recibe un broadcast
//       (se dispara aparte con realtime.send o con un cambio en scan_runs/findings/incidents de la demo);
//   (4) un canal público es rechazado («Allow public access» OFF);
//   (5) el canal privado de otra org (IDOR A) es rechazado.
// Nunca imprime el JWT ni la clave: solo OK/MAL por caso.
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
const ESPERA_MS = Number(process.env.HUMO_ESPERA_MS || 45_000);
const ORG_IDOR_A = '00000000-0000-4000-a000-00000000a001';
if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) { console.log('MAL faltan SUPABASE_URL o SUPABASE_PUBLISHABLE_KEY'); process.exit(1); }

let fallos = 0;
const ok = (n, b) => { console.log(`${b ? 'OK ' : 'MAL'} ${n}`); if (!b) fallos++; };
const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// El cliente reintenta solo tras un CHANNEL_ERROR (p. ej. mientras arranca el tenant de Realtime): se espera hasta 20 s
// a SUBSCRIBED y se devuelve el último estado visto. Un canal rechazado nunca llega a SUBSCRIBED.
const suscribir = (topic, privado) => new Promise((resolve) => {
  const ch = sb.channel(topic, { config: { private: privado } });
  let ultimo = 'SIN_RESPUESTA';
  const t = setTimeout(() => resolve({ ch, estado: ultimo }), 20_000);
  ch.subscribe((estado) => { ultimo = estado; if (estado === 'SUBSCRIBED') { clearTimeout(t); resolve({ ch, estado }); } });
});

try {
  const { data, error } = await sb.auth.signInAnonymously();
  ok('signInAnonymously', !error && !!data.session);
  const claims = JSON.parse(Buffer.from(data.session.access_token.split('.')[1], 'base64url').toString());
  ok('JWT con is_anonymous=true y rol authenticated', claims.is_anonymous === true && claims.role === 'authenticated');

  const { data: demo, error: ej } = await sb.rpc('join_demo_org');
  ok('join_demo_org devuelve la org de demo', !ej && typeof demo === 'string');
  // Informativo: en este proyecto authenticated no tiene SELECT en las tablas de public (los datos van por la API);
  // si algún día se concede, RLS debe dejar ver solo la org de demo.
  const { data: orgs, error: eo } = await sb.from('orgs').select('id, is_demo');
  console.log(eo ? 'INFO lectura directa de orgs denegada (sin GRANT a authenticated)' : `INFO lectura directa de orgs: ${orgs.length} fila(s)`);
  if (!eo) ok('por RLS solo ve la org de demo', orgs.length === 1 && orgs[0].id === demo);

  await sb.realtime.setAuth(data.session.access_token);
  let recibido = null;
  const privado = await suscribir(`org:${demo}`, true);
  for (const ev of ['INSERT', 'UPDATE', 'DELETE']) privado.ch.on('broadcast', { event: ev }, (m) => { recibido = m; });
  ok(`canal privado org:<demo> → ${privado.estado}`, privado.estado === 'SUBSCRIBED');

  const publico = await suscribir('humo-publico', false);
  ok(`canal público rechazado (${publico.estado})`, publico.estado !== 'SUBSCRIBED');
  const ajeno = await suscribir(`org:${ORG_IDOR_A}`, true);
  ok(`canal privado de otra org rechazado (${ajeno.estado})`, ajeno.estado !== 'SUBSCRIBED');

  console.log(`ESPERANDO broadcast en org:<demo> hasta ${ESPERA_MS / 1000} s…`);
  const t0 = Date.now();
  while (!recibido && Date.now() - t0 < ESPERA_MS) await new Promise((r) => setTimeout(r, 500));
  ok('broadcast recibido en el canal privado', !!recibido);
  await sb.removeAllChannels();
  await sb.auth.signOut();
} catch (e) {
  fallos++;
  console.log(`MAL error: ${e?.name ?? 'desconocido'}`);
}
console.log(fallos ? `humo-auth: ${fallos} fallo(s)` : 'humo-auth: todo OK');
process.exit(fallos ? 1 : 0);
