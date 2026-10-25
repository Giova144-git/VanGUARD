// E13h y E13t (historial de fallas, 0025_historial_hallazgos.sql): filtros, orden, la org de la sesión, la línea de tiempo
// con la cola de la IA y las fotos, y que /findings/history no cae en E13b.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingHistoryItem, FindingTimeline } from '@vanguard/contracts';
import { cumpleFiltros, dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const { app } = await import('../app.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const F = 'c3d40000-0000-4000-8000-000000000001';
const fila = (o: Record<string, unknown> = {}) => ({ id: F, module: 'supabase', rule_id: 'SB_RLS_DISABLED', severity: 'critical',
  title: 'RLS apagada', resource: 'public.pedidos', status: 'open', status_reason: 'reapareció', connection_id: null,
  first_seen_at: '2026-10-21T18:03:20+00:00', last_seen_at: '2026-10-24T18:02:05+00:00', fixed_at: null, verified_at: null,
  ignored_at: null, reopened_at: '2026-10-24T18:02:05+00:00', reopen_count: 1, status_changed_at: '2026-10-24T18:02:05+00:00',
  org_id: ORG, ...o });

let tabla: (op: Op) => Resp | undefined;
let doble: ReturnType<typeof dbDoble>;

beforeEach(() => {
  tabla = () => undefined;
  doble = dbDoble({
    tabla: (op) => tabla(op) ?? (op.table === 'org_members' ? { data: { role: 'viewer' } } : undefined),
    claims: (t) => (t === 'ok' ? { sub: ANA, email: 'ana@acme.dev', is_anonymous: false, role: 'authenticated' } : null),
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const pedir = (ruta: string) => app.request(`https://officialvanguard.com/api/orgs/${ORG}${ruta}`,
  { headers: { authorization: 'Bearer ok', origin: 'https://officialvanguard.com' } }, envDoble().env);
const consultas = (t: string) => doble.ops.filter((o) => o.table === t);

describe('E13h · GET findings/history', () => {
  it('todas las de la org, del último cambio al más viejo, con horas en Z y changed_at', async () => {
    tabla = (op) => (op.table === 'findings' ? { data: [fila()] } : undefined);
    const r = await pedir('/findings/history');
    expect(r.status).toBe(200);
    const [x] = (await r.json()) as unknown[];
    const item = FindingHistoryItem.parse(x);
    expect(item).toMatchObject({ changed_at: '2026-10-24T18:02:05.000Z', reopened_at: '2026-10-24T18:02:05.000Z', reopen_count: 1 });
    expect(x).not.toHaveProperty('org_id');
    expect(x).not.toHaveProperty('status_changed_at');
    const [op] = consultas('findings');
    expect(eqDe(op!, 'org_id')).toBe(ORG);
    expect(op!.orden).toEqual([['status_changed_at', false], ['id', true]]);
    expect(op!.columns).not.toMatch(/evidence|fix_prompt/);
  });

  it('filtros: estado, módulo, severidad, días (por el último cambio) y orden ascendente', async () => {
    tabla = (op) => (op.table === 'findings' ? { data: [] } : undefined);
    expect((await pedir('/findings/history?status=verified&module=codebase&severity=high&days=30&order=asc')).status).toBe(200);
    const [op] = consultas('findings');
    expect([eqDe(op!, 'status'), eqDe(op!, 'module'), eqDe(op!, 'severity')]).toEqual(['verified', 'codebase', 'high']);
    const desde = op!.filters.find(([c, o]) => c === 'status_changed_at' && o === 'gte')?.[2] as string;
    expect(Math.abs(Date.parse(desde) - (Date.now() - 30 * 86_400_000))).toBeLessThan(5_000);
    expect(op!.orden?.[0]).toEqual(['status_changed_at', true]);
  });

  it('un filtro fuera de contrato → 422 con su campo, sin consultar', async () => {
    for (const [q, campo] of [['status=abierta', 'status'], ['module=x', 'module'], ['severity=grave', 'severity'],
      ['days=0', 'days'], ['days=1e1', 'days'], ['limit=900', 'limit'], ['order=random', 'order']] as const) {
      const r = await pedir(`/findings/history?${q}`);
      expect(r.status, q).toBe(422);
      const b = (await r.json()) as { error: { details: { field_errors: Record<string, string[]> } } };
      expect(Object.keys(b.error.details.field_errors), q).toEqual([campo]);
    }
    expect(consultas('findings')).toEqual([]);
  });

  it('un error de la base → 500 sin filtrar el detalle', async () => {
    tabla = (op) => (op.table === 'findings' ? { error: { code: '42703', message: 'column findings.fixed_at does not exist' } } : undefined);
    const r = await pedir('/findings/history');
    expect(r.status).toBe(500);
    expect(await r.text()).not.toMatch(/fixed_at/);
  });
});

describe('E13t · GET findings/:id/timeline', () => {
  it('la fila, su cola de la IA y las fotos: detectada, salió, enviada, reapareció', async () => {
    const fotos = [
      { org_id: ORG, taken_at: '2026-10-22T18:02:50+00:00', new_ids: [], fixed_ids: [F] },
      { org_id: ORG, taken_at: '2026-10-24T18:04:11+00:00', new_ids: [F], fixed_ids: [] },
    ];
    tabla = (op) => {
      if (op.table === 'findings') return { data: eqDe(op, 'org_id') === ORG && eqDe(op, 'id') === F ? fila() : null };
      if (op.table === 'fix_requests') return { data: [{ id: 'f1c00000-0000-4000-8000-000000000001', finding_id: F, status: 'arreglando',
        client: 'claude_code', created_at: '2026-10-24T19:30:00+00:00', started_at: '2026-10-24T19:31:10+00:00', closed_at: null }] };
      if (op.table === 'audit_snapshots') return { data: fotos.filter((s) => cumpleFiltros(s, op)) };
      return undefined;
    };
    const r = await pedir(`/findings/${F}/timeline`);
    expect(r.status).toBe(200);
    const t = FindingTimeline.parse(await r.json());
    expect(t.events.map((e) => e.kind)).toEqual(['detectado', 'salio', 'reaparecido', 'visto', 'enviado_ia', 'arreglando']);
    expect(t.events.find((e) => e.kind === 'reaparecido')!.at).toBe('2026-10-24T18:02:05.000Z');
    for (const t2 of ['fix_requests', 'audit_snapshots']) for (const op of consultas(t2)) expect(eqDe(op, 'org_id'), t2).toBe(ORG);
    expect(consultas('audit_snapshots').map((o) => o.filters.find(([, x]) => x === 'cs'))).toEqual([['new_ids', 'cs', [F]], ['fixed_ids', 'cs', [F]]]);
  });

  it('si la cola o las fotos fallan, sale la línea con lo de la fila', async () => {
    tabla = (op) => (op.table === 'findings' ? { data: fila({ reopened_at: null, reopen_count: 0, status_reason: null }) }
      : op.table === 'org_members' ? undefined : { error: { code: '57014' } });
    const t = FindingTimeline.parse(await (await pedir(`/findings/${F}/timeline`)).json());
    expect(t.events.map((e) => e.kind)).toEqual(['detectado', 'visto']);
  });

  it('id que no es uuid, o de otra org → el mismo 404', async () => {
    tabla = (op) => (op.table === 'findings' ? { data: null } : undefined);
    expect((await pedir('/findings/no-es-uuid/timeline')).status).toBe(404);
    expect((await pedir(`/findings/${F}/timeline`)).status).toBe(404);
  });
});
