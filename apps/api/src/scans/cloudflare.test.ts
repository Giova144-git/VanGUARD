import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MsgScan } from '../jobs.ts';
import { dbDoble, eqDe, type Op } from '../test/db-doble.ts';

// Paso cloudflare (§08.7): CF_ZONE_01, el cable trampa (15.8 regla 9) y coverage.detail.cloudflare.miradas {zona}.
// Sin red: fetch simulado y doble de la base.
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
vi.mock('../lib/credentials.ts', () => ({
  withSecret: async (_e: unknown, _a: unknown, _c: unknown, fn: (t: string) => Promise<unknown>) => fn('tok-de-prueba'),
}));
const { pasoCloudflare, reglasZona, zonaParaAuditar } = await import('./cloudflare.ts');

const ZONA = 'a'.repeat(32);
const CONN = 'c0000000-0000-4000-8000-000000000002';
const m = { v: 1, kind: 'scan', scan_run_id: '5a1c0000-0000-4000-8000-000000000001', org_id: '0f6c0000-0000-4000-8000-000000000001',
  paso: 'cloudflare' } as MsgScan;
const env = {} as CloudflareBindings;
const PAT = ['gh', 'p_', 'A'.repeat(20)].join('');   // armado en tiempo de ejecución: ningún literal con forma de secreto

let conexion: { id: string; meta: Record<string, unknown>; capabilities: Record<string, unknown> } | null;
let cobertura: Record<string, unknown> | null;
let upserts: { rows: { rule_id: string }[]; complete: boolean; rule?: unknown }[];
let zonaResp: { status: number; body?: unknown };
let fetchs: string[];

beforeEach(() => {
  conexion = { id: CONN, meta: { zone_id: ZONA }, capabilities: {} };
  cobertura = { seen: 2, total: 4, missing: ['codebase', 'performance'], detail: { supabase: { miradas: { advisors: true } } } };
  upserts = [];
  zonaResp = { status: 200, body: { result: { name: 'demo.com', status: 'active', paused: false } } };
  fetchs = [];
  estado.client = dbDoble({
    tabla: (op: Op) => {
      if (op.table === 'connections') return { data: conexion };
      if (op.table === 'scan_runs' && op.action === 'update') {
        expect(eqDe(op, 'org_id')).toBe(m.org_id);
        // Escritura condicionada de escribirDetalleModulo: solo si coverage sigue como se leyó.
        const cond = eqDe(op, 'coverage');
        if (cond !== undefined && cond !== JSON.stringify(cobertura)) return { data: [] };
        cobertura = (op.payload as { coverage: Record<string, unknown> }).coverage;
        return { data: [{ id: m.scan_run_id }] };
      }
      if (op.table === 'scan_runs') return { data: { params: {}, coverage: cobertura } };
      return undefined;
    },
    rpc: (name, a) => {
      if (name === 'vg_upsert_findings') {
        upserts.push({ rows: a.p_rows as { rule_id: string }[], complete: a.p_complete as boolean, rule: a.p_rule });
      }
      return {};
    },
  }).client;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetchs.push(new URL(url).pathname);
    return new Response(zonaResp.body === undefined ? 'no' : JSON.stringify(zonaResp.body), { status: zonaResp.status });
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const detalle = () => (cobertura?.detail as Record<string, unknown> | undefined)?.cloudflare;

describe('zonaParaAuditar', () => {
  it('un zone_id mal formado no llega a GET /zones/ (devolvería la lista de zonas)', async () => {
    await expect(zonaParaAuditar('t', '')).rejects.toMatchObject({ code: 'invalid' });
    await expect(zonaParaAuditar('t', '../user')).rejects.toMatchObject({ code: 'invalid' });
    expect(fetchs).toEqual([]);
  });

  it('sin el objeto de la zona en result → invalid, nunca un {} que pase por zona sana', async () => {
    for (const body of [{}, { result: null }, { result: [{ name: 'otra.com' }] }]) {
      zonaResp = { status: 200, body };
      await expect(zonaParaAuditar('t', ZONA)).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it('devuelve la zona y lee solo /zones/{id}', async () => {
    expect(await zonaParaAuditar('t', ZONA)).toEqual({ name: 'demo.com', status: 'active', paused: false });
    expect(fetchs).toEqual([`/client/v4/zones/${ZONA}`]);
  });
});

describe('reglasZona', () => {
  it('CF_ZONE_01 solo con la zona activa y pausada', () => {
    expect(reglasZona({ name: 'demo.com', status: 'active', paused: true }, ZONA).map((f) => f.rule_id)).toEqual(['CF_ZONE_01']);
    expect(reglasZona({ name: 'demo.com', status: 'pending', paused: true }, ZONA)).toEqual([]);
    expect(reglasZona({ name: 'demo.com', status: 'active', paused: false }, ZONA)).toEqual([]);
  });
});

describe('pasoCloudflare', () => {
  it('sin conexión: skipped no_connection y no toca coverage', async () => {
    conexion = null;
    expect(await pasoCloudflare(env, m)).toEqual({ status: 'skipped', error_code: 'no_connection' });
    expect(detalle()).toBeUndefined();
  });

  it('zona sana: done sin hallazgos, auto-verifica CF_ZONE_01 y miradas.zona true sin pisar el detalle de supabase', async () => {
    expect(await pasoCloudflare(env, m)).toEqual({ status: 'done', findings: 0 });
    expect(upserts).toEqual([{ rows: [], complete: true, rule: 'CF_ZONE_01' }]);
    expect(detalle()).toEqual({ miradas: { zona: true } });
    expect(cobertura).toMatchObject({ seen: 2, detail: { supabase: { miradas: { advisors: true } } } });
  });

  it('zona pausada: CF_ZONE_01 guardado y miradas.zona true', async () => {
    zonaResp = { status: 200, body: { result: { name: 'demo.com', status: 'active', paused: true } } };
    expect(await pasoCloudflare(env, m)).toEqual({ status: 'done', findings: 1 });
    expect(upserts).toEqual([{ rows: [expect.objectContaining({ rule_id: 'CF_ZONE_01' })], complete: true, rule: 'CF_ZONE_01' }]);
    expect(detalle()).toEqual({ miradas: { zona: true } });
  });

  it('cable trampa: la fila se descarta, error_code tripwire, sin auto-verificar y miradas.zona false', async () => {
    zonaResp = { status: 200, body: { result: { name: `x_${PAT}`, status: 'active', paused: true } } };   // redact() exige \b
    expect(await pasoCloudflare(env, m)).toEqual({ status: 'done', findings: 0, error_code: 'tripwire' });
    expect(upserts.some((u) => u.complete)).toBe(false);
    expect(detalle()).toEqual({ miradas: { zona: false } });
  });

  it('la zona no se puede leer (403): lanza y no escribe ni hallazgos ni miradas', async () => {
    zonaResp = { status: 403 };
    await expect(pasoCloudflare(env, m)).rejects.toMatchObject({ code: 'forbidden' });
    expect(upserts).toEqual([]);
    expect(detalle()).toBeUndefined();
  });

  it('zone_id corrupto en la conexión: invalid sin llamar a Cloudflare', async () => {
    conexion = { id: CONN, meta: {}, capabilities: {} };
    await expect(pasoCloudflare(env, m)).rejects.toMatchObject({ code: 'invalid' });
    expect(fetchs).toEqual([]);
    expect(detalle()).toBeUndefined();
  });
});
