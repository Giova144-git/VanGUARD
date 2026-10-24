import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { EstadoModulo, type Module } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { estadoModulo, errorDeConexion, mediana } = await import('./modulo.ts');
const { modules } = await import('../rutas/modules.ts');
const { errorHandler } = await import('../mw/error.ts');

const ORG = '0f6c0000-0000-4000-8000-000000000001';
const env = {} as CloudflareBindings;
const H = 3_600_000;
const hace = (ms: number) => new Date(Date.now() - ms).toISOString();

let tablas: Record<string, (op: Op) => Resp | undefined>;
let doble: ReturnType<typeof dbDoble>;
beforeEach(() => {
  tablas = {};
  doble = dbDoble({ tabla: (op) => tablas[op.table]?.(op) });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

let n = 0;
const uuid = () => `c3d40000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const hallazgo = (rule_id: string, severity = 'high', o: Record<string, unknown> = {}) => ({ id: uuid(), rule_id, severity,
  title: `Hallazgo ${rule_id}`, resource: 'public.x', confirmed: false, evidence: null, ...o });
const conexion = (provider: string, status = 'active', o: Record<string, unknown> = {}) =>
  ({ id: uuid(), provider, kind: 'read', status, last_error: null, ...o });
const scan = (steps: { name: string; status: string; error_code?: string }[], detail?: Record<string, unknown>, finished_at: string | null = hace(H)) =>
  ({ steps, coverage: detail ? { seen: 1, total: 4, missing: [], detail } : null, finished_at });
const fijar = (o: { findings?: unknown[]; scans?: unknown[]; conns?: unknown[] }) => {
  tablas.findings = () => ({ data: o.findings ?? [], count: (o.findings ?? []).length });
  tablas.scan_runs = () => ({ data: o.scans ?? [] });
  tablas.connections = () => ({ data: o.conns ?? [] });
};
const pedir = async (m: Module) => EstadoModulo.parse(await estadoModulo(env, ORG, m));
const check = (e: EstadoModulo, codigo: string) => e.checks.find((c) => c.codigo === codigo);
const cifra = (e: EstadoModulo, tipo: string) => e.cifras.find((c) => c.tipo === tipo);

// ── Hallazgo 1: Rendimiento desde perf_runs (§15.4 E6, §10.10, §10.3) ────────────────────────────────────────────────
describe('#1 · E6 de Rendimiento sale de perf_runs', () => {
  const run = (strategy: string, run_group: string, created_at: string, perf: number, m: Record<string, number | null>, o: Record<string, unknown> = {}) =>
    ({ url: 'https://demo.officialvanguard.com/', strategy, run_group, version_label: 'v2-regresion', lighthouse_version: '13.5.0',
      scores: { performance: perf, accessibility: 0.9 }, metrics: m, created_at, runtime_error: null, ...o });

  it('última medición por estrategia (mediana de su run_group): cifras con rol por banda y checks PF_* de §10.10', async () => {
    const t = hace(2 * H);
    const tD = hace(2 * H - 5000);
    tablas.findings = () => ({ data: [], count: 0 });
    tablas.perf_runs = () => ({ data: [
      run('mobile', 'g-err', hace(H), 0.1, { lcp_ms: 90000 }, { runtime_error: 'NO_FCP' }),   // no entra en medianas
      run('desktop', 'g-d', tD, 0.68, { lcp_ms: 1800, tbt_ms: 90, cls: 0.05, ttfb_ms: 100 }),
      run('mobile', 'g-m', hace(2 * H - 2000), 0.45, { lcp_ms: 6400, tbt_ms: 900, cls: 0.32, ttfb_ms: 140 }),
      run('mobile', 'g-m', hace(2 * H - 1000), 0.40, { lcp_ms: 6000, tbt_ms: 800, cls: 0.30, ttfb_ms: 120 }),
      run('mobile', 'g-m', t, 0.41, { lcp_ms: 6200, tbt_ms: 820, cls: 0.31, ttfb_ms: 130 }),
      run('mobile', 'g-v1', hace(30 * H), 0.97, { lcp_ms: 1450, tbt_ms: 40, cls: 0, ttfb_ms: 110 }, { version_label: 'v1-sana' }),
    ] });
    const e = await pedir('performance');
    expect(e.ok).toBe(true);
    expect(cifra(e, 'perf_score_mobile')).toMatchObject({ n: 41, de: 100, rol: 'mal' });
    expect(cifra(e, 'perf_score_mobile')?.sub).toMatch(/^v2-regresion · \S{3} \d\d:\d\d · mediana de 3 · Lighthouse 13\.5\.0$/);
    expect(cifra(e, 'perf_score_desktop')).toMatchObject({ n: 68, rol: 'aviso' });
    expect(cifra(e, 'perf_score_desktop')?.sub).toContain('indicativo');
    expect(cifra(e, 'lcp_mobile')).toMatchObject({ n: 6200, unidad: 'ms', rol: 'mal' });
    expect(cifra(e, 'tbt_mobile')).toMatchObject({ n: 820, unidad: 'ms', rol: 'mal' });
    expect(cifra(e, 'cls_mobile')).toMatchObject({ n: 0.31, decimales: 2, rol: 'mal' });
    expect(cifra(e, 'ttfb_mobile')).toMatchObject({ n: 130, unidad: 'ms', rol: 'bien' });
    expect(e.checks).toEqual([
      { nombre: 'LCP móvil bajo 2,5 s', codigo: 'PF_LCP', n: 1, de: 1, comprobado: true },
      { nombre: 'TBT móvil bajo 200 ms', codigo: 'PF_TBT', n: 1, de: 1, comprobado: true },
      { nombre: 'CLS móvil bajo 0,1', codigo: 'PF_CLS', n: 1, de: 1, comprobado: true },
      { nombre: 'Medición de hace ≤ 7 días', codigo: 'PF_FRESH', n: 0, de: 1, comprobado: true },
    ]);
    expect(e.hora).toBe(tD);   // hora de la medición más nueva, no «ahora»
    const op = doble.ops.find((o) => o.table === 'perf_runs');
    expect(eqDe(op!, 'org_id')).toBe(ORG);
    expect(doble.ops.some((o) => o.table === 'scan_runs')).toBe(false);   // Rendimiento no depende de pasos psi
  });

  it('prefiere la URL de la conexión ingest aunque otra URL se haya medido después; sin conexión, la más reciente', async () => {
    tablas.findings = () => ({ data: [], count: 0 });
    tablas.perf_runs = () => ({ data: [
      run('mobile', 'g-o', hace(H), 0.99, { lcp_ms: 900 }, { url: 'https://officialvanguard.com/' }),
      run('mobile', 'g-v', hace(3 * H), 0.41, { lcp_ms: 6200 }),
    ] });
    tablas.connections = () => ({ data: [{ label: 'demo.officialvanguard.com' }] });
    expect(cifra(await pedir('performance'), 'perf_score_mobile')).toMatchObject({ n: 41 });
    const op = doble.ops.find((o) => o.table === 'connections');
    expect(eqDe(op!, 'org_id')).toBe(ORG);
    expect(eqDe(op!, 'provider')).toBe('ingest');
    tablas.connections = () => ({ data: [] });
    expect(cifra(await pedir('performance'), 'perf_score_mobile')).toMatchObject({ n: 99 });
  });

  it('sin filas en perf_runs: todas las cifras n:null y los checks sin mirar (nunca verde)', async () => {
    tablas.findings = () => ({ data: [], count: 0 });
    tablas.perf_runs = () => ({ data: [] });
    const e = await pedir('performance');
    expect(e.ok).toBe(true);
    expect(e.cifras.every((c) => c.n === null && c.rol === undefined)).toBe(true);
    expect(e.checks.every((c) => c.n === null && !c.comprobado)).toBe(true);
    expect(e.checks.map((c) => c.codigo)).toEqual(['PF_LCP', 'PF_TBT', 'PF_CLS', 'PF_FRESH']);
  });

  it('siembra manual de hace 8 días: PF_FRESH n:1, verde donde cumple y «indicativo» con una sola repetición', async () => {
    tablas.findings = () => ({ data: [], count: 0 });
    tablas.perf_runs = () => ({ data: [
      run('mobile', 'g1', hace(8 * 24 * H), 0.93, { lcp_ms: 1400, tbt_ms: 30, cls: 0.01, ttfb_ms: null }, { version_label: 'v1-sana' }),
    ] });
    const e = await pedir('performance');
    expect(cifra(e, 'perf_score_mobile')).toMatchObject({ n: 93, rol: 'bien' });
    expect(cifra(e, 'perf_score_mobile')?.sub).toContain('indicativo');
    expect(cifra(e, 'perf_score_desktop')?.n).toBeNull();
    expect(cifra(e, 'ttfb_mobile')).toMatchObject({ n: null });
    expect(check(e, 'PF_LCP')).toMatchObject({ n: 0, comprobado: true });
    expect(check(e, 'PF_FRESH')).toMatchObject({ n: 1, comprobado: true });
  });

  it('solo escritorio: los checks móviles quedan sin mirar y PF_FRESH sí se comprueba', async () => {
    tablas.findings = () => ({ data: [], count: 0 });
    tablas.perf_runs = () => ({ data: [run('desktop', 'g1', hace(H), 0.8, { lcp_ms: 1000, tbt_ms: 10, cls: 0, ttfb_ms: 90 })] });
    const e = await pedir('performance');
    expect(check(e, 'PF_LCP')).toMatchObject({ n: null, comprobado: false });
    expect(check(e, 'PF_FRESH')).toMatchObject({ n: 0, comprobado: true });
    expect(mediana([3, 1, 2, 10])).toBe(2.5);
  });
});

// ── Hallazgo 6: reglas en vivo de Cloudflare solo con la ingesta mirando ─────────────────────────────────────────────
describe('#6 · CF_ADMIN_EXPOSED, CF_PATH_SCAN y CF_UA_TOOL solo se comprueban con ingesta activa y edge_hits recientes', () => {
  const VIVAS = ['CF_ADMIN_EXPOSED', 'CF_PATH_SCAN', 'CF_UA_TOOL'];
  const pasoCf = scan([{ name: 'cloudflare', status: 'done' }], { cloudflare: { miradas: { zona: true } } });

  it('solo el token de Cloudflare: las tres van sin mirar (n:null) y no se consulta edge_hits', async () => {
    fijar({ scans: [pasoCf], conns: [conexion('cloudflare')] });
    const e = await pedir('cloudflare');
    for (const c of VIVAS) expect(check(e, c)).toMatchObject({ n: null, comprobado: false });
    expect(check(e, 'CF_ZONE_01')).toMatchObject({ n: 0, comprobado: true });
    expect(doble.ops.some((o) => o.table === 'edge_hits' || o.table === 'incidents')).toBe(false);
  });

  it('ingesta activa con edge_hits en 24 h: comprobadas y n = incidentes open/ack con esa regla', async () => {
    const ing = conexion('ingest');
    fijar({ scans: [pasoCf], conns: [conexion('cloudflare'), ing] });
    tablas.edge_hits = () => ({ data: [{ id: 1 }] });
    tablas.incidents = () => ({ data: [{ rule_ids: ['CF_ADMIN_EXPOSED', 'CF_PATH_SCAN'] }, { rule_ids: ['CF_PATH_SCAN'] }] });
    const e = await pedir('cloudflare');
    expect(check(e, 'CF_ADMIN_EXPOSED')).toMatchObject({ n: 1, comprobado: true });
    expect(check(e, 'CF_PATH_SCAN')).toMatchObject({ n: 2, comprobado: true });
    expect(check(e, 'CF_UA_TOOL')).toMatchObject({ n: 0, comprobado: true });
    const hits = doble.ops.find((o) => o.table === 'edge_hits')!;
    expect(eqDe(hits, 'org_id')).toBe(ORG);
    expect(hits.filters).toContainEqual(['connection_id', 'in', [ing.id]]);
    const desde = Date.parse(String(hits.filters.find(([c, op]) => c === 'ts' && op === 'gte')?.[2]));
    expect(Math.abs(Date.now() - 24 * H - desde)).toBeLessThan(60_000);
    const inc = doble.ops.find((o) => o.table === 'incidents')!;
    expect(inc.filters).toContainEqual(['status', 'in', ['open', 'ack']]);
    expect(eqDe(inc, 'org_id')).toBe(ORG);
  });

  it('ingesta activa pero sin edge_hits recientes, o ingesta revocada: sin mirar', async () => {
    fijar({ scans: [pasoCf], conns: [conexion('cloudflare'), conexion('ingest')] });
    tablas.edge_hits = () => ({ data: [] });
    tablas.incidents = () => ({ data: [{ rule_ids: ['CF_ADMIN_EXPOSED'] }] });
    let e = await pedir('cloudflare');
    for (const c of VIVAS) expect(check(e, c)).toMatchObject({ n: null, comprobado: false });

    fijar({ scans: [pasoCf], conns: [conexion('cloudflare'), conexion('ingest', 'revoked')] });
    tablas.edge_hits = () => ({ data: [{ id: 1 }] });
    e = await pedir('cloudflare');
    for (const c of VIVAS) expect(check(e, c)).toMatchObject({ n: null, comprobado: false });
  });
});

// ── Hallazgo 7: coverage.detail.<modulo>.miradas decide chequeo por chequeo ──────────────────────────────────────────
describe('#7 · miradas del FORMATO COMPARTIDO: un paso done a medias no pinta verde lo que no miró', () => {
  it('Supabase done con SQL caído y advisors sí: solo el check de advisors queda comprobado', async () => {
    fijar({
      findings: [hallazgo('SB_ADVISOR_RLS_ENABLED_NO_POLICY', 'info')],
      scans: [scan([{ name: 'supabase', status: 'done', error_code: 'parcial:3' }],
        { supabase: { miradas: { advisors: true, sql_rls: false, sql_politicas: false, sql_rpc: false } } })],
      conns: [conexion('supabase')],
    });
    const e = await pedir('supabase');
    expect(check(e, 'SB_ADVISOR_*')).toMatchObject({ n: 1, comprobado: true });
    for (const c of ['SB_RLS_DISABLED', 'SB_POLICY_ALLOW_ALL', 'SB_RPC_ANON_NO_LIMIT', 'SB_CPU_HIGH']) {
      expect(check(e, c)).toMatchObject({ n: null, comprobado: false });
    }
  });

  it('una clave que falta en miradas cuenta como no mirada', async () => {
    fijar({ scans: [scan([{ name: 'supabase', status: 'done' }], { supabase: { miradas: { advisors: true, sql_rls: true } } })],
      conns: [conexion('supabase')] });
    const e = await pedir('supabase');
    expect(check(e, 'SB_RLS_DISABLED')).toMatchObject({ n: 0, comprobado: true });
    expect(check(e, 'SB_POLICY_ALLOW_ALL')).toMatchObject({ n: null, comprobado: false });
  });

  it('corrida vieja sin miradas: decide el estado del paso, como antes', async () => {
    fijar({ scans: [scan([{ name: 'supabase', status: 'done' }])], conns: [conexion('supabase')] });
    const e = await pedir('supabase');
    for (const c of ['SB_RLS_DISABLED', 'SB_POLICY_ALLOW_ALL', 'SB_RPC_ANON_NO_LIMIT', 'SB_ADVISOR_*']) {
      expect(check(e, c)).toMatchObject({ n: 0, comprobado: true });
    }
    expect(check(e, 'SB_CPU_HIGH')).toMatchObject({ n: null, comprobado: false });
  });

  it('Codebase con OSV caído (osv_unavailable): «Dependencias con avisos» sin mirar; secretos y .env sí', async () => {
    fijar({
      findings: [hallazgo('CB_SECRET_SUPABASE_SERVICE_ROLE', 'critical')],
      scans: [scan([{ name: 'repo', status: 'done', error_code: 'osv_unavailable' }],
        { codebase: { modo: 'riesgo', miradas: { secretos: true, env: true, lockfiles: true, osv: false } } })],
      conns: [conexion('github')],
    });
    const e = await pedir('codebase');
    expect(check(e, 'CB_DEP_VULN')).toMatchObject({ n: null, comprobado: false });
    expect(check(e, 'CB_SECRET_*')).toMatchObject({ n: 1, comprobado: true });
    expect(check(e, 'CB_ENV_COMMITTED')).toMatchObject({ n: 0, comprobado: true });
    expect(check(e, 'CB_GITIGNORE_NO_ENV')).toMatchObject({ n: 0, comprobado: true });
  });

  it('cuentan las miradas de la última auditoría que INTENTÓ el paso (no la más nueva si lo saltó); si falló, nada', async () => {
    const todas = { advisors: true, sql_rls: true, sql_politicas: true, sql_rpc: true };
    fijar({
      scans: [
        scan([{ name: 'supabase', status: 'skipped' }], { supabase: { miradas: todas } }, null),
        scan([{ name: 'supabase', status: 'done' }], { supabase: { miradas: { ...todas, sql_rpc: false } } }),
        scan([{ name: 'supabase', status: 'done' }], { supabase: { miradas: todas } }),
      ],
      conns: [conexion('supabase')],
    });
    let e = await pedir('supabase');
    expect(check(e, 'SB_RPC_ANON_NO_LIMIT')).toMatchObject({ n: null, comprobado: false });
    expect(check(e, 'SB_RLS_DISABLED')).toMatchObject({ comprobado: true });

    fijar({ scans: [scan([{ name: 'supabase', status: 'failed' }], { supabase: { miradas: todas } }), scan([{ name: 'supabase', status: 'done' }])],
      conns: [conexion('supabase')] });
    e = await pedir('supabase');
    expect(e.checks.every((c) => !c.comprobado && c.n === null)).toBe(true);
  });
});

// ── Hallazgo 12: un fallo de la base nunca sale verde ────────────────────────────────────────────────────────────────
describe('#12 · si falla la consulta de findings o de scan_runs → ok:false, cifras n:null, nada comprobado', () => {
  it('falla findings: ok:false sin_conexion, contador null y ningún check comprobado', async () => {
    fijar({ scans: [scan([{ name: 'supabase', status: 'done' }])], conns: [conexion('supabase')] });
    tablas.findings = () => ({ error: { code: '57014', message: 'timeout' } });
    const e = await pedir('supabase');
    expect(e).toMatchObject({ ok: false, error: 'sin_conexion', contador: { rojo: null, aviso: null, cola: null }, ahora: [] });
    expect(e.cifras.length).toBeGreaterThan(0);
    expect(e.cifras.every((c) => c.n === null)).toBe(true);
    expect(e.checks.every((c) => c.n === null && !c.comprobado)).toBe(true);
  });

  it('falla scan_runs: ok:false aunque los hallazgos se lean (se muestran, pero sin checks verdes)', async () => {
    fijar({ findings: [hallazgo('SB_RLS_DISABLED', 'critical')], conns: [conexion('supabase')] });
    tablas.scan_runs = () => ({ error: { code: 'PGRST000' } });
    const e = await pedir('supabase');
    expect(e).toMatchObject({ ok: false, error: 'sin_conexion', contador: { rojo: 1, aviso: 0, cola: 0 } });
    expect(e.ahora[0]?.grupo).toBe('SB_RLS_DISABLED');
    expect(e.cifras.every((c) => c.n === null)).toBe(true);
    expect(e.checks.every((c) => !c.comprobado)).toBe(true);
  });

  it('falla perf_runs: Rendimiento ok:false con sus 6 cifras en n:null', async () => {
    tablas.findings = () => ({ data: [], count: 0 });
    tablas.perf_runs = () => ({ error: { code: '500' } });
    const e = await pedir('performance');
    expect(e).toMatchObject({ ok: false, error: 'sin_conexion' });
    expect(e.cifras.map((c) => c.n)).toEqual([null, null, null, null, null, null]);
    expect(e.checks.every((c) => !c.comprobado)).toBe(true);
  });
});

// ── Hallazgo 13 (parte E6): conexión revocada o en error → token_invalido / sin_permiso ───────────────────────────────
describe('#13 · E6 con la conexión del proveedor revocada o en error', () => {
  const base = { findings: [hallazgo('SB_RLS_DISABLED', 'critical')], scans: [scan([{ name: 'supabase', status: 'done' }])] };

  it('revocada → ok:false token_invalido, cifras n:null y checks sin mirar; los hallazgos siguen en «ahora»', async () => {
    fijar({ ...base, conns: [conexion('supabase', 'revoked', { last_error: 'http_401' })] });
    const e = await pedir('supabase');
    expect(e).toMatchObject({ ok: false, error: 'token_invalido' });
    expect(e.cifras.every((c) => c.n === null)).toBe(true);
    expect(e.checks.every((c) => !c.comprobado && c.n === null)).toBe(true);
    expect(e.ahora).toHaveLength(1);
  });

  it('en error según last_error: forbidden/not_found → sin_permiso, rate_limited → limite_api', async () => {
    fijar({ ...base, conns: [conexion('github', 'error', { last_error: 'forbidden' })] });
    expect(await pedir('codebase')).toMatchObject({ ok: false, error: 'sin_permiso' });
    fijar({ ...base, conns: [conexion('cloudflare', 'error', { last_error: 'rate_limited' })] });
    expect(await pedir('cloudflare')).toMatchObject({ ok: false, error: 'limite_api' });
    expect(errorDeConexion('expired', null)).toBe('token_invalido');
    expect(errorDeConexion('error', 'unauthorized')).toBe('token_invalido');
    expect(errorDeConexion('error', 'not_found')).toBe('sin_permiso');
    expect(errorDeConexion('error', 'http_404')).toBe('sin_permiso');
    expect(errorDeConexion('error', 'excess_scope')).toBe('sin_permiso');
    expect(errorDeConexion('error', 'timeout')).toBe('sin_conexion');
  });

  it('una activa gana a una revocada; la de acciones de Cloudflare no cuenta; sin conexión → sin_conexion', async () => {
    fijar({ ...base, conns: [conexion('supabase', 'revoked'), conexion('supabase')] });
    expect((await pedir('supabase')).ok).toBe(true);
    fijar({ scans: [scan([{ name: 'cloudflare', status: 'done' }])],
      conns: [conexion('cloudflare'), conexion('cloudflare', 'revoked', { kind: 'action' })] });
    expect((await pedir('cloudflare')).ok).toBe(true);
    fijar({ ...base, conns: [] });
    expect(await pedir('supabase')).toMatchObject({ ok: false, error: 'sin_conexion' });
  });
});

describe('E6 · ruta', () => {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => { c.set('rid', 'r1'); c.set('orgId', ORG); await next(); });
  app.onError(errorHandler);
  app.route('/api', modules);

  it('módulo desconocido → 404; conocido → EstadoModulo válido', async () => {
    expect((await app.request(`/api/orgs/${ORG}/modules/kubernetes/state`, {}, env)).status).toBe(404);
    tablas.findings = () => ({ data: [], count: 0 });
    tablas.perf_runs = () => ({ data: [] });
    const r = await app.request(`/api/orgs/${ORG}/modules/performance/state`, {}, env);
    expect(r.status).toBe(200);
    expect(EstadoModulo.parse(await r.json()).checks).toHaveLength(4);
  });
});
