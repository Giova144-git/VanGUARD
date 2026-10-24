// Prueba de humo (4) de §15.14: sesión anónima y Realtime privado. Desde apps/api:
//   SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=sb_publishable_… node scripts/humo-auth.mjs
// Solo usa la clave PUBLICABLE (pública por diseño, aplica RLS). Comprueba:
//   (1) signInAnonymously da un JWT con is_anonymous=true y rol authenticated;
//   (2) E4 POST /api/demo/join une la sesión como viewer a la org de demo, y la RPC join_demo_org está revocada (0008d);
//   (3) el canal privado org:<demo> llega a SUBSCRIBED y recibe un broadcast
//       (se dispara aparte con realtime.send o con un cambio en scan_runs/findings/incidents de la demo);
//   (4) un canal público es rechazado («Allow public access» OFF);
//   (5) el canal privado de otra org (IDOR A) es rechazado;
//   (6) si llega un broadcast, su payload es el mínimo de 0008e (sin la fila entera).
// Con HUMO_DISPARAR=1 (y SUPABASE_SECRET_KEY en el entorno, p. ej. `node --env-file=.dev.vars`) el propio script dispara
// el broadcast: inserta una auditoría failed de prueba en scan_runs de la demo (pasa por el trigger) y la borra al acabar.
// La clave secreta solo se usa para eso; las comprobaciones (1)–(6) van con la publicable.
// Nunca imprime el JWT ni la clave: solo OK/MAL por caso.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const ESPERA_MS = Number(process.env.HUMO_ESPERA_MS || 45_000);
const API = process.env.HUMO_API || 'https://officialvanguard.com';   // E4 de la API desplegada (o http://localhost:8787)
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

  // «Ver demo» por la vía principal: E4 de la API (el FRONT hace lo mismo). La RPC join_demo_org quedó revocada (0008d).
  const r4 = await fetch(`${API}/api/demo/join`, { method: 'POST', headers: { authorization: `Bearer ${data.session.access_token}` } });
  const demo = (await r4.json().catch(() => null))?.org_id;
  ok(`E4 POST /api/demo/join → ${r4.status} con la org de demo`, r4.status === 200 && typeof demo === 'string');
  const { error: ej } = await sb.rpc('join_demo_org');
  ok('la RPC join_demo_org ya no es ejecutable por authenticated (42501)', ej?.code === '42501');
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

  let disparo = null;
  if (process.env.HUMO_DISPARAR === '1' && process.env.SUPABASE_SECRET_KEY) {
    const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: fila, error: ef } = await admin.from('scan_runs')
      .insert({ org_id: demo, kind: 'full_audit', status: 'failed', error: 'humo-auth' }).select('id').single();
    ok('disparo: auditoría de prueba insertada en la demo', !ef && !!fila);
    if (fila) disparo = { admin, id: fila.id };
  }
  console.log(`ESPERANDO broadcast en org:<demo> hasta ${ESPERA_MS / 1000} s…`);
  const t0 = Date.now();
  while (!recibido && Date.now() - t0 < ESPERA_MS) await new Promise((r) => setTimeout(r, 500));
  if (disparo) await disparo.admin.from('scan_runs').delete().eq('id', disparo.id).eq('org_id', demo);
  ok('broadcast recibido en el canal privado', !!recibido);
  // 0008e: el payload solo lleva table, operation y los ids (nunca la fila entera). Se imprimen los NOMBRES de lo que
  // sobre, nunca los valores. El `id` de la raíz lo añade Realtime (id del mensaje en realtime.messages), no la fila.
  if (recibido) {
    const p = recibido.payload ?? {};
    const sobra = [...Object.keys(p).filter((k) => !['table', 'operation', 'record', 'old_record'].includes(k)
        && !(k === 'id' && p.id !== p.record?.id)),
      ...Object.keys(p.record ?? {}).filter((k) => !['id', 'org_id'].includes(k)).map((k) => `record.${k}`),
      ...(p.old_record != null ? ['old_record'] : [])];
    ok(`payload mínimo {table, operation, record{id, org_id}}${sobra.length ? ` (sobran: ${sobra.join(', ')})` : ''}`,
      sobra.length === 0 && typeof p.record?.id === 'string');
  }
  await sb.removeAllChannels();
  await sb.auth.signOut();
} catch (e) {
  fallos++;
  console.log(`MAL error: ${e?.name ?? 'desconocido'}`);
}
console.log(fallos ? `humo-auth: ${fallos} fallo(s)` : 'humo-auth: todo OK');
process.exit(fallos ? 1 : 0);
