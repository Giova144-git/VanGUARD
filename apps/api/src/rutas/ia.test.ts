// E28 · GET /api/orgs/:org/ai/usage (PLAN_MAESTRO §11): solo el gasto de la org, cuatro claves, IA_CORTE manda.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiUsage } from '@vanguard/contracts';
import { dbDoble, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { app } = await import('../app.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
let rol: string;
let anon: boolean;
let rpc: (args: Record<string, unknown>) => Resp;
let doble: ReturnType<typeof dbDoble>;

beforeEach(() => {
  rol = 'viewer'; anon = false;
  rpc = () => ({ data: { enabled: true, today_usd: 0.4213, cap_usd: 10, calls_1m: 3, level: 'normal' } });
  doble = dbDoble({
    tabla: (op) => (op.table === 'org_members' ? { data: { role: rol } } : undefined),
    rpc: (name, args) => (name === 'vg_ai_status' ? rpc(args) : undefined),
    claims: (t) => (t === 'ok' ? { sub: ANA, email: anon ? '' : 'ana@acme.dev', is_anonymous: anon } : null),
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const pedir = (extra: Partial<CloudflareBindings> = {}) => app.request(`https://officialvanguard.com/api/orgs/${ORG}/ai/usage`,
  { headers: { authorization: 'Bearer ok' } }, envDoble(extra).env);

describe('E28 · ai/usage', () => {
  it('cualquier miembro (también el anónimo de la demo): solo las cuatro claves de AiUsage, sin calls_1m', async () => {
    for (const a of [false, true]) {
      anon = a;
      const r = await pedir();
      expect(r.status).toBe(200);
      const b = await r.json();
      expect(b).toEqual({ today_usd: 0.4213, cap_usd: 10, enabled: true, level: 'normal' });
      expect(AiUsage.parse(b)).toEqual(b);
    }
    expect(doble.rpcs.every((x) => x.args.p_org === ORG)).toBe(true);
  });

  it('IA_CORTE=1 → enabled false y level off aunque la base diga otra cosa; el gasto sigue siendo el de hoy', async () => {
    expect(await (await pedir({ IA_CORTE: '1' } as Partial<CloudflareBindings>)).json())
      .toEqual({ today_usd: 0.4213, cap_usd: 10, enabled: false, level: 'off' });
  });

  it('numeric de Postgres como texto → número; un nivel fuera del enum o un fallo de la RPC → 500 sin datos', async () => {
    rpc = () => ({ data: { enabled: false, today_usd: '1.5000', cap_usd: '1.5', level: 'off' } });
    expect(await (await pedir()).json()).toEqual({ today_usd: 1.5, cap_usd: 1.5, enabled: false, level: 'off' });
    rpc = () => ({ error: { code: '57014' } });
    const r = await pedir();
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('57014');
    rpc = () => ({ data: { enabled: true, today_usd: 0, cap_usd: 1, level: 'turbo' } });
    expect((await pedir()).status).toBe(500);
  });
});
