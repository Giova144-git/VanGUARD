import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { EstadoModulo, type Module } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { cumpleFiltros, dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';

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

// ── «Medir ahora» no es una auditoría: ni la hora ni el último paso del proveedor salen de una medición ──────────────
describe('E6 de un proveedor salta las mediciones de Rendimiento (kind lighthouse)', () => {
  const fila = (kind: string, created_at: string, steps: { name: string; status: string }[]) =>
    ({ org_id: ORG, kind, created_at, finished_at: created_at, steps, coverage: null });
  // scan_runs en memoria con los filtros de la consulta y su limit(20), más nuevas primero.
  const conScans = (scans: ReturnType<typeof fila>[]) => {
    fijar({ conns: [conexion('supabase')] });
    tablas.scan_runs = (op) => ({ data: scans.filter((s) => cumpleFiltros(s, op))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20) });
  };

  it('hora = fin de la última auditoría, no de una medición más nueva', async () => {
    const auditoria = hace(5 * H);
    conScans([fila('lighthouse', hace(H), [{ name: 'psi', status: 'done' }]),
      fila('full_audit', auditoria, [{ name: 'supabase', status: 'done' }])]);
    const e = await pedir('supabase');
    expect(e.hora).toBe(auditoria);
    const op = doble.ops.find((o) => o.table === 'scan_runs')!;
    expect(op.filters).toContainEqual(['kind', 'neq', 'lighthouse']);
  });

  it('20 mediciones (el cupo de la demo) no sacan de la ventana a la auditoría: los checks siguen comprobados', async () => {
    const psi = [{ name: 'psi', status: 'done' }];
    const mediciones = Array.from({ length: 20 }, (_, i) => fila('lighthouse', hace(H - i * 1000), psi));
    conScans([...mediciones, fila('full_audit', hace(5 * H), [{ name: 'supabase', status: 'done' }])]);
    const e = await pedir('supabase');
    expect(check(e, 'SB_RLS_DISABLED')).toMatchObject({ n: 0, comprobado: true });
  });
});

// ── Varias codebases (asignaciones/varias-codebases.md §2.4, B5): lo que miró un repo no da por mirado a otro ─────────
describe('B5 · Codebase con 2 o más repos activos', () => {
  const TODAS = { secretos: true, env: true, lockfiles: true, osv: true };
  const CB = ['CB_ENV_COMMITTED', 'CB_GITIGNORE_NO_ENV', 'CB_SECRET_*', 'CB_DEP_VULN'];
  const gh = (repo: string, status = 'active') => conexion('github', status, { meta: { repo_full_name: repo } });
  // Una auditoría con el paso repo terminado y su coverage.detail.codebase (extra: params u otros campos de la fila).
  const auditoria = (codebase: Record<string, unknown>, status = 'done', extra: Record<string, unknown> = {}) =>
    ({ ...scan([{ name: 'repo', status }], { codebase }), ...extra });
  const comprobados = (e: EstadoModulo) => e.checks.filter((c) => c.comprobado).map((c) => c.codigo);
  const LARGO = 'equipo22-demo/vanguard-demo-landing-con-un-nombre-bastante-largo';

  it('con UN repo activo (y otro revocado), como siempre: sin «Repos revisados» ni chips de repo', async () => {
    const tienda = gh('acme/tienda');
    fijar({ findings: [hallazgo('CB_ENV_COMMITTED', 'high', { connection_id: tienda.id })],
      scans: [auditoria({ connection_id: tienda.id, miradas: TODAS })], conns: [tienda, gh('acme/otro', 'revoked')] });
    const e = await pedir('codebase');
    expect(e.ok).toBe(true);
    expect(comprobados(e)).toEqual(CB);
    expect(cifra(e, 'codebase_repos')).toBeUndefined();
    expect(e.ahora[0]?.filas[0]?.chips).toBeUndefined();
  });

  it('2 repos y uno analizado → ningún chequeo comprobado; «Repos revisados» 1 de 2; chips con el repo, sin recortar', async () => {
    const tienda = gh('acme/tienda');
    const landing = gh(LARGO);
    const lodash = { resource: 'npm:lodash@4.17.15' };
    fijar({
      findings: [hallazgo('CB_DEP_VULN', 'high', { ...lodash, connection_id: tienda.id, confirmed: true }),
        hallazgo('CB_DEP_VULN', 'high', { ...lodash, connection_id: landing.id }),
        hallazgo('CB_ENV_COMMITTED', 'high', { connection_id: null })],
      scans: [auditoria({ connection_id: landing.id, miradas: TODAS }, 'done', { params: { connection_id: landing.id } })],
      conns: [tienda, landing],
    });
    const e = await pedir('codebase');
    expect(e.ok).toBe(true);
    expect(e.checks.every((c) => !c.comprobado && c.n === null)).toBe(true);   // «Analizar este repo» de uno no mira el otro
    expect(cifra(e, 'codebase_repos')).toEqual({ tipo: 'codebase_repos', etiqueta: 'Repos revisados', n: 1, de: 2, rol: 'aviso' });
    const filas = e.ahora.flatMap((g) => g.filas);
    expect(filas.map((f) => f.chips)).toEqual([['confirmado', 'acme/tienda'], [LARGO], undefined]);
    expect(cifra(e, 'codebase_abiertos')?.n).toBe(3);   // conteos agregados, como siempre
  });

  it('los dos con su último intento done → comprobados; si el último de uno falló o no miró OSV, ese chequeo no', async () => {
    const tienda = gh('acme/tienda');
    const landing = gh('acme/landing');
    const deLanding = (miradas: Record<string, boolean>, status = 'done') =>
      auditoria({ connection_id: landing.id, miradas }, status, { params: { connection_id: landing.id } });
    const completa = auditoria({ connection_id: tienda.id, miradas: TODAS });   // full_audit: el repo principal (B0)
    fijar({ findings: [hallazgo('CB_SECRET_AWS', 'critical', { connection_id: landing.id })], scans: [deLanding(TODAS), completa],
      conns: [tienda, landing] });
    let e = await pedir('codebase');
    expect(comprobados(e)).toEqual(CB);
    expect(check(e, 'CB_SECRET_*')).toMatchObject({ n: 1, comprobado: true });
    expect(cifra(e, 'codebase_repos')).toMatchObject({ n: 2, de: 2, rol: 'bien' });

    fijar({ scans: [deLanding({ ...TODAS, osv: false }), completa], conns: [tienda, landing] });
    e = await pedir('codebase');
    expect(comprobados(e)).toEqual(['CB_ENV_COMMITTED', 'CB_GITIGNORE_NO_ENV', 'CB_SECRET_*']);

    fijar({ scans: [deLanding(TODAS, 'failed'), deLanding(TODAS), completa], conns: [tienda, landing] });   // el más nuevo manda
    e = await pedir('codebase');
    expect(comprobados(e)).toEqual([]);
    expect(cifra(e, 'codebase_repos')).toMatchObject({ n: 1, de: 2, rol: 'aviso' });
  });

  it('un ZIP no cuenta para ningún repo; una auditoría de antes de B0 (sin detalle ni params), la conexión más antigua', async () => {
    const tienda = gh('acme/tienda');   // la más antigua (conns va en orden de created_at)
    const landing = gh('acme/landing');
    const zip = scan([{ name: 'zip', status: 'done' }], { codebase: { modo: 'zip', miradas: TODAS } });
    const vieja = scan([{ name: 'repo', status: 'done' }], { codebase: { modo: 'riesgo', miradas: TODAS } });
    fijar({ scans: [zip, vieja], conns: [tienda, landing] });
    let e = await pedir('codebase');
    expect(comprobados(e)).toEqual([]);
    expect(cifra(e, 'codebase_repos')).toMatchObject({ n: 1, de: 2 });

    const deLanding = auditoria({ miradas: TODAS }, 'done', { params: { connection_id: landing.id } });
    fijar({ scans: [zip, deLanding, vieja], conns: [tienda, landing] });
    e = await pedir('codebase');
    expect(comprobados(e)).toEqual(CB);
    expect(cifra(e, 'codebase_repos')).toMatchObject({ n: 2, de: 2, rol: 'bien' });
    const op = doble.ops.find((o) => o.table === 'connections')!;
    expect(op.columns).toContain('meta');
    expect(op.orden).toEqual([['created_at', true], ['id', true]]);
    expect(doble.ops.find((o) => o.table === 'scan_runs')?.columns).toContain('params');
  });

  it('un failed sin detalle ni params (GitHub cayó antes del detalle de B0) va a la ACTIVA más antigua', async () => {
    const x = gh('acme/x', 'revoked');   // la más antigua en cualquier estado: ya no cuenta
    const y = gh('acme/y');              // la activa más antigua: la que eligió conexionActiva para la auditoría completa
    const z = gh('acme/z');
    const fallida = { ...scan([{ name: 'repo', status: 'failed' }]), params: {} };
    const deY = auditoria({ connection_id: y.id, miradas: TODAS });
    const deZ = auditoria({ connection_id: z.id, miradas: TODAS }, 'done', { params: { connection_id: z.id } });
    fijar({ scans: [fallida, deY, deZ], conns: [x, y, z] });
    let e = await pedir('codebase');
    expect(comprobados(e)).toEqual([]);   // el último intento de acme/y falló: nada sale comprobado
    expect(cifra(e, 'codebase_repos')).toMatchObject({ n: 1, de: 2, rol: 'aviso' });

    // Un done sin detalle ni params solo puede ser de antes de B0: sigue siendo de la más antigua (§2.4), aquí la revocada.
    const vieja = { ...scan([{ name: 'repo', status: 'done' }], { codebase: { modo: 'riesgo', miradas: TODAS } }), params: {} };
    fijar({ scans: [vieja, deY, deZ], conns: [x, y, z] });
    e = await pedir('codebase');
    expect(comprobados(e)).toEqual(CB);
    expect(cifra(e, 'codebase_repos')).toMatchObject({ n: 2, de: 2, rol: 'bien' });
  });

  it('con detail.codebase.repos manda cada entrada: pending = sin mirar; sin miradas propias, las de la corrida (el Y)', async () => {
    const tienda = gh('acme/tienda');
    const landing = gh('acme/landing');
    const recorrido = (repos: Record<string, unknown>[], miradas = TODAS) =>
      auditoria({ connection_id: landing.id, miradas, repos });
    const primero = { connection_id: tienda.id, status: 'done', miradas: TODAS };
    fijar({ scans: [recorrido([primero, { connection_id: landing.id, status: 'pending' }])], conns: [tienda, landing] });
    let e = await pedir('codebase');
    expect(comprobados(e)).toEqual([]);
    expect(cifra(e, 'codebase_repos')).toMatchObject({ n: 1, de: 2 });

    fijar({ scans: [recorrido([primero, { connection_id: landing.id, status: 'done' }], { ...TODAS, osv: false })],
      conns: [tienda, landing] });
    e = await pedir('codebase');
    expect(comprobados(e)).toEqual(['CB_ENV_COMMITTED', 'CB_GITIGNORE_NO_ENV', 'CB_SECRET_*']);
    expect(cifra(e, 'codebase_repos')).toMatchObject({ n: 2, de: 2, rol: 'bien' });
  });

  it('las parejas viejas de «Reconectar» son el mismo repo; sin ningún intento, «Repos revisados» sin dato', async () => {
    const vieja = gh('Acme/Tienda', 'revoked');
    const tienda = gh('acme/tienda');
    const landing = gh('acme/landing');
    fijar({ findings: [hallazgo('CB_ENV_COMMITTED', 'high', { connection_id: vieja.id })], conns: [vieja, tienda, landing] });
    let e = await pedir('codebase');
    expect(comprobados(e)).toEqual([]);
    expect(cifra(e, 'codebase_repos')).toEqual({ tipo: 'codebase_repos', etiqueta: 'Repos revisados', n: null, de: 2 });
    expect(e.ahora[0]?.filas[0]?.chips).toEqual(['Acme/Tienda']);

    fijar({ scans: [auditoria({ connection_id: vieja.id, miradas: TODAS }), auditoria({ connection_id: landing.id, miradas: TODAS })],
      conns: [vieja, tienda, landing] });
    e = await pedir('codebase');
    expect(comprobados(e)).toEqual(CB);
    expect(cifra(e, 'codebase_repos')).toMatchObject({ n: 2, de: 2 });
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
