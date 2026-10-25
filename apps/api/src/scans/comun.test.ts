import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MsgScan } from '../jobs.ts';
import { dbDoble, type Op } from '../test/db-doble.ts';

// Cable trampa de vg_upsert_findings (15.8 regla 9, hallazgos 16, 19 y 24) con el cliente de supabase-js simulado.
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const { PARECE_SECRETO, TOPE_SUBPETICIONES, conexionActiva, guardarHallazgos, prefiltrar } = await import('./comun.ts');
const { ProviderError } = await import('../lib/http.ts');

const m = { v: 1, kind: 'scan', scan_run_id: '5a1c0000-0000-4000-8000-000000000001', org_id: '0f6c0000-0000-4000-8000-000000000001',
  paso: 'repo' } as MsgScan;
const env = {} as CloudflareBindings;
// Valores con forma de secreto armados en tiempo de ejecución (ningún literal en el repo).
const PAT = ['gh', 'p_', 'A'.repeat(30)].join('');
const JWT = ['eyJ', 'a'.repeat(12), '.eyJ', 'b'.repeat(12), '.'].join('');

type Fila = { rule_id: string; title: string; resource: string; evidence: Record<string, unknown> };
type Llamada = { rows: Fila[]; complete: boolean; ok: boolean };
let llamadas: Llamada[];
let rechazo: (rows: Fila[]) => { code: string } | null;

// La base rechaza (23514) el lote con una fila «MALA» en el título, o con «MALA_EVIDENCIA» en una evidencia sin redactar.
const tripwireBase = (rows: Fila[]) =>
  rows.some((r) => r.title.includes('MALA') && !r.title.includes('MALA_EVIDENCIA') || JSON.stringify(r.evidence).includes('MALA_EVIDENCIA'))
    ? { code: '23514' } : null;

beforeEach(() => {
  llamadas = [];
  rechazo = tripwireBase;
  estado.client = dbDoble({
    rpc: (name, a) => {
      if (name !== 'vg_upsert_findings') return undefined;
      const rows = a.p_rows as Fila[];
      const error = rechazo(rows);
      llamadas.push({ rows, complete: a.p_complete as boolean, ok: !error });
      return error ? { error } : { data: rows.length };
    },
  }).client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const b = (title: string, evidence: Record<string, unknown> = { path: 'src/a.ts' }) =>
  ({ rule_id: 'CB_SECRET_GENERIC', severity: 'high', title, resource: `src/${title}.ts:1`, evidence });

describe('PARECE_SECRETO y prefiltrar', () => {
  it('casa lo mismo que private.looks_like_secret, sin \\b (x_ghp_… y aeyJ….eyJ….)', () => {
    expect(PARECE_SECRETO.test(`x_${PAT}`)).toBe(true);
    expect(PARECE_SECRETO.test(`a${JWT}`)).toBe(true);
    expect(PARECE_SECRETO.test('[SECRET:CB_SECRET_GITHUB_PAT] ghp_…AAAA eyJh…Xk9Q')).toBe(false);
  });

  it('evidencia con forma de secreto → evidence {redacted:true}; en title o resource → se descarta', () => {
    const fila = (title: string, resource: string, evidence: Record<string, unknown>) =>
      ({ rule_id: 'R', severity: 'high', confirmed: true, origin: 'rule' as const, title, resource, evidence, suspected_injection: false, dedupe_key: 'k' });
    const r = prefiltrar([fila('ok', 'a.ts:1', { snippet: 'limpio' }), fila('ev', 'b.ts:1', { snippet: `x_${PAT}` }),
      fila(`t ${JWT}`, 'c.ts:1', {}), fila('res', `d/x_${PAT}`, {})]);
    expect(r.descartadas).toBe(2);
    expect(r.filas.map((x) => [x.title, x.evidence])).toEqual([['ok', { snippet: 'limpio' }], ['ev', { redacted: true }]]);
  });
});

describe('guardarHallazgos', () => {
  it('lote limpio: un solo RPC con p_complete = completo y sin tripwire', async () => {
    const g = await guardarHallazgos(env, m, 'codebase', 'c1', [b('uno'), b('dos')], true);
    expect(g).toEqual({ n: 2, descartadas: 0 });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]).toMatchObject({ complete: true, ok: true });
  });

  it('nunca manda a la base una evidencia que su cable trampa rechazaría', async () => {
    await guardarHallazgos(env, m, 'codebase', 'c1', [b('ev', { snippet: `const t = "x_${PAT}"` })], true);
    expect(llamadas).toHaveLength(1);
    expect(PARECE_SECRETO.test(JSON.stringify(llamadas[0]?.rows[0]?.evidence))).toBe(false);
  });

  it('sin filas y completo: un RPC vacío que auto-verifica', async () => {
    expect(await guardarHallazgos(env, m, 'codebase', 'c1', [], true)).toEqual({ n: 0, descartadas: 0 });
    expect(llamadas).toEqual([{ rows: [], complete: true, ok: true }]);
  });

  it('23514 con ≤ 3 filas: fila por fila; rescata con evidence redactada y descarta la que no cabe; sin auto-verificar', async () => {
    const g = await guardarHallazgos(env, m, 'codebase', 'c1',
      [b('buena'), b('rescatable', { snippet: 'MALA_EVIDENCIA' }), b('MALA')], true);
    expect(g).toEqual({ n: 2, descartadas: 1, error_code: 'tripwire' });
    expect(llamadas.map((l) => l.rows.length)).toEqual([3, 1, 1, 1, 1, 1]);   // lote + buena + rescatable×2 + MALA×2
    expect(llamadas.some((l) => l.complete && l.ok)).toBe(false);
    expect(llamadas[3]?.rows[0]?.evidence).toEqual({ redacted: true });
  });

  it('23514 con más de 3 filas: un solo lote con evidence redactada que auto-verifica en la misma llamada (RPC atómico)', async () => {
    const borradores = [b('a'), b('b'), b('c'), b('d', { snippet: 'MALA_EVIDENCIA' }), b('e')];
    const g = await guardarHallazgos(env, m, 'codebase', 'c1', borradores, true);
    expect(g).toEqual({ n: 5, descartadas: 0 });
    expect(llamadas).toHaveLength(2);
    expect(llamadas[1]?.rows.every((r) => JSON.stringify(r.evidence) === '{"redacted":true}')).toBe(true);
    expect(llamadas[1]).toMatchObject({ complete: true, ok: true });
  });

  it('23514 con más de 3 filas y el secreto en un título: se descarta el lote, tripwire y sin auto-verificar', async () => {
    const g = await guardarHallazgos(env, m, 'codebase', 'c1', [b('a'), b('b'), b('c'), b('MALA'), b('e')], true);
    expect(g).toEqual({ n: 0, descartadas: 5, error_code: 'tripwire' });
    expect(llamadas).toHaveLength(2);
    expect(llamadas.some((l) => l.complete && l.ok)).toBe(false);
  });

  it('un error que no es 23514 (red, 5xx, tope de subpeticiones) lanza ProviderError, no se cuenta como descarte', async () => {
    rechazo = () => ({ code: 'PGRST000' });
    await expect(guardarHallazgos(env, m, 'codebase', 'c1', [b('a')], true)).rejects.toBeInstanceOf(ProviderError);
    let n = 0;
    rechazo = () => (n++ === 0 ? { code: '23514' } : { code: 'FETCH_ERROR' });
    await expect(guardarHallazgos(env, m, 'codebase', 'c1', [b('a')], true)).rejects.toMatchObject({ code: 'unavailable' });
  });

  // Revisión de la ronda 1: el rescate usa lo que de verdad le queda al paso, no un tope fijo de 6 (§A7, hallazgo 24).
  it('presupuesto justo: con 2 filas que fila por fila no caben, va el lote tapado aunque sean ≤ 3', async () => {
    const g = await guardarHallazgos(env, m, 'codebase', 'c1', [b('a'), b('d', { snippet: 'MALA_EVIDENCIA' })], true, undefined, 3);
    expect(g).toEqual({ n: 2, descartadas: 0 });
    expect(llamadas.map((l) => [l.rows.length, l.complete])).toEqual([[2, true], [2, true]]);
    expect(llamadas[1]?.rows.every((r) => JSON.stringify(r.evidence) === '{"redacted":true}')).toBe(true);
  });

  it('presupuesto de 1 (solo el lote): tras el 23514 no gasta más, todo cuenta como descartado y sin auto-verificar', async () => {
    const g = await guardarHallazgos(env, m, 'codebase', 'c1', [b('a'), b('d', { snippet: 'MALA_EVIDENCIA' })], true, undefined, 1);
    expect(g).toEqual({ n: 0, descartadas: 2, error_code: 'tripwire' });
    expect(llamadas).toHaveLength(1);
  });

  it('nunca pasa del presupuesto, sea cual sea el número de filas, completo o no y lo que rechace la base', async () => {
    const siempre = () => ({ code: '23514' });
    const deriva = (rows: Fila[]) => (rows.some((r) => JSON.stringify(r.evidence) !== '{"redacted":true}') ? { code: '23514' } : null);
    for (const regla of [siempre, deriva, tripwireBase]) {
      for (let p = 1; p <= 9; p++) {
        for (let n = 1; n <= 5; n++) {
          for (const completo of [true, false]) {
            llamadas = [];
            rechazo = regla;
            const borradores = Array.from({ length: n }, (_, i) => b(i === 0 ? 'MALA' : `f${i}`, { snippet: 'MALA_EVIDENCIA' }));
            const g = await guardarHallazgos(env, m, 'codebase', 'c1', borradores, completo, undefined, p);
            expect(llamadas.length).toBeLessThanOrEqual(p);
            if (g.descartadas > 0) expect(llamadas.some((l) => l.complete && l.ok)).toBe(false);
            if (regla === deriva && p >= 2) expect(g).toEqual({ n, descartadas: 0 });   // el lote tapado siempre cabe
          }
        }
      }
    }
    expect(TOPE_SUBPETICIONES).toBe(40);
  });

  it('p_rule viaja cuando se pide (CF_ZONE_01)', async () => {
    let args: Record<string, unknown> = {};
    estado.client = dbDoble({ rpc: (_n, a) => { args = a; return {}; } }).client;
    await guardarHallazgos(env, m, 'cloudflare', 'c1', [b('z')], true, 'CF_ZONE_01');
    expect(args.p_rule).toBe('CF_ZONE_01');
  });
});

describe('conexionActiva (varias-codebases B0)', () => {
  it('GitHub: la activa MÁS ANTIGUA (created_at e id ascendentes); los demás proveedores, la más reciente', async () => {
    const ops: Op[] = [];
    estado.client = dbDoble({ tabla: (op) => {
      if (op.table === 'connections') { ops.push(op); return { data: { id: 'c1', meta: {}, capabilities: {} } }; }
      if (op.table === 'scan_runs') return { data: { params: {} } };
      return undefined;
    } }).client;
    await conexionActiva(env, m, 'github');
    await conexionActiva(env, m, 'cloudflare');
    expect(ops[0]!.orden).toEqual([['created_at', true], ['id', true]]);
    expect(ops[0]!.filters).toEqual(expect.arrayContaining([['status', 'eq', 'active'], ['provider', 'eq', 'github']]));
    expect(ops[1]!.orden).toEqual([['created_at', false], ['id', false]]);
  });
});
