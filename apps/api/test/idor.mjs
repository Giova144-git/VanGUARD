// test:idor (§15.13), contra accshmgmfrqrxubpuxcl. Se corre desde apps/api con:
//   pnpm test:idor        (= node --env-file=.dev.vars test/idor.mjs)
// Lee SUPABASE_URL, SUPABASE_SECRET_KEY, TEST_USER_A_PASSWORD, TEST_USER_B_PASSWORD y SUPABASE_PUBLISHABLE_KEY del entorno (el chat no abre
// .dev.vars) e IDOR_API (por defecto https://officialvanguard.com; http://localhost:8787 con dev-node).
// 1) crea o actualiza idor-a@vanguard.test e idor-b@vanguard.test (email_confirm) y sus membresías owner en las orgs
//    IDOR A/B del seed dev-idor.sql; 2) inicia sesión con los dos; 3) B pide por id los recursos de A → 404 y sus
//    listas solo traen lo suyo. Nunca imprime contraseñas, tokens ni filas: solo OK/MAL por caso.
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SECRET_KEY, TEST_USER_A_PASSWORD, TEST_USER_B_PASSWORD } = process.env;
const API = process.env.IDOR_API || 'https://officialvanguard.com';
const ORG_A = '00000000-0000-4000-a000-00000000a001';
const ORG_B = '00000000-0000-4000-a000-00000000b002';
const CONN_A = '00000000-0000-4000-a000-0000000c0a01';
const USUARIOS = [
  { email: 'idor-a@vanguard.test', password: TEST_USER_A_PASSWORD, org: ORG_A },
  { email: 'idor-b@vanguard.test', password: TEST_USER_B_PASSWORD, org: ORG_B },
];

for (const [nombre, v] of Object.entries({ SUPABASE_URL, SUPABASE_SECRET_KEY, TEST_USER_A_PASSWORD, TEST_USER_B_PASSWORD })) {
  if (!v) { console.log(`MAL falta ${nombre} en el entorno`); process.exit(1); }
}
const opciones = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, opciones);
let fallos = 0;
const ok = (nombre, bien) => { console.log(`${bien ? 'OK ' : 'MAL'} ${nombre}`); if (!bien) fallos++; };

async function asegurarUsuario({ email, password, org }) {
  let id;
  const creado = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (creado.data?.user) id = creado.data.user.id;
  else {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (error) throw new Error(`listUsers falló (${error.status ?? 'sin estado'})`);
    id = data.users.find((u) => u.email === email)?.id;
    if (!id) throw new Error(`no se pudo crear ni encontrar ${email}`);
    const up = await admin.auth.admin.updateUserById(id, { password, email_confirm: true });
    if (up.error) throw new Error(`no se pudo actualizar ${email} (${up.error.status ?? 'sin estado'})`);
  }
  const m = await admin.from('org_members').upsert({ org_id: org, user_id: id, role: 'owner' }, { onConflict: 'org_id,user_id' });
  if (m.error) throw new Error(`membresía de ${email} falló (${m.error.code})`);
}

async function token({ email, password }) {
  const c = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, opciones);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`no se pudo iniciar sesión como ${email} (${error?.status ?? 'sin sesión'})`);
  return data.session.access_token;
}

const pedir = (tok, metodo, ruta) => fetch(`${API}${ruta}`, { method: metodo, headers: { authorization: `Bearer ${tok}` } });

try {
  for (const u of USUARIOS) await asegurarUsuario(u);
  ok('usuarios y membresías de prueba listos', true);
  const [ta, tb] = [await token(USUARIOS[0]), await token(USUARIOS[1])];

  // B pide recursos de A por id → 404 (no 403: no confirma que existan).
  const contraA = [
    ['GET', `/api/orgs/${ORG_A}/connections`],
    ['POST', `/api/orgs/${ORG_A}/connections/${CONN_A}/test`],
    ['DELETE', `/api/orgs/${ORG_A}/connections/${CONN_A}`],
    // Cuando existan sus rutas (hito 3+): findings/:id, incidents/:id, scans/:id y actions/:id de A.
    ['GET', `/api/orgs/${ORG_A}/findings/00000000-0000-4000-a000-0000000f0a01`],
    ['GET', `/api/orgs/${ORG_A}/scans/00000000-0000-4000-a000-0000000d0a01`],
    ['GET', `/api/orgs/${ORG_A}/incidents/00000000-0000-4000-a000-0000000e0a01`],
  ];
  for (const [metodo, ruta] of contraA) {
    const r = await pedir(tb, metodo, ruta);
    ok(`B ${metodo} ${ruta.replace(ORG_A, 'A')} → 404`, r.status === 404);
  }

  // /api/me de cada uno solo lista su propia org; la lista de conexiones de B no trae nada de A.
  for (const [tok, propia, ajena, quien] of [[ta, ORG_A, ORG_B, 'A'], [tb, ORG_B, ORG_A, 'B']]) {
    const me = await (await pedir(tok, 'GET', '/api/me')).json();
    const ids = (me.orgs ?? []).map((o) => o.id);
    ok(`/api/me de ${quien} incluye su org y no la ajena`, ids.includes(propia) && !ids.includes(ajena));
  }
  const listaB = await (await pedir(tb, 'GET', `/api/orgs/${ORG_B}/connections`)).json();
  ok('las conexiones de B no traen ninguna de A', Array.isArray(listaB) && !listaB.some((c) => c.id === CONN_A));

  // Decisión (a) del ORQUESTADOR: authenticated no tiene SELECT directo en public (todo va por la API). Con la clave
  // publicable y la sesión de idor-a, un select directo a findings debe dar «permission denied» (42501).
  const PUBLICABLE = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (PUBLICABLE) {
    const pub = createClient(SUPABASE_URL, PUBLICABLE,
      { ...opciones, global: { headers: { Authorization: `Bearer ${ta}` } } });
    const { error } = await pub.from('findings').select('id').limit(1);
    ok('select directo a findings con la sesión de A → permission denied', error?.code === '42501');
  } else {
    console.log('INFO sin SUPABASE_PUBLISHABLE_KEY ni VITE_SUPABASE_PUBLISHABLE_KEY: se salta la comprobación de lectura directa');
  }
} catch (e) {
  fallos++;
  console.log(`MAL error: ${e?.message ?? 'desconocido'}`);
}
console.log(fallos ? `test:idor: ${fallos} fallo(s)` : 'test:idor: todo OK');
process.exitCode = fallos ? 1 : 0;
