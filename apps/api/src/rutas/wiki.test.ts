import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, fixtures, WikiDoc, WikiEstimate, WikiRun, WikiRunAccepted } from '@vanguard/contracts';
import { huellaHallazgos } from '@vanguard/deepwiki';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';
import { TOPE_SUBPETICIONES } from '../wiki/deps.ts';

// E40–E44 de la Wiki del repo, sin red: fetch simulado como la API de GitHub, withSecret simulado y un doble de la base
// que guarda wiki_runs en memoria y aplica los .eq(), .in(), .order() y .limit() de cada consulta como Postgres, y el
// índice único de corridas en curso de 0010.
const estado = vi.hoisted(() => ({ client: null as unknown, salidaCerrada: false }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const cred = vi.hoisted(() => ({ withSecret: vi.fn(), createConnectionWithSecret: vi.fn() }));
vi.mock('../lib/credentials.ts', () => cred);
// La lista de salida real, salvo cuando una prueba la «cierra» para comprobar que entonces no sale nada.
vi.mock('@vanguard/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@vanguard/core')>();
  return { ...real, assertAllowedUrl: (u: string | URL) => {
    if (estado.salidaCerrada) throw new Error('EGRESS_BLOCKED:host');
    return real.assertAllowedUrl(u);
  } };
});

const { app } = await import('../app.ts');
const { SUBPETICIONES_RUTA_E40, SUBPETICIONES_RUTA_E41 } = await import('./wiki.ts');
const { ERROR_PARADA, LIMITE_HISTORIAL, pasosCache, pasosIniciales, SIN_AVANCE_MS, SUBPETICIONES_CACHE } = await import('../wiki/corridas.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ANON = '7b1e0000-0000-4000-8000-0000000000aa';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const OTRA_ORG = '0f6c0000-0000-4000-8000-000000000002';
const CONN = 'c0aa0000-0000-4000-8000-000000000001';
const CONN_SB = 'c0aa0000-0000-4000-8000-000000000005';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const API = 'https://api.github.com';
const RUN_OK = 'e1e00000-0000-4000-8000-0000000000a1';
// PAT falso armado en tiempo de ejecución: ningún literal con forma de secreto queda en el repo.
const PAT = ['github', 'pat', 'w'.repeat(40)].join('_');
const { run_id: _sinId, ...DOC } = fixtures.wikiDoc;

const claims = (tok: string) => (tok === 'ana' ? { sub: ANA, email: 'ana@acme.dev', is_anonymous: false }
  : tok === 'anon' ? { sub: ANON, is_anonymous: true } : null);

// ── Base en memoria ─────────────────────────────────────────────────────────────────────────────────────────────
type Fila = Record<string, unknown>;
// connections de la base: la de GitHub de acme/tienda, una de otra org, una revocada (otro repo) y una de Cloudflare.
const CONEXIONES: Fila[] = [
  { id: CONN, org_id: ORG, provider: 'github', kind: 'read', status: 'active', meta: { repo_full_name: 'acme/tienda' } },
  { id: 'c0aa0000-0000-4000-8000-000000000002', org_id: OTRA_ORG, provider: 'github', kind: 'read', status: 'active',
    meta: { repo_full_name: 'acme/tienda' } },
  { id: 'c0aa0000-0000-4000-8000-000000000003', org_id: ORG, provider: 'github', kind: 'read', status: 'revoked',
    meta: { repo_full_name: 'acme/viejo' } },
  { id: 'c0aa0000-0000-4000-8000-000000000004', org_id: ORG, provider: 'cloudflare', kind: 'read', status: 'active', meta: {} },
];
const DEFAULTS: Fila = { connection_id: null, requested_by: null, branch: null, commit_sha: null, huella: null,
  status: 'queued', progress: 0, steps: [], est_usd: null, max_usd: 1, cost_usd: 0, models: {}, cached: false, error: null,
  state: null, doc: null, started_at: null, finished_at: null };

let rol: string;
let scans: Fila[];
let hallazgos: Fila[];
let corridas: Fila[];
let fallaInsert: boolean;
let sinTablaWiki: boolean;     // 0010 sin aplicar: wiki_runs responde PGRST205
let doble: ReturnType<typeof dbDoble>;
let latencia: number;
let fetchMock: ReturnType<typeof vi.fn>;
let lineas: string[];

const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) => (o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : true));

// order() y limit() del doble no se registran: este envoltorio los apunta (y puede retrasar cada consulta para simular
// dos peticiones a la vez) y wiki_runs los aplica; sin order, el orden es el de inserción, como un heap de Postgres.
type Pedido = { table: string; orden: [string, boolean][]; limite?: number };
type Constructor = Record<string, unknown> & { then: (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) => unknown };
let pedidos: Pedido[];
let actual: Pedido | null;
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
        const x = Date.parse(String(a[col])) || String(a[col] ?? '');
        const y = Date.parse(String(b[col])) || String(b[col] ?? '');
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
let secuencia = 0;
function wikiRuns(op: Op): Resp {
  if (op.action === 'insert') {
    if (fallaInsert) return { error: { code: '23514' } };
    secuencia++;
    const creada = new Date(Date.now() + secuencia).toISOString();
    const fila: Fila = { ...DEFAULTS, id: `e1e00000-0000-4000-8000-${String(secuencia).padStart(12, '0')}`,
      created_at: creada, updated_at: creada, ...(op.payload as Fila) };
    if (viva(fila) && corridas.some((f) => viva(f) && mismaLlave(f, fila))) return { error: { code: '23505' } };
    corridas.push(fila);
    return { data: op.single ? { id: fila.id } : [fila] };
  }
  if (op.action === 'update') { for (const f of corridas.filter((x) => cumple(x, op))) Object.assign(f, op.payload); return {}; }
  return responder(corridas, op);
}
// Corrida ya guardada (por defecto, una wiki terminada de acme/tienda@SHA sin auditoría). updated_at = created_at.
function corrida(extra: Fila = {}): Fila {
  const creada = extra.created_at ?? '2026-10-24T18:20:05+00:00';
  return { ...DEFAULTS, id: RUN_OK, org_id: ORG, repo_full_name: 'acme/tienda', branch: 'main', commit_sha: SHA, huella: null,
    status: 'succeeded', progress: 100, cost_usd: 0.034, est_usd: 0.043, models: DOC.models,
    steps: pasosIniciales().map((s) => ({ ...s, status: 'done' })), doc: DOC, created_at: creada, updated_at: creada,
    started_at: '2026-10-24T18:20:07+00:00', finished_at: '2026-10-24T18:21:52+00:00', ...extra };
}

// Auditoría de acme/tienda: paso repo (CONN) y luego Supabase. Los hallazgos que el motor recibiría son SB_RLS_DISABLED y
// CB_ENV_COMMITTED; el de acme/viejo y el de otra org no cuentan.
const HALLAZGOS_REPO = [
  { rule_id: 'SB_RLS_DISABLED', severity: 'critical' as const, title: 'Tabla pedidos sin RLS' },
  { rule_id: 'CB_ENV_COMMITTED', severity: 'high' as const, title: '.env subido al repo', path: '.env' },
];
function auditar() {
  scans.push({ org_id: ORG, status: 'succeeded', kind: 'repo', params: {}, steps: [{ name: 'repo', status: 'done' }],
    finished_at: '2026-10-24T18:00:00+00:00' },
  { org_id: ORG, status: 'succeeded', kind: 'supabase', params: {}, steps: [{ name: 'supabase', status: 'done' }],
    finished_at: '2026-10-24T18:04:00+00:00' });
  hallazgos.push(
    { org_id: ORG, status: 'open', module: 'supabase', rule_id: 'SB_RLS_DISABLED', severity: 'critical', title: 'Tabla pedidos sin RLS',
      connection_id: CONN_SB, path: null },
    { org_id: ORG, status: 'open', module: 'codebase', rule_id: 'CB_ENV_COMMITTED', severity: 'high', title: '.env subido al repo',
      connection_id: CONN, path: '.env' },
    { org_id: ORG, status: 'open', module: 'codebase', rule_id: 'CB_SECRET_GENERIC', severity: 'high', title: 'Secreto',
      connection_id: 'c0aa0000-0000-4000-8000-000000000003', path: 'a.ts' },
    { org_id: OTRA_ORG, status: 'open', module: 'supabase', rule_id: 'SB_POLICY_ALLOW_ALL', severity: 'high', title: 'Otra org',
      connection_id: null, path: null },
  );
}
const huellaAuditada = () => huellaHallazgos(HALLAZGOS_REPO);

// GitHub de un repo pequeño (acme/tienda): metadatos, commit de main y árbol recursivo.
const json = (v: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(v), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
const ARBOL = [{ path: 'README.md', type: 'blob', size: 60 }, { path: 'package.json', type: 'blob', size: 120 },
  { path: 'src', type: 'tree' }, { path: 'src/index.ts', type: 'blob', size: 400 },
  { path: 'src/rutas/pedidos.ts', type: 'blob', size: 1200 }, { path: '.env', type: 'blob', size: 50 },
  { path: 'pnpm-lock.yaml', type: 'blob', size: 90000 }];
function github(url: string): Response {
  if (url === `${API}/repos/acme/tienda`) {
    return json({ full_name: 'acme/tienda', description: 'Tienda de prueba', language: 'TypeScript', private: false,
      default_branch: 'main' });
  }
  if (url === `${API}/repos/acme/tienda/commits/main`) return new Response(SHA);
  if (url === `${API}/repos/acme/tienda/git/trees/${SHA}?recursive=1`) return json({ sha: SHA, truncated: false, tree: ARBOL });
  return new Response('no encontrado', { status: 404 });
}
const cabeceras = (i: number) => ((fetchMock.mock.calls[i]?.[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
const TABLAS_CACHE = new Set(['wiki_runs', 'scan_runs', 'findings']);

beforeEach(() => {
  estado.salidaCerrada = false;
  rol = 'owner';
  scans = [];
  hallazgos = [];
  corridas = [];
  fallaInsert = false;
  sinTablaWiki = false;
  latencia = 0;
  pedidos = [];
  actual = null;
  lineas = [];
  doble = dbDoble({
    tabla: (op: Op): Resp | undefined => {
      switch (op.table) {
        case 'org_members': return { data: eqDe(op, 'org_id') === ORG ? { role: rol } : null };
        case 'connections': return responder(CONEXIONES, op);
        case 'scan_runs': return responder(scans, op);
        case 'findings': return responder(hallazgos, op);
        case 'wiki_runs': return sinTablaWiki ? { error: { code: 'PGRST205', message: 'x' } } as unknown as Resp : wikiRuns(op);
        default: return undefined;
      }
    },
    claims,
  });
  estado.client = envolver(doble.client);
  cred.withSecret.mockReset().mockImplementation(async (_e: unknown, _a: unknown, _ctx: unknown, fn: (t: string) => unknown) => fn(PAT));
  fetchMock = vi.fn(async (u: string) => github(String(u)));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation((l: unknown) => { lineas.push(String(l)); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const leer = (ruta: string, o: { org?: string; tok?: string } = {}) =>
  app.request(`https://officialvanguard.com/api/orgs/${o.org ?? ORG}/wiki/${ruta}`,
    { headers: { authorization: `Bearer ${o.tok ?? 'ana'}` } }, envDoble().env);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;

describe('E40 · POST /api/orgs/:org/wiki/estimate', () => {
  const estimarPost = (body: unknown, o: { tok?: string; env?: Partial<CloudflareBindings>; crudo?: string } = {}) =>
    app.request(`https://officialvanguard.com/api/orgs/${ORG}/wiki/estimate`, {
      method: 'POST', headers: { authorization: `Bearer ${o.tok ?? 'ana'}`, 'content-type': 'application/json' },
      body: o.crudo ?? JSON.stringify(body),
    }, envDoble(o.env).env);

  it('admin con repo público → 200 WikiEstimate válido, sin token, sin Claude y con cached_run_id null', async () => {
    const r = await estimarPost({ repo_full_name: 'acme/tienda' });
    expect(r.status).toBe(200);
    const e = WikiEstimate.parse(await r.json());
    expect(e).toMatchObject({ repo_full_name: 'acme/tienda', branch: 'main', commit_sha: SHA, cached_run_id: null, truncado: false });
    expect(e.files_total).toBe(ARBOL.filter((n) => n.type === 'blob').length);
    expect(e.files_candidatos).toBeLessThan(e.files_total);           // .env y el lockfile no cuentan
    expect(e.est.usd).toBeGreaterThan(0);
    expect(e.est.desglose.map((d) => d.paso)).toEqual(['triage', 'area', 'sintesis']);
    expect(e.avisos.at(-1)).toContain('US$');                          // el techo va el último
    // Solo api.github.com (nada de Anthropic), 3 subpeticiones, redirect manual y sin Authorization.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [i, [u, init]] of fetchMock.mock.calls.entries()) {
      expect(String(u).startsWith(`${API}/`)).toBe(true);
      expect((init as RequestInit).redirect).toBe('manual');
      expect(cabeceras(i).Authorization).toBeUndefined();
    }
    expect(cred.withSecret).not.toHaveBeenCalled();
    expect(doble.ops.some((o) => o.table === 'connections')).toBe(false);
    // Sin wikis terminadas de ese commit no se calcula la huella: una sola consulta a wiki_runs, de la org.
    const cache = doble.ops.filter((o) => TABLAS_CACHE.has(o.table));
    expect(cache.map((o) => o.table)).toEqual(['wiki_runs']);
    expect(cache[0] && eqDe(cache[0], 'org_id')).toBe(ORG);
  });

  it('cached_run_id: la terminada de la misma org, repo, commit y huella; con otra huella u otra org, null', async () => {
    auditar();
    corridas.push(corrida({ huella: await huellaAuditada() }));
    let e = WikiEstimate.parse(await (await estimarPost({ repo_full_name: 'acme/tienda' })).json());
    expect(e.cached_run_id).toBe(RUN_OK);

    // Alguien arregló el RLS y se re-auditó: la huella cambia y el documento viejo ya no sirve.
    hallazgos.splice(0, 1);
    e = WikiEstimate.parse(await (await estimarPost({ repo_full_name: 'acme/tienda' })).json());
    expect(e.cached_run_id).toBeNull();

    // La misma wiki, pero de otra org, nunca es caché de esta.
    corridas.splice(0, corridas.length, corrida({ org_id: OTRA_ORG, huella: await huellaHallazgos(HALLAZGOS_REPO.slice(1)) }));
    e = WikiEstimate.parse(await (await estimarPost({ repo_full_name: 'acme/tienda' })).json());
    expect(e.cached_run_id).toBeNull();
    // Una fallida o de otro commit tampoco.
    corridas.splice(0, corridas.length, corrida({ status: 'failed', huella: await huellaHallazgos(HALLAZGOS_REPO.slice(1)) }),
      corrida({ id: 'e1e00000-0000-4000-8000-0000000000a2', commit_sha: 'f'.repeat(40) }));
    e = WikiEstimate.parse(await (await estimarPost({ repo_full_name: 'acme/tienda' })).json());
    expect(e.cached_run_id).toBeNull();
  });

  it('con connection_id de su org → GitHub recibe el PAT en Authorization y nunca sale en la respuesta ni en los logs', async () => {
    const r = await estimarPost({ repo_full_name: 'acme/tienda', connection_id: CONN });
    expect(r.status).toBe(200);
    const texto = await r.text();
    WikiEstimate.parse(JSON.parse(texto));
    expect(texto).not.toContain(PAT);
    expect(lineas.join('\n')).not.toContain(PAT);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) expect(cabeceras(i).Authorization).toBe(`Bearer ${PAT}`);
    expect(cred.withSecret).toHaveBeenCalledTimes(1);
    expect(cred.withSecret.mock.calls[0]?.[2]).toEqual({ orgId: ORG, connectionId: CONN, provider: 'github', kind: 'read' });
    const consulta = doble.ops.find((o) => o.table === 'connections');
    expect(consulta && eqDe(consulta, 'org_id')).toBe(ORG);
  });

  it('connection_id de otra org, revocada, de otro proveedor o inexistente → 404 sin descifrar ni llamar a GitHub', async () => {
    for (const id of ['c0aa0000-0000-4000-8000-000000000002', 'c0aa0000-0000-4000-8000-000000000003',
      'c0aa0000-0000-4000-8000-000000000004', 'c0aa0000-0000-4000-8000-0000000000ff']) {
      const r = await estimarPost({ repo_full_name: 'acme/tienda', connection_id: id });
      expect(r.status, id).toBe(404);
      expect((await error(r)).message).toBe('Conexión no encontrada');
    }
    expect(cred.withSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('B8: la conexión tiene que ser la del repo pedido: otro repo que vea el PAT → 404; otras mayúsculas → vale', async () => {
    for (const repo of ['acme/privado', 'acme/viejo', 'otra/tienda']) {
      const r = await estimarPost({ repo_full_name: repo, connection_id: CONN });
      expect(r.status, repo).toBe(404);
      expect((await error(r)).message).toBe('Conexión no encontrada');
    }
    expect(cred.withSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // GitHub no distingue mayúsculas en el nombre del repo.
    fetchMock.mockImplementation(async (u: string) => github(String(u).replace('/repos/ACME/Tienda', '/repos/acme/tienda')));
    const r = await estimarPost({ repo_full_name: 'ACME/Tienda', connection_id: CONN });
    expect(r.status).toBe(200);
    expect(cred.withSecret).toHaveBeenCalledTimes(1);
    expect(cabeceras(0).Authorization).toBe(`Bearer ${PAT}`);
  });

  it('viewer y anónimo → 403 sin llamar a GitHub', async () => {
    rol = 'viewer';
    expect((await estimarPost({ repo_full_name: 'acme/tienda' })).status).toBe(403);
    rol = 'owner';
    const r = await estimarPost({ repo_full_name: 'acme/tienda' }, { tok: 'anon' });
    expect(r.status).toBe(403);
    expect((await error(r)).code).toBe('forbidden');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cuerpo inválido → 422 con field_errors, sin gastar RL_COSTLY ni llamar a GitHub', async () => {
    const claves: string[] = [];
    const rl: RateLimit = { limit: async ({ key }) => { claves.push(key); return { success: true }; } };
    for (const [body, campo] of [[{}, 'repo_full_name'], [{ repo_full_name: 'no-es-un-repo' }, 'repo_full_name'],
      [{ repo_full_name: 'acme/..' }, 'repo_full_name'], [{ repo_full_name: 'acme/tienda', connection_id: 'x' }, 'connection_id'],
      [{ repo_full_name: 'acme/tienda', ref: '' }, 'ref']] as const) {
      const r = await estimarPost(body, { env: { RL_COSTLY: rl } });
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect((await error(r)).details).toMatchObject({ field_errors: { [campo]: expect.any(Array) } });
    }
    expect((await estimarPost(null, { crudo: 'no es json', env: { RL_COSTLY: rl } })).status).toBe(422);
    expect(claves).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('límite de GitHub → 429 rate_limited con el Retry-After que pide GitHub (retry-after o x-ratelimit-reset)', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }));
    let r = await estimarPost({ repo_full_name: 'acme/tienda' });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('30');
    expect(await error(r)).toMatchObject({ code: 'rate_limited', details: { reason: 'limite_github' } });

    const reset = Math.floor(Date.now() / 1000) + 600;
    fetchMock.mockImplementation(async () => new Response('{}', { status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }));
    r = await estimarPost({ repo_full_name: 'acme/tienda', connection_id: CONN });
    expect(r.status).toBe(429);
    const espera = Number(r.headers.get('retry-after'));
    expect(espera).toBeGreaterThanOrEqual(595);
    expect(espera).toBeLessThanOrEqual(601);
    expect(lineas.join('\n')).not.toContain(PAT);
  });

  it('repo o rama inexistente → 404 claro; GitHub caído, sin red o respuesta rara → 502 (nunca 500)', async () => {
    fetchMock.mockImplementation(async () => new Response('Not Found', { status: 404 }));
    let r = await estimarPost({ repo_full_name: 'acme/privado' });
    expect(r.status).toBe(404);
    expect(await error(r)).toMatchObject({ code: 'not_found', details: { reason: 'repo_no_encontrado' } });
    expect((await estimarPost({ repo_full_name: 'acme/privado' })).status).toBe(404);

    fetchMock.mockImplementation(async (u: string) => github(String(u)));
    r = await estimarPost({ repo_full_name: 'acme/tienda', ref: 'no-existe' });
    expect(r.status).toBe(404);
    expect((await error(r)).details?.reason).toBe('ref_no_encontrada');

    for (const [falla, reason] of [
      [async () => new Response('caído', { status: 503 }), 'github_error'],
      [async () => { throw new TypeError('fetch failed'); }, 'github_red'],
      [async () => new Response('<html>', { status: 200 }), 'respuesta_invalida'],
    ] as const) {
      fetchMock.mockImplementation(falla);
      r = await estimarPost({ repo_full_name: 'acme/tienda' });
      expect(r.status, reason).toBe(502);
      expect(await error(r)).toMatchObject({ code: 'provider_unavailable', details: { reason } });
    }
  });

  it('host fuera de la lista de salida → nunca llama a fetch (502 provider_unavailable)', async () => {
    estado.salidaCerrada = true;
    const r = await estimarPost({ repo_full_name: 'acme/tienda', connection_id: CONN });
    expect(r.status).toBe(502);
    expect((await error(r)).code).toBe('provider_unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lineas.join('\n')).toContain('egress.bloqueado');
  });

  it('RL_COSTLY agotado → 429 con Retry-After 60 y clave u:<user_id>, sin descifrar ni llamar a GitHub', async () => {
    const claves: string[] = [];
    const lleno: RateLimit = { limit: async ({ key }) => { claves.push(key); return { success: false }; } };
    const r = await estimarPost({ repo_full_name: 'acme/tienda', connection_id: CONN }, { env: { RL_COSTLY: lleno } });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect((await error(r)).code).toBe('rate_limited');
    expect(claves).toEqual([`u:${ANA}`]);
    expect(cred.withSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('presupuesto: con árbol superficial (GitHub trunca) ≤ 25 llamadas a GitHub y ≤ 40 sumando la ruta y la caché', async () => {
    // Peor caso sin redirecciones: el recursivo viene truncado, la raíz trae 15 carpetas y cada una falla en sus dos
    // intentos (recursivo y superficial): 2 + 1 + 1 + 10 × 2 = 24. Con una wiki terminada de ese commit, la caché hace
    // sus 4 consultas.
    auditar();
    corridas.push(corrida({ huella: await huellaAuditada() }));
    const carpetas = Array.from({ length: 15 }, (_, i) => ({ path: `modulo${i}`, type: 'tree', sha: i.toString(16).padStart(2, '0').repeat(20) }));
    fetchMock.mockImplementation(async (u: string) => {
      const url = String(u);
      if (url === `${API}/repos/acme/tienda/git/trees/${SHA}?recursive=1`) return json({ sha: SHA, truncated: true, tree: ARBOL });
      if (url === `${API}/repos/acme/tienda/git/trees/${SHA}`) {
        return json({ sha: SHA, truncated: false, tree: [{ path: 'README.md', type: 'blob', size: 60 }, ...carpetas] });
      }
      return github(url);
    });
    const r = await estimarPost({ repo_full_name: 'acme/tienda', connection_id: CONN });
    expect(r.status).toBe(200);
    const e = WikiEstimate.parse(await r.json());
    expect(e.truncado).toBe(true);
    expect(e.cached_run_id).toBe(RUN_OK);
    const aGithub = fetchMock.mock.calls.length;
    expect(aGithub).toBe(24);
    // Ruta: getClaims (1) + org_members y connections del token + withSecret simulado (connection_secrets y
    // vg_crypto_material, 2). Caché: wiki_runs + connections, scan_runs y findings de la huella.
    const deCache = (o: Op) => TABLAS_CACHE.has(o.table) || (o.table === 'connections' && o.single === undefined);
    const ruta = 1 + doble.ops.filter((o) => !deCache(o)).length + doble.rpcs.length + 2;
    const cache = doble.ops.filter(deCache).length;
    expect(ruta).toBeLessThanOrEqual(SUBPETICIONES_RUTA_E40);
    expect(cache).toBe(SUBPETICIONES_CACHE);
    expect(aGithub + ruta + cache).toBeLessThanOrEqual(TOPE_SUBPETICIONES);
    // Peor caso documentado del motor (33 si GitHub redirige) más la ruta: sigue cabiendo (la caché se salta si no cabe).
    expect(33 + SUBPETICIONES_RUTA_E40).toBeLessThanOrEqual(TOPE_SUBPETICIONES);
  });
});

describe('E41 · POST /api/orgs/:org/wiki/runs', () => {
  const LOCAL = { VG_ENV: 'local' as const };
  async function correr(body: unknown, o: { tok?: string; env?: Partial<CloudflareBindings>; host?: string } = {}) {
    const d = envDoble({ ...LOCAL, ...o.env });
    const r = await app.request(`https://${o.host ?? 'officialvanguard.com'}/api/orgs/${ORG}/wiki/runs`, {
      method: 'POST', headers: { authorization: `Bearer ${o.tok ?? 'ana'}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, d.env);
    return { r, ...d };
  }

  it('sin caché → 202 {cached:false}, fila queued con commit, rama, huella null y max_usd 1, y encola EXACTAMENTE el paso arbol', async () => {
    const { r, enviados } = await correr({ repo_full_name: 'acme/tienda' });
    expect(r.status).toBe(202);
    const a = WikiRunAccepted.parse(await r.json());
    expect(a.cached).toBe(false);
    expect(corridas).toHaveLength(1);
    expect(corridas[0]).toMatchObject({ id: a.wiki_run_id, org_id: ORG, repo_full_name: 'acme/tienda', branch: 'main',
      commit_sha: SHA, huella: null, status: 'queued', progress: 0, cached: false, max_usd: 1, connection_id: null,
      requested_by: ANA, steps: pasosIniciales(), doc: null });
    expect(enviados).toStrictEqual([{ v: 1, kind: 'wiki', org_id: ORG, wiki_run_id: a.wiki_run_id, paso: 'arbol' }]);
    // Solo leerMeta (repo y commit), sin token, sin árbol y sin Claude.
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([`${API}/repos/acme/tienda`, `${API}/repos/acme/tienda/commits/main`]);
    expect(cabeceras(0).Authorization).toBeUndefined();
    // Cada consulta a la base, de la org.
    for (const o of doble.ops.filter((x) => x.table !== 'org_members')) {
      if (o.action !== 'insert') expect(eqDe(o, 'org_id'), o.table).toBe(ORG);
    }
  });

  it('el E42 de la corrida recién creada cumple WikiRun (models por defecto, pasos pending)', async () => {
    const { r } = await correr({ repo_full_name: 'acme/tienda', max_usd: 0.15 });
    const { wiki_run_id } = WikiRunAccepted.parse(await r.json());
    expect(corridas[0]?.max_usd).toBe(0.15);
    const run = WikiRun.parse(await (await leer(`runs/${wiki_run_id}`)).json());
    expect(run).toMatchObject({ id: wiki_run_id, status: 'queued', progress: 0, cached: false, commit_sha: SHA, branch: 'main',
      models: { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' }, cost_usd: 0, est_usd: null, started_at: null });
    expect(run.steps.map((s) => s.status)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
  });

  it('caché (misma org, repo, commit y huella) → 200 {cached:true}: copia succeeded, pasos skipped, costo 0, doc copiado y nada encolado', async () => {
    auditar();
    corridas.push(corrida({ huella: await huellaAuditada() }));
    const { r, enviados } = await correr({ repo_full_name: 'acme/tienda' });
    expect(r.status).toBe(200);
    const a = WikiRunAccepted.parse(await r.json());
    expect(a.cached).toBe(true);
    expect(a.wiki_run_id).not.toBe(RUN_OK);
    expect(enviados).toEqual([]);
    const copia = corridas.find((f) => f.id === a.wiki_run_id);
    expect(copia).toMatchObject({ cached: true, status: 'succeeded', progress: 100, cost_usd: 0, huella: await huellaAuditada(),
      steps: pasosCache(SHA), models: DOC.models });
    expect(copia?.doc).toEqual(DOC);

    // E42 y E44 de la copia: WikiRun cached y WikiDoc con run_id = la copia.
    const run = WikiRun.parse(await (await leer(`runs/${a.wiki_run_id}`)).json());
    expect(run).toMatchObject({ cached: true, status: 'succeeded', cost_usd: 0, progress: 100 });
    expect(run.steps.map((s) => s.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'done']);
    const doc = WikiDoc.parse(await (await leer(`runs/${a.wiki_run_id}/doc`)).json());
    expect(doc).toEqual({ ...DOC, run_id: a.wiki_run_id });
  });

  it('force → ignora la caché: corrida nueva queued y encolada', async () => {
    corridas.push(corrida());
    const { r, enviados } = await correr({ repo_full_name: 'acme/tienda', force: true });
    expect(r.status).toBe(202);
    const a = WikiRunAccepted.parse(await r.json());
    expect(a).toEqual({ wiki_run_id: expect.not.stringMatching(RUN_OK), cached: false });
    expect(enviados).toEqual([{ v: 1, kind: 'wiki', org_id: ORG, wiki_run_id: a.wiki_run_id, paso: 'arbol' }]);
  });

  it('huella distinta (cambiaron los hallazgos) → no sirve la caché; la fila nueva guarda la huella actual', async () => {
    auditar();
    corridas.push(corrida({ huella: await huellaHallazgos(HALLAZGOS_REPO.slice(1)) }));   // de antes de detectar el RLS
    const { r, enviados } = await correr({ repo_full_name: 'acme/tienda' });
    expect(r.status).toBe(202);
    const a = WikiRunAccepted.parse(await r.json());
    expect(a.cached).toBe(false);
    expect(enviados).toHaveLength(1);
    expect(corridas.find((f) => f.id === a.wiki_run_id)?.huella).toBe(await huellaAuditada());
    // Una wiki sin auditoría tampoco es caché de una con auditoría (null ≠ huella).
    corridas.splice(0, corridas.length, corrida({ huella: null }));
    expect((await correr({ repo_full_name: 'acme/tienda' })).r.status).toBe(202);
  });

  it('la caché de otra org no se usa nunca', async () => {
    corridas.push(corrida({ org_id: OTRA_ORG }));
    const { r, enviados } = await correr({ repo_full_name: 'acme/tienda' });
    expect(r.status).toBe(202);
    expect((WikiRunAccepted.parse(await r.json())).cached).toBe(false);
    expect(enviados).toHaveLength(1);
  });

  it('la misma wiki ya en curso → 202 con ESA corrida, sin fila nueva ni mensaje (también con force)', async () => {
    // Creada hace 10 h (esperas largas de GitHub) pero avanzó hace 1 min: sigue viva.
    const enCurso = corrida({ id: 'e1e00000-0000-4000-8000-0000000000b1', status: 'running', progress: 30, doc: null,
      created_at: new Date(Date.now() - 10 * 3_600_000).toISOString(), updated_at: new Date(Date.now() - 60_000).toISOString() });
    corridas.push(enCurso);
    for (const force of [false, true]) {
      const { r, enviados } = await correr({ repo_full_name: 'acme/tienda', force });
      expect(r.status).toBe(202);
      expect(WikiRunAccepted.parse(await r.json())).toEqual({ wiki_run_id: enCurso.id, cached: false });
      expect(enviados).toEqual([]);
    }
    expect(corridas).toHaveLength(1);
    // Más de SIN_AVANCE_MS sin avanzar: es de un Worker perdido. Se cierra failed (su CAS ya no paga) y se crea otra.
    enCurso.updated_at = new Date(Date.now() - SIN_AVANCE_MS - 60_000).toISOString();
    const { r, enviados } = await correr({ repo_full_name: 'acme/tienda' });
    const a = WikiRunAccepted.parse(await r.json());
    expect(a.wiki_run_id).not.toBe(enCurso.id);
    expect(enviados).toEqual([{ v: 1, kind: 'wiki', org_id: ORG, wiki_run_id: a.wiki_run_id, paso: 'arbol' }]);
    expect(enCurso).toMatchObject({ status: 'failed', error: ERROR_PARADA });
    expect(WikiRun.parse(await (await leer(`runs/${String(enCurso.id)}`)).json()).status).toBe('failed');
  });

  it('dos E41 iguales a la vez (doble clic, dos pestañas): una sola fila y un solo mensaje; las dos, la misma corrida', async () => {
    latencia = 3;
    const [x, y] = await Promise.all([correr({ repo_full_name: 'acme/tienda' }), correr({ repo_full_name: 'acme/tienda' })]);
    expect([x.r.status, y.r.status]).toEqual([202, 202]);
    const [a, b] = [WikiRunAccepted.parse(await x.r.json()), WikiRunAccepted.parse(await y.r.json())];
    expect(a).toEqual({ wiki_run_id: b.wiki_run_id, cached: false });
    expect(corridas).toHaveLength(1);
    expect([...x.enviados, ...y.enviados]).toStrictEqual([{ v: 1, kind: 'wiki', org_id: ORG, wiki_run_id: a.wiki_run_id, paso: 'arbol' }]);
  });

  it('viewer y anónimo → 403 sin GitHub, sin filas y sin mensajes', async () => {
    rol = 'viewer';
    let x = await correr({ repo_full_name: 'acme/tienda' });
    expect(x.r.status).toBe(403);
    expect((await error(x.r)).code).toBe('forbidden');
    rol = 'owner';
    x = await correr({ repo_full_name: 'acme/tienda' }, { tok: 'anon' });
    expect(x.r.status).toBe(403);
    expect(x.enviados).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(corridas).toEqual([]);
  });

  it('productor de vg-jobs: en producción solo desde officialvanguard.com (workers.dev y www → 403)', async () => {
    const PROD = { VG_ENV: 'production' as const, APP_ORIGIN: 'https://officialvanguard.com' };
    for (const host of ['vanguard.giovannizm14.workers.dev', 'www.officialvanguard.com']) {
      const x = await correr({ repo_full_name: 'acme/tienda' }, { env: PROD, host });
      expect(x.r.status, host).toBe(403);
      expect(x.enviados).toEqual([]);
    }
    expect((await correr({ repo_full_name: 'acme/tienda' }, { env: { VG_ENV: undefined } })).r.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    const x = await correr({ repo_full_name: 'acme/tienda' }, { env: PROD });
    expect(x.r.status).toBe(202);
    expect(x.enviados).toHaveLength(1);
  });

  it('cuerpo inválido (max_usd > 5 o ≤ 0, force no booleano, repo malo) → 422 sin gastar RL_COSTLY', async () => {
    const claves: string[] = [];
    const rl: RateLimit = { limit: async ({ key }) => { claves.push(key); return { success: true }; } };
    for (const [body, campo] of [[{ repo_full_name: 'acme/tienda', max_usd: 5.01 }, 'max_usd'],
      [{ repo_full_name: 'acme/tienda', max_usd: 0 }, 'max_usd'], [{ repo_full_name: 'acme/tienda', force: 'si' }, 'force'],
      [{ repo_full_name: 'acme/..' }, 'repo_full_name']] as const) {
      const { r } = await correr(body, { env: { RL_COSTLY: rl } });
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect((await error(r)).details).toMatchObject({ field_errors: { [campo]: expect.any(Array) } });
    }
    expect(claves).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RL_COSTLY agotado → 429 Retry-After 60 sin GitHub ni filas', async () => {
    const lleno: RateLimit = { limit: async () => ({ success: false }) };
    const { r, enviados } = await correr({ repo_full_name: 'acme/tienda' }, { env: { RL_COSTLY: lleno } });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect(enviados).toEqual([]);
    expect(corridas).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con connection_id → el PAT va a GitHub y a ningún otro sitio (fila, mensaje, respuesta ni logs)', async () => {
    const { r, enviados } = await correr({ repo_full_name: 'acme/tienda', connection_id: CONN.toUpperCase() });
    expect(r.status).toBe(202);
    const texto = await r.text();
    expect(cabeceras(0).Authorization).toBe(`Bearer ${PAT}`);
    expect(corridas[0]?.connection_id).toBe(CONN);
    for (const t of [texto, JSON.stringify(corridas), JSON.stringify(enviados), lineas.join('\n')]) expect(t).not.toContain(PAT);
  });

  it('B8: connection_id de acme/tienda con otro repo → 404 sin descifrar, sin GitHub, sin fila ni mensaje', async () => {
    const { r, enviados } = await correr({ repo_full_name: 'acme/privado', connection_id: CONN });
    expect(r.status).toBe(404);
    expect((await error(r)).message).toBe('Conexión no encontrada');
    expect(cred.withSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(corridas).toEqual([]);
    expect(enviados).toEqual([]);
  });

  it('GitHub: repo inexistente → 404 y límite → 429 con Retry-After, sin filas ni mensajes', async () => {
    fetchMock.mockImplementation(async () => new Response('Not Found', { status: 404 }));
    let x = await correr({ repo_full_name: 'acme/privado' });
    expect(x.r.status).toBe(404);
    expect((await error(x.r)).details?.reason).toBe('repo_no_encontrado');
    fetchMock.mockImplementation(async () => new Response('{}', { status: 429, headers: { 'retry-after': '45' } }));
    x = await correr({ repo_full_name: 'acme/tienda' });
    expect(x.r.status).toBe(429);
    expect(x.r.headers.get('retry-after')).toBe('45');
    expect(corridas).toEqual([]);
    expect(x.enviados).toEqual([]);
  });

  it('si encolar falla → 502 y la fila queda failed (no en cola para siempre)', async () => {
    const cola = { send: vi.fn(async () => { throw new Error('cola caída'); }), sendBatch: vi.fn() };
    const { r } = await correr({ repo_full_name: 'acme/tienda' }, { env: { JOBS_Q: cola as unknown as CloudflareBindings['JOBS_Q'] } });
    expect(r.status).toBe(502);
    expect((await error(r)).code).toBe('provider_unavailable');
    expect(corridas[0]).toMatchObject({ status: 'failed', error: 'No se pudo encolar' });
    expect(typeof corridas[0]?.finished_at).toBe('string');
    WikiRun.parse(await (await leer(`runs/${String(corridas[0]?.id)}`)).json());
  });

  it('error de la base al crear → 500 sin encolar', async () => {
    fallaInsert = true;
    const { r, enviados } = await correr({ repo_full_name: 'acme/tienda' });
    expect(r.status).toBe(500);
    expect(enviados).toEqual([]);
  });

  it('presupuesto: GitHub + ruta ≤ 40 subpeticiones (peor caso con auditoría y caché)', async () => {
    auditar();
    corridas.push(corrida({ huella: await huellaAuditada() }));
    const { r } = await correr({ repo_full_name: 'acme/tienda', connection_id: CONN });
    expect(r.status).toBe(200);
    // getClaims (1) + consultas del doble + withSecret simulado (2) + nada a la cola (caché).
    const ruta = 1 + doble.ops.length + doble.rpcs.length + 2;
    expect(ruta).toBeLessThanOrEqual(SUBPETICIONES_RUTA_E41);
    expect(fetchMock.mock.calls.length + SUBPETICIONES_RUTA_E41).toBeLessThanOrEqual(TOPE_SUBPETICIONES);
  });
});

// B8 con un repo renombrado en GitHub: la conexión conserva en meta.repo_full_name el nombre de antes (ni E9 ni
// vg_rotate_secret lo reescriben) y GitHub responde a ese nombre con un 301 hacia el repo, que ya se llama acme/nuevo.
describe('B8 · repo renombrado en GitHub', () => {
  const CONN_REN = 'c0aa0000-0000-4000-8000-000000000006';
  function githubRenombrado(url: string): Response {
    const u = url.replace(`${API}/repos/ACME/Antes`, `${API}/repos/acme/antes`);   // GitHub no distingue mayúsculas
    if (u === `${API}/repos/acme/antes`) {
      return new Response(null, { status: 301, headers: { location: `${API}/repositories/42` } });
    }
    if (u === `${API}/repositories/42`) {
      return json({ full_name: 'acme/nuevo', description: null, language: null, private: true, default_branch: 'main' });
    }
    if (u === `${API}/repos/acme/nuevo/commits/main`) return new Response(SHA);
    if (u === `${API}/repos/acme/nuevo/git/trees/${SHA}?recursive=1`) return json({ sha: SHA, truncated: false, tree: ARBOL });
    return new Response('no encontrado', { status: 404 });
  }
  beforeEach(() => {
    CONEXIONES.push({ id: CONN_REN, org_id: ORG, provider: 'github', kind: 'read', status: 'active',
      meta: { repo_full_name: 'acme/antes' } });
    fetchMock.mockImplementation(async (u: string) => githubRenombrado(String(u)));
  });
  afterEach(() => { CONEXIONES.splice(CONEXIONES.findIndex((c) => c.id === CONN_REN), 1); });
  const post = (ruta: string, body: unknown) => app.request(`https://officialvanguard.com/api/orgs/${ORG}/wiki/${ruta}`, {
    method: 'POST', headers: { authorization: 'Bearer ana', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, envDoble({ VG_ENV: 'local' }).env);

  it('flujo del FRONT: E40 da el nombre de la conexión, E41 lo guarda en la fila y E43 ?repo= la encuentra', async () => {
    const r = await post('estimate', { repo_full_name: 'acme/antes', connection_id: CONN_REN });
    expect(r.status).toBe(200);
    const est = WikiEstimate.parse(await r.json());
    expect(est.repo_full_name).toBe('acme/antes');   // el FRONT manda este nombre a E41
    // El 301 se siguió: el árbol se leyó con el nombre canónico, con el PAT.
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(`${API}/repos/acme/nuevo/git/trees/${SHA}?recursive=1`);
    expect(cabeceras(0).Authorization).toBe(`Bearer ${PAT}`);

    const r2 = await post('runs', { repo_full_name: est.repo_full_name, connection_id: CONN_REN, max_usd: 1 });
    expect(r2.status).toBe(202);
    // El nombre que se comprobó: los pasos arbol y area lo vuelven a comprobar con fila.repo_full_name.
    expect(corridas[0]).toMatchObject({ repo_full_name: 'acme/antes', connection_id: CONN_REN, commit_sha: SHA,
      branch: 'main' });
    const h = WikiRun.array().parse(await (await leer('runs?repo=acme/antes')).json());
    expect(h.map((x) => x.id)).toEqual([corridas[0]?.id]);
  });

  it('con otras mayúsculas, la fila lleva el nombre tal como está en la conexión', async () => {
    const r = await post('runs', { repo_full_name: 'ACME/Antes', connection_id: CONN_REN });
    expect(r.status).toBe(202);
    expect(corridas[0]).toMatchObject({ repo_full_name: 'acme/antes', connection_id: CONN_REN });
  });

  it('sin conexión (repo público), la fila y la estimación llevan el nombre canónico, como siempre', async () => {
    const est = WikiEstimate.parse(await (await post('estimate', { repo_full_name: 'acme/antes' })).json());
    expect(est.repo_full_name).toBe('acme/nuevo');
    const r = await post('runs', { repo_full_name: 'acme/antes' });
    expect(r.status).toBe(202);
    expect(corridas[0]).toMatchObject({ repo_full_name: 'acme/nuevo', connection_id: null });
  });
});

describe('E43 · GET /api/orgs/:org/wiki/runs', () => {
  beforeEach(() => {
    corridas.push(
      corrida({ id: 'e1e00000-0000-4000-8000-0000000000c1', created_at: '2026-10-24T18:20:05+00:00' }),
      corrida({ id: 'e1e00000-0000-4000-8000-0000000000c2', created_at: '2026-10-24T18:31:20+00:00', cached: true, cost_usd: 0,
        steps: pasosCache(SHA) }),
      corrida({ id: 'e1e00000-0000-4000-8000-0000000000c3', repo_full_name: 'acme/otro', created_at: '2026-10-24T18:25:00+00:00' }),
      corrida({ id: 'e1e00000-0000-4000-8000-0000000000c4', org_id: OTRA_ORG, created_at: '2026-10-24T18:40:00+00:00' }),
    );
  });

  it('historial del repo, más nuevas primero, válido según el contrato y solo de la org (el viewer y el anónimo leen)', async () => {
    rol = 'viewer';
    for (const tok of ['ana', 'anon']) {
      const r = await leer('runs?repo=acme/tienda', { tok });
      expect(r.status, tok).toBe(200);
      const runs = WikiRun.array().parse(await r.json());
      expect(runs.map((x) => x.id)).toEqual(['e1e00000-0000-4000-8000-0000000000c2', 'e1e00000-0000-4000-8000-0000000000c1']);
      expect(runs[0]).toMatchObject({ cached: true, cost_usd: 0 });
    }
    const consulta = doble.ops.filter((o) => o.table === 'wiki_runs').at(-1);
    expect(consulta && eqDe(consulta, 'org_id')).toBe(ORG);
    expect(consulta?.columns).not.toMatch(/\bstate\b|\bdoc\b/);
    // Las más nuevas primero las ordena la base (el doble solo aplica lo pedido) y con un límite.
    expect(pedidos.filter((p) => p.table === 'wiki_runs').at(-1)).toEqual({ table: 'wiki_runs', orden: [['created_at', false]],
      limite: LIMITE_HISTORIAL });
  });

  it('sin ?repo= → todas las de la org', async () => {
    const runs = WikiRun.array().parse(await (await leer('runs')).json());
    expect(runs.map((x) => x.id)).toEqual(['e1e00000-0000-4000-8000-0000000000c2', 'e1e00000-0000-4000-8000-0000000000c3',
      'e1e00000-0000-4000-8000-0000000000c1']);
  });

  it('repo con formato inválido → 422 con field_errors.repo', async () => {
    const r = await leer('runs?repo=no-es-un-repo');
    expect(r.status).toBe(422);
    expect((await error(r)).details).toMatchObject({ field_errors: { repo: expect.any(Array) } });
  });

  it('quien no es miembro → 404; sin sesión → 401', async () => {
    expect((await leer('runs', { org: OTRA_ORG })).status).toBe(404);
    const r = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/wiki/runs`, {}, envDoble().env);
    expect(r.status).toBe(401);
  });
});

describe('E42 · GET /api/orgs/:org/wiki/runs/:id y E44 · …/doc', () => {
  beforeEach(() => {
    corridas.push(corrida(),
      corrida({ id: 'e1e00000-0000-4000-8000-0000000000d1', status: 'running', progress: 40, doc: null, finished_at: null }),
      corrida({ id: 'e1e00000-0000-4000-8000-0000000000d2', status: 'failed', error: 'GitHub frenó las peticiones', doc: null }),
      corrida({ id: 'e1e00000-0000-4000-8000-0000000000d3', org_id: OTRA_ORG }));
  });

  it('E42: la corrida de la org → WikiRun (viewer y anónimo leen)', async () => {
    rol = 'viewer';
    for (const tok of ['ana', 'anon']) {
      const r = await leer(`runs/${RUN_OK}`, { tok });
      expect(r.status, tok).toBe(200);
      const run = WikiRun.parse(await r.json());
      expect(run).toMatchObject({ id: RUN_OK, status: 'succeeded', progress: 100, cost_usd: 0.034, est_usd: 0.043,
        created_at: '2026-10-24T18:20:05.000Z', finished_at: '2026-10-24T18:21:52.000Z' });
    }
    expect(WikiRun.parse(await (await leer('runs/e1e00000-0000-4000-8000-0000000000d2')).json()).error).toBe('GitHub frenó las peticiones');
  });

  it('E42 y E44: ajena, inexistente o malformada → el mismo 404 (la malformada sin consultar la base)', async () => {
    const textos = new Set<string>();
    for (const ruta of ['runs/e1e00000-0000-4000-8000-0000000000d3', 'runs/e1e00000-0000-4000-8000-0000000000ff', 'runs/no-es-un-uuid',
      'runs/e1e00000-0000-4000-8000-0000000000d3/doc', 'runs/e1e00000-0000-4000-8000-0000000000ff/doc', 'runs/no-es-un-uuid/doc']) {
      const antes = doble.ops.filter((o) => o.table === 'wiki_runs').length;
      const r = await leer(ruta);
      expect(r.status, ruta).toBe(404);
      textos.add((await error(r)).message);
      const consultas = doble.ops.filter((o) => o.table === 'wiki_runs').slice(antes);
      if (ruta.includes('no-es-un-uuid')) expect(consultas, ruta).toEqual([]);
      else for (const o of consultas) expect(eqDe(o, 'org_id')).toBe(ORG);
    }
    expect(textos.size).toBe(1);
  });

  it('E44: terminada → WikiDoc con run_id; en curso o fallida → 409 con details.status', async () => {
    rol = 'viewer';
    const r = await leer(`runs/${RUN_OK.toUpperCase()}/doc`, { tok: 'anon' });
    expect(r.status).toBe(200);
    expect(WikiDoc.parse(await r.json())).toEqual({ ...DOC, run_id: RUN_OK });
    for (const [id, status] of [['e1e00000-0000-4000-8000-0000000000d1', 'running'], ['e1e00000-0000-4000-8000-0000000000d2', 'failed']]) {
      const x = await leer(`runs/${id}/doc`);
      expect(x.status, status).toBe(409);
      expect(await error(x)).toMatchObject({ code: 'conflict', details: { status } });
    }
  });

  it('E44: un doc guardado que no cumple el contrato → 500 (nunca se sirve a medias)', async () => {
    corridas.push(corrida({ id: 'e1e00000-0000-4000-8000-0000000000d4', doc: { overview_md: 1 } }));
    expect((await leer('runs/e1e00000-0000-4000-8000-0000000000d4/doc')).status).toBe(500);
  });
});

describe('sin la tabla wiki_runs (0010 sin aplicar): la Wiki degrada en silencio', () => {
  it('E43 → [], E42 y E44 → el 404 uniforme, E40 → cached_run_id null; E41 → 503 sin_tabla; nunca un log de error', async () => {
    sinTablaWiki = true;
    const h = await leer('runs?repo=acme/tienda');
    expect(h.status).toBe(200);
    expect(WikiRun.array().parse(await h.json())).toEqual([]);
    for (const ruta of ['runs/e1e00000-0000-4000-8000-0000000000c1', 'runs/e1e00000-0000-4000-8000-0000000000c1/doc']) {
      expect((await leer(ruta)).status, ruta).toBe(404);
    }
    const e = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/wiki/estimate`, { method: 'POST',
      headers: { authorization: 'Bearer ana', 'content-type': 'application/json' }, body: JSON.stringify({ repo_full_name: 'acme/tienda' }) },
      envDoble().env);
    expect(e.status).toBe(200);
    expect(WikiEstimate.parse(await e.json()).cached_run_id).toBeNull();
    const g = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/wiki/runs`, { method: 'POST',
      headers: { authorization: 'Bearer ana', 'content-type': 'application/json' }, body: JSON.stringify({ repo_full_name: 'acme/tienda' }) },
      envDoble({ VG_ENV: 'local' }).env);
    expect(g.status).toBe(503);
    expect((await error(g)).details).toMatchObject({ reason: 'sin_tabla' });
    expect(lineas.filter((l) => l.includes('"level":"error"'))).toEqual([]);
    expect(lineas.filter((l) => l.includes('wiki.estimar_sin_cache'))).toEqual([]);
  });
});
