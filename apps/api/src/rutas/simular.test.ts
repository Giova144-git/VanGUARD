import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, SimulateAttackOut } from '@vanguard/contracts';
import { HOST_SIMULADO } from '@vanguard/core';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const aviso = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../notify/despachador.ts', () => ({ avisarIncidente: aviso.fn }));

const { app } = await import('../app.ts');
const { ORG_DEMO } = await import('./simular.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';     // owner de la demo y de la otra org
const VERA = '7b1e0000-0000-4000-8000-000000000002';    // viewer
const ANON = '7b1e0000-0000-4000-8000-000000000003';    // «Ver demo»
const OTRA = '0f6c0000-0000-4000-8000-000000000002';
const CONN = '5c0e0000-0000-4000-8000-0000000000aa';
const INC = '9e0b0000-0000-4000-8000-000000000001';
const ROL: Record<string, string> = { [ANA]: 'owner', [VERA]: 'viewer', [ANON]: 'viewer' };
const CLAIMS: Record<string, Record<string, unknown>> = {
  ana: { sub: ANA, email: 'ana@acme.dev', is_anonymous: false },
  vera: { sub: VERA, email: 'vera@acme.dev', is_anonymous: false },
  anon: { sub: ANON, email: null, is_anonymous: true },
};

type Fila = Record<string, unknown>;
let simulados: number;
let conexion: Fila | null;
let hits: Fila[];
let escala: number;     // < 1: recorta lo que «ve» la ventana para quedar por debajo del umbral
let tryEval: boolean | null;
let doble: ReturnType<typeof dbDoble>;

// Espejo de vg_edge_window (0006) sobre los edge_hits insertados: lo que la base devolvería al motor.
const PROBE = /^\/(\.env|\.git\/config|wp-login\.php|phpmyadmin|server-status)/;
function ventana(): Fila[] {
  const xs = hits.slice(0, Math.floor(hits.length * escala));
  const porIp = new Map<string, Fila[]>();
  for (const h of xs) porIp.set(String(h.ip), [...(porIp.get(String(h.ip)) ?? []), h]);
  return [...porIp].map(([ip, ys]) => {
    const lat = ys.map((y) => Number(y.latency_ms)).sort((a, b) => a - b);
    const uas = new Map<string, number>();
    for (const y of ys) uas.set(String(y.ua), (uas.get(String(y.ua)) ?? 0) + 1);
    return { ip, n: String(ys.length), total: String(xs.length),
      paths_4xx: String(new Set(ys.filter((y) => y.status === 404 || y.status === 403).map((y) => y.path)).size),
      probe_hits: String(ys.filter((y) => PROBE.test(String(y.path))).length), admin_ok: '0',
      n5xx: String(ys.filter((y) => Number(y.status) >= 500).length),
      p95_ms: lat[Math.min(lat.length - 1, Math.ceil(0.95 * lat.length) - 1)] ?? null,
      ua_top: [...uas].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null };
  });
}

beforeEach(() => {
  simulados = 0;
  conexion = { id: CONN, org_id: ORG_DEMO, label: HOST_SIMULADO, meta: { simulador: true } };
  hits = [];
  escala = 1;
  tryEval = true;
  doble = dbDoble({
    claims: (tok) => CLAIMS[tok] ?? null,
    tabla: (op: Op): Resp | undefined => {
      if (op.table === 'org_members') return { data: { role: ROL[String(eqDe(op, 'user_id'))] } };
      if (op.table === 'incidents' && op.action === 'select' && op.head) return { count: simulados };
      if (op.table === 'incidents' && op.action === 'select') return { data: [] };          // abiertos del motor
      if (op.table === 'connections') return { data: conexion };
      if (op.table === 'edge_hits' && op.action === 'insert') { hits.push(...(op.payload as Fila[])); return {}; }
      return undefined;
    },
    rpc: (name, args) => {
      if (name === 'vg_try_eval') return { data: tryEval };
      if (name === 'vg_edge_window') return { data: ventana() };
      if (name === 'vg_ip_first_seen') return { data: null };
      if (name === 'vg_upsert_incident') {
        return { data: [{ id: INC, code: 'S1M0K4', severity: args.p_severity, prev_severity: null, is_new: true,
          reopened: false, status: 'open', muted_until: null }] };
      }
      return undefined;
    },
  });
  estado.client = doble.client;
  aviso.fn.mockReset().mockResolvedValue({ whatsapp: 'queued', voice: 'queued' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const simular = (org: string, o: { tok?: string; body?: unknown } = {}) =>
  app.request(`https://officialvanguard.com/api/orgs/${org}/incidents/simulate`, { method: 'POST',
    headers: { authorization: `Bearer ${o.tok ?? 'ana'}`, 'content-type': 'application/json' },
    body: JSON.stringify(o.body ?? {}) }, envDoble().env);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;
const upserts = () => doble.rpcs.filter((x) => x.name === 'vg_upsert_incident');

describe('E57 · «Simular ataque» por el motor real', () => {
  it.each([
    ['path_scan', ['CF_PATH_SCAN'], 'high', 'Escaneo de rutas desde 203.0.x.x'],
    ['ip_flood', ['CF_IP_FLOOD'], 'critical', 'Inundación de peticiones desde 203.0.x.x'],
    ['attack_tool', ['CF_UA_TOOL'], 'high', /^Tráfico con (sqlmap|nikto) desde 203\.0\.x\.x$/],
  ] as const)('%s: edge_hits de TEST-NET → la regla del motor decide %j, %s y el título; simulated en details', async (kind, reglas, sev, titulo) => {
    const r = await simular(ORG_DEMO, { body: { kind } });
    expect(r.status).toBe(200);
    expect(SimulateAttackOut.parse(await r.json())).toEqual({ incident_id: INC, code: 'S1M0K4', whatsapp: 'queued', voice: 'queued' });
    // Los eventos pasan por aFila de /ingest: columnas de edge_hits, la conexión del simulador y una sola IP de TEST-NET-3.
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h) => h.ip)).size).toBe(1);
    expect(String(hits[0]!.ip)).toMatch(/^203\.0\.113\.\d{1,3}$/);
    expect(hits.every((h) => h.org_id === ORG_DEMO && h.connection_id === CONN)).toBe(true);
    // Lo decide el motor: vg_try_eval y vg_edge_window, y vg_upsert_incident con lo que salió de evaluateEdge.
    expect(doble.rpcs.map((x) => x.name)).toEqual(expect.arrayContaining(['vg_try_eval', 'vg_edge_window', 'vg_upsert_incident']));
    expect(upserts()).toHaveLength(1);
    const a = upserts()[0]!.args;
    expect(a.p_rules).toEqual(reglas);
    expect(a.p_severity).toBe(sev);
    if (typeof titulo === 'string') expect(a.p_title).toBe(titulo); else expect(String(a.p_title)).toMatch(titulo);
    expect(a.p_conn).toBe(CONN);
    expect(a.p_details).toMatchObject({ simulated: true, host: HOST_SIMULADO, source: 'ingest', ip: hits[0]!.ip });
    expect(aviso.fn).toHaveBeenCalledTimes(1);
  });

  it('por debajo del umbral la regla no se dispara → 422 sin incidente ni aviso', async () => {
    escala = 0.5;
    const r = await simular(ORG_DEMO, { body: { kind: 'ip_flood' } });
    expect(r.status).toBe(422);
    expect((await error(r)).message).toContain('La regla no se disparó');
    expect(upserts()).toEqual([]);
    expect(aviso.fn).not.toHaveBeenCalled();
  });

  it('viewer y visitante anónimo → 403; otra org (aunque seas owner) → 403; nada se escribe ni se avisa', async () => {
    for (const tok of ['vera', 'anon']) {
      const r = await simular(ORG_DEMO, { tok });
      expect(r.status).toBe(403);
      expect((await error(r)).code).toBe('forbidden');
    }
    expect((await simular(OTRA)).status).toBe(403);
    expect(hits).toEqual([]);
    expect(upserts()).toEqual([]);
    expect(aviso.fn).not.toHaveBeenCalled();
  });

  it('otra simulación en 2 min → 429 sin escribir; un kind desconocido → 422', async () => {
    simulados = 1;
    const r = await simular(ORG_DEMO);
    expect(r.status).toBe(429);
    expect((await error(r)).message).toBe('Espera 2 minutos entre simulaciones');
    expect(hits).toEqual([]);
    const op = doble.ops.find((o) => o.table === 'incidents' && o.head)!;
    expect(op.filters).toContainEqual(['details->>simulated', 'eq', 'true']);
    simulados = 0;
    expect((await simular(ORG_DEMO, { body: { kind: 'ddos' } })).status).toBe(422);
  });

  it('sin la conexión del simulador → 409 sin escribir; motor ocupado (vg_try_eval null) → 409', async () => {
    conexion = null;
    expect((await simular(ORG_DEMO)).status).toBe(409);
    expect(hits).toEqual([]);
    conexion = { id: CONN, org_id: ORG_DEMO, label: HOST_SIMULADO, meta: { simulador: true } };
    tryEval = null;
    const r = await simular(ORG_DEMO);
    expect(r.status).toBe(409);
    expect(upserts()).toEqual([]);
  });
});
