import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, fixtures, PerfRunExt } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// E24 · GET /api/orgs/:org/perf/runs (sin red: doble de la base con las filas del fixture del contrato).
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { app } = await import('../app.ts');
const { MAX_PERF } = await import('./perf.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const OTRA_ORG = '0f6c0000-0000-4000-8000-000000000002';

// Filas tal como las devuelve Postgres: fechas con +00:00 y columnas de más que el contrato no lleva (diagnosis no se pide).
const filas = () => fixtures.perfRuns.map((r) => ({ ...r, created_at: r.created_at.replace('Z', '+00:00'), is_representative: false }));
let resp: Resp;
let doble: ReturnType<typeof dbDoble>;
beforeEach(() => {
  resp = { data: filas() };
  doble = dbDoble({
    tabla: (op: Op): Resp | undefined => {
      if (op.table === 'org_members') return { data: eqDe(op, 'org_id') === ORG ? { role: 'viewer' } : null };
      if (op.table === 'perf_runs') return resp;
      return undefined;
    },
    claims: (tok) => (tok === 'ana' ? { sub: ANA, email: 'ana@acme.dev', is_anonymous: false } : null),
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const pedir = (q = '', org = ORG) =>
  app.request(`https://officialvanguard.com/api/orgs/${org}/perf/runs${q}`, { headers: { authorization: 'Bearer ana' } }, envDoble().env);
const consulta = () => doble.ops.filter((o) => o.table === 'perf_runs').at(-1)!;

describe('E24 · GET /api/orgs/:org/perf/runs', () => {
  it('el viewer lee las repeticiones válidas según PerfRunExt, con run_group, rep y version_label, filtradas por su org', async () => {
    const r = await pedir('?limit=30');
    expect(r.status).toBe(200);
    const runs = PerfRunExt.array().parse(await r.json());
    expect(runs).toHaveLength(fixtures.perfRuns.length);
    expect(runs[0]).toMatchObject({ run_group: fixtures.perfRuns[0]!.run_group, rep: fixtures.perfRuns[0]!.rep,
      version_label: fixtures.perfRuns[0]!.version_label, created_at: fixtures.perfRuns[0]!.created_at });
    expect(runs.every((x) => !('diagnosis' in x))).toBe(true);
    expect(eqDe(consulta(), 'org_id')).toBe(ORG);
    expect(consulta().columns).not.toMatch(/diagnosis|field/);
  });

  it('filtros url y strategy van a la consulta', async () => {
    const url = fixtures.perfRuns[0]!.url;
    await pedir(`?url=${encodeURIComponent(url)}&strategy=mobile&limit=5`);
    expect(eqDe(consulta(), 'url')).toBe(url);
    expect(eqDe(consulta(), 'strategy')).toBe('mobile');
  });

  it(`limit fuera de 1–${MAX_PERF}, strategy rara o url vacía → 422 con field_errors y sin consultar`, async () => {
    for (const q of ['?limit=0', '?limit=31', '?limit=abc', '?strategy=tablet', '?url=']) {
      const r = await pedir(q);
      expect(r.status, q).toBe(422);
      expect(ApiErrorBody.parse(await r.json()).error.details?.field_errors, q).toBeTruthy();
    }
    expect(doble.ops.some((o) => o.table === 'perf_runs')).toBe(false);
  });

  it('una fila sin alguna métrica sale con null; una fuera de contrato se descarta sin tumbar la lista', async () => {
    const [a, b] = filas();
    resp = { data: [{ ...a, metrics: { lcp_ms: 900 } }, { ...b, strategy: 'tablet' }] };
    const runs = PerfRunExt.array().parse(await (await pedir()).json());
    expect(runs).toHaveLength(1);
    expect(runs[0]!.metrics).toMatchObject({ lcp_ms: 900, tbt_ms: null, cls: null, fcp_ms: null, si_ms: null, ttfb_ms: null });
  });

  it('error de la base → 500 sin el texto de Postgres; quien no es miembro → 404; sin sesión → 401', async () => {
    resp = { error: { code: '57014', message: 'canceling statement due to statement timeout' } } as unknown as Resp;
    const r = await pedir();
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('statement');
    expect((await pedir('', OTRA_ORG)).status).toBe(404);
    expect((await app.request(`https://officialvanguard.com/api/orgs/${ORG}/perf/runs`, {}, envDoble().env)).status).toBe(401);
  });
});
