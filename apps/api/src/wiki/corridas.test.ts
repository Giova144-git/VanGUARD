import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures, WikiRun, WikiRunStep } from '@vanguard/contracts';
import { huellaHallazgos, MODELOS_POR_DEFECTO } from '@vanguard/deepwiki';
import { ApiError } from '../lib/errors.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import {
  aWikiRun, cacheDeEstimacion, crearCorrida, elegir, ERROR_PARADA, hallazgosDelRepo, huellaDe, leerDoc, MAX_HALLAZGOS,
  mensajeInicio, pasosCache, pasosIniciales, SIN_AVANCE_MS, type FilaLlave,
} from './corridas.ts';

// Filas de wiki_runs y caché de la wiki (wiki/corridas.ts). Sin red: doble de la base que aplica los .eq(), .in(),
// .order() y .limit() de cada consulta como Postgres, y el índice único de corridas en curso de 0010.
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const OTRA_ORG = '0f6c0000-0000-4000-8000-000000000002';
const ANA = '7b1e0000-0000-4000-8000-000000000001';
const CONN = 'c0aa0000-0000-4000-8000-000000000001';       // GitHub de acme/tienda
const CONN_OTRO = 'c0aa0000-0000-4000-8000-000000000002';  // GitHub de acme/otro (misma org)
const CONN_SB = 'c0aa0000-0000-4000-8000-000000000003';    // Supabase de la org
const SHA = '0123456789abcdef0123456789abcdef01234567';
const T_REPO = '2026-10-24T18:00:00+00:00';
const T_SB = '2026-10-24T18:04:11.123456+00:00';
const RUN_A = 'e1e00000-0000-4000-8000-0000000000aa';
const RUN_B = 'e1e00000-0000-4000-8000-0000000000bb';
const { run_id: _sinId, ...DOC } = fixtures.wikiDoc;

type Fila = Record<string, unknown>;
const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) => (o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : true));

// order() y limit() del doble no se registran: este envoltorio los apunta (y puede retrasar cada consulta para simular
// dos peticiones a la vez) y el manejador los aplica.
type Pedido = { table: string; orden: [string, boolean][]; limite?: number };
type Constructor = Record<string, unknown> & { then: (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) => unknown };
let pedidos: Pedido[];
let actual: Pedido | null;
let latencia: number;
function envolver(c: ReturnType<typeof dbDoble>['client']) {
  return { ...c, from: (t: string) => {
    const b = c.from(t) as unknown as Constructor;
    const p: Pedido = { table: t, orden: [] };
    const then = b.then;
    b.order = (col: string, o?: { ascending?: boolean }) => { p.orden.push([col, o?.ascending !== false]); return b; };
    b.limit = (n: number) => { p.limite = n; return b; };
    b.then = (ok, ko) => {
      const correr = () => { pedidos.push(p); actual = p; try { return then(ok, ko); } finally { actual = null; } };
      return latencia ? new Promise((r) => setTimeout(r, latencia)).then(correr) : correr();
    };
    return b;
  } };
}
function ordenar(filas: Fila[]): Fila[] {
  const p = actual;
  let r = [...filas];
  if (p?.orden.length) {
    r.sort((a, b) => {
      for (const [col, asc] of p.orden) {
        const x = (a[col] ?? '') as string | number;
        const y = (b[col] ?? '') as string | number;
        if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
      }
      return 0;
    });
  }
  if (p?.limite !== undefined) r = r.slice(0, p.limite);
  return r;
}
function responder(filas: Fila[], op: Op): Resp {
  const sel = ordenar(filas.filter((f) => cumple(f, op)));
  if (op.single === 'maybe') return { data: sel[0] ?? null };
  if (op.single === 'single') return sel[0] ? { data: sel[0] } : { error: { code: 'PGRST116' } };
  return { data: sel };
}
// wiki_runs_en_curso_uidx: (org_id, repo_full_name, commit_sha, coalesce(huella, '')) where status in (queued, running).
const viva = (f: Fila) => f.status === 'queued' || f.status === 'running';
const mismaLlave = (a: Fila, b: Fila) => a.org_id === b.org_id && a.repo_full_name === b.repo_full_name
  && a.commit_sha != null && a.commit_sha === b.commit_sha && (a.huella ?? '') === (b.huella ?? '');

let tablas: Record<string, Fila[]>;
let fallo: string | null;
let forzar23505: boolean;
let antesDeUpdate: (() => void) | null;
let doble: ReturnType<typeof dbDoble>;
let cliente: ReturnType<typeof envolver>;
let lineas: string[];
const admin = () => cliente as unknown as SupabaseClient;

beforeEach(() => {
  fallo = null;
  forzar23505 = false;
  antesDeUpdate = null;
  latencia = 0;
  pedidos = [];
  actual = null;
  lineas = [];
  tablas = {
    connections: [
      { id: CONN, org_id: ORG, provider: 'github', meta: { repo_full_name: 'Acme/Tienda' } },
      { id: CONN_OTRO, org_id: ORG, provider: 'github', meta: { repo_full_name: 'acme/otro' } },
      { id: CONN_SB, org_id: ORG, provider: 'supabase', meta: { project_ref: 'abcd' } },
    ],
    scan_runs: [],
    findings: [],
    wiki_runs: [],
  };
  let n = 0;
  doble = dbDoble({
    tabla: (op) => {
      if (fallo === op.table) return { error: { code: 'XX000' } };
      const filas = tablas[op.table];
      if (!filas) return undefined;
      if (op.action === 'insert') {
        const ahora = new Date().toISOString();
        const fila: Fila = { id: `e1e00000-0000-4000-8000-${String(++n).padStart(12, '0')}`, created_at: ahora, updated_at: ahora,
          cached: false, ...(op.payload as Fila) };
        if (forzar23505 || (op.table === 'wiki_runs' && viva(fila) && filas.some((f) => viva(f) && mismaLlave(f, fila)))) {
          return { error: { code: '23505' } };
        }
        filas.push(fila);
        return { data: { id: fila.id } };
      }
      if (op.action === 'update') {
        antesDeUpdate?.();
        for (const f of filas.filter((x) => cumple(x, op))) Object.assign(f, op.payload);
        return {};
      }
      return responder(filas, op);
    },
  });
  cliente = envolver(doble.client);
  vi.spyOn(console, 'log').mockImplementation((l: unknown) => { lineas.push(String(l)); });
});
afterEach(() => { vi.restoreAllMocks(); });

const scan = (kind: string, steps: [string, string][], finished_at: string | null, extra: Fila = {}) =>
  ({ org_id: ORG, status: 'succeeded', kind, params: {}, finished_at, steps: steps.map(([name, status]) => ({ name, status })), ...extra });
const RANGO: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
let dedupe = 0;
const hallazgo = (module: string, rule_id: string, severity: string, connection_id: string | null, path: string | null, org = ORG) =>
  ({ org_id: org, status: 'open', module, rule_id, severity, severity_rank: RANGO[severity] ?? null, title: `Título de ${rule_id}`,
    connection_id, path, dedupe_key: (++dedupe).toString(16).padStart(64, '0') });
const deFindings = () => doble.ops.filter((o) => o.table === 'findings');

describe('hallazgosDelRepo: los de la auditoría de ESE repo, también para la síntesis de la cola (LEEME, punto 7)', () => {
  it('código de las conexiones de ese repo + Supabase y Cloudflare de la org; path sin línea; auditoria_at la más nueva', async () => {
    tablas.scan_runs!.push(scan('supabase', [['supabase', 'done'], ['resumen_ia', 'done']], T_SB), scan('repo', [['repo', 'done']], T_REPO),
      scan('full_audit', [['repo', 'done']], '2026-10-24T19:00:00+00:00', { status: 'failed' }),
      scan('supabase', [['supabase', 'done']], '2026-10-24T19:30:00+00:00', { org_id: OTRA_ORG }));
    tablas.findings!.push(
      hallazgo('cloudflare', 'CF_WAF_OFF', 'low', null, 'wrangler.toml:10:5'),
      hallazgo('codebase', 'CB_ENV_COMMITTED', 'high', CONN, '.env:3'),               // sin «:línea»
      hallazgo('codebase', 'CB_SECRET_GENERIC', 'high', CONN_OTRO, 'src/otro.ts'),   // otro repo de la org: fuera
      hallazgo('codebase', 'CB_ZIP_SUELTO', 'medium', null, 'a.ts'),                 // ZIP: no es de ningún repo
      hallazgo('performance', 'PF_LCP', 'medium', null, null),                       // ni código ni infraestructura
      hallazgo('supabase', 'SB_RARO', 'grave', CONN_SB, null),                       // severidad ilegible: fuera
      hallazgo('supabase', 'SB_DE_OTRA', 'high', CONN_SB, null, OTRA_ORG),
      { ...hallazgo('cloudflare', 'CF_ZONE_01', 'low', null, null), status: 'verified' },   // ya no está abierto
      hallazgo('supabase', 'SB_RLS_DISABLED', 'critical', CONN_SB, null),
    );
    const h = await hallazgosDelRepo(admin(), ORG, 'acme/tienda');
    expect(h).toEqual({
      hallazgos: [
        { rule_id: 'SB_RLS_DISABLED', severity: 'critical', title: 'Título de SB_RLS_DISABLED' },
        { rule_id: 'CB_ENV_COMMITTED', severity: 'high', title: 'Título de CB_ENV_COMMITTED', path: '.env' },
        { rule_id: 'CF_WAF_OFF', severity: 'low', title: 'Título de CF_WAF_OFF', path: 'wrangler.toml' },
      ],
      auditoria_at: '2026-10-24T18:04:11.123Z',
    });
    // Cuatro consultas, todas de la org; de findings solo evidence->>path, nunca la evidencia entera.
    expect(doble.ops.map((o) => o.table).sort()).toEqual(['connections', 'findings', 'findings', 'scan_runs']);
    for (const o of doble.ops) expect(eqDe(o, 'org_id'), o.table).toBe(ORG);
    for (const f of deFindings()) {
      expect(f.columns).toContain('path:evidence->>path');
      expect(f.columns).not.toMatch(/evidence(,|$)/);
      expect(eqDe(f, 'status')).toBe('open');
    }
    // Filtrado en SQL: la infraestructura de la org y el código solo de las conexiones de ESE repo.
    expect(deFindings().map((f) => f.filters.filter(([c]) => c === 'module' || c === 'connection_id'))).toEqual(expect.arrayContaining([
      [['module', 'in', ['supabase', 'cloudflare']]],
      [['module', 'eq', 'codebase'], ['connection_id', 'in', [CONN]]],
    ]));
    // Orden total (dedupe_key es único por org) y el corte del motor.
    const ordenes = pedidos.filter((p) => p.table === 'findings');
    expect(ordenes).toHaveLength(2);
    for (const p of ordenes) expect(p).toMatchObject({ orden: [['severity_rank', false], ['dedupe_key', true]], limite: MAX_HALLAZGOS });
  });

  it(`más de ${MAX_HALLAZGOS} abiertos: el corte es siempre el mismo y el código de otros repos no desplaza al de este`, async () => {
    tablas.scan_runs!.push(scan('repo', [['repo', 'done']], T_REPO));
    const infra = Array.from({ length: MAX_HALLAZGOS + 50 }, (_, i) => hallazgo('supabase', `SB_${i}`, 'medium', CONN_SB, null));
    const ajenos = Array.from({ length: MAX_HALLAZGOS + 50 }, (_, i) => hallazgo('codebase', `CB_OTRO_${i}`, 'critical', CONN_OTRO, `x${i}.ts`));
    const propio = hallazgo('codebase', 'CB_PROPIO', 'high', CONN, 'src/a.ts');
    tablas.findings = [...infra, ...ajenos, propio];
    const a = await hallazgosDelRepo(admin(), ORG, 'acme/tienda');
    tablas.findings = [propio, ...[...ajenos].reverse(), ...[...infra].reverse()];   // otro orden físico
    const b = await hallazgosDelRepo(admin(), ORG, 'acme/tienda');
    expect(a.hallazgos).toHaveLength(MAX_HALLAZGOS);
    expect(a.hallazgos).toEqual(b.hallazgos);
    expect(await huellaDe(a)).toBe(await huellaDe(b));
    expect(a.hallazgos?.[0]).toMatchObject({ rule_id: 'CB_PROPIO', severity: 'high' });
    expect(a.hallazgos?.some((h) => h.rule_id.startsWith('CB_OTRO_'))).toBe(false);
  });

  it('sin conexión de ese repo, sin auditoría del repo o con la del repo de otra conexión → {} (no hubo auditoría)', async () => {
    tablas.scan_runs!.push(scan('supabase', [['supabase', 'done']], T_SB));
    tablas.findings!.push(hallazgo('supabase', 'SB_RLS_DISABLED', 'critical', CONN_SB, null));
    expect(await hallazgosDelRepo(admin(), ORG, 'acme/tienda')).toEqual({});           // solo Supabase auditado
    expect(await hallazgosDelRepo(admin(), ORG, 'acme/sin-conexion')).toEqual({});
    tablas.scan_runs!.push(scan('repo', [['repo', 'done']], T_REPO, { params: { connection_id: CONN_OTRO } }));
    expect(await hallazgosDelRepo(admin(), ORG, 'acme/tienda')).toEqual({});           // auditó acme/otro
    tablas.scan_runs!.push(scan('repo', [['repo', 'failed']], T_REPO, { params: { connection_id: CONN } }));
    expect(await hallazgosDelRepo(admin(), ORG, 'acme/tienda')).toEqual({});           // el paso repo falló
    expect(deFindings()).toEqual([]);                                                   // sin auditoría ni se leen
  });

  it('repo auditado sin hallazgos → [] (auditó y no encontró nada), con su fecha', async () => {
    tablas.scan_runs!.push(scan('full_audit', [['supabase', 'failed'], ['repo', 'done']], T_REPO, { params: { connection_id: CONN } }));
    expect(await hallazgosDelRepo(admin(), ORG, 'ACME/tienda')).toEqual({ hallazgos: [], auditoria_at: '2026-10-24T18:00:00.000Z' });
  });

  it('error de la base → ApiError internal (nunca hallazgos a medias)', async () => {
    tablas.scan_runs!.push(scan('repo', [['repo', 'done']], T_REPO));
    for (const t of ['scan_runs', 'findings', 'connections']) {
      fallo = t;
      await expect(hallazgosDelRepo(admin(), ORG, 'acme/tienda'), t).rejects.toMatchObject({ code: 'internal' });
    }
    expect(lineas.join('\n')).toContain('wiki.hallazgos_error');
  });

  it('huellaDe: null sin auditoría; con auditoría, la huellaHallazgos del motor (64 hex)', async () => {
    expect(await huellaDe({})).toBeNull();
    const hs = [{ rule_id: 'SB_RLS_DISABLED', severity: 'critical' as const, title: 't' }];
    expect(await huellaDe({ hallazgos: hs })).toBe(await huellaHallazgos(hs));
    expect(await huellaDe({ hallazgos: [] })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('elegir: caché, corrida en curso y corrida parada con la misma huella', () => {
  const ahora = Date.parse('2026-10-24T18:30:00Z');
  const hace = (ms: number) => new Date(ahora - ms).toISOString();
  const f = (id: string, status: string, huella: string | null, avance: number, creada = avance): FilaLlave =>
    ({ id, status, huella, created_at: hace(creada), updated_at: hace(avance) });

  it('la terminada más nueva con esa huella (null = sin auditoría); la en curso cuenta por su último avance, no por su edad', () => {
    const filas = [f('a', 'running', 'h1', 60_000, 10 * 3_600_000), f('b', 'succeeded', 'h2', 120_000), f('c', 'succeeded', null, 180_000),
      f('d', 'succeeded', 'h1', 240_000), f('e', 'queued', null, SIN_AVANCE_MS + 1000)];
    expect(elegir(filas, 'h1', ahora)).toEqual({ cache: 'd', enCurso: 'a', parada: null });     // 10 h viva, avanzó hace 1 min
    expect(elegir(filas, null, ahora)).toEqual({ cache: 'c', enCurso: null, parada: filas[4] });  // 'e' es de un Worker perdido
    expect(elegir(filas, 'h3', ahora)).toEqual({ cache: null, enCurso: null, parada: null });
  });

  it('SIN_AVANCE_MS = 10 min, el umbral del vigilante: tocada hace 9 min sigue viva; hace 11 min es parada', () => {
    expect(SIN_AVANCE_MS).toBe(10 * 60_000);
    const viva = f('v', 'running', 'h1', 9 * 60_000, 30 * 60_000);
    expect(elegir([viva], 'h1', ahora)).toEqual({ cache: null, enCurso: 'v', parada: null });
    const parada = f('p', 'queued', 'h1', 11 * 60_000);
    expect(elegir([parada], 'h1', ahora)).toEqual({ cache: null, enCurso: null, parada });
  });
});

describe('pasos y mensaje de la cola', () => {
  it('pasos iniciales: los cinco pending; caché: cuatro skipped y fin done con el commit corto', () => {
    expect(pasosIniciales()).toEqual(['arbol', 'triage', 'area', 'sintesis', 'fin'].map((name) => ({ name, status: 'pending' })));
    const c = pasosCache(SHA);
    for (const s of c) WikiRunStep.parse(s);
    expect(c.map((s) => s.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'done']);
    expect(c.at(-1)?.detalle).toBe('Reutiliza la wiki del commit 0123456');
  });

  it('mensaje de inicio: exactamente el de la interfaz con la pieza «cola»', () => {
    expect(mensajeInicio(ORG, 'e1e00000-0000-4000-8000-000000000001'))
      .toStrictEqual({ v: 1, kind: 'wiki', org_id: ORG, wiki_run_id: 'e1e00000-0000-4000-8000-000000000001', paso: 'arbol' });
  });
});

describe('aWikiRun: fila de wiki_runs → WikiRun', () => {
  it('models por defecto, numeric como texto, fechas en Z y pasos acotados al contrato', () => {
    const r = aWikiRun({ id: 'e1e00000-0000-4000-8000-000000000001', repo_full_name: 'acme/tienda', branch: 'main',
      commit_sha: SHA, status: 'running', progress: 104.4, est_usd: '0.043', cost_usd: null, models: {}, cached: false,
      error: null, created_at: T_SB, started_at: T_SB, finished_at: null,
      steps: [{ name: 'arbol', status: 'done', detalle: 'x'.repeat(120) }, { name: 'otro', status: 'done' }, null,
        { name: 'triage', status: 'running', error_code: 'limite_github' }] });
    expect(WikiRun.parse(r)).toEqual(r);
    expect(r).toMatchObject({ models: MODELOS_POR_DEFECTO, est_usd: 0.043, cost_usd: 0, progress: 100,
      created_at: '2026-10-24T18:04:11.123Z', finished_at: null });
    expect(r.steps).toEqual([{ name: 'arbol', status: 'done', detalle: 'x'.repeat(80) },
      { name: 'triage', status: 'running', error_code: 'limite_github' }]);
  });
});

describe('crearCorrida y cacheDeEstimacion (E40/E41)', () => {
  const base = { org_id: ORG, repo_full_name: 'acme/tienda', commit_sha: SHA, huella: null, doc: DOC, models: DOC.models,
    cached: false, created_at: T_SB, updated_at: T_SB };
  const pedido = (extra: Partial<Parameters<typeof crearCorrida>[1]> = {}) =>
    ({ orgId: ORG, repo: 'acme/tienda', commitSha: SHA, branch: 'main', userId: ANA, maxUsd: 1, force: false, ...extra });
  const enCola = () => tablas.wiki_runs!.filter((f) => f.status === 'queued');

  it('sin terminadas de ese commit, E40 ni siquiera calcula la huella (1 consulta)', async () => {
    expect(await cacheDeEstimacion(admin(), { orgId: ORG, repo: 'acme/tienda', commitSha: SHA })).toBeNull();
    expect(doble.ops.map((o) => o.table)).toEqual(['wiki_runs']);
  });

  it('con una terminada de la misma huella: E40 la devuelve y E41 crea la copia cached sin encolar', async () => {
    tablas.wiki_runs!.push({ ...base, id: RUN_A, status: 'succeeded' });
    expect(await cacheDeEstimacion(admin(), { orgId: ORG, repo: 'acme/tienda', commitSha: SHA })).toBe(RUN_A);
    const c = await crearCorrida(admin(), pedido({ maxUsd: 0.2 }));
    expect(c.tipo).toBe('cache');
    const nueva = tablas.wiki_runs!.find((f) => f.id === c.id);
    expect(nueva).toMatchObject({ org_id: ORG, cached: true, status: 'succeeded', progress: 100, cost_usd: 0, est_usd: 0,
      huella: null, max_usd: 0.2, requested_by: ANA, models: DOC.models, steps: pasosCache(SHA) });
    expect(nueva?.doc).toEqual(DOC);
    expect(nueva?.doc).not.toHaveProperty('run_id');
    // El doc se lee de ESA fila, de la org y terminada (defensa anti-IDOR aunque el id venga de la llave).
    const lectura = doble.ops.find((o) => o.table === 'wiki_runs' && o.columns === 'doc');
    expect(lectura && [eqDe(lectura, 'id'), eqDe(lectura, 'org_id'), eqDe(lectura, 'status')]).toEqual([RUN_A, ORG, 'succeeded']);
  });

  it('las copias cached no cuentan en la llave: muchas copias nuevas no tapan a la original', async () => {
    tablas.wiki_runs!.push({ ...base, id: RUN_A, status: 'succeeded', created_at: '2026-10-24T10:00:00+00:00' });
    for (let i = 0; i < 80; i++) {
      tablas.wiki_runs!.push({ ...base, id: `e1e00000-0000-4000-8000-${String(900 + i).padStart(12, '0')}`, status: 'succeeded',
        cached: true, created_at: new Date(Date.parse(T_REPO) + i * 1000).toISOString() });
    }
    expect(await cacheDeEstimacion(admin(), { orgId: ORG, repo: 'acme/tienda', commitSha: SHA })).toBe(RUN_A);
    const llave = doble.ops.find((o) => o.table === 'wiki_runs');
    expect(llave && [eqDe(llave, 'org_id'), eqDe(llave, 'cached')]).toEqual([ORG, false]);
    expect(pedidos.find((p) => p.table === 'wiki_runs')).toMatchObject({ orden: [['created_at', false]], limite: 50 });
  });

  it('con huella (repo auditado), E41 filtra la llave por ella en la propia consulta', async () => {
    tablas.scan_runs!.push(scan('repo', [['repo', 'done']], T_REPO));
    tablas.findings!.push(hallazgo('supabase', 'SB_RLS_DISABLED', 'critical', CONN_SB, null));
    const huella = await huellaHallazgos([{ rule_id: 'SB_RLS_DISABLED', severity: 'critical', title: 'Título de SB_RLS_DISABLED' }]);
    const c = await crearCorrida(admin(), pedido());
    expect(c.tipo).toBe('nueva');
    const llave = doble.ops.find((o) => o.table === 'wiki_runs' && o.action === 'select');
    expect(llave && eqDe(llave, 'huella')).toBe(huella);
    expect(tablas.wiki_runs!.find((f) => f.id === c.id)?.huella).toBe(huella);
  });

  it('doc guardado que ya no cumple el contrato → no se sirve: corrida nueva en cola (y un aviso)', async () => {
    tablas.wiki_runs!.push({ ...base, id: RUN_A, status: 'succeeded', doc: { overview_md: 1 } });
    const c = await crearCorrida(admin(), pedido());
    expect(c.tipo).toBe('nueva');
    expect(tablas.wiki_runs!.find((f) => f.id === c.id)).toMatchObject({ status: 'queued', cached: false, steps: pasosIniciales(),
      models: MODELOS_POR_DEFECTO });
    expect(lineas.join('\n')).toContain('wiki.cache_doc_invalido');
  });

  it('una corrida en curso de esa llave se devuelve tal cual, también con force (no se paga dos veces)', async () => {
    const ahora = new Date().toISOString();
    tablas.wiki_runs!.push({ ...base, id: RUN_B, status: 'running', doc: null, created_at: ahora, updated_at: ahora });
    for (const force of [false, true]) {
      expect(await crearCorrida(admin(), pedido({ force }))).toEqual({ tipo: 'en_curso', id: RUN_B });
    }
    expect(tablas.wiki_runs).toHaveLength(1);
  });

  it('dos E41 iguales a la vez: una sola fila en cola y las dos reciben esa corrida (23505 → en_curso)', async () => {
    latencia = 5;
    const [a, b] = await Promise.all([crearCorrida(admin(), pedido()), crearCorrida(admin(), pedido())]);
    expect([a.tipo, b.tipo].sort()).toEqual(['en_curso', 'nueva']);
    expect(a.id).toBe(b.id);
    expect(enCola()).toHaveLength(1);
    expect(lineas.join('\n')).toContain('wiki.crear_concurrente');
  });

  it('23505 sin ninguna en curso al releer (la que ganó ya cerró) → 409 conflict, sin fila', async () => {
    forzar23505 = true;
    await expect(crearCorrida(admin(), pedido())).rejects.toMatchObject({ code: 'conflict' });
    expect(tablas.wiki_runs).toEqual([]);
  });

  it('una en curso que lleva más de SIN_AVANCE_MS sin avanzar se cierra failed (CAS sobre updated_at) y se crea otra', async () => {
    const vieja = new Date(Date.now() - SIN_AVANCE_MS - 60_000).toISOString();
    tablas.wiki_runs!.push({ ...base, id: RUN_B, status: 'running', doc: null, created_at: vieja, updated_at: vieja });
    const c = await crearCorrida(admin(), pedido());
    expect(c.tipo).toBe('nueva');
    expect(tablas.wiki_runs!.find((f) => f.id === RUN_B)).toMatchObject({ status: 'failed', error: ERROR_PARADA });
    const cierre = doble.ops.find((o) => o.table === 'wiki_runs' && o.action === 'update');
    expect(cierre && [eqDe(cierre, 'id'), eqDe(cierre, 'org_id'), eqDe(cierre, 'updated_at')]).toEqual([RUN_B, ORG, vieja]);
    expect(cierre?.filters).toContainEqual(['status', 'in', ['queued', 'running']]);
    expect(enCola().map((f) => f.id)).toEqual([c.id]);
    expect(lineas.join('\n')).toContain('wiki.parada_cerrada');
  });

  it('si la parada avanzó justo antes del cierre, no se toca: el insert choca y se devuelve esa', async () => {
    const vieja = new Date(Date.now() - SIN_AVANCE_MS - 60_000).toISOString();
    const fila: Fila = { ...base, id: RUN_B, status: 'running', doc: null, created_at: vieja, updated_at: vieja };
    tablas.wiki_runs!.push(fila);
    antesDeUpdate = () => { fila.updated_at = new Date().toISOString(); };   // vg_wiki_avanzar de otra entrega
    expect(await crearCorrida(admin(), pedido())).toEqual({ tipo: 'en_curso', id: RUN_B });
    expect(fila.status).toBe('running');
    expect(tablas.wiki_runs).toHaveLength(1);
  });

  it('leerDoc: run_id = la fila pedida; de otra org → null; doc ilegible → doc null', async () => {
    tablas.wiki_runs!.push({ ...base, id: RUN_A, status: 'succeeded' },
      { ...base, id: 'e1e00000-0000-4000-8000-0000000000cc', status: 'succeeded', doc: { a: 1 } });
    const r = await leerDoc(admin(), ORG, RUN_A);
    expect(r?.doc?.run_id).toBe(RUN_A);
    expect(await leerDoc(admin(), OTRA_ORG, RUN_A)).toBeNull();
    expect((await leerDoc(admin(), ORG, 'e1e00000-0000-4000-8000-0000000000cc'))?.doc).toBeNull();
  });

  it('error de la base al crear → ApiError internal', async () => {
    fallo = 'wiki_runs';
    await expect(crearCorrida(admin(), pedido())).rejects.toBeInstanceOf(ApiError);
  });
});
