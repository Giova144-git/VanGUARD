import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ApiError as ApiErrorBody, Overview, Severity } from '@vanguard/contracts';
import { score } from '@vanguard/core';
import type { AppEnv } from '../env.ts';
import { cumpleFiltros, dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { overview } = await import('./overview.ts');
const { errorHandler } = await import('../mw/error.ts');

const ORG = '0f6c0000-0000-4000-8000-000000000001';
const env = {} as CloudflareBindings;
const app = new Hono<AppEnv>();
app.use(async (c, next) => { c.set('rid', 'r1'); c.set('orgId', ORG); await next(); });
app.onError(errorHandler);
app.route('/api', overview);

let n = 0;
const uuid = () => `9e0b0000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
let tabla: (op: Op) => Resp | undefined;
let doble: ReturnType<typeof dbDoble>;
beforeEach(() => {
  tabla = () => undefined;
  doble = dbDoble({
    tabla: (op) => {
      const r = tabla(op);
      if (r) return r;
      // Cobertura 4 de 4 (calcularCobertura): pasos correctos y una medición de Rendimiento.
      if (op.table === 'scan_runs' && op.columns === 'steps') {
        return { data: [{ steps: [{ name: 'supabase', status: 'done' }, { name: 'cloudflare', status: 'done' }, { name: 'repo', status: 'done' }] }] };
      }
      if (op.table === 'perf_runs') return { count: 1 };
      return undefined;
    },
    rpc: () => ({ data: { enabled: true, level: 'normal' } }),
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const incidente = () => ({ id: uuid(), rule_ids: ['CF_PATH_SCAN'], severity: 'high', title: 'Escaneo de rutas', resource: 'ip:198.51.100.9' });
const fila = (module: string, severity: string, confirmed = false) => ({ module, severity, confirmed });
const pedir = () => app.request(`/api/orgs/${ORG}/overview`, {}, env);
const esPuntaje = (op: Op) => op.table === 'findings' && op.columns === 'module, severity, confirmed';
const esTop = (op: Op) => op.table === 'findings' && !op.head && op.columns?.startsWith('id, module, rule_id');
const sevDe = (op: Op) => eqDe(op, 'severity') as string | undefined;

// ── Hallazgo 21: open_incidents y counts exactos; puntaje sobre todos los open ───────────────────────────────────────
describe('#21 · E5 cuenta todo lo abierto, no las 10 filas de «ahora»', () => {
  it('open_incidents = count exacto de open/ack aunque «ahora» solo lleve 10', async () => {
    tabla = (op) => {
      if (op.table === 'incidents' && op.head) return { count: 37 };
      if (op.table === 'incidents') return { data: Array.from({ length: 10 }, incidente) };
      return undefined;
    };
    const r = await pedir();
    expect(r.status).toBe(200);
    const b = Overview.parse(await r.json());
    expect(b.open_incidents).toBe(37);
    expect(b.ahora).toHaveLength(10);
    const cnt = doble.ops.find((o) => o.table === 'incidents' && o.head)!;
    expect(eqDe(cnt, 'org_id')).toBe(ORG);
    expect(cnt.filters).toContainEqual(['status', 'in', ['open', 'ack']]);
  });

  it('counts = count exacto por severidad y el puntaje sale de todos los open (no de 500 ni de 10)', async () => {
    // 600 low de codebase + 3 critical confirmados de supabase + 30 medium de cloudflare.
    const todos = [...Array.from({ length: 600 }, () => fila('codebase', 'low')), ...Array.from({ length: 3 }, () => fila('supabase', 'critical', true)),
      ...Array.from({ length: 30 }, () => fila('cloudflare', 'medium'))];
    const exactos: Record<string, number> = { critical: 3, high: 0, medium: 30, low: 2400, info: 7 };
    tabla = (op) => {
      if (esPuntaje(op)) return { data: todos };
      if (op.table === 'findings' && op.head) return { count: exactos[sevDe(op) ?? ''] ?? 0 };
      if (esTop(op)) return { data: Array.from({ length: 10 }, () => ({ id: uuid(), module: 'supabase', rule_id: 'SB_RLS_DISABLED',
        severity: 'critical', confirmed: true, title: 'RLS desactivada', resource: 'public.pedidos' })) };
      return undefined;
    };
    const b = Overview.parse(await (await pedir()).json());
    expect(b.counts).toEqual(exactos);
    expect(b.score).toBe(score(todos as Parameters<typeof score>[0]).score);
    expect(b.band).toBe('red');
    expect(b.coverage).toEqual({ seen: 4, total: 4, missing: [] });
    expect(b.ahora).toHaveLength(10);
    // Un head por severidad, todos sobre los open de la org.
    const heads = doble.ops.filter((o) => o.table === 'findings' && o.head);
    expect(heads.map(sevDe).sort()).toEqual([...Severity.options].sort());
    for (const h of heads) { expect(eqDe(h, 'org_id')).toBe(ORG); expect(eqDe(h, 'status')).toBe('open'); }
    const p = doble.ops.find(esPuntaje)!;
    expect(eqDe(p, 'org_id')).toBe(ORG);
    expect(eqDe(p, 'status')).toBe('open');
  });

  it('si falla un count (incidentes o severidad) → 500 internal, nunca cifras inventadas', async () => {
    tabla = (op) => (op.table === 'incidents' && op.head ? { error: { code: '57014' } } : undefined);
    let r = await pedir();
    expect(r.status).toBe(500);
    expect(ApiErrorBody.parse(await r.json()).error.code).toBe('internal');

    tabla = (op) => (op.table === 'findings' && op.head && sevDe(op) === 'low' ? { error: { code: 'PGRST000' } } : undefined);
    r = await pedir();
    expect(r.status).toBe(500);
  });
});

// ── «Medir ahora» no es una auditoría: last_scan sale de la última auditoría, no de la medición más nueva ─────────────
describe('E5 · last_scan salta las mediciones de Rendimiento (kind lighthouse)', () => {
  const AUDITORIA = '5a1c0000-0000-4000-8000-0000000000a1';
  const MEDICION = '5a1c0000-0000-4000-8000-0000000000a2';
  const scansDe = () => [
    { id: MEDICION, org_id: ORG, kind: 'lighthouse', status: 'succeeded', created_at: '2026-10-24T12:00:00+00:00',
      finished_at: '2026-10-24T12:00:50+00:00' },
    { id: AUDITORIA, org_id: ORG, kind: 'full_audit', status: 'succeeded', created_at: '2026-10-24T10:00:00+00:00',
      finished_at: '2026-10-24T10:05:00+00:00' },
  ];

  it('una medición más nueva que la auditoría no se vuelve «Última auditoría» (ni marca «Audita todo»)', async () => {
    tabla = (op) => {
      if (op.table !== 'scan_runs' || op.columns !== 'id, status, finished_at') return undefined;
      const casan = scansDe().filter((s) => cumpleFiltros(s, op)).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { data: casan[0] ?? null };
    };
    const b = Overview.parse(await (await pedir()).json());
    expect(b.last_scan).toEqual({ id: AUDITORIA, status: 'succeeded', finished_at: '2026-10-24T10:05:00.000Z' });
    const op = doble.ops.find((o) => o.table === 'scan_runs' && o.columns === 'id, status, finished_at')!;
    expect(op.filters).toContainEqual(['kind', 'neq', 'lighthouse']);
  });

  it('sin auditorías, solo mediciones → last_scan null', async () => {
    tabla = (op) => {
      if (op.table !== 'scan_runs' || op.columns !== 'id, status, finished_at') return undefined;
      return { data: scansDe().filter((s) => s.kind === 'lighthouse' && cumpleFiltros(s, op))[0] ?? null };
    };
    expect(Overview.parse(await (await pedir()).json()).last_scan).toBeNull();
  });
});

// ── Revisión de UX (ux-revision-develop.md P0-1, P0-2, P0-4 y P0-3): lo que la web necesita para no prometer de más ──
describe('E5 · last_ok_scan, module_checks, last_ingest_at y preview', () => {
  const BUENA = '5a1c0000-0000-4000-8000-0000000000b1';
  const APP = 'c0000000-0000-4000-8000-0000000000a1';
  const SIM = 'c0000000-0000-4000-8000-0000000000a2';
  const esBuena = (op: Op) => op.table === 'scan_runs' && op.columns === 'id, steps, finished_at';
  let hitsDe: string[];
  beforeEach(() => {
    hitsDe = [];
    tabla = (op) => {
      if (esBuena(op)) {
        return { data: { id: BUENA, finished_at: '2026-10-25T08:00:00+00:00', steps: [{ name: 'supabase', status: 'done' },
          { name: 'cloudflare', status: 'skipped' }, { name: 'repo', status: 'failed' }, { name: 'resumen_ia', status: 'done' }] } };
      }
      if (op.table === 'connections') return { data: [{ id: APP, meta: {} }, { id: SIM, meta: { simulador: true } }] };
      if (op.table === 'edge_hits') {
        hitsDe = (op.filters.find(([c, o]) => c === 'connection_id' && o === 'in')?.[2] ?? []) as string[];
        return { data: { ts: '2026-10-25T08:30:00+00:00' } };
      }
      return undefined;
    };
  });

  it('la última full_audit TERMINADA y lo que miró cada módulo en ella (done, sin_revisar, fallido)', async () => {
    const b = Overview.parse(await (await pedir()).json());
    expect(b.last_ok_scan).toEqual({ id: BUENA, finished_at: '2026-10-25T08:00:00.000Z' });
    expect(b.module_checks).toEqual({ supabase: 'done', cloudflare: 'sin_revisar', codebase: 'fallido' });
    const op = doble.ops.find(esBuena)!;
    expect(op.filters).toEqual(expect.arrayContaining([['kind', 'eq', 'full_audit'], ['status', 'eq', 'succeeded']]));
  });

  it('sin auditoría terminada: last_ok_scan null y todos los módulos sin_revisar', async () => {
    const previa = tabla;
    tabla = (op) => (esBuena(op) ? { data: null } : previa(op));
    const b = Overview.parse(await (await pedir()).json());
    expect(b.last_ok_scan).toBeNull();
    expect(b.module_checks).toEqual({ supabase: 'sin_revisar', cloudflare: 'sin_revisar', codebase: 'sin_revisar' });
  });

  it('last_ingest_at: el último edge_hit de la app, sin la conexión del simulador; sin ingesta → null sin consulta', async () => {
    let b = Overview.parse(await (await pedir()).json());
    expect(b.last_ingest_at).toBe('2026-10-25T08:30:00.000Z');
    expect(hitsDe).toEqual([APP]);
    const previa = tabla;
    tabla = (op) => (op.table === 'connections' ? { data: [{ id: SIM, meta: { simulador: true } }] }
      : op.table === 'edge_hits' ? { data: { ts: 'x' } } : previa(op));
    doble.ops.length = 0;
    b = Overview.parse(await (await pedir()).json());
    expect(b.last_ingest_at).toBeNull();
    expect(doble.ops.some((o) => o.table === 'edge_hits')).toBe(false);
  });

  it('preview: sin la cola (vista previa) true; con JOBS_Q en producción false', async () => {
    expect(Overview.parse(await (await pedir()).json()).preview).toBe(true);
    const prod = { VG_ENV: 'production', JOBS_Q: { send: async () => {} } } as unknown as CloudflareBindings;
    const r = await app.request(`/api/orgs/${ORG}/overview`, {}, prod);
    expect(Overview.parse(await r.json()).preview).toBe(false);
  });
});

// Varias codebases (asignaciones/varias-codebases.md §2.4, B4): el repo de cada hallazgo de «ahora» viaja por
// connection_id (null si no tiene); los incidentes no llevan el campo. Puntaje y counts, agregados como siempre.
describe('E5 · connection_id en «ahora» (varias-codebases B4)', () => {
  it('hallazgo con su conexión, hallazgo sin conexión (ZIP o repo quitado) → null; incidente → sin campo', async () => {
    const REPO_1 = 'c0000000-0000-4000-8000-000000000001';
    const REPO_2 = 'c0000000-0000-4000-8000-000000000007';
    const top = [
      { id: uuid(), module: 'codebase', rule_id: 'CB_DEP_VULN', severity: 'high', confirmed: false, title: 'lodash',
        resource: 'npm:lodash@4.17.15', connection_id: REPO_1 },
      { id: uuid(), module: 'codebase', rule_id: 'CB_DEP_VULN', severity: 'high', confirmed: false, title: 'lodash',
        resource: 'npm:lodash@4.17.15', connection_id: REPO_2 },
      { id: uuid(), module: 'codebase', rule_id: 'CB_ENV_COMMITTED', severity: 'high', confirmed: false, title: '.env',
        resource: 'zip:proyecto.zip/.env', connection_id: null },
    ];
    tabla = (op) => {
      if (op.table === 'incidents' && !op.head) return { data: [incidente()] };
      if (esTop(op)) return { data: top };
      return undefined;
    };
    const r = await pedir();
    const crudo = await r.json() as { ahora: Record<string, unknown>[] };   // tal cual sale, antes de que zod quite nada
    const b = Overview.parse(crudo);
    expect(b.ahora.map((a) => a.kind)).toEqual(['incident', 'finding', 'finding', 'finding']);
    expect('connection_id' in crudo.ahora[0]!).toBe(false);
    expect(crudo.ahora.slice(1).map((a) => a.connection_id)).toEqual([REPO_1, REPO_2, null]);
    expect(doble.ops.find(esTop)!.columns).toContain('connection_id');
  });
});
