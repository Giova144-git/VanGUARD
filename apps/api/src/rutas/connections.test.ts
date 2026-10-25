import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, ConnectionCreated, ConnectionPublic, ConnectionTest } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const cred = vi.hoisted(() => ({ createConnectionWithSecret: vi.fn(), withSecret: vi.fn() }));
vi.mock('../lib/credentials.ts', () => cred);

const { app } = await import('../app.ts');

// Tokens falsos armados en tiempo de ejecución: ningún literal con forma de secreto queda en el repo (dogfooding).
const t = (...p: string[]) => p.join('_');
const PAT_SB = t('sbp', 'fc' + 'x'.repeat(40));
const PAT_GH = t('github', 'pat', 'y'.repeat(40));
const CF_LECTURA = 'r'.repeat(40);
const CF_ACCIONES = 'w'.repeat(40);
const SECRET_SB = t('sb', 'secret', 'z'.repeat(30));
const CLASICO_GH = t('ghp', 'q'.repeat(36));

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const CONN = 'c0aa0000-0000-4000-8000-000000000001';
const REF = 'abcdefghijklmnopqrst';
const ZONA = '023e105f4ecef8ad9ca31a8372d0c353';

let tabla: (op: Op) => Resp | undefined;
let rol: string;
let doble: ReturnType<typeof dbDoble>;
let creadas: Record<string, unknown>[];
let fetchMock: ReturnType<typeof vi.fn>;

const fila = (o: Record<string, unknown> = {}) => ({ id: CONN, provider: 'supabase', kind: 'read', label: 'Supabase · tienda',
  status: 'active', last4: 'xxxx', scopes: [], meta: { project_ref: REF }, capabilities: { project: true },
  expires_at: null, last_checked_at: '2026-10-24T14:00:00.123456+00:00', last_error: null, ...o });

beforeEach(() => {
  rol = 'owner';
  creadas = [];
  tabla = () => undefined;
  doble = dbDoble({
    tabla: (op) => {
      if (op.table === 'org_members') return { data: { role: rol } };
      if (op.table === 'connections' && op.action === 'select' && op.filters.some(([c, o]) => c === 'id' && o === 'in')) {
        return { data: creadas.map((c) => fila({ id: c.connectionId, provider: c.provider, kind: c.kind, label: c.label,
          meta: c.meta, capabilities: c.capabilities, scopes: c.scopes })) };
      }
      return tabla(op);
    },
    claims: (tok) => (tok === 'ana' ? { sub: ANA, email: 'ana@acme.dev', is_anonymous: false } : null),
  });
  estado.client = doble.client;
  cred.createConnectionWithSecret.mockReset().mockImplementation(async (_e: unknown, _a: unknown, c: Record<string, unknown>) => {
    creadas.push(c);
  });
  cred.withSecret.mockReset();
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const post = (body: unknown) => app.request(`https://officialvanguard.com/api/orgs/${ORG}/connections`, {
  method: 'POST', headers: { authorization: 'Bearer ana', 'content-type': 'application/json' }, body: JSON.stringify(body),
}, envDoble().env);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;

const MGMT = 'https://api.supabase.com';
const PROYECTO = `${MGMT}/v1/projects/${REF}`;
// Rutas del sondeo negativo (permisos que el PAT NO debe tener): por defecto 403, como el PAT de la demo.
const NEGATIVAS = ['/v1/organizations', '/api-keys', '/postgrest', '/secrets'];

// Respuestas de la Management API por ruta (relativa al proyecto, o /v1/organizations); lo que no esté → 200 '{}',
// salvo las rutas negativas → 403. Un 0 simula que vence el plazo (TimeoutError).
function supabaseResponde(porRuta: Record<string, number>) {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    const ruta = u.startsWith(PROYECTO) ? u.slice(PROYECTO.length) : u.replace(MGMT, '');
    const clave = Object.keys(porRuta).find((k) => ruta.startsWith(k) && (k !== '' || ruta === ''));
    const s = clave !== undefined ? porRuta[clave]! : NEGATIVAS.includes(ruta) ? 403 : 200;
    if (s === 0) throw Object.assign(new Error('plazo'), { name: 'TimeoutError' });
    return new Response(ruta === '' && s === 200 ? JSON.stringify({ name: 'tienda', region: 'us-west-2', status: 'ACTIVE_HEALTHY' }) : '{}', { status: s });
  });
}

describe('E8 · guardas antes de llamar al proveedor', () => {
  it('sb_secret_ en el PAT → 422 key_rejected y ni un fetch', async () => {
    const r = await post({ provider: 'supabase', project_ref: REF, pat: SECRET_SB });
    expect(r.status).toBe(422);
    const e = await error(r);
    expect(e.code).toBe('key_rejected');
    expect(e.details?.reason).toBe('sb_secret');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cred.createConnectionWithSecret).not.toHaveBeenCalled();
  });

  it('sb_secret_ pegada en el campo de Cloudflare también se rechaza', async () => {
    const r = await post({ provider: 'cloudflare', zone_id: ZONA, read_token: SECRET_SB });
    expect((await error(r)).details?.reason).toBe('sb_secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GitHub con repo acme/.. → 422 invalid_body sin llamar a GitHub (T17)', async () => {
    for (const repo of ['acme/..', 'acme/.', '../..', 'acme/web/x']) {
      const r = await post({ provider: 'github', repo_full_name: repo, pat: PAT_GH });
      expect(r.status).toBe(422);
      expect((await error(r)).code).toBe('invalid_body');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PAT clásico de GitHub → classic_github_pat; sin prefijo github_pat_ → field_errors.pat', async () => {
    expect((await error(await post({ provider: 'github', repo_full_name: 'acme/web', pat: CLASICO_GH }))).details?.reason)
      .toBe('classic_github_pat');
    const e = await error(await post({ provider: 'github', repo_full_name: 'acme/web', pat: 'z'.repeat(40) }));
    expect(e.code).toBe('invalid_body');
    expect(e.details?.field_errors).toHaveProperty('pat');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Cloudflare con el mismo token de lectura y de acciones → same_token', async () => {
    const r = await post({ provider: 'cloudflare', zone_id: ZONA, read_token: CF_LECTURA, action_token: CF_LECTURA });
    expect((await error(r)).details?.reason).toBe('same_token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('project_ref que no es ref ni URL → 422 con field_errors.project_ref', async () => {
    const e = await error(await post({ provider: 'supabase', project_ref: 'no-es-un-ref', pat: PAT_SB }));
    expect(e.details?.field_errors).toHaveProperty('project_ref');
  });

  it('viewer → 403', async () => {
    rol = 'viewer';
    expect((await post({ provider: 'ingest', label: 'victima' })).status).toBe(403);
  });
});

describe('E8 · Supabase', () => {
  it('PAT con los 3 permisos obligatorios → 201 con checks, capacidades booleanas y el token solo hacia el sellado', async () => {
    supabaseResponde({ '/analytics': 403, '/config/auth': 403 });
    const r = await post({ provider: 'supabase', project_ref: `https://${REF}.supabase.co`, pat: ` ${PAT_SB} ` });
    expect(r.status).toBe(201);
    const b = ConnectionCreated.parse(await r.json());
    expect(b.connection.label).toBe('Supabase · tienda');
    expect(b.checks.find((c) => c.permission === 'database_read')?.ok).toBe(true);
    expect(b.checks.find((c) => c.permission === 'analytics_logs_read')).toMatchObject({ ok: false, error_code: 'forbidden' });
    const [, , conn, token] = cred.createConnectionWithSecret.mock.calls[0]!;
    expect(token).toBe(PAT_SB);
    expect(conn).toMatchObject({ orgId: ORG, provider: 'supabase', kind: 'read', createdBy: ANA,
      meta: { project_ref: REF, project_name: 'tienda' },
      capabilities: { project: true, health: true, advisors: true, sql_read_only: true, analytics: false, auth_config: false } });
    expect(JSON.stringify(b)).not.toContain(PAT_SB);
  });

  it('sin Database · Read → 422 provider_rejected con missing_permissions [database_read] y nada guardado', async () => {
    supabaseResponde({ '/database/query/read-only': 403 });
    const r = await post({ provider: 'supabase', project_ref: REF, pat: PAT_SB });
    expect(r.status).toBe(422);
    const e = await error(r);
    expect(e.code).toBe('provider_rejected');
    expect(e.details?.missing_permissions).toEqual(['database_read']);
    expect(cred.createConnectionWithSecret).not.toHaveBeenCalled();
  });

  it('401 del proyecto → provider_rejected con reason unauthorized; 403 → project_not_in_token; 503 → 502', async () => {
    supabaseResponde({ '': 401 });
    expect((await error(await post({ provider: 'supabase', project_ref: REF, pat: PAT_SB }))).details?.reason).toBe('unauthorized');
    supabaseResponde({ '': 403 });
    expect((await error(await post({ provider: 'supabase', project_ref: REF, pat: PAT_SB }))).details)
      .toMatchObject({ reason: 'project_not_in_token', missing_permissions: ['project_admin_read'] });
    supabaseResponde({ '': 503 });
    expect((await post({ provider: 'supabase', project_ref: REF, pat: PAT_SB })).status).toBe(502);
  });
});

describe('E8 · Supabase · sondeo negativo (permisos de más, §06.3)', () => {
  const alta = () => post({ provider: 'supabase', project_ref: REF, pat: PAT_SB });

  it('todos los negativos 403 → 201: 4 GET tras el lote positivo, /api-keys sin reveal y nunca más de 5 a la vez', async () => {
    supabaseResponde({});
    const responde = fetchMock.getMockImplementation() as (u: string, i?: RequestInit) => Promise<Response>;
    let enVuelo = 0;
    let max = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      max = Math.max(max, ++enVuelo);
      await new Promise((r) => setTimeout(r, 5));
      try { return await responde(url, init); } finally { enVuelo--; }
    });
    const r = await alta();
    expect(r.status).toBe(201);
    const pedidas = fetchMock.mock.calls.map(([u, i]) => `${(i as RequestInit | undefined)?.method ?? 'GET'} ${String(u)}`);
    const negativas = [`GET ${MGMT}/v1/organizations`, `GET ${PROYECTO}/api-keys`, `GET ${PROYECTO}/postgrest`, `GET ${PROYECTO}/secrets`];
    expect(pedidas).toEqual(expect.arrayContaining(negativas));
    expect(pedidas.some((p) => p.includes('reveal'))).toBe(false);
    expect(max).toBeLessThanOrEqual(5);
    const ultimaPositiva = pedidas.findIndex((p) => p.includes('/config/auth'));
    for (const n of negativas) expect(pedidas.indexOf(n)).toBeGreaterThan(ultimaPositiva);
    const b = ConnectionCreated.parse(await r.json());
    expect(b.checks.map((c) => c.permission)).not.toContain('organizations_read');
    expect(cred.createConnectionWithSecret).toHaveBeenCalledTimes(1);
  });

  it('400, 401 o 404 en los negativos también son «no lo tiene» → 201', async () => {
    supabaseResponde({ '/v1/organizations': 401, '/api-keys': 404, '/postgrest': 400, '/secrets': 404 });
    expect((await alta()).status).toBe(201);
  });

  it('200 en /v1/organizations → 422 key_rejected legacy_pat y nada guardado', async () => {
    supabaseResponde({ '/v1/organizations': 200 });
    const r = await alta();
    expect(r.status).toBe(422);
    const e = await error(r);
    expect(e.code).toBe('key_rejected');
    expect(e.details).toEqual({ reason: 'legacy_pat', excess_permissions: ['organizations_read'] });
    expect(e.message).toMatch(/^Ese token tiene permisos de más \(.+\)\. Crea uno con alcance a este proyecto/);
    expect(JSON.stringify(e)).not.toContain(PAT_SB);
    expect(cred.createConnectionWithSecret).not.toHaveBeenCalled();
  });

  it('200 en /api-keys, /postgrest o /secrets → key_rejected excess_scope con el permiso que sobra', async () => {
    const casos = [['/api-keys', 'api_gateway_keys_read'], ['/postgrest', 'data_api_config_read'],
      ['/secrets', 'edge_functions_secrets_read']] as const;
    for (const [ruta, permiso] of casos) {
      supabaseResponde({ [ruta]: 200 });
      const r = await alta();
      expect(r.status).toBe(422);
      const e = await error(r);
      expect(e.code).toBe('key_rejected');
      expect(e.details).toEqual({ reason: 'excess_scope', excess_permissions: [permiso] });
    }
    expect(cred.createConnectionWithSecret).not.toHaveBeenCalled();
  });

  it('acceso total (todo 2xx) → legacy_pat con los 4 permisos; sobra gana aunque falte un obligatorio', async () => {
    supabaseResponde({ '/v1/organizations': 200, '/api-keys': 200, '/postgrest': 200, '/secrets': 200 });
    expect((await error(await alta())).details).toEqual({ reason: 'legacy_pat',
      excess_permissions: ['organizations_read', 'api_gateway_keys_read', 'data_api_config_read', 'edge_functions_secrets_read'] });
    supabaseResponde({ '/database/query/read-only': 403, '/secrets': 200 });
    const e = await error(await alta());
    expect(e.code).toBe('key_rejected');
    expect(e.details?.reason).toBe('excess_scope');
    expect(cred.createConnectionWithSecret).not.toHaveBeenCalled();
  });

  it('503, 429 o plazo vencido en un negativo → 502 provider_unavailable y nada guardado', async () => {
    for (const s of [503, 429, 0]) {
      supabaseResponde({ '/postgrest': s });
      const r = await alta();
      expect(r.status).toBe(502);
      expect((await error(r)).code).toBe('provider_unavailable');
    }
    expect(cred.createConnectionWithSecret).not.toHaveBeenCalled();
  });
});

describe('E8 · GitHub e ingest', () => {
  it('ya hay un repo activo → 409 sin llamar a GitHub', async () => {
    tabla = (op) => (op.table === 'connections' && eqDe(op, 'provider') === 'github' ? { count: 1 } : undefined);
    expect((await post({ provider: 'github', repo_full_name: 'acme/web', pat: PAT_GH })).status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('repo que el token no ve → 422 provider_rejected [metadata:read]', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));
    const e = await error(await post({ provider: 'github', repo_full_name: 'acme/web', pat: PAT_GH }));
    expect(e.details?.missing_permissions).toEqual(['metadata:read']);
  });

  it('ingest → 201 con un vgi_ que sale una sola vez', async () => {
    const r = await post({ provider: 'ingest', label: 'victima' });
    expect(r.status).toBe(201);
    const b = ConnectionCreated.parse(await r.json());
    expect(b.ingest_secret).toMatch(/^vgi_[A-Za-z0-9_-]{43}$/);
    expect(cred.createConnectionWithSecret.mock.calls[0]?.[3]).toBe(b.ingest_secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('E7, E9 y E10', () => {
  it('E7 lista solo la org del contexto y quita de capabilities lo que no es booleano', async () => {
    tabla = (op) => (op.table === 'connections' && eqDe(op, 'org_id') === ORG
      ? { data: [fila({ capabilities: { project: true, checked_at: '2026-10-24' } })] } : undefined);
    const r = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/connections`,
      { headers: { authorization: 'Bearer ana' } }, envDoble().env);
    const [c] = ConnectionPublic.array().parse(await r.json());
    expect(c?.capabilities).toEqual({ project: true });
    expect(c?.last_checked_at).toBe('2026-10-24T14:00:00.123Z');
  });

  it('E9: un 401 del proveedor deja la conexión revoked', async () => {
    tabla = (op) => (op.table === 'connections' && op.action === 'select' ? { data: fila() } : undefined);
    cred.withSecret.mockImplementation(async (_e: unknown, _a: unknown, _c: unknown, fn: (t: string) => Promise<unknown>) => fn(PAT_SB));
    fetchMock.mockImplementation(async () => new Response('{}', { status: 401 }));
    const r = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/connections/${CONN}/test`,
      { method: 'POST', headers: { authorization: 'Bearer ana' } }, envDoble().env);
    expect(ConnectionTest.parse(await r.json()).ok).toBe(false);
    const up = doble.ops.find((o) => o.action === 'update' && o.table === 'connections');
    expect(up?.payload).toMatchObject({ status: 'revoked', last_error: 'unauthorized' });
    expect(eqDe(up!, 'org_id')).toBe(ORG);
  });

  it('E9: negativos 403 → ok y active; 200 en /secrets → error con last_error excess_scope y 422 key_rejected', async () => {
    tabla = (op) => (op.table === 'connections' && op.action === 'select' ? { data: fila() } : undefined);
    cred.withSecret.mockImplementation(async (_e: unknown, _a: unknown, _c: unknown, fn: (t: string) => Promise<unknown>) => fn(PAT_SB));
    const probar = () => app.request(`https://officialvanguard.com/api/orgs/${ORG}/connections/${CONN}/test`,
      { method: 'POST', headers: { authorization: 'Bearer ana' } }, envDoble().env);
    const updates = () => doble.ops.filter((o) => o.action === 'update' && o.table === 'connections');

    supabaseResponde({});
    expect(ConnectionTest.parse(await (await probar()).json()).ok).toBe(true);
    expect(updates()[0]?.payload).toMatchObject({ status: 'active', last_error: null });

    supabaseResponde({ '/secrets': 200 });
    const r = await probar();
    expect(r.status).toBe(422);
    const e = await error(r);
    expect(e.code).toBe('key_rejected');
    expect(e.details).toEqual({ reason: 'excess_scope', excess_permissions: ['edge_functions_secrets_read'] });
    const up = updates()[1];
    expect(up?.payload).toEqual({ status: 'error', last_checked_at: expect.any(String), last_error: 'excess_scope' });
    expect(eqDe(up!, 'org_id')).toBe(ORG);
  });

  it('E10: 204 con X-VG-Revoke-Url; un id de otra org → 404 y no borra', async () => {
    tabla = (op) => (op.table === 'connections' && op.action === 'select' && eqDe(op, 'id') === CONN ? { data: fila() } : undefined);
    const r = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/connections/${CONN}`,
      { method: 'DELETE', headers: { authorization: 'Bearer ana' } }, envDoble().env);
    expect(r.status).toBe(204);
    expect(r.headers.get('x-vg-revoke-url')).toBe('https://supabase.com/dashboard/account/tokens');
    const borrado = doble.ops.find((o) => o.action === 'delete');
    expect(eqDe(borrado!, 'org_id')).toBe(ORG);
    const otra = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/connections/c0aa0000-0000-4000-8000-0000000000ff`,
      { method: 'DELETE', headers: { authorization: 'Bearer ana' } }, envDoble().env);
    expect(otra.status).toBe(404);
  });

  describe('E10 con un token de acciones y bloqueos executed (§05.8)', () => {
    const PROD = { VG_ENV: 'production' as const, APP_ORIGIN: 'https://officialvanguard.com' };
    const REF = 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
    let bloqueos: Record<string, unknown>[];
    let enCurso: Record<string, unknown>[];
    beforeEach(() => {
      bloqueos = [{ id: 'a1', org_id: ORG, provider_ref: REF, previous: { connection_id: CONN, zone_id: ZONA, existed: false } }];
      enCurso = [];
      tabla = (op) => {
        if (op.table === 'connections' && op.action === 'select') return { data: fila({ provider: 'cloudflare', kind: 'action', meta: { zone_id: ZONA } }) };
        if (op.table === 'actions' && op.action === 'select') return { data: eqDe(op, 'status') === 'proposed' ? enCurso : bloqueos };
        return undefined;
      };
      cred.withSecret.mockImplementation(async (_e: unknown, _a: unknown, _c: unknown, fn: (t: string) => Promise<unknown>) => fn(CF_ACCIONES));
    });
    const borrar = (env: Partial<CloudflareBindings> = PROD) => app.request(`https://officialvanguard.com/api/orgs/${ORG}/connections/${CONN}`,
      { method: 'DELETE', headers: { authorization: 'Bearer ana' } }, envDoble(env).env);

    it('primero deshace sus bloqueos (DELETE de la regla, undone) y luego borra la conexión → 204', async () => {
      const r = await borrar();
      expect(r.status).toBe(204);
      const sel = doble.ops.find((o) => o.table === 'actions' && o.action === 'select')!;
      expect([eqDe(sel, 'org_id'), eqDe(sel, 'status'), eqDe(sel, 'previous->>connection_id')]).toEqual([ORG, 'executed', CONN]);
      expect(cred.withSecret.mock.calls[0]![2]).toEqual({ orgId: ORG, connectionId: CONN, provider: 'cloudflare', kind: 'action' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect([url, init.method]).toEqual([`https://api.cloudflare.com/client/v4/zones/${ZONA}/firewall/access_rules/rules/${REF}`, 'DELETE']);
      const undone = doble.ops.find((o) => o.table === 'actions' && o.action === 'update')!;
      expect(undone.payload).toMatchObject({ status: 'undone' });
      const borrado = doble.ops.find((o) => o.action === 'delete')!;
      expect(doble.ops.indexOf(undone)).toBeLessThan(doble.ops.indexOf(borrado));
    });

    it('si un bloqueo no se puede retirar (Cloudflare 403 o caído) → 409 y no borra nada', async () => {
      for (const status of [403, 503]) {
        fetchMock.mockImplementation(async () => new Response('{}', { status }));
        const r = await borrar();
        expect(r.status).toBe(409);
        expect((await error(r)).message).toBe('Hay bloqueos activos que no pudimos retirar');
      }
      expect(doble.ops.some((o) => o.action === 'delete')).toBe(false);
    });

    it('un bloqueo aplicándose ahora (proposed de < 2 min) → 409 block_in_progress sin tocar Cloudflare ni borrar', async () => {
      enCurso = [{ id: 'a9' }];
      bloqueos = [];
      const r = await borrar();
      expect([r.status, (await error(r)).details?.reason]).toEqual([409, 'block_in_progress']);
      const q = doble.ops.find((o) => o.table === 'actions' && eqDe(o, 'status') === 'proposed')!;
      expect(eqDe(q, 'org_id')).toBe(ORG);
      expect(q.filters.some(([c, op]) => c === 'created_at' && op === 'gte')).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(doble.ops.some((o) => o.action === 'delete')).toBe(false);
    });

    it('un modo bajo ataque vivo va a deshacerBajoAtaque (DELETE de la regla de configuración), un bloqueo a deshacerBloqueos', async () => {
      const RS = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
      const REGLA = 'd'.repeat(32);
      bloqueos = [
        { id: 'a1', org_id: ORG, kind: 'block_ip', provider_ref: REF, previous: { connection_id: CONN, zone_id: ZONA, existed: false } },
        { id: 'u1', org_id: ORG, kind: 'under_attack_on', provider_ref: REGLA,
          previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ruleset_id: RS, ref: 'vg_ua_' + 'a'.repeat(32) } },
      ];
      const r = await borrar();
      expect(r.status).toBe(204);
      const sel = doble.ops.find((o) => o.table === 'actions' && o.action === 'select')!;
      expect(sel.columns).toBe('id, org_id, kind, provider_ref, previous');
      expect(fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit).method} ${String(c[0])}`)).toEqual([
        `DELETE https://api.cloudflare.com/client/v4/zones/${ZONA}/firewall/access_rules/rules/${REF}`,
        `DELETE https://api.cloudflare.com/client/v4/zones/${ZONA}/rulesets/${RS}/rules/${REGLA}`,
      ]);
      // Por id (deshacerBloqueos además pasa a undone por provider_ref): primero el bloqueo, luego el modo bajo ataque.
      const undone = doble.ops.filter((o) => o.table === 'actions' && o.action === 'update' && o.filters.some(([c]) => c === 'id'));
      expect(undone.map((o) => o.filters.find(([c]) => c === 'id')![2])).toEqual([['a1'], ['u1']]);
      expect(undone[1]!.filters).toContainEqual(['kind', 'eq', 'under_attack_on']);
    });

    it('si el modo bajo ataque no se puede retirar (403 de Config Rules) → 409 y no borra la conexión', async () => {
      bloqueos = [{ id: 'u1', org_id: ORG, kind: 'under_attack_on', provider_ref: 'd'.repeat(32),
        previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ruleset_id: 'b'.repeat(32) } }];
      fetchMock.mockImplementation(async () => new Response('{}', { status: 403 }));
      const r = await borrar();
      expect([r.status, (await error(r)).details?.reason]).toEqual([409, 'unblock_failed']);
      expect(fetchMock.mock.calls.every((c) => String(c[0]).includes('/rulesets/'))).toBe(true);
      expect(doble.ops.some((o) => o.action === 'delete')).toBe(false);
    });

    it('fuera del host de producción con bloqueos → 409 sin tocar Cloudflare ni borrar; sin bloqueos borra igual', async () => {
      const r = await borrar({});
      expect(r.status).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(doble.ops.some((o) => o.action === 'delete')).toBe(false);
      bloqueos = [];
      expect((await borrar({})).status).toBe(204);
    });
  });
});
