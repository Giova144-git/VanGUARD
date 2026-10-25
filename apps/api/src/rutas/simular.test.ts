import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, SimulateAttackOut } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
vi.mock('../engine/evaluar.ts', async (orig) => ({ ...(await orig<typeof import('../engine/evaluar.ts')>()), evaluarEnVivo: vi.fn() }));
const aviso = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../notify/despachador.ts', () => ({ avisarIncidente: aviso.fn }));

const { app } = await import('../app.ts');
const { ORG_DEMO, HOST_SIMULADO } = await import('./simular.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';     // owner de la demo y de la otra org
const VERA = '7b1e0000-0000-4000-8000-000000000002';    // viewer
const ANON = '7b1e0000-0000-4000-8000-000000000003';    // «Ver demo»
const OTRA = '0f6c0000-0000-4000-8000-000000000002';
const INC = '9e0b0000-0000-4000-8000-000000000001';
const ROL: Record<string, string> = { [ANA]: 'owner', [VERA]: 'viewer', [ANON]: 'viewer' };
const CLAIMS: Record<string, Record<string, unknown>> = {
  ana: { sub: ANA, email: 'ana@acme.dev', is_anonymous: false },
  vera: { sub: VERA, email: 'vera@acme.dev', is_anonymous: false },
  anon: { sub: ANON, email: null, is_anonymous: true },
};

let simulados: number;
let doble: ReturnType<typeof dbDoble>;

beforeEach(() => {
  simulados = 0;
  doble = dbDoble({
    claims: (tok) => CLAIMS[tok] ?? null,
    tabla: (op: Op): Resp | undefined => {
      if (op.table === 'org_members') return { data: { role: ROL[String(eqDe(op, 'user_id'))] } };
      if (op.table === 'incidents' && op.action === 'select') return { count: simulados };
      if (op.table === 'incidents' && op.action === 'update') return {};
      return undefined;
    },
    rpc: (name) => (name === 'vg_upsert_incident'
      ? { data: [{ id: INC, code: 'S1M0K4', severity: 'critical', prev_severity: null, is_new: true, reopened: false,
        status: 'open', muted_until: null }] } : undefined),
  });
  estado.client = doble.client;
  aviso.fn.mockReset().mockResolvedValue({ whatsapp: 'queued', voice: 'skipped' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const simular = (org: string, o: { tok?: string; body?: unknown } = {}) =>
  app.request(`https://officialvanguard.com/api/orgs/${org}/incidents/simulate`, { method: 'POST',
    headers: { authorization: `Bearer ${o.tok ?? 'ana'}`, 'content-type': 'application/json' },
    body: JSON.stringify(o.body ?? {}) }, envDoble().env);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;
const upserts = () => doble.rpcs.filter((x) => x.name === 'vg_upsert_incident');

describe('E57 · POST /api/orgs/:org/incidents/simulate', () => {
  it('owner de la demo: incidente critical por vg_upsert_incident con IP TEST-NET, simulated y el host de la víctima; avisa una vez', async () => {
    const r = await simular(ORG_DEMO, { body: { kind: 'path_scan' } });
    expect(r.status).toBe(200);
    expect(SimulateAttackOut.parse(await r.json())).toEqual({ incident_id: INC, code: 'S1M0K4', whatsapp: 'queued', voice: 'skipped' });
    expect(upserts()).toHaveLength(1);
    const a = upserts()[0]!.args;
    expect(a).toMatchObject({ p_org: ORG_DEMO, p_conn: null, p_rules: ['CF_PATH_SCAN'], p_severity: 'critical', p_ip: null });
    expect(String(a.p_resource)).toMatch(/^ip:203\.0\.113\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/);
    expect(String(a.p_dedupe)).toMatch(/^[0-9a-f]{64}$/);
    const d = a.p_details as Record<string, unknown>;
    expect(d).toMatchObject({ simulated: true, host: HOST_SIMULADO, ip: String(a.p_resource).slice(3), source: 'ingest' });
    expect(Number(d.n_60s)).toBeGreaterThanOrEqual(40);
    expect(Number(d.n_60s)).toBeLessThanOrEqual(120);
    // event_count creíble (la RPC lo deja en 1 sin edge_hits) y el aviso por el despachador, una vez.
    const up = doble.ops.find((o) => o.table === 'incidents' && o.action === 'update')!;
    expect(eqDe(up, 'id')).toBe(INC);
    expect((up.payload as Record<string, unknown>).event_count).toBe(d.n_60s);
    expect(aviso.fn).toHaveBeenCalledTimes(1);
    expect(aviso.fn.mock.calls[0]!.slice(1, 4)).toEqual([ORG_DEMO, INC, { is_new: true, prev_severity: null, reopened: false }]);
  });

  it('por defecto path_scan; ip_flood y attack_tool usan su regla; un kind desconocido → 422', async () => {
    await simular(ORG_DEMO);
    await simular(ORG_DEMO, { body: { kind: 'ip_flood' } });
    await simular(ORG_DEMO, { body: { kind: 'attack_tool' } });
    expect(upserts().map((x) => x.args.p_rules)).toEqual([['CF_PATH_SCAN'], ['CF_IP_FLOOD'], ['CF_UA_TOOL']]);
    expect(String(upserts()[2]!.args.p_title)).toContain('sqlmap');
    expect((await simular(ORG_DEMO, { body: { kind: 'ddos' } })).status).toBe(422);
  });

  it('viewer y visitante anónimo → 403; otra org (aunque seas owner) → 403; nada se crea ni se avisa', async () => {
    for (const tok of ['vera', 'anon']) {
      const r = await simular(ORG_DEMO, { tok });
      expect(r.status).toBe(403);
      expect((await error(r)).code).toBe('forbidden');
    }
    expect((await simular(OTRA)).status).toBe(403);
    expect(upserts()).toEqual([]);
    expect(aviso.fn).not.toHaveBeenCalled();
  });

  it('otra simulación en los últimos 2 min → 429 sin crear nada; la consulta mira details.simulated y started_at', async () => {
    simulados = 1;
    const r = await simular(ORG_DEMO);
    expect(r.status).toBe(429);
    expect((await error(r)).message).toBe('Espera 2 minutos entre simulaciones');
    expect(upserts()).toEqual([]);
    const op = doble.ops.find((o) => o.table === 'incidents' && o.action === 'select')!;
    expect(op.filters).toContainEqual(['details->>simulated', 'eq', 'true']);
    expect(op.filters.some(([c, o]) => c === 'started_at' && o === 'gte')).toBe(true);
  });

  it('si la RPC falla → 500 y no avisa', async () => {
    doble = dbDoble({ claims: (tok) => CLAIMS[tok] ?? null, tabla: (op) => (op.table === 'org_members'
      ? { data: { role: 'owner' } } : op.table === 'incidents' ? { count: 0 } : undefined),
      rpc: () => ({ error: { code: 'XX000' } }) });
    estado.client = doble.client;
    expect((await simular(ORG_DEMO)).status).toBe(500);
    expect(aviso.fn).not.toHaveBeenCalled();
  });
});
