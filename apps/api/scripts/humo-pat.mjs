// Prueba de humo SB-01 (§07.10, pruebas 1–7) del PAT de Supabase, más los sondeos negativos del P0 de la revisión del
// hito 2. Desde apps/api:
//   node --env-file=../../.env scripts/humo-pat.mjs            (o --env-file=.dev.vars)
// Lee SUPABASE_HUMO_PAT (sbp_fc… de solo lectura) y SUPABASE_HUMO_REF (ref de 20 letras del proyecto a probar; para el
// adelanto sin víctima vale el de accshmgmfrqrxubpuxcl con un PAT de solo lectura de ese proyecto). Nunca imprime el PAT,
// filas, nombres de tablas del cliente ni cuerpos: solo códigos HTTP, conteos y OK/MAL. La prueba 8 (fuga) es manual (§15.11).
const PAT = process.env.SUPABASE_HUMO_PAT;
const REF = process.env.SUPABASE_HUMO_REF ?? process.argv[2];
const CON_SEED = process.env.HUMO_CON_SEED === '1';   // 1 = la víctima ya tiene el seed de §07.9 (pruebas 2 y 3 con filas)
if (!PAT || !/^[a-z]{20}$/.test(REF ?? '')) { console.log('MAL faltan SUPABASE_HUMO_PAT o SUPABASE_HUMO_REF (20 letras)'); process.exit(1); }
if (!PAT.startsWith('sbp_fc')) console.log('AVISO el PAT no empieza por sbp_fc: la guarda de VanGUARD lo rechazaría como legacy_pat');

const BASE = `https://api.supabase.com/v1/projects/${REF}`;
const H = { Authorization: `Bearer ${PAT}`, Accept: 'application/json' };
let fallos = 0;
const ok = (n, b, extra = '') => { console.log(`${b ? 'OK ' : 'MAL'} ${n}${extra ? ` · ${extra}` : ''}`); if (!b) fallos++; };
const info = (n) => console.log(`INFO ${n}`);
const pedir = async (url, init = {}) => {
  try { return await fetch(url, { ...init, headers: { ...H, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) }); }
  catch (e) { return { status: e?.name === 'TimeoutError' ? 'timeout' : 'red', ok: false, text: async () => '', json: async () => null }; }
};
const sql = (query) => pedir(`${BASE}/database/query/read-only`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }) });

// 1 · forma de la respuesta del endpoint de solo lectura
{
  const r = await sql('select 1 as ok');
  const j = r.ok ? await r.json() : null;
  ok('1 · read-only devuelve un array de filas [{ok:1}]', Array.isArray(j) && j[0]?.ok === 1, `HTTP ${r.status}`);
}

// 2 y 3 · SQL 1 y SQL 3 con el rol supabase_read_only_user (permisos siempre; filas solo con el seed de la víctima)
{
  const sql1 = `select n.nspname as esquema, c.relname as tabla, c.relrowsecurity as rls_activa,
    has_table_privilege('anon', c.oid, 'select') as anon_select from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname = 'public'`;
  const r = await sql(sql1);
  const filas = r.ok ? await r.json() : null;
  ok('2 · SQL 1 (pg_class + has_table_privilege) corre como supabase_read_only_user', Array.isArray(filas), `HTTP ${r.status}`);
  if (CON_SEED && Array.isArray(filas)) {
    const p = filas.find((f) => f.esquema === 'public' && f.tabla === 'pedidos');
    ok('2 · public.pedidos con rls_activa=false y anon_select=true', !!p && (p.rls_activa === false || p.rls_activa === 'f') && (p.anon_select === true || p.anon_select === 't'));
  }
  const sql3 = `select n.nspname as esquema, p.proname as funcion, p.prosecdef as definer,
    exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'authenticator'
      and coalesce(array_to_string(r.rolconfig, ','), '') like '%pgrst.db_pre_request%') as hay_pre_request
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`;
  const r3 = await sql(sql3);
  const f3 = r3.ok ? await r3.json() : null;
  ok('3 · SQL 3 (pg_roles.rolconfig) no da error de permiso', Array.isArray(f3), `HTTP ${r3.status}${r3.status === 500 ? ' → SB_RPC_ANON_NO_LIMIT saldrá «sin mirar»' : ''}`);
  if (CON_SEED && Array.isArray(f3)) {
    const e = f3.find((f) => f.funcion === 'enviar_otp');
    ok('3 · public.enviar_otp con hay_pre_request=false', !!e && (e.hay_pre_request === false || e.hay_pre_request === 'f'));
  }
}

// 4 · advisors con lints[] y cache_key
for (const tipo of ['security', 'performance']) {
  const r = await pedir(`${BASE}/advisors/${tipo}`);
  const j = r.ok ? await r.json() : null;
  const lints = Array.isArray(j?.lints) ? j.lints : null;
  ok(`4 · advisors/${tipo} trae lints[] con cache_key`, !!lints && lints.every((l) => typeof l.cache_key === 'string'),
    `HTTP ${r.status} · ${lints ? lints.length : 0} lint(s)`);
  if (CON_SEED && tipo === 'security' && lints) {
    ok('4 · aparece rls_disabled_in_public', lints.some((l) => l.name === 'rls_disabled_in_public'));
  }
}

// 5 · métricas Prometheus con Logs · Read
{
  const r = await pedir(`${BASE}/analytics/endpoints/metrics`, { headers: { Accept: 'text/plain' } });
  const t = r.ok ? await r.text() : '';
  const tiene = (m) => t.includes(m);
  ok('5 · metrics con node_cpu_seconds_total, connection_stats_connection_count y node_filesystem /data',
    r.ok && tiene('node_cpu_seconds_total') && tiene('connection_stats_connection_count') && /node_filesystem_\w+\{[^}]*mountpoint="\/data"/.test(t),
    `HTTP ${r.status} · ${t.length} bytes`);
}

// 6 · config de Auth (pickAuth deja solo la lista blanca de 14 campos; aquí solo se mira que responde y cuántas claves trae)
{
  const r = await pedir(`${BASE}/config/auth`);
  const j = r.ok ? await r.json() : null;
  ok('6 · config/auth responde con Auth Config · Read', !!j && typeof j === 'object', `HTTP ${r.status} · ${j ? Object.keys(j).length : 0} claves`);
  if (j) info(`6 · claves sensibles presentes en la respuesta cruda (pickAuth debe quitarlas): ${Object.keys(j).filter((k) => /secret|pass|key/i.test(k)).length}`);
}

// 7 · error de SQL por read-only → 500 (sqlRead no reintenta)
{
  const r = await sql('select from where');
  ok('7 · SQL con error de sintaxis → 500', r.status === 500, `HTTP ${r.status}`);
}

// Sondeos negativos (P0 de la revisión del hito 2): un PAT correcto NO debe tener estos permisos.
for (const [n, url] of [['organizations_read', 'https://api.supabase.com/v1/organizations'], ['api_gateway_keys_read', `${BASE}/api-keys`],
  ['data_api_config_read', `${BASE}/postgrest`], ['edge_functions_secrets_read', `${BASE}/secrets`]]) {
  const r = await pedir(url);
  try { await r.body?.cancel?.(); } catch { /* sin cuerpo */ }
  const s = r.status;
  ok(`negativo · ${n} sin permiso (401/403/404/400)`, [400, 401, 403, 404].includes(s), `HTTP ${s}`);
}

console.log(fallos ? `humo-pat: ${fallos} fallo(s)` : 'humo-pat: todo OK');
process.exitCode = fallos ? 1 : 0;
