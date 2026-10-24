import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, WikiEstimate, WikiRun } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';
import { TOPE_SUBPETICIONES } from '../wiki/deps.ts';

// E40 con el motor de DeepWiki (sin red: fetch simulado como la API de GitHub, doble de la base y withSecret simulado).
// E42–E44 provisionales (rutas/wiki.ts): historial vacío y 404 uniforme hasta wiki_runs.
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
const { SUBPETICIONES_RUTA_E40 } = await import('./wiki.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ANON = '7b1e0000-0000-4000-8000-0000000000aa';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const OTRA_ORG = '0f6c0000-0000-4000-8000-000000000002';
const CONN = 'c0aa0000-0000-4000-8000-000000000001';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const API = 'https://api.github.com';
// PAT falso armado en tiempo de ejecución: ningún literal con forma de secreto queda en el repo.
const PAT = ['github', 'pat', 'w'.repeat(40)].join('_');

const claims = (tok: string) => (tok === 'ana' ? { sub: ANA, email: 'ana@acme.dev', is_anonymous: false }
  : tok === 'anon' ? { sub: ANON, is_anonymous: true } : null);

beforeEach(() => {
  estado.salidaCerrada = false;
  estado.client = dbDoble({
    tabla: (op: Op): Resp | undefined => (op.table === 'org_members'
      ? { data: eqDe(op, 'org_id') === ORG ? { role: 'viewer' } : null } : undefined),
    claims,
  }).client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const pedir = (ruta: string, org = ORG) =>
  app.request(`https://officialvanguard.com/api/orgs/${org}/wiki/${ruta}`, { headers: { authorization: 'Bearer ana' } }, envDoble().env);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;

describe('E40 · POST /api/orgs/:org/wiki/estimate', () => {
  // connections de la base; el doble aplica todos los .eq() de la consulta, como Postgres.
  const CONEXIONES = [
    { id: CONN, org_id: ORG, provider: 'github', kind: 'read', status: 'active' },
    { id: 'c0aa0000-0000-4000-8000-000000000002', org_id: OTRA_ORG, provider: 'github', kind: 'read', status: 'active' },
    { id: 'c0aa0000-0000-4000-8000-000000000003', org_id: ORG, provider: 'github', kind: 'read', status: 'revoked' },
    { id: 'c0aa0000-0000-4000-8000-000000000004', org_id: ORG, provider: 'cloudflare', kind: 'read', status: 'active' },
  ];
  let rol: string;
  let doble: ReturnType<typeof dbDoble>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let lineas: string[];

  const json = (v: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(v), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  // GitHub de un repo pequeño (acme/tienda): metadatos, commit de main y árbol recursivo.
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

  beforeEach(() => {
    rol = 'owner';
    lineas = [];
    doble = dbDoble({
      tabla: (op: Op): Resp | undefined => {
        if (op.table === 'org_members') return { data: eqDe(op, 'org_id') === ORG ? { role: rol } : null };
        if (op.table === 'connections') {
          return { data: CONEXIONES.find((f) => op.filters.every(([c, o, v]) => o !== 'eq' || (f as Record<string, unknown>)[c] === v)) ?? null };
        }
        return undefined;
      },
      claims,
    });
    estado.client = doble.client;
    cred.withSecret.mockReset().mockImplementation(async (_e: unknown, _a: unknown, _ctx: unknown, fn: (t: string) => unknown) => fn(PAT));
    fetchMock = vi.fn(async (u: string) => github(String(u)));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => { lineas.push(String(l)); });
  });

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

  it('presupuesto: con árbol superficial (GitHub trunca) ≤ 25 llamadas a GitHub y ≤ 40 sumando las de la ruta', async () => {
    // Peor caso sin redirecciones: el recursivo viene truncado, la raíz trae 15 carpetas y cada una falla en sus dos
    // intentos (recursivo y superficial): 2 + 1 + 1 + 10 × 2 = 24.
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
    expect(WikiEstimate.parse(await r.json()).truncado).toBe(true);
    const aGithub = fetchMock.mock.calls.length;
    expect(aGithub).toBe(24);
    // Ruta: getClaims (1) + consultas del doble (org_members, connections) + withSecret simulado (connection_secrets y
    // vg_crypto_material, 2).
    const ruta = 1 + doble.ops.length + doble.rpcs.length + 2;
    expect(ruta).toBeLessThanOrEqual(SUBPETICIONES_RUTA_E40);
    expect(aGithub + ruta).toBeLessThanOrEqual(TOPE_SUBPETICIONES);
    // Peor caso documentado del motor (33 si GitHub redirige) más la ruta: sigue cabiendo.
    expect(33 + SUBPETICIONES_RUTA_E40).toBeLessThanOrEqual(TOPE_SUBPETICIONES);
  });
});

describe('E43 · GET /api/orgs/:org/wiki/runs (provisional)', () => {
  it('el historial sale vacío y válido según el contrato (el viewer puede leer)', async () => {
    for (const q of ['runs', 'runs?repo=acme/tienda']) {
      const r = await pedir(q);
      expect(r.status, q).toBe(200);
      expect(WikiRun.array().parse(await r.json())).toEqual([]);
    }
  });

  it('repo con formato inválido → 422 con field_errors.repo', async () => {
    const r = await pedir('runs?repo=no-es-un-repo');
    expect(r.status).toBe(422);
    expect((await error(r)).details).toMatchObject({ field_errors: { repo: expect.any(Array) } });
  });

  it('quien no es miembro → 404; sin sesión → 401', async () => {
    expect((await pedir('runs', OTRA_ORG)).status).toBe(404);
    const r = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/wiki/runs`, {}, envDoble().env);
    expect(r.status).toBe(401);
  });
});

describe('E42 / E44 (provisionales): 404 con el mismo texto para cualquier id', () => {
  it('uuid, id malformado y el documento dan el mismo 404', async () => {
    const textos = [];
    for (const ruta of ['runs/0f6c0000-0000-4000-8000-0000000000aa', 'runs/no-es-un-uuid', 'runs/0f6c0000-0000-4000-8000-0000000000aa/doc']) {
      const r = await pedir(ruta);
      expect(r.status, ruta).toBe(404);
      textos.push((await error(r)).message);
    }
    expect(new Set(textos).size).toBe(1);
  });
});
