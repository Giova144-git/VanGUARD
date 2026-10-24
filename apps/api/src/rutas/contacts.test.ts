import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, Contact } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { app } = await import('../app.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const C1 = 'c0c00000-0000-4000-8000-000000000001';
const C2 = 'c0c00000-0000-4000-8000-000000000002';
const URL_C = `https://officialvanguard.com/api/orgs/${ORG}/contacts`;

let rol: string;
let anon: boolean;
let tabla: (op: Op) => Resp | undefined;
let rpc: (name: string, args: Record<string, unknown>) => Resp | undefined;
let doble: ReturnType<typeof dbDoble>;

const fila = (o: Record<string, unknown> = {}) => ({ id: C1, org_id: ORG, name: 'Gabriel', phone_e164: '+584141234567', whatsapp: true,
  voice: true, priority: 1, verified_at: '2026-10-24T14:00:00.123456+00:00', created_at: '2026-10-24T13:00:00+00:00', ...o });

beforeEach(() => {
  rol = 'owner';
  anon = false;
  tabla = () => undefined;
  rpc = () => undefined;
  doble = dbDoble({
    tabla: (op) => (op.table === 'org_members' ? { data: { role: rol } } : tabla(op)),
    rpc: (n, a) => rpc(n, a),
    claims: (tok) => (tok === 'ana' ? { sub: ANA, email: anon ? undefined : 'ana@acme.dev', is_anonymous: anon } : null),
  });
  estado.client = doble.client;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sin red en las pruebas'); }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const pedir = (method: 'GET' | 'PUT', body?: unknown) => app.request(URL_C, {
  method, headers: { authorization: 'Bearer ana', 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}, envDoble().env);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;

describe('E26 · GET contacts', () => {
  it('admin → 200 Contact[] con verified_at en …Z, filtrado por org y ordenado por prioridad', async () => {
    rol = 'admin';
    tabla = (op) => (op.table === 'contacts' ? { data: [fila(), fila({ id: C2, name: 'Carlos', phone_e164: '+584121112233', voice: false,
      priority: 2, verified_at: null })] } : undefined);
    const r = await pedir('GET');
    expect(r.status).toBe(200);
    const b = (await r.json()) as unknown[];
    const lista = b.map((x) => Contact.parse(x));
    expect(lista[0]!.verified_at).toBe('2026-10-24T14:00:00.123Z');
    expect(lista[1]!.verified_at).toBeNull();
    expect(b[0]).not.toHaveProperty('org_id');
    const op = doble.ops.find((o) => o.table === 'contacts')!;
    expect(eqDe(op, 'org_id')).toBe(ORG);
  });

  it('viewer → 403 sin leer teléfonos', async () => {
    rol = 'viewer';
    const r = await pedir('GET');
    expect(r.status).toBe(403);
    expect((await error(r)).code).toBe('forbidden');
    expect(doble.ops.some((o) => o.table === 'contacts')).toBe(false);
  });

  it('sesión anónima (aunque fuese admin) → 403', async () => {
    anon = true;
    expect((await pedir('GET')).status).toBe(403);
  });

  it('error de la base → 500 internal', async () => {
    tabla = (op) => (op.table === 'contacts' ? { error: { code: '57014' } } : undefined);
    const r = await pedir('GET');
    expect(r.status).toBe(500);
    expect((await error(r)).code).toBe('internal');
  });
});

describe('E26 · PUT contacts', () => {
  const lista = [{ name: ' Gabriel ', phone_e164: '+584141234567', whatsapp: true, voice: true, priority: 1 }];

  it('reemplaza con vg_replace_contacts (nunca delete + insert) y devuelve Contact[]', async () => {
    rpc = (n) => (n === 'vg_replace_contacts' ? { data: [fila({ verified_at: null })] } : undefined);
    const r = await pedir('PUT', lista);
    expect(r.status).toBe(200);
    const [c] = ((await r.json()) as unknown[]).map((x) => Contact.parse(x));
    expect(c).toMatchObject({ id: C1, name: 'Gabriel', verified_at: null });
    expect(doble.rpcs).toEqual([{ name: 'vg_replace_contacts', args: { p_org: ORG, p_rows: [{ ...lista[0], name: 'Gabriel' }] } }]);
    expect(doble.ops.some((o) => o.table === 'contacts' && (o.action === 'delete' || o.action === 'insert'))).toBe(false);
  });

  it('lista vacía es válida (la org se queda sin contactos)', async () => {
    rpc = () => ({ data: [] });
    const r = await pedir('PUT', []);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it('teléfono sin + o con letras → 422 invalid_body sin llamar a la RPC', async () => {
    for (const phone_e164 of ['584141234567', '+58414abc4567', '+0123456789']) {
      const r = await pedir('PUT', [{ ...lista[0], phone_e164 }]);
      expect(r.status).toBe(422);
      const e = await error(r);
      expect(e.code).toBe('invalid_body');
      expect(e.details?.field_errors).toBeDefined();
    }
    expect(doble.rpcs).toHaveLength(0);
  });

  it('más de 5, prioridades o teléfonos repetidos → 422', async () => {
    const c = (i: number, o: Record<string, unknown> = {}) => ({ name: `Persona ${i}`, phone_e164: `+58414123456${i}`, whatsapp: true,
      voice: false, priority: i, ...o });
    for (const body of [[1, 2, 3, 4, 5, 6].map((i) => c(i)), [c(1), c(2, { priority: 1 })], [c(1), c(2, { phone_e164: '+584141234561' })]]) {
      expect((await pedir('PUT', body)).status).toBe(422);
    }
    expect(doble.rpcs).toHaveLength(0);
  });

  it('viewer → 403 sin llamar a la RPC', async () => {
    rol = 'viewer';
    expect((await pedir('PUT', lista)).status).toBe(403);
    expect(doble.rpcs).toHaveLength(0);
  });

  it('error de la RPC → 500; 23505 → 409', async () => {
    rpc = () => ({ error: { code: 'XX000' } });
    expect((await pedir('PUT', lista)).status).toBe(500);
    rpc = () => ({ error: { code: '23505' } });
    expect((await error(await pedir('PUT', lista))).code).toBe('conflict');
  });
});
