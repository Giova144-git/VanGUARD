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
const SBX = '0f6c0000-0000-4000-8000-0000000005b1';      // sandbox de «Ver demo» de alguien (0026)
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
      ? { data: [{ role: 'owner', orgs: { id: ORG, name: 'Acme', is_demo: false, sandbox_of: null } },
        { role: 'owner', orgs: { id: SBX, name: 'Tienda Demo', is_demo: false, sandbox_of: DEMO } }] } : undefined;
    const r = await pedir('/api/me', { tok: 'ana' });
    expect(r.status).toBe(200);
    expect(Me.parse(await r.json())).toEqual({
      user: { id: ANA, email: 'ana@acme.dev', is_anonymous: false },
      orgs: [{ id: ORG, name: 'Acme', role: 'owner', is_demo: false, sandbox: false },
        { id: SBX, name: 'Tienda Demo', role: 'owner', is_demo: false, sandbox: true }],
    });
    expect(doble.ops[0]?.columns).toBe('role, orgs(id, name, is_demo, sandbox_of)');
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

  it('dueño de 3 orgs → 409 conflict; su sandbox de «Ver demo» no cuenta', async () => {
    tabla = (op) => (op.table === 'org_members' ? { count: 3 } : undefined);
    const r = await post({ name: 'Acme' });
    expect(r.status).toBe(409);
    expect(doble.rpcs).toHaveLength(0);
    const conteo = doble.ops.find((o) => o.table === 'org_members')!;
    expect(conteo.columns).toBe('org_id, orgs!inner(sandbox_of)');
    expect(conteo.filters).toContainEqual(['orgs.sandbox_of', 'is', null]);
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

describe('E4 · POST /api/demo/join (sandbox por visitante, 0026)', () => {
  const join = (tok: string, headers: Record<string, string> = {}) => pedir('/api/demo/join', { method: 'POST', tok, headers });

  it('sin org de demo → 404', async () => {
    rpc = (n) => (n === 'vg_sandbox_join' ? { error: { code: 'P0002', message: 'demo_org_missing' } } : undefined);
    expect((await join('anon')).status).toBe(404);
  });

  it('anónimo: crea (o recupera) SU sandbox con vg_sandbox_join y ya no se une como viewer a la demo', async () => {
    rpc = (n) => (n === 'vg_sandbox_join' ? { data: SBX } : undefined);
    const r = await join('anon');
    expect(r.status).toBe(200);
    expect(DemoJoin.parse(await r.json())).toEqual({ org_id: SBX, sandbox: true });
    expect(doble.rpcs).toEqual([{ name: 'vg_sandbox_join', args: { p_user: ANON, p_ip_hash: null } }]);
    expect(doble.ops.filter((o) => o.table === 'org_members')).toHaveLength(0);
  });

  it('una cuenta real también obtiene su sandbox (owner) y no queda unida a la demo', async () => {
    rpc = (n) => (n === 'vg_sandbox_join' ? { data: SBX } : undefined);
    const r = await join('ana');
    expect(DemoJoin.parse(await r.json())).toEqual({ org_id: SBX, sandbox: true });
    expect(doble.rpcs[0]?.args.p_user).toBe(ANA);
    expect(doble.ops.some((o) => o.action === 'upsert' || o.action === 'insert')).toBe(false);
  });

  it('la IP viaja como HMAC (64 hex), nunca en claro; el mismo cliente da el mismo hash', async () => {
    rpc = (n) => (n === 'vg_sandbox_join' ? { data: SBX } : undefined);
    const ip = ['198', '51', '100', '23'].join('.');
    await join('anon', { 'cf-connecting-ip': ip });
    await join('anon', { 'cf-connecting-ip': ip });
    const [a, b] = doble.rpcs.map((x) => String(x.args.p_ip_hash));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toContain(ip);
  });

  it('cupo por IP → 429 con Retry-After 3600; cupo global → 429; usuario purgado → 401', async () => {
    rpc = () => ({ error: { code: 'P0001', message: 'sandbox_cupo_ip' } });
    let r = await join('anon');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('3600');
    expect(ApiErrorBody.parse(await r.json()).error.details?.reason).toBe('sandbox_ip');
    rpc = () => ({ error: { code: 'P0001', message: 'sandbox_cupo_global' } });
    r = await join('anon');
    expect(r.status).toBe(429);
    expect(ApiErrorBody.parse(await r.json()).error.details?.reason).toBe('sandbox_global');
    rpc = () => ({ error: { code: '23503', message: 'fk' } });
    expect((await join('anon')).status).toBe(401);
  });
});

describe('E4b latido, E4c salir y E4d cerrando (sandbox de «Ver demo»)', () => {
  const post = (ruta: string, body: unknown, tok = 'anon') => pedir(ruta, { method: 'POST', tok, body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' } });

  it('latido de su sandbox → 204; de otra (o ya purgada) → 404; cuerpo malo → 422', async () => {
    rpc = (n, a) => (n === 'vg_sandbox_latido' ? { data: a.p_org === SBX && a.p_user === ANON ? true : null } : undefined);
    expect((await post('/api/demo/latido', { org_id: SBX })).status).toBe(204);
    expect((await post('/api/demo/latido', { org_id: ORG })).status).toBe(404);
    expect((await post('/api/demo/latido', { org_id: 'x' })).status).toBe(422);
    expect(doble.rpcs[0]).toEqual({ name: 'vg_sandbox_latido', args: { p_org: SBX, p_user: ANON } });
  });

  it('cerrando (pagehide, keepalive con Authorization) → 204 sin borrar; 404 si no es su sandbox; latido después la mantiene', async () => {
    // Doble de la base: cerrando marca cierra_en, latido lo anula (vg_sandbox_cerrando / vg_sandbox_latido de 0026).
    let cierra: boolean | null = null;
    rpc = (n, a) => {
      const suya = a.p_org === SBX && a.p_user === ANA;
      if (n === 'vg_sandbox_cerrando') { if (suya) cierra = true; return { data: suya ? true : null }; }
      if (n === 'vg_sandbox_latido') { if (suya) cierra = null; return { data: suya ? true : null }; }
      return undefined;
    };
    const r = await pedir('/api/demo/cerrando', { method: 'POST', tok: 'ana', body: JSON.stringify({ org_id: SBX }) });
    expect(r.status).toBe(204);
    expect(cierra).toBe(true);
    expect((await post('/api/demo/cerrando', { org_id: SBX }, 'ana')).status).toBe(204);   // idempotente
    expect((await post('/api/demo/cerrando', { org_id: ORG }, 'ana')).status).toBe(404);
    expect((await post('/api/demo/cerrando', { org_id: SBX }, 'anon')).status).toBe(404);  // la de otro
    expect((await post('/api/demo/latido', { org_id: SBX }, 'ana')).status).toBe(204);     // la recarga late
    expect(cierra).toBeNull();
    expect(doble.rpcs.some((x) => x.name === 'vg_sandbox_salir')).toBe(false);             // cerrar no borra
  });

  it('salir → 204 e idempotente (la base borra la sandbox y al anónimo sin orgs; la segunda vez no hay nada)', async () => {
    let vez = 0;
    rpc = (n) => (n === 'vg_sandbox_salir'
      ? { data: ++vez === 1 ? { borrada: true, usuario_borrado: true } : { borrada: false, usuario_borrado: false } } : undefined);
    expect((await post('/api/demo/salir', { org_id: SBX })).status).toBe(204);
    expect((await post('/api/demo/salir', { org_id: SBX })).status).toBe(204);
    expect(doble.rpcs).toEqual([{ name: 'vg_sandbox_salir', args: { p_org: SBX, p_user: ANON } },
      { name: 'vg_sandbox_salir', args: { p_org: SBX, p_user: ANON } }]);
  });

  it('salir acepta el fetch keepalive de pagehide: Authorization normal y text/plain también vale como JSON', async () => {
    rpc = () => ({ data: { borrada: true, usuario_borrado: false } });
    const r = await pedir('/api/demo/salir', { method: 'POST', tok: 'ana', body: JSON.stringify({ org_id: SBX }) });
    expect(r.status).toBe(204);
    expect(doble.rpcs[0]?.args.p_user).toBe(ANA);
  });
});

describe('originGuard y rateLimit', () => {
  it('POST con Origin de otro host → 403', async () => {
    const r = await pedir('/api/demo/join', { method: 'POST', tok: 'ana', headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(doble.ops).toHaveLength(0);
  });

  it('Vite local solo con VG_ENV=local', async () => {
    rpc = (n) => (n === 'vg_sandbox_join' ? { data: SBX } : undefined);
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
  // Membresías por org: ORG normal, DEMO compartida (viewer) y SBX, la sandbox del anónimo (owner, orgs.sandbox_of = DEMO).
  const enOrgs = (filas: Record<string, { role: string; sandbox_of: string | null } | null>) => {
    tabla = (op) => {
      if (op.table !== 'org_members') return undefined;
      const f = filas[String(eqDe(op, 'org_id'))];
      return { data: f ? { role: f.role, orgs: { sandbox_of: f.sandbox_of } } : null };
    };
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

  it(':org en mayúsculas entra igual y el orgId del contexto sale en minúsculas (AAD y huella estables)', async () => {
    miembro('admin');
    const r = await ir(`/api/orgs/${ORG.toUpperCase()}/leer`, 'ana');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ org: ORG, role: 'admin' });
    const consulta = doble.ops.find((o) => o.table === 'org_members');
    expect(consulta && eqDe(consulta, 'org_id')).toBe(ORG);
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

  it('sandbox (0026): el anónimo escribe en SU sandbox; en la demo sigue en solo lectura; en la de otro → 404', async () => {
    enOrgs({ [SBX]: { role: 'owner', sandbox_of: DEMO }, [DEMO]: { role: 'viewer', sandbox_of: null } });
    expect((await ir(`/api/orgs/${SBX}/escribir`, 'anon', 'POST')).status).toBe(200);
    expect((await ir(`/api/orgs/${SBX}/leer`, 'anon')).status).toBe(200);
    const demo = await ir(`/api/orgs/${DEMO}/escribir`, 'anon', 'POST');
    expect(demo.status).toBe(403);
    expect(ApiErrorBody.parse(await demo.json()).error.message).toMatch(/Crea una cuenta/);
    // La sandbox de otro: no es miembro → 404 (orgMember no confirma que exista, S15 15.3).
    enOrgs({ [SBX]: null });
    expect((await ir(`/api/orgs/${SBX}/escribir`, 'anon', 'POST')).status).toBe(404);
    expect((await ir(`/api/orgs/${SBX}/leer`, 'anon')).status).toBe(404);
  });

  it('sandbox: lo decide la fila de la org, no el cliente (un anónimo owner de una org normal sigue sin escribir)', async () => {
    enOrgs({ [ORG]: { role: 'owner', sandbox_of: null } });
    const r = await t.request(`/api/orgs/${ORG}/escribir`, { method: 'POST',
      headers: { authorization: 'Bearer anon', 'x-sandbox': '1', 'content-type': 'application/json' }, body: '{"sandbox":true}' },
      envDoble().env);
    expect(r.status).toBe(403);
  });
});
