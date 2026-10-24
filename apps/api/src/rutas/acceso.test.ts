import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ApiError as ApiErrorBody, DemoJoin, Me, Org } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { app } = await import('../app.ts');
const { fail } = await import('../lib/errors.ts');
const { errorHandler } = await import('../mw/error.ts');
const { requestId } = await import('../mw/request-id.ts');
const { auth } = await import('../mw/auth.ts');
const { orgMember } = await import('../mw/org.ts');
const { anonReadOnly } = await import('../mw/anon.ts');
const { requireAdmin } = await import('../mw/admin.ts');
const { slugDe } = await import('./orgs.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ANON = '7b1e0000-0000-4000-8000-0000000000aa';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const DEMO = '0f6c0000-0000-4000-8000-0000000000de';
const TOKENS: Record<string, Record<string, unknown>> = {
  ana: { sub: ANA, email: 'ana@acme.dev', is_anonymous: false, role: 'authenticated' },
  anon: { sub: ANON, email: '', is_anonymous: true, role: 'authenticated' },
};

let tabla: (op: Op) => Resp | undefined;
let rpc: (name: string, args: Record<string, unknown>) => Resp | undefined;
let doble: ReturnType<typeof dbDoble>;

beforeEach(() => {
  tabla = () => undefined;
  rpc = () => undefined;
  doble = dbDoble({ tabla: (op) => tabla(op), rpc: (n, a) => rpc(n, a), claims: (t) => TOKENS[t] ?? null });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const pedir = (ruta: string, init: RequestInit & { tok?: string } = {}, extra: Partial<CloudflareBindings> = {}) => {
  const headers = new Headers(init.headers);
  if (init.tok) headers.set('authorization', `Bearer ${init.tok}`);
  return app.request(`https://officialvanguard.com${ruta}`, { ...init, headers }, envDoble(extra).env);
};
const codigo = async (r: Response) => ApiErrorBody.parse(await r.json()).error.code;

describe('auth (getClaims)', () => {
  it('sin token → 401 unauthorized', async () => {
    const r = await pedir('/api/me');
    expect(r.status).toBe(401);
    expect(await codigo(r)).toBe('unauthorized');
  });

  it('token que no valida → 401 y no consulta la base', async () => {
    const r = await pedir('/api/me', { tok: 'falso' });
    expect(r.status).toBe(401);
    expect(doble.ops).toHaveLength(0);
  });

  it('con token, una ruta /api inexistente → 404', async () => {
    const r = await pedir('/api/nada', { tok: 'ana' });
    expect(r.status).toBe(404);
  });

  it('E1 sigue siendo pública', async () => {
    expect((await pedir('/api/health')).status).toBe(200);
  });
});

describe('E2 · GET /api/me', () => {
  it('devuelve el usuario del JWT y sus orgs con rol', async () => {
    tabla = (op) => op.table === 'org_members' && eqDe(op, 'user_id') === ANA
      ? { data: [{ role: 'owner', orgs: { id: ORG, name: 'Acme', is_demo: false } }] } : undefined;
    const r = await pedir('/api/me', { tok: 'ana' });
    expect(r.status).toBe(200);
    expect(Me.parse(await r.json())).toEqual({
      user: { id: ANA, email: 'ana@acme.dev', is_anonymous: false },
      orgs: [{ id: ORG, name: 'Acme', role: 'owner', is_demo: false }],
    });
  });

  it('anónimo: email null e is_anonymous true', async () => {
    tabla = () => ({ data: [] });
    const b = Me.parse(await (await pedir('/api/me', { tok: 'anon' })).json());
    expect(b.user).toEqual({ id: ANON, email: null, is_anonymous: true });
  });
});

describe('E3 · POST /api/orgs', () => {
  const post = (body: unknown, tok = 'ana') =>
    pedir('/api/orgs', { method: 'POST', tok, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  it('anónimo → 403 sin tocar la base', async () => {
    const r = await post({ name: 'Acme' }, 'anon');
    expect(r.status).toBe(403);
    expect(doble.rpcs).toHaveLength(0);
  });

  it('nombre de 1 carácter → 422 invalid_body con field_errors', async () => {
    const r = await post({ name: 'A' });
    expect(r.status).toBe(422);
    const b = ApiErrorBody.parse(await r.json());
    expect(b.error.code).toBe('invalid_body');
    expect(b.error.details?.field_errors).toHaveProperty('name');
  });

  it('dueño de 3 orgs → 409 conflict', async () => {
    tabla = (op) => (op.table === 'org_members' ? { count: 3 } : undefined);
    const r = await post({ name: 'Acme' });
    expect(r.status).toBe(409);
    expect(doble.rpcs).toHaveLength(0);
  });

  it('crea con vg_create_org (owner = sub del JWT), reintenta un slug repetido y responde 201 Org', async () => {
    const creada = '2026-10-24T14:00:00.123456+00:00';
    let llamadas = 0;
    rpc = (name) => (name === 'vg_create_org'
      ? (++llamadas === 1 ? { error: { code: '23505' } } : { data: ORG }) : undefined);
    tabla = (op) => {
      if (op.table === 'org_members') return { count: 0 };
      if (op.table === 'orgs' && eqDe(op, 'id') === ORG) {
        return { data: { id: ORG, name: 'Acme', slug: 'acme-4k2p', is_demo: false, created_at: creada } };
      }
      return undefined;
    };
    const r = await post({ name: '  Acme  ' });
    expect(r.status).toBe(201);
    expect(Org.parse(await r.json())).toEqual({
      id: ORG, name: 'Acme', slug: 'acme-4k2p', is_demo: false, created_at: '2026-10-24T14:00:00.123Z',
    });
    expect(doble.rpcs).toHaveLength(2);
    for (const { args } of doble.rpcs) {
      expect(args.p_owner).toBe(ANA);
      expect(args.p_name).toBe('Acme');
      expect(String(args.p_slug)).toMatch(/^acme-[a-z0-9]{4}$/);
    }
  });

  it('slugDe cumple el check de §05 con acentos, símbolos y nombres largos o vacíos', () => {
    const check = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
    for (const n of ['Tienda Demo', 'Ñandú & Café', 'x'.repeat(80), '!!', 'a']) expect(slugDe(n)).toMatch(check);
    expect(slugDe('!!')).toMatch(/^org-/);
    expect(slugDe('Ñandú & Café')).toMatch(/^nandu-cafe-/);
  });
});

describe('E4 · POST /api/demo/join', () => {
  it('sin org de demo → 404', async () => {
    tabla = () => ({ data: null });
    expect((await pedir('/api/demo/join', { method: 'POST', tok: 'anon' })).status).toBe(404);
  });

  it('anónimo entra como viewer con upsert que no rebaja roles', async () => {
    tabla = (op) => (op.table === 'orgs' && eqDe(op, 'is_demo') === true ? { data: { id: DEMO } } : undefined);
    const r = await pedir('/api/demo/join', { method: 'POST', tok: 'anon' });
    expect(r.status).toBe(200);
    expect(DemoJoin.parse(await r.json())).toEqual({ org_id: DEMO });
    const up = doble.ops.find((o) => o.action === 'upsert');
    expect(up?.table).toBe('org_members');
    expect(up?.payload).toEqual({ org_id: DEMO, user_id: ANON, role: 'viewer' });
    expect(up?.options).toEqual({ onConflict: 'org_id,user_id', ignoreDuplicates: true });
  });
});

describe('originGuard y rateLimit', () => {
  it('POST con Origin de otro host → 403', async () => {
    const r = await pedir('/api/demo/join', { method: 'POST', tok: 'ana', headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(doble.ops).toHaveLength(0);
  });

  it('Vite local solo con VG_ENV=local', async () => {
    tabla = (op) => (op.table === 'orgs' ? { data: { id: DEMO } } : undefined);
    const init = { method: 'POST', tok: 'ana', headers: { origin: 'http://localhost:5173' } };
    expect((await pedir('/api/demo/join', init, { VG_ENV: 'local' })).status).toBe(200);
    expect((await pedir('/api/demo/join', init, { VG_ENV: 'production' })).status).toBe(403);
  });

  it('RL_API agotado → 429 rate_limited con Retry-After 60', async () => {
    const no: RateLimit = { limit: async () => ({ success: false }) };
    const r = await pedir('/api/me', { tok: 'ana' }, { RL_API: no });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect(await codigo(r)).toBe('rate_limited');
  });
});

describe('orgMember, anonReadOnly y requireAdmin', () => {
  // Mini app con el mismo orden que app.ts y rutas de prueba bajo /api/orgs/:org/*.
  const t = new Hono<AppEnv>();
  t.use('*', requestId);
  t.onError(errorHandler);
  t.notFound((c) => fail(c, 'not_found', 'Ruta inexistente'));
  t.use('/api/*', auth);
  t.use('/api/orgs/:org/*', orgMember, anonReadOnly);
  t.get('/api/orgs/:org/leer', (c) => c.json({ org: c.get('orgId'), role: c.get('role') }));
  t.post('/api/orgs/:org/escribir', requireAdmin, (c) => c.json({ ok: true }));
  t.post('/api/orgs/:org/findings/:id/fix-prompt', (c) => c.json({ ok: true }));
  const ir = (ruta: string, tok: string, method = 'GET') =>
    t.request(ruta, { method, headers: { authorization: `Bearer ${tok}` } }, envDoble().env);
  const miembro = (role: string | null) => {
    tabla = (op) => (op.table === 'org_members' && eqDe(op, 'org_id') === ORG ? { data: role ? { role } : null } : undefined);
  };

  it('no miembro → 404 (no confirma que la org exista); id que no es uuid → 404 sin consultar', async () => {
    miembro(null);
    expect((await ir(`/api/orgs/${ORG}/leer`, 'ana')).status).toBe(404);
    const antes = doble.ops.length;
    expect((await ir('/api/orgs/no-es-uuid/leer', 'ana')).status).toBe(404);
    expect(doble.ops.length).toBe(antes);
  });

  it('miembro lee con orgId y rol en el contexto', async () => {
    miembro('viewer');
    const r = await ir(`/api/orgs/${ORG}/leer`, 'ana');
    expect(await r.json()).toEqual({ org: ORG, role: 'viewer' });
  });

  it('viewer no escribe; admin y owner sí', async () => {
    miembro('viewer');
    expect((await ir(`/api/orgs/${ORG}/escribir`, 'ana', 'POST')).status).toBe(403);
    for (const role of ['admin', 'owner']) {
      miembro(role);
      expect((await ir(`/api/orgs/${ORG}/escribir`, 'ana', 'POST')).status).toBe(200);
    }
  });

  it('anónimo: escritura → 403 salvo E15 (fix-prompt, que solo sirve la caché)', async () => {
    miembro('viewer');
    const r = await ir(`/api/orgs/${ORG}/escribir`, 'anon', 'POST');
    expect(r.status).toBe(403);
    expect(ApiErrorBody.parse(await r.json()).error.message).toMatch(/Crea una cuenta/);
    expect((await ir(`/api/orgs/${ORG}/findings/c3d4/fix-prompt`, 'anon', 'POST')).status).toBe(200);
  });

  it('anónimo con rol owner tampoco pasa requireAdmin', async () => {
    miembro('owner');
    expect((await ir(`/api/orgs/${ORG}/escribir`, 'anon', 'POST')).status).toBe(403);
  });
});
