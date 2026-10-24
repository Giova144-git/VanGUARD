import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, Traffic } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { app } = await import('../app.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const OTRA_ORG = '0f6c0000-0000-4000-8000-000000000002';

let rpcResp: Resp;
let doble: ReturnType<typeof dbDoble>;

// Lo que devuelve vg_traffic (jsonb): fechas de Postgres con +00:00 y ua_top '' cuando la IP no manda UA.
const RPC = {
  buckets: [
    { t: '2026-10-24T19:01:00+00:00', n: 212, n4xx: 40, n5xx: 0 },
    { t: '2026-10-24T19:01:10+00:00', n: 9, n4xx: 0, n5xx: 1 },
  ],
  top_ips: [
    { ip: '198.51.100.7', n: 180, ua_top: 'sqlmap/1.8' },
    { ip: '2001:db8::1', n: 12, ua_top: '' },
  ],
};

beforeEach(() => {
  rpcResp = { data: RPC };
  doble = dbDoble({
    tabla: (op: Op): Resp | undefined => (op.table === 'org_members'
      ? { data: eqDe(op, 'org_id') === ORG ? { role: 'viewer' } : null } : undefined),
    rpc: () => rpcResp,
    claims: (tok) => (tok === 'ana' ? { sub: ANA, email: 'ana@acme.dev', is_anonymous: false } : null),
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const pedir = (q = '', org = ORG) =>
  app.request(`https://officialvanguard.com/api/orgs/${org}/traffic${q}`, { headers: { authorization: 'Bearer ana' } }, envDoble().env);
const llamadas = () => doble.rpcs.filter((r) => r.name === 'vg_traffic');

describe('E18 · GET /api/orgs/:org/traffic', () => {
  it('por defecto 300 s: RPC con la org de la ruta, fechas en …Z y ua_top vacío → null (el viewer puede leer)', async () => {
    const r = await pedir();
    expect(r.status).toBe(200);
    const b = Traffic.parse(await r.json());
    expect(llamadas()).toEqual([{ name: 'vg_traffic', args: { p_org: ORG, p_seconds: 300 } }]);
    expect(b.buckets).toEqual([
      { t: '2026-10-24T19:01:00.000Z', n: 212, n4xx: 40, n5xx: 0 },
      { t: '2026-10-24T19:01:10.000Z', n: 9, n4xx: 0, n5xx: 1 },
    ]);
    expect(b.top_ips).toEqual([
      { ip: '198.51.100.7', n: 180, ua_top: 'sqlmap/1.8' },
      { ip: '2001:db8::1', n: 12, ua_top: null },
    ]);
  });

  it('seconds en los bordes 60 y 3600 pasa tal cual', async () => {
    expect((await pedir('?seconds=60')).status).toBe(200);
    expect((await pedir('?seconds=3600')).status).toBe(200);
    expect(llamadas().map((l) => l.args.p_seconds)).toEqual([60, 3600]);
  });

  it.each(['59', '3601', 'abc', '1e3', '300.5', '-60', ' 300', '0'])('seconds=%s → 422 sin llamar a la RPC', async (s) => {
    const r = await pedir(`?seconds=${encodeURIComponent(s)}`);
    expect(r.status).toBe(422);
    const b = ApiErrorBody.parse(await r.json());
    expect(b.error.code).toBe('invalid_body');
    expect((b.error.details?.field_errors as Record<string, unknown>).seconds).toBeDefined();
    expect(llamadas()).toHaveLength(0);
  });

  it('top_ips se recorta a 10 aunque la RPC mande más', async () => {
    rpcResp = { data: { buckets: [], top_ips: Array.from({ length: 12 }, (_, i) => ({ ip: `198.51.100.${i + 1}`, n: 20 - i, ua_top: null })) } };
    const b = Traffic.parse(await (await pedir()).json());
    expect(b.top_ips).toHaveLength(10);
    expect(b.top_ips[0]?.ip).toBe('198.51.100.1');
  });

  it('sin tráfico (data null) → listas vacías', async () => {
    rpcResp = { data: null };
    expect(await (await pedir()).json()).toEqual({ buckets: [], top_ips: [] });
  });

  it('error de la RPC → 500 internal sin el mensaje de Postgres', async () => {
    rpcResp = { error: { code: '42883', message: 'function public.vg_traffic does not exist' } };
    const r = await pedir();
    expect(r.status).toBe(500);
    const b = ApiErrorBody.parse(await r.json());
    expect(b.error.code).toBe('internal');
    expect(JSON.stringify(b)).not.toContain('vg_traffic');
  });

  it('org de la que no es miembro → 404 sin llamar a la RPC', async () => {
    const r = await pedir('', OTRA_ORG);
    expect(r.status).toBe(404);
    expect(llamadas()).toHaveLength(0);
  });

  it('sin sesión → 401', async () => {
    const r = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/traffic`, {}, envDoble().env);
    expect(r.status).toBe(401);
    expect(llamadas()).toHaveLength(0);
  });
});
