import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JobMsg, MsgScan, ResultadoPaso } from '../jobs.ts';
import { dbDoble, type Op } from '../test/db-doble.ts';

// Paso repo de punta a punta sin red: GitHub y OSV con fetch simulado, supabase-js con el doble, y el token, las llaves y
// la huella con dobles (hallazgos 4, 5, 8, 16, 17, 19, 20, 22 y 24, y los fallos de su revisión).
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
vi.mock('../lib/credentials.ts', () => ({
  withSecret: async (_e: unknown, _a: unknown, _c: unknown, fn: (t: string) => Promise<unknown>) => fn('tok-de-prueba'),
}));
vi.mock('../lib/keyring.ts', () => ({
  activeKid: async () => 'v1',
  getKeys: async () => {
    const k = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return { kid: 'v1', kek: k, fpk: k };
  },
}));
const { TOPE_HALLAZGOS, aCursor, deCursor, pasoRepo, recortar } = await import('./repo-paso.ts');
const { guarded, registrarPaso } = await import('../jobs.ts');
registrarPaso('repo', pasoRepo);

const SCAN = '5a1c0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const env = {} as CloudflareBindings;
const msg = (extra: Partial<MsgScan> = {}) => ({ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: 'repo', ...extra }) as MsgScan;

type Fila = { rule_id: string; resource: string; evidence: Record<string, unknown> };
type Rpc = { rows: Fila[]; complete: boolean; ok: boolean };
type Detalle = Record<string, unknown> & { miradas?: Record<string, boolean> };
let rpcs: Rpc[];
let marcas: Record<string, unknown>[];   // p_patch de cada vg_mark_step (guarded)
let coverage: Record<string, unknown>;
let rechazo: (rows: Fila[]) => boolean;
let doble: ReturnType<typeof dbDoble>;
const detalle = () => ((coverage.detail as Record<string, unknown> | undefined)?.codebase ?? {}) as Detalle;
const autoVerifico = () => rpcs.some((r) => r.complete && r.ok);

// ── GitHub y OSV simulados ──
type Repo = { arbol: string[]; truncado?: boolean; contenidos?: Record<string, string | number> };
let repo: Repo;
let osv: { batch: number | null; query: number | null };
type Fetch = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let f: Mock<Fetch>;
const LOCK = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { lodash: '4.17.15' } },
  'node_modules/lodash': { version: '4.17.15' } } });
const lockCon = (n: number) => JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(
  Array.from({ length: n }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0' }])) });

async function responder(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const u = new URL(String(url));
  if (u.host === 'api.osv.dev') {
    if (u.pathname === '/v1/querybatch') {
      if (osv.batch) return new Response('x', { status: osv.batch });
      const qs = (JSON.parse(String(init?.body)) as { queries: unknown[] }).queries;
      return Response.json({ results: qs.map(() => ({ vulns: [{ id: 'GHSA-1' }] })) });
    }
    if (osv.query) return new Response('x', { status: osv.query });
    return Response.json({ vulns: [{ id: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-23337'], database_specific: { severity: 'HIGH' } }] });
  }
  if (u.pathname === '/repos/o/r') return Response.json({ default_branch: 'main' });
  if (u.pathname === '/repos/o/r/commits') return Response.json([{ sha: 'abc' }]);
  if (u.pathname === '/repos/o/r/git/trees/abc') {
    const tree = repo.arbol.map((path) => {
      const c = repo.contenidos?.[path];
      return { path, type: 'blob', mode: '100644', size: typeof c === 'string' ? c.length : 10 };
    });
    return Response.json({ tree, truncated: repo.truncado === true });
  }
  const path = decodeURIComponent(u.pathname.replace(/^\/repos\/o\/r\/contents\//, ''));
  const c = repo.contenidos?.[path];
  return typeof c === 'number' ? new Response('x', { status: c }) : new Response(c ?? 'X=1');
}
// Árbol recursivo de más de 2 MB: arbolRepo pide además la raíz (4 peticiones en vez de 3).
const arbolGrande = (sig: Fetch): Fetch => async (url, init) => (new URL(String(url)).searchParams.get('recursive') === '1'
  ? new Response('{"tree":[', { headers: { 'content-length': '3000000' } }) : sig(url, init));
// Repo renombrado tras conectarlo: cada /repos/o/r/… da 301 a /repositories/1/… (mismo host) y su full_name es o/nuevo.
const renombrado = (sig: Fetch): Fetch => async (url, init) => {
  const u = new URL(String(url));
  if (u.host !== 'api.github.com') return sig(url, init);
  if (/^\/repos\/o\/r(\/|$)/.test(u.pathname)) {
    return new Response(null, { status: 301, headers: { location: u.href.replace('/repos/o/r', '/repositories/1') } });
  }
  if (u.pathname === '/repositories/1') return Response.json({ default_branch: 'main', full_name: 'o/nuevo' });
  return sig(u.href.replace(/\/repositories\/1|\/repos\/o\/nuevo/, '/repos/o/r'), init);
};

beforeEach(() => {
  rpcs = [];
  marcas = [];
  coverage = { seen: 2, detail: { supabase: { advisors: true } } };
  rechazo = () => false;
  repo = { arbol: [] };
  osv = { batch: null, query: null };
  doble = dbDoble({
    tabla: (op: Op) => {
      if (op.table === 'scan_runs' && op.action === 'select' && op.columns?.includes('steps')) {
        return { data: { id: SCAN, org_id: ORG, kind: 'repo', status: 'running',
          steps: [{ name: 'repo', status: 'running' }, { name: 'resumen_ia', status: 'pending' }] } };
      }
      if (op.table === 'scan_runs' && op.action === 'select') return { data: op.columns === 'params' ? { params: {} } : { coverage } };
      if (op.table === 'scan_runs' && op.action === 'update') { coverage = (op.payload as { coverage: Record<string, unknown> }).coverage; return {}; }
      if (op.table === 'connections') return { data: { id: 'c1', meta: { repo_full_name: 'o/r' }, capabilities: {} } };
      if (op.table === 'findings') return { count: 7 };
      return undefined;
    },
    rpc: (name, a) => {
      if (name === 'vg_claim_step') return { data: true };
      if (name === 'vg_mark_step') { marcas.push(a.p_patch as Record<string, unknown>); return {}; }
      if (name !== 'vg_upsert_findings') return undefined;
      const rows = a.p_rows as Fila[];
      const mala = rechazo(rows);
      rpcs.push({ rows, complete: a.p_complete as boolean, ok: !mala });
      return mala ? { error: { code: '23514' } } : { data: rows.length };
    },
  });
  estado.client = doble.client;
  f = vi.fn<Fetch>(responder);
  vi.stubGlobal('fetch', f);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const continuacion = (r: ResultadoPaso) => {
  if (!('continuar' in r)) throw new Error('esperaba continuar');
  return r.continuar;
};
const BASE = { '.gitignore': '.env\nnode_modules/\n', 'src/config.ts': 'export const a = 1;\n' };

describe('cursor y tope', () => {
  it('el cursor lleva ronda, marcas y cuentas; osv:2 a secas (mensajes en vuelo) sigue valiendo', () => {
    const e = { ronda: 3, parcial: true, tripwire: true, osvIncompleto: false, escritas: 12, omitidas: 4 };
    expect(aCursor(e)).toBe('osv:3:pt:12:4');
    expect(deCursor(aCursor(e))).toEqual(e);
    expect(deCursor('osv:2')).toEqual({ ronda: 2, parcial: false, tripwire: false, osvIncompleto: false, escritas: 0, omitidas: 0 });
    expect(deCursor('osv:1:o:0:0').parcial).toBe(true);
  });

  it('recortar deja las más graves dentro del cupo', () => {
    const xs = [{ severity: 'low', i: 0 }, { severity: 'critical', i: 1 }, { severity: 'medium', i: 2 }, { severity: 'critical', i: 3 }];
    const r = recortar(xs, 2);
    expect(r.dentro.map((x) => x.i)).toEqual([1, 3]);
    expect(r.fuera.map((x) => x.i)).toEqual([2, 0]);
    expect(recortar(xs, -5).dentro).toEqual([]);
  });
});

describe('repo:archivos', () => {
  it('sin deps y todo leído: un solo RPC que auto-verifica, miradas en verde y coverage fusionado', async () => {
    repo = { arbol: ['.gitignore', 'src/config.ts'], contenidos: BASE };
    const r = await pasoRepo(env, msg());
    expect(r).toEqual({ status: 'done', findings: 7 });
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]?.complete).toBe(true);
    expect(detalle().miradas).toEqual({ secretos: true, env: true, lockfiles: true, osv: true });
    expect(coverage.seen).toBe(2);
    expect((coverage.detail as Record<string, unknown>).supabase).toEqual({ advisors: true });
  });

  it.each([502, 429])('un contents con %i lanza ProviderError transitorio y no escribe nada (hallazgos 4, 5 y 8)', async (status) => {
    repo = { arbol: ['.gitignore', 'src/config.ts'], contenidos: { ...BASE, 'src/config.ts': status } };
    await expect(pasoRepo(env, msg())).rejects.toMatchObject({ code: status === 429 ? 'rate_limited' : 'unavailable' });
    expect(rpcs).toHaveLength(0);
  });

  it('un archivo que da 404 deja la lectura parcial: sin auto-verificar, miradas.secretos false y error_code parcial', async () => {
    repo = { arbol: ['.gitignore', 'src/config.ts'], contenidos: { ...BASE, 'src/config.ts': 404 } };
    const r = await pasoRepo(env, msg());
    expect(r).toEqual({ status: 'done', findings: 7, error_code: 'parcial' });
    expect(autoVerifico()).toBe(false);
    expect(detalle().miradas?.secretos).toBe(false);
    expect(detalle().archivos_incompletos).toBe(1);
  });

  it('lockfile ilegible: sin deps pero sin auto-verificar y con lockfiles y osv sin mirar', async () => {
    repo = { arbol: ['.gitignore', 'package-lock.json'], contenidos: { ...BASE, 'package-lock.json': '{ roto' } };
    const r = await pasoRepo(env, msg());
    expect(r).toMatchObject({ status: 'done', error_code: 'parcial' });
    expect(autoVerifico()).toBe(false);
    expect(detalle()).toMatchObject({ lockfiles_ilegibles: 1, miradas: { lockfiles: false, osv: false, secretos: true } });
  });

  it('un package-lock de más de 1 MB (no se elige) también deja parcial el cierre', async () => {
    repo = { arbol: ['.gitignore', 'package-lock.json'], contenidos: { ...BASE, 'package-lock.json': ' '.repeat(1_000_001) } };
    await pasoRepo(env, msg());
    expect(autoVerifico()).toBe(false);
    expect(detalle().miradas?.lockfiles).toBe(false);
  });

  it('solo pnpm-lock.yaml (aún no se lee): osv sin mirar, pero el cierre auto-verifica (no pudo dejar CB_DEP_VULN)', async () => {
    repo = { arbol: ['.gitignore', 'pnpm-lock.yaml'], contenidos: { ...BASE, 'pnpm-lock.yaml': 'lockfileVersion: 9' } };
    await pasoRepo(env, msg());
    expect(autoVerifico()).toBe(true);
    expect(detalle().miradas).toMatchObject({ lockfiles: false, osv: false });
  });

  it('.gitignore en el árbol pero sin leer: no inventa CB_GITIGNORE_NO_ENV y miradas.env false', async () => {
    repo = { arbol: ['.gitignore', 'src/config.ts'], contenidos: { ...BASE, '.gitignore': 404 } };
    await pasoRepo(env, msg());
    expect(rpcs.flatMap((r) => r.rows).some((x) => x.rule_id === 'CB_GITIGNORE_NO_ENV')).toBe(false);
    expect(detalle().miradas?.env).toBe(false);
  });

  it('.gitignore de más de 1 MB (no se elige): sin CB_GITIGNORE_NO_ENV y el cierre no auto-verifica (revisión de 4/5/8)', async () => {
    repo = { arbol: ['.gitignore', 'src/config.ts'], contenidos: { ...BASE, '.gitignore': 'node_modules/\n' + ' '.repeat(1_000_001) } };
    const r = await pasoRepo(env, msg());
    expect(r).toMatchObject({ status: 'done', error_code: 'parcial' });
    expect(autoVerifico()).toBe(false);
    expect(rpcs.flatMap((x) => x.rows).some((x) => x.rule_id === 'CB_GITIGNORE_NO_ENV')).toBe(false);
    expect(detalle().miradas?.env).toBe(false);
  });

  // Regresión de la ronda 1: leerContenidos perdía los archivos vacíos (ni en archivos ni en incompletos).
  it('.gitignore vacío: sale CB_GITIGNORE_NO_ENV, el paso no queda parcial y el cierre auto-verifica', async () => {
    repo = { arbol: ['.gitignore', '.env', 'src/config.ts'], contenidos: { ...BASE, '.gitignore': '', '.env': 'A=1\n' } };
    const r = await pasoRepo(env, msg());
    expect(r).toEqual({ status: 'done', findings: 7 });
    expect(rpcs.flatMap((x) => x.rows).map((x) => x.rule_id)).toEqual(expect.arrayContaining(['CB_ENV_COMMITTED', 'CB_GITIGNORE_NO_ENV']));
    expect(rpcs).toHaveLength(1);
    expect(autoVerifico()).toBe(true);
    expect(detalle()).toMatchObject({ archivos_incompletos: 0, miradas: { secretos: true, env: true, lockfiles: true, osv: true } });
  });

  it.each(['package-lock.json', 'composer.lock'])('%s vacío = leído sin deps: ni ilegible ni sin leer, sin cola de OSV y auto-verifica', async (lock) => {
    repo = { arbol: ['.gitignore', lock, 'src/config.ts'], contenidos: { ...BASE, [lock]: '' } };
    const r = await pasoRepo(env, msg());
    expect(r).toEqual({ status: 'done', findings: 7 });
    expect(autoVerifico()).toBe(true);
    expect(detalle()).toMatchObject({ lockfiles_ilegibles: 0, archivos_incompletos: 0,
      miradas: { secretos: true, env: true, lockfiles: true, osv: true } });
  });

  it('tope de 200 filas por escaneo: entran las críticas, el resto en hallazgos_omitidos (hallazgo 20)', async () => {
    const envs = Array.from({ length: 250 }, (_, i) => `d${i}/.env`);
    repo = { arbol: ['src/config.ts', ...envs] };   // sin .gitignore: CB_GITIGNORE_NO_ENV (medium) queda fuera
    const r = await pasoRepo(env, msg());
    const filas = rpcs.flatMap((x) => x.rows);
    expect(filas).toHaveLength(TOPE_HALLAZGOS);
    expect(filas.every((x) => x.rule_id === 'CB_ENV_COMMITTED')).toBe(true);
    expect(r).toMatchObject({ status: 'done', error_code: 'hallazgos_truncados' });
    expect(autoVerifico()).toBe(false);
    expect(detalle()).toMatchObject({ hallazgos_omitidos: 51, miradas: { env: false } });
  });

  it('cable trampa: la fila descartada da error_code tripwire y el cierre no auto-verifica (hallazgos 16 y 19)', async () => {
    rechazo = (rows) => rows.some((x) => x.resource === 'secreto/.env');
    repo = { arbol: ['.gitignore', 'secreto/.env'], contenidos: BASE };
    const r = await pasoRepo(env, msg());
    expect(r).toEqual({ status: 'done', findings: 7, error_code: 'tripwire' });
    expect(autoVerifico()).toBe(false);
    expect(detalle().miradas).toMatchObject({ secretos: false, env: false });
  });
});

describe('repo:osv', () => {
  const conDeps = (extra: Partial<Repo> = {}) => {
    repo = { arbol: ['.gitignore', 'package-lock.json'], contenidos: { ...BASE, 'package-lock.json': LOCK }, ...extra };
  };

  it('todo leído: archivos encola osv:1 y el cierre auto-verifica con miradas.osv true', async () => {
    conDeps();
    const c = continuacion(await pasoRepo(env, msg()));
    expect(c.cursor).toBe('osv:1::0:0');
    expect(c.deps).toEqual([['npm', 'lodash', '4.17.15', 0]]);
    expect(autoVerifico()).toBe(false);
    expect(detalle().miradas).toEqual({ secretos: true, env: true, lockfiles: true, osv: false });

    const r = await pasoRepo(env, msg(c));
    expect(r).toEqual({ status: 'done', findings: 7 });
    const cierre = rpcs.at(-1)!;
    expect(cierre).toMatchObject({ complete: true, ok: true });
    expect(cierre.rows[0]).toMatchObject({ rule_id: 'CB_DEP_VULN', resource: 'npm:lodash@4.17.15' });
    expect(detalle().miradas).toEqual({ secretos: true, env: true, lockfiles: true, osv: true });
  });

  it('árbol truncado: la marca p viaja en el cursor y el cierre no auto-verifica (hallazgo 4)', async () => {
    conDeps({ truncado: true });
    const c = continuacion(await pasoRepo(env, msg()));
    expect(c.cursor).toBe('osv:1:p:0:0');
    const r = await pasoRepo(env, msg(c));
    expect(r).toMatchObject({ status: 'done', error_code: 'parcial' });
    expect(autoVerifico()).toBe(false);
    expect(detalle().miradas?.osv).toBe(false);
  });

  it('más de 2000 deps: se marca parcial y deps_truncadas', async () => {
    conDeps({ contenidos: { ...BASE, 'package-lock.json': lockCon(2001) } });
    const c = continuacion(await pasoRepo(env, msg()));
    expect(c.cursor.startsWith('osv:1:p:')).toBe(true);
    expect(c.deps).toHaveLength(2000);
    expect(detalle().deps_truncadas).toBe(true);
  });

  it('cable trampa en archivos con deps: la marca t llega al cierre (error_code tripwire, sin auto-verificar)', async () => {
    rechazo = (rows) => rows.some((x) => x.resource === 'secreto/.env');
    conDeps({ arbol: ['.gitignore', 'package-lock.json', 'secreto/.env'] });
    const c = continuacion(await pasoRepo(env, msg()));
    expect(c.cursor).toBe('osv:1:pt:0:0');
    const r = await pasoRepo(env, msg(c));
    expect(r).toMatchObject({ status: 'done', error_code: 'tripwire' });
    expect(autoVerifico()).toBe(false);
  });

  it('OSV caído: el primer intento lanza para el reintento de cola; con él gastado, done osv_unavailable sin auto-verificar (hallazgo 17)', async () => {
    conDeps();
    const c = continuacion(await pasoRepo(env, msg()));
    osv.batch = 503;
    const antes = JSON.stringify(coverage);
    await expect(pasoRepo(env, msg(c), 1)).rejects.toMatchObject({ code: 'unavailable' });
    expect(JSON.stringify(coverage)).toBe(antes);   // sin marca propia en coverage: decide m.attempts
    const r = await pasoRepo(env, msg(c), 2);
    expect(r).toEqual({ status: 'done', findings: 7, error_code: 'osv_unavailable' });
    expect(autoVerifico()).toBe(false);
    expect(detalle().miradas?.osv).toBe(false);
  });

  it('OSV que se recupera en el reintento de cola cierra normal', async () => {
    conDeps();
    const c = continuacion(await pasoRepo(env, msg()));
    osv.batch = 502;
    await expect(pasoRepo(env, msg(c), 1)).rejects.toMatchObject({ code: 'unavailable' });
    osv.batch = null;
    expect(await pasoRepo(env, msg(c), 2)).toEqual({ status: 'done', findings: 7 });
    expect(autoVerifico()).toBe(true);
  });

  it('OSV con 400 (no transitorio) se rinde sin gastar el reintento de cola', async () => {
    conDeps();
    const c = continuacion(await pasoRepo(env, msg()));
    osv.batch = 400;
    expect(await pasoRepo(env, msg(c))).toMatchObject({ status: 'done', error_code: 'osv_unavailable' });
  });

  it('un /query caído: primero vuelve a la cola; luego entra sin detalle y el cierre no auto-verifica (hallazgo 8)', async () => {
    conDeps();
    const c = continuacion(await pasoRepo(env, msg()));
    osv.query = 503;
    await expect(pasoRepo(env, msg(c), 1)).rejects.toMatchObject({ code: 'unavailable' });
    expect(rpcs.filter((x) => x.rows.some((y) => y.rule_id === 'CB_DEP_VULN'))).toHaveLength(0);   // no rebaja nada todavía
    const r = await pasoRepo(env, msg(c), 2);
    expect(r).toMatchObject({ status: 'done', error_code: 'parcial' });
    expect(rpcs.at(-1)?.rows[0]?.evidence.sin_detalle).toBe(true);
    expect(autoVerifico()).toBe(false);
    expect(detalle().miradas?.osv).toBe(false);
  });

  it('un /query con 400 (no transitorio): no vuelve a la cola, pero entra sin detalle y el cierre no auto-verifica', async () => {
    conDeps();
    const c = continuacion(await pasoRepo(env, msg()));
    osv.query = 400;
    const r = await pasoRepo(env, msg(c), 1);
    expect(r).toMatchObject({ status: 'done', error_code: 'parcial' });
    expect(rpcs.at(-1)?.rows[0]?.evidence.sin_detalle).toBe(true);
    expect(autoVerifico()).toBe(false);
    expect(detalle().miradas?.osv).toBe(false);
  });

  it('el tope de 200 cuenta lo ya escrito por archivos: en el cierre de OSV entra solo el cupo que queda', async () => {
    conDeps({ contenidos: { ...BASE, 'package-lock.json': lockCon(5) } });
    const c = continuacion(await pasoRepo(env, msg()));
    const r = await pasoRepo(env, msg({ ...c, cursor: `osv:1::${TOPE_HALLAZGOS - 2}:0` }));
    expect(rpcs.at(-1)?.rows).toHaveLength(2);
    expect(r).toMatchObject({ status: 'done', error_code: 'hallazgos_truncados' });
    expect(autoVerifico()).toBe(false);
    expect(detalle()).toMatchObject({ hallazgos_omitidos: 3, miradas: { osv: false } });
  });
});

// .gitignore que los lockfiles dejaban fuera del cupo (revisión de los hallazgos 4, 5 y 8): ningún RPC auto-verifica.
describe('repo · .gitignore y cupo de 3 MB', () => {
  it('3 lockfiles de ~1 MB y un .gitignore sin .env: entra el .gitignore y la cadena archivos→osv nunca auto-verifica', async () => {
    const relleno = (txt: string) => txt + ' '.repeat(999_990 - txt.length);
    const composer = JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v8.0.0' }] });
    repo = { arbol: ['.gitignore', 'apps/a/package-lock.json', 'composer.lock', 'package-lock.json', 'src/config.ts'],
      contenidos: { '.gitignore': 'node_modules/\n' + '#'.repeat(26), 'apps/a/package-lock.json': relleno(LOCK),
        'composer.lock': relleno(composer), 'package-lock.json': relleno(LOCK), 'src/config.ts': 'export const a = 1;\n' } };
    const c = continuacion(await pasoRepo(env, msg()));   // .gitignore de 40 B: el tercer lockfile ya no cabe en los 3 MB
    expect(f.mock.calls.some(([u]) => String(u).includes('/contents/.gitignore'))).toBe(true);
    expect(c.cursor.startsWith('osv:1:p')).toBe(true);
    await pasoRepo(env, msg(c));
    expect(autoVerifico()).toBe(false);
    expect(rpcs.flatMap((x) => x.rows).some((x) => x.rule_id === 'CB_GITIGNORE_NO_ENV')).toBe(true);   // ahora sí se mira
    expect(detalle().miradas).toMatchObject({ env: true, lockfiles: false, osv: false });
  });
});

// Hallazgo 17 por la cola de verdad (guarded): decide m.attempts, no una marca en coverage que una entrega anterior
// caída por otra cosa (claim, encolar, CPU) nunca llegó a escribir.
describe('repo:osv · reintento de cola por m.attempts', () => {
  const entrega = (cuerpo: MsgScan, attempts: number) => ({ id: 'm1', timestamp: new Date(), body: cuerpo as JobMsg, attempts,
    ack: vi.fn(), retry: vi.fn() });
  const envCola = () => ({ JOBS_Q: { send: vi.fn(async () => {}) } }) as unknown as CloudflareBindings;
  const cuerpoOsv = () => msg({ cursor: 'osv:1::0:0', deps: [['npm', 'lodash', '4.17.15', 0]] });

  it('primera entrega con OSV caído: m.retry y el paso sigue abierto', async () => {
    osv.batch = 503;
    const m = entrega(cuerpoOsv(), 1);
    await guarded(envCola(), m as unknown as Message<JobMsg>, cuerpoOsv());
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(marcas).toEqual([]);
  });

  // Workers sube attempts en cada reentrega, también si la anterior cayó por otra cosa (CPU, claim): 3 es igual que 2.
  it.each([2, 3])('attempts=%i sin marca previa y querybatch caído: done osv_unavailable, no failed unavailable', async (attempts) => {
    osv.batch = 503;
    const m = entrega(cuerpoOsv(), attempts);
    await guarded(envCola(), m as unknown as Message<JobMsg>, cuerpoOsv());
    expect(m.retry).not.toHaveBeenCalled();
    expect(marcas).toEqual([{ status: 'done', findings: 7, error_code: 'osv_unavailable' }]);
    expect(m.ack).toHaveBeenCalled();
    expect(autoVerifico()).toBe(false);
  });

  it('attempts=2 y un /query caído: entra sin detalle y el paso queda done parcial, sin auto-verificar', async () => {
    osv.query = 503;
    const m = entrega(cuerpoOsv(), 2);
    await guarded(envCola(), m as unknown as Message<JobMsg>, cuerpoOsv());
    expect(marcas).toEqual([{ status: 'done', findings: 7, error_code: 'parcial' }]);
    expect(rpcs.at(-1)?.rows[0]?.evidence.sin_detalle).toBe(true);
    expect(autoVerifico()).toBe(false);
  });
});

// Presupuesto de subpeticiones del paso (§A7: tope propio de 40) contado por la cola de verdad (guarded): GitHub y OSV
// por fetch, cada consulta y RPC del doble de supabase-js, el send de la cola y las 4 de las llaves en frío y rotadas
// (connection_secrets, app_config y 2 × vg_crypto_material, aquí con dobles). Revisión de la ronda 1: con RESCATE=6 fijo
// el paso repo:archivos llegaba a 42.
const LLAVES_EN_FRIO = 4;
const CONFIGS = ['wrangler.toml', '.npmrc', 'Dockerfile', 'vercel.json', 'netlify.toml', 'firebase.json', 'docker-compose.yml',
  'supabase/config.toml', '.github/workflows/ci.yml'];
const codigoRiesgo = (n: number) => Array.from({ length: n }, (_, i) => `src/config${i}.ts`);
const deriva = (rows: Fila[]) => rows.some((x) => JSON.stringify(x.evidence) !== '{"redacted":true}');   // la regex de JS no lo vio
// Una entrega por guarded; devuelve las subpeticiones contadas de verdad (las llaves en frío van con dobles, se suman a mano).
async function porLaCola(cuerpo: MsgScan = msg()) {
  const send = vi.fn(async () => {});
  const m = { id: 'm1', timestamp: new Date(), body: cuerpo as JobMsg, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  await guarded({ JOBS_Q: { send } } as unknown as CloudflareBindings, m as unknown as Message<JobMsg>, cuerpo);
  expect(m.ack).toHaveBeenCalled();
  expect(m.retry).not.toHaveBeenCalled();
  return doble.ops.length + doble.rpcs.length + f.mock.calls.length + send.mock.calls.length + (cuerpo.cursor ? 0 : LLAVES_EN_FRIO);
}
const leidos = () => f.mock.calls.filter(([u]) => String(u).includes('/contents/')).length;

describe('repo:archivos · presupuesto de subpeticiones del rescate (hallazgo 24)', () => {

  it('20 archivos en frío, 3 filas y la base rechaza todo: el lote tapado en vez de fila por fila, tripwire y ≤ 40', async () => {
    rechazo = () => true;
    repo = { arbol: ['.gitignore', 'a/.env', 'b/.env', 'c/.env', ...CONFIGS, ...codigoRiesgo(10)], contenidos: { '.gitignore': '.env\n' } };
    const n = await porLaCola();
    expect(leidos()).toBe(20);
    expect(rpcs.map((x) => [x.rows.length, x.complete])).toEqual([[3, true], [3, true]]);   // lote y lote tapado, sin fila por fila
    expect(rpcs[1]?.rows.every((x) => JSON.stringify(x.evidence) === '{"redacted":true}')).toBe(true);
    expect(marcas).toEqual([{ status: 'done', findings: 7, error_code: 'tripwire' }]);
    expect(autoVerifico()).toBe(false);
    expect(n).toBeLessThanOrEqual(40);
  });

  it('peor caso: árbol de 4 peticiones (recursivo > 2 MB) y 20 archivos; el lote tapado guarda todo y no pasa de 40', async () => {
    rechazo = deriva;
    repo = { arbol: ['.gitignore', 'a/.env', 'b/.env', 'c/.env', ...CONFIGS, ...codigoRiesgo(10)], contenidos: { '.gitignore': '.env\n' } };
    f.mockImplementation(arbolGrande(responder));
    const n = await porLaCola();
    expect(f.mock.calls.filter(([u]) => String(u).includes('/git/trees/'))).toHaveLength(2);
    expect(leidos()).toBe(20);
    expect(rpcs.map((x) => [x.rows.length, x.complete, x.ok])).toEqual([[3, false, false], [3, false, true]]);
    expect(marcas).toEqual([{ status: 'done', findings: 7, error_code: 'parcial' }]);   // árbol truncado: parcial, no tripwire
    expect(n).toBeLessThanOrEqual(40);
  });

  it('1 fila: fila por fila sí cabe (lote, fila, fila tapada y auto-verificación) y llega justo a 40', async () => {
    rechazo = deriva;
    repo = { arbol: ['.gitignore', 'a/.env', ...CONFIGS, ...codigoRiesgo(12)], contenidos: { '.gitignore': '.env\n' } };
    const n = await porLaCola();
    expect(leidos()).toBe(20);
    expect(rpcs.map((x) => [x.rows.length, x.complete, x.ok])).toEqual([[1, true, false], [1, false, false], [1, false, true], [0, true, true]]);
    expect(marcas).toEqual([{ status: 'done', findings: 7 }]);
    expect(n).toBe(40);
  });

  // Revisión de la ronda 1: con RESCATE fijo o una reserva de menos, estos casos pasaban de 40. Cada uno con su cuenta exacta.
  it('20 archivos (uno con 404, parcial) y 2 filas con deriva: fila por fila ya no cabe, va el lote tapado y quedan 38', async () => {
    rechazo = deriva;
    repo = { arbol: ['.gitignore', 'a/.env', 'b/.env', ...CONFIGS, ...codigoRiesgo(8)],
      contenidos: { '.gitignore': '.env\n', 'src/config0.ts': 404 } };
    const n = await porLaCola();
    expect(leidos()).toBe(20);
    expect(rpcs.map((x) => [x.rows.length, x.complete, x.ok])).toEqual([[2, false, false], [2, false, true]]);
    expect(marcas).toEqual([{ status: 'done', findings: 7, error_code: 'parcial' }]);
    expect(n).toBe(38);
  });

  it('árbol de 4 peticiones, 20 archivos y 1 fila con deriva: fila por fila cabe justo (sin auto-verificar) y llega a 40', async () => {
    rechazo = deriva;
    repo = { arbol: ['.gitignore', 'a/.env', ...CONFIGS, ...codigoRiesgo(12)], contenidos: { '.gitignore': '.env\n' } };
    f.mockImplementation(arbolGrande(responder));
    const n = await porLaCola();
    expect(leidos()).toBe(20);
    expect(rpcs.map((x) => [x.rows.length, x.complete, x.ok])).toEqual([[1, false, false], [1, false, false], [1, false, true]]);
    expect(marcas).toEqual([{ status: 'done', findings: 7, error_code: 'parcial' }]);
    expect(n).toBe(40);
  });

  it('pocos archivos y 3 filas con deriva: el presupuesto sale de lo gastado de verdad y fila por fila sí cabe (28)', async () => {
    rechazo = deriva;
    repo = { arbol: ['.gitignore', 'a/.env', 'b/.env', 'c/.env'], contenidos: { '.gitignore': '.env\n' } };
    const n = await porLaCola();
    expect(rpcs.map((x) => [x.rows.length, x.complete, x.ok])).toEqual([[3, true, false],
      [1, false, false], [1, false, true], [1, false, false], [1, false, true], [1, false, false], [1, false, true], [0, true, true]]);
    expect(marcas).toEqual([{ status: 'done', findings: 7 }]);
    expect(n).toBe(28);
  });

  it('el descarte del filtro en JS (secreto en la ruta) sale como tripwire en steps y deja miradas reales', async () => {
    const PAT = ['gh', 'p_', 'A'.repeat(30)].join('');   // armado en tiempo de ejecución: ningún literal con forma de secreto
    // «x_ghp_…»: redact() exige \b y no lo tapa; el filtro en JS, como private.looks_like_secret, sí lo ve.
    repo = { arbol: ['.gitignore', `x_${PAT}/.env`, 'src/config.ts'], contenidos: BASE };
    await porLaCola();
    expect(marcas).toEqual([{ status: 'done', findings: 7, error_code: 'tripwire' }]);
    expect(rpcs).toHaveLength(0);   // la única fila se descartó antes de la base; sin filas y con descarte no auto-verifica
    expect(detalle().miradas).toEqual({ secretos: false, env: false, lockfiles: true, osv: true });
  });
});

// Revisión de la ronda 2 (bloqueante): con el nombre viejo de la conexión GitHub da 301 en cada llamada y el paso hacía
// 46 fetch en vez de 23 (54 subpeticiones > 50 de Free). Ahora solo /repos/<viejo> paga el salto y se cuenta por lo alto.
describe('repo:archivos · repo renombrado o transferido', () => {
  const VEINTE = ['.gitignore', 'a/.env', 'b/.env', 'c/.env', ...CONFIGS, ...codigoRiesgo(10)];
  const saltos = () => f.mock.calls.filter(([u]) => /\/repos\/o\/r(\/|$|\?)/.test(new URL(String(u)).pathname)).length;

  it('301 en cada llamada con el nombre viejo: 20 archivos leídos con el canónico, un solo salto y ≤ 40', async () => {
    repo = { arbol: VEINTE, contenidos: { '.gitignore': '.env\n' } };
    f.mockImplementation(renombrado(responder));
    const n = await porLaCola();
    expect(saltos()).toBe(1);
    expect(leidos()).toBe(20);
    expect(f.mock.calls.filter(([u]) => String(u).includes('/repos/o/nuevo/'))).toHaveLength(22);   // commits, árbol y 20 contents
    expect(marcas).toEqual([{ status: 'done', findings: 7 }]);
    expect(autoVerifico()).toBe(true);
    expect(n).toBe(38);   // el presupuesto contó 3 saltos (40): nunca por debajo del gasto real
  });

  it('renombrado y la base lo rechaza todo: solo cabe el lote (sin rescate), tripwire y ≤ 40', async () => {
    rechazo = () => true;
    repo = { arbol: VEINTE, contenidos: { '.gitignore': '.env\n' } };
    f.mockImplementation(renombrado(responder));
    const n = await porLaCola();
    expect(rpcs.map((x) => [x.rows.length, x.complete])).toEqual([[3, true]]);
    expect(marcas).toEqual([{ status: 'done', findings: 7, error_code: 'tripwire' }]);
    expect(n).toBeLessThanOrEqual(40);
  });

  it('renombrado con árbol de 4 peticiones: solo caben 19 rutas; la de menos riesgo queda sin leer (parcial) y ≤ 40', async () => {
    repo = { arbol: VEINTE, contenidos: { '.gitignore': '.env\n' } };
    f.mockImplementation(renombrado(arbolGrande(responder)));
    const n = await porLaCola();
    expect(leidos()).toBe(19);
    expect(f.mock.calls.some(([u]) => String(u).includes('/contents/src/config9.ts'))).toBe(false);
    expect(marcas).toEqual([{ status: 'done', findings: 7, error_code: 'parcial' }]);
    expect(detalle()).toMatchObject({ archivos_sin_cupo: 1, archivos_incompletos: 1, miradas: { secretos: false } });
    expect(n).toBeLessThanOrEqual(40);
  });
});

// Revisión de la ronda 2: un repo sin commits (409 en /commits) quedaba failed 'invalid' en cada auditoría.
describe('repo:archivos · repo vacío', () => {
  it('409 en /commits: done sin hallazgos, auto-verifica (no había nada que mirar) y miradas en verde', async () => {
    f.mockImplementation(async (url, init) => (new URL(String(url)).pathname === '/repos/o/r/commits'
      ? Response.json({ message: 'Git Repository is empty.' }, { status: 409 }) : responder(url, init)));
    const n = await porLaCola();
    expect(marcas).toEqual([{ status: 'done', findings: 7 }]);
    expect(rpcs.map((x) => [x.rows.length, x.complete, x.ok])).toEqual([[0, true, true]]);   // sin CB_GITIGNORE_NO_ENV
    expect(f).toHaveBeenCalledTimes(2);
    expect(detalle()).toMatchObject({ repo_vacio: true, archivos_leidos: 0, archivos_total: 0,
      miradas: { secretos: true, env: true, lockfiles: true, osv: true } });
    expect(n).toBeLessThanOrEqual(40);
  });
});

// repo:osv por guarded: el presupuesto del rescate resta las /query de este mensaje (12 como mucho).
describe('repo:osv · presupuesto de subpeticiones', () => {
  const deps = (k: number) => Array.from({ length: k }, (_, i) => ['npm', `p${i}`, '1.0.0', 0] as [string, string, string, 0 | 1]);

  it('cierre con 12 paquetes y deriva en la base: fila por fila no cabe (25 > 17), va el lote tapado y quedan 24', async () => {
    rechazo = deriva;
    const n = await porLaCola(msg({ cursor: 'osv:1::0:0', deps: deps(12) }));
    expect(f.mock.calls.filter(([u]) => String(u).endsWith('/v1/query'))).toHaveLength(12);
    expect(rpcs.map((x) => [x.rows.length, x.complete, x.ok])).toEqual([[12, true, false], [12, true, true]]);
    expect(marcas).toEqual([{ status: 'done', findings: 7 }]);
    expect(n).toBe(24);
  });

  it('continuación con 13 paquetes y deriva: el lote tapado, encola la ronda 2 y quedan 20', async () => {
    rechazo = deriva;
    const send = vi.fn(async () => {});
    const cuerpo = msg({ cursor: 'osv:1::0:0', deps: deps(13) });
    const m = { id: 'm1', timestamp: new Date(), body: cuerpo as JobMsg, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await guarded({ JOBS_Q: { send } } as unknown as CloudflareBindings, m as unknown as Message<JobMsg>, cuerpo);
    expect(rpcs.map((x) => [x.rows.length, x.complete, x.ok])).toEqual([[12, false, false], [12, false, true]]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'osv:2::12:0', deps: [['npm', 'p12', '1.0.0', 0]] }));
    expect(marcas).toEqual([]);
    expect(doble.ops.length + doble.rpcs.length + f.mock.calls.length + send.mock.calls.length).toBe(20);
  });
});
