import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluarSupabase, MAX_LINTS_POR_ADVISOR, redact, SQL1, SQL2, type LintAdvisor } from '@vanguard/core';
import type { MsgScan } from '../jobs.ts';
import { dbDoble, type Op } from '../test/db-doble.ts';

// Paso supabase (§07.5, F4 de la revisión del hito 3: hallazgos 10, 11 y 14) y mgmt() sin red: fetch simulado y doble
// de la base. coverage.detail.supabase.miradas = lo que de verdad se miró.
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
vi.mock('../lib/credentials.ts', () => ({
  withSecret: async (_e: unknown, _a: unknown, _c: unknown, fn: (t: string) => Promise<unknown>) => fn('tok-de-prueba'),
}));
const { pasoSupabase, mgmt, leerAdvisor, recortarLints, MAX_RESPUESTA, TOPE_BORRADORES, TOPE_LINTS_MIN } = await import('./supabase.ts');
const { ProviderError } = await import('../lib/http.ts');

const REF = 'abcdefghijklmnopqrst';
const CONN = 'c0000000-0000-4000-8000-000000000001';
const m = { v: 1, kind: 'scan', scan_run_id: '5a1c0000-0000-4000-8000-000000000001', org_id: '0f6c0000-0000-4000-8000-000000000001',
  paso: 'supabase' } as MsgScan;
const env = {} as CloudflareBindings;
const PAT = ['gh', 'p_', 'A'.repeat(20)].join('');   // armado en tiempo de ejecución: ningún literal con forma de secreto

// Respuesta por fuente: un número es ese status sin cuerpo útil; otra cosa, el JSON con 200 (advisors) o 201 (SQL).
type Fuente = 'sec' | 'perf' | 's1' | 's2' | 's3';
let resp: Record<Fuente, unknown>;
let llamadas: Fuente[];
let capacidades: Record<string, unknown>;
let cobertura: Record<string, unknown> | null;
let upserts: { rows: { rule_id: string }[]; complete: boolean; rule?: string }[];
let doble: ReturnType<typeof dbDoble>;

const lint = (name: string, i: number, level = 'WARN') => ({ name, level, title: 'Lint', categories: ['SECURITY'],
  cache_key: `${name}_${i}`, metadata: { schema: 'public', name: `t${i}`, type: 'table' } });
const SANO: Record<Fuente, unknown> = { sec: { lints: [] }, perf: { lints: [] }, s1: [], s2: [], s3: [] };

beforeEach(() => {
  resp = { ...SANO };
  llamadas = [];
  capacidades = {};
  cobertura = { seen: 1, total: 4, missing: [], detail: { codebase: { miradas: { secretos: true } } } };
  upserts = [];
  doble = dbDoble({
    tabla: (op: Op) => {
      if (op.table === 'connections') return { data: { id: CONN, meta: { project_ref: REF }, capabilities: capacidades } };
      if (op.table === 'scan_runs' && op.action === 'update') {
        // Escritura condicionada de escribirDetalleModulo: solo si coverage sigue como se leyó.
        const cond = op.filters.find(([c]) => c === 'coverage');
        if (cond && cond[2] !== JSON.stringify(cobertura)) return { data: [] };
        cobertura = (op.payload as { coverage: Record<string, unknown> }).coverage;
        return { data: [{ id: m.scan_run_id }] };
      }
      if (op.table === 'scan_runs') return { data: { params: {}, coverage: cobertura } };
      return undefined;
    },
    rpc: (name, a) => {
      if (name === 'vg_upsert_findings') {
        upserts.push({ rows: a.p_rows as { rule_id: string }[], complete: a.p_complete as boolean,
          ...(a.p_rule ? { rule: a.p_rule as string } : {}) });
      }
      return {};
    },
  });
  estado.client = doble.client;
  vi.stubGlobal('fetch', vi.fn(responder));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
async function responder(url: string, init: RequestInit) {
  const ruta = new URL(url).pathname;
  let k: Fuente;
  if (ruta.endsWith('/advisors/security')) k = 'sec';
  else if (ruta.endsWith('/advisors/performance')) k = 'perf';
  else {
    const q = (JSON.parse(String(init.body)) as { query: string }).query;
    k = q === SQL1 ? 's1' : q === SQL2 ? 's2' : 's3';
  }
  llamadas.push(k);
  const v = resp[k];
  return typeof v === 'number' ? new Response('no', { status: v })
    : new Response(typeof v === 'string' ? v : JSON.stringify(v), { status: k.startsWith('s') ? 201 : 200 });
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

const detalle = () => (cobertura?.detail as Record<string, Record<string, unknown>> | undefined)?.supabase;
// Lote de hallazgos (sin p_rule) y auto-verificaciones por regla (p_rule, sin filas y con p_complete).
const lotes = () => upserts.filter((u) => !u.rule);
const verificadas = () => {
  const v = upserts.filter((u) => u.rule);
  expect(v.every((u) => u.complete && u.rows.length === 0)).toBe(true);
  return v.map((u) => u.rule).sort();
};
const SQL_TODAS = ['SB_POLICY_ALLOW_ALL', 'SB_RLS_DISABLED', 'SB_RPC_ANON_NO_LIMIT'];

describe('mgmt', () => {
  it('ProviderError invalid de pedir() (redirección a otro host) no se reintenta', async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://otro.example.com/v1' } }));
    vi.stubGlobal('fetch', f);
    const e = await mgmt('t', REF, '/advisors/security').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as InstanceType<typeof ProviderError>).code).toBe('invalid');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it(`una respuesta de más de ${MAX_RESPUESTA} bytes es invalid sin reintentar; justo en el tope, se parsea`, async () => {
    expect(MAX_RESPUESTA).toBeLessThanOrEqual(1_000_000);   // 2 × 1,95 MB ≈ 12 ms de CPU: pasa de los 10 de Free
    const cuerpo = (k: number) => `{"lints":[${'"x",'.repeat(k)}"x"]}`;   // 15 + 4k bytes
    const k = Math.floor((MAX_RESPUESTA - 15) / 4);
    expect(cuerpo(k).length).toBeLessThanOrEqual(MAX_RESPUESTA);
    expect(cuerpo(k + 1).length).toBeGreaterThan(MAX_RESPUESTA);
    const f = vi.fn(async () => new Response(cuerpo(k + 1), { status: 200 }));
    vi.stubGlobal('fetch', f);
    await expect(mgmt('t', REF, '/advisors/security')).rejects.toMatchObject({ code: 'invalid' });
    expect(f).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(cuerpo(k), { status: 200 })));
    expect(((await mgmt('t', REF, '/advisors/security')) as { lints: string[] }).lints).toHaveLength(k + 1);
  });

  // Cuerpo que cuenta lo que se le pide: trozos de 64 KB de '[' sin fin (nunca acaba si nadie corta).
  const sinFin = () => {
    const leido = { trozos: 0, cancelado: false };
    const trozo = new TextEncoder().encode('['.repeat(65_536));
    const body = new ReadableStream<Uint8Array>({
      pull(c) { leido.trozos++; c.enqueue(trozo); },
      cancel() { leido.cancelado = true; },
    }, { highWaterMark: 0 });
    return { leido, body };
  };

  it('Content-Length por encima del tope: invalid sin leer el cuerpo', async () => {
    const { leido, body } = sinFin();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(body, { status: 200, headers: { 'Content-Length': String(MAX_RESPUESTA + 1) } })));
    await expect(mgmt('t', REF, '/advisors/security')).rejects.toMatchObject({ code: 'invalid' });
    expect(leido).toEqual({ trozos: 0, cancelado: true });
  });

  it('sin Content-Length, la lectura se corta al pasar del tope (no decodifica la respuesta entera)', async () => {
    const { leido, body } = sinFin();
    const f = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', f);
    await expect(mgmt('t', REF, '/advisors/security')).rejects.toMatchObject({ code: 'invalid' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(leido.cancelado).toBe(true);
    expect(leido.trozos).toBeLessThanOrEqual(Math.ceil(MAX_RESPUESTA / 65_536) + 2);
  });

  it('un error de red sí se reintenta hasta 3 veces', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => { throw new TypeError('fetch failed'); });
    vi.stubGlobal('fetch', f);
    const p = mgmt('t', REF, '/advisors/security').catch((x: unknown) => x);
    await vi.runAllTimersAsync();
    expect(((await p) as InstanceType<typeof ProviderError>).code).toBe('unavailable');
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe('leerAdvisor', () => {
  it('advisor_check_unavailable y project_not_active dejan el advisor sin mirar; lints sin array es invalid', () => {
    expect(leerAdvisor({ ok: true, v: { lints: [lint('advisor_check_unavailable', 1)] } }, 'security'))
      .toEqual({ ok: false, code: 'advisor_check_unavailable' });
    expect(leerAdvisor({ ok: true, v: { lints: [lint('project_not_active', 1)] } }, 'performance'))
      .toEqual({ ok: false, code: 'project_not_active' });
    expect(leerAdvisor({ ok: true, v: {} }, 'security')).toEqual({ ok: false, code: 'invalid' });
    expect(leerAdvisor({ ok: true, v: null }, 'security')).toEqual({ ok: false, code: 'invalid' });
    expect(leerAdvisor({ ok: false, code: 'forbidden' }, 'security')).toEqual({ ok: false, code: 'forbidden' });
  });

  it('cuenta lints distintos: copias del mismo cache_key, nombres que evalAdvisors salta o sin cache_key no gastan el tope', () => {
    const copias = Array.from({ length: 250 }, () => lint('auth_rls_initplan', 1));
    const r = leerAdvisor({ ok: true, v: { lints: [...copias, { name: 'Mal-Nombre', cache_key: 'k' }, { name: 'sin_clave' }, null] } },
      'performance');
    expect(r).toEqual({ ok: true, v: { lints: [copias[0]], sobran: 0 } });
    expect(console.log).not.toHaveBeenCalled();
  });

  it(`tope de ${MAX_LINTS_POR_ADVISOR}: se quedan los más graves y se registra advisor_truncado con el número`, () => {
    const lints = [
      ...Array.from({ length: 240 }, (_, i) => lint('unused_index', i, 'INFO')),
      lint('rls_disabled_in_public', 0, 'ERROR'),
      ...Array.from({ length: 9 }, (_, i) => lint('function_search_path_mutable', i, 'WARN')),
    ];
    const r = leerAdvisor({ ok: true, v: { lints } }, 'performance');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.v.sobran).toBe(50);
    expect(r.v.lints).toHaveLength(MAX_LINTS_POR_ADVISOR);
    expect(r.v.lints[0]?.name).toBe('rls_disabled_in_public');
    expect(r.v.lints.slice(1, 10).every((l) => l.level === 'WARN')).toBe(true);
    const eventos = vi.mocked(console.log).mock.calls.map(([s]) => JSON.parse(String(s)) as Record<string, unknown>);
    expect(eventos).toContainEqual(expect.objectContaining({ event: 'advisor_truncado', advisor: 'performance', n: 250 }));
  });
});

describe('recortarLints', () => {
  const adv = (lints: LintAdvisor[], sobran = 0) => ({ lints, sobran });

  it('sin pasar del cupo: todos, en su orden (security y luego performance) y sin repetir cache_key entre los dos', () => {
    const a = lint('auth_users_exposed', 1, 'ERROR'), b = lint('unused_index', 2, 'INFO');
    expect(recortarLints({ security: adv([a]), performance: adv([b, a]) }, 5))
      .toEqual({ lints: [a, b], descartados: { security: 0, performance: 0 } });
    expect(console.log).not.toHaveBeenCalled();
  });

  it('pasando del cupo: los más graves de los dos; lo que no cabe se suma a los descartes de su advisor', () => {
    const warn = Array.from({ length: 20 }, (_, i) => lint('auth_rls_initplan', i, 'WARN'));
    const info = Array.from({ length: 30 }, (_, i) => lint('unused_index', i, 'INFO'));
    const error = lint('security_definer_view', 1, 'ERROR');
    const r = recortarLints({ security: adv([...warn.slice(0, 10), error], 7), performance: adv([...info, ...warn.slice(10)]) }, 15);
    expect(r.lints).toEqual([error, ...warn.slice(0, 14)]);
    expect(r.descartados).toEqual({ security: 7, performance: 36 });
    const eventos = vi.mocked(console.log).mock.calls.map(([s]) => JSON.parse(String(s)) as Record<string, unknown>);
    expect(eventos).toContainEqual(expect.objectContaining({ event: 'lints_recortados', n: 51, cupo: 15 }));
  });

  it('rls_disabled_in_public va primero, salvo en una tabla que SQL 1 ya confirmó (saldría como duplicado info): al final', () => {
    const rls1 = lint('rls_disabled_in_public', 1, 'ERROR'), rls2 = lint('rls_disabled_in_public', 2, 'ERROR');
    const warn = lint('auth_rls_initplan', 3, 'WARN'), info = lint('unused_index', 4, 'INFO');
    const r = recortarLints({ security: adv([warn, rls1, info, rls2]) }, 3, new Set(['public.t1']));
    expect(r).toEqual({ lints: [rls2, warn, info], descartados: { security: 1, performance: 0 } });
  });
});

describe('pasoSupabase', () => {
  it('todas las fuentes con 403: failed (no done con 0 hallazgos), sin escribir hallazgos y con miradas en false', async () => {
    resp = { sec: 403, perf: 403, s1: 403, s2: 403, s3: 403 };
    expect(await pasoSupabase(env, m)).toEqual({ status: 'failed', error_code: 'forbidden', connection_id: CONN });
    expect(doble.rpcs.filter((x) => x.name === 'vg_upsert_findings')).toEqual([]);
    expect(detalle()?.miradas).toEqual({ advisors: false, sql_rls: false, sql_politicas: false, sql_rpc: false });
    expect((cobertura?.detail as Record<string, unknown>).codebase).toEqual({ miradas: { secretos: true } });
  });

  it('sin permisos en las capacidades: failed sin llamar a Supabase', async () => {
    capacidades = { advisors: false, sql_read_only: false };
    expect(await pasoSupabase(env, m)).toMatchObject({ status: 'failed', error_code: 'forbidden' });
    expect(llamadas).toEqual([]);
  });

  it('advisors 404 y SQL con error 500 (no transitorio): failed', async () => {
    resp = { sec: 404, perf: 404, s1: 500, s2: 500, s3: 500 };
    expect(await pasoSupabase(env, m)).toMatchObject({ status: 'failed', error_code: 'not_found' });
  });

  it('advisors no disponibles y SQL sin permiso: failed (advisor_check_unavailable no cuenta como respuesta)', async () => {
    resp = { sec: { lints: [lint('advisor_check_unavailable', 1)] }, perf: { lints: [lint('advisor_check_unavailable', 2)] },
      s1: 403, s2: 403, s3: 403 };
    expect(await pasoSupabase(env, m)).toMatchObject({ status: 'failed', error_code: 'advisor_check_unavailable' });
  });

  it('todo caído con algún transitorio: lanza unavailable para que la cola reintente', async () => {
    resp = { sec: 403, perf: 403, s1: 503, s2: 403, s3: 403 };
    await expect(pasoSupabase(env, m)).rejects.toMatchObject({ code: 'unavailable' });
    expect(detalle()).toBeUndefined();
  });

  it('un 401 lanza unauthorized antes de escribir nada', async () => {
    resp = { sec: 401, perf: 401, s1: 401, s2: 401, s3: 401 };
    await expect(pasoSupabase(env, m)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(doble.rpcs).toEqual([]);
    expect(detalle()).toBeUndefined();
  });

  it('todo sano: done sin error_code, auto-verifica y las cuatro miradas en true', async () => {
    expect(await pasoSupabase(env, m)).toEqual({ status: 'done', findings: 0 });
    expect(upserts).toEqual([{ rows: [], complete: true }]);
    expect(detalle()).toEqual({ miradas: { advisors: true, sql_rls: true, sql_politicas: true, sql_rpc: true } });
    expect(cobertura).toMatchObject({ seen: 1, detail: { codebase: { miradas: { secretos: true } } } });
    // Presupuesto (≤ 40 por paso): 5 a Supabase y 5 a la base (conexión 2, RPC 1, coverage 2) sin contar el secreto.
    expect(llamadas).toHaveLength(5);
    expect(doble.ops.length + doble.rpcs.length).toBe(5);
  });

  it('advisor_check_unavailable en security: miradas.advisors false, parcial:1; solo los SQL se auto-verifican, por regla', async () => {
    resp.sec = { lints: [lint('advisor_check_unavailable', 1)] };
    resp.perf = { lints: [lint('unindexed_foreign_keys', 1, 'INFO')] };
    expect(await pasoSupabase(env, m)).toEqual({ status: 'done', findings: 1, error_code: 'parcial:1' });
    expect(lotes()).toEqual([{ rows: [expect.objectContaining({ rule_id: 'SB_ADVISOR_UNINDEXED_FOREIGN_KEYS' })], complete: false }]);
    expect(verificadas()).toEqual(SQL_TODAS);
    expect(detalle()).toEqual({ miradas: { advisors: false, sql_rls: true, sql_politicas: true, sql_rpc: true },
      sin_mirar: { advisors_security: 'advisor_check_unavailable' } });
  });

  it('project_not_active: sin mirar y proyecto_pausado en el detalle', async () => {
    resp.sec = { lints: [lint('project_not_active', 1)] };
    resp.perf = { lints: [lint('project_not_active', 2)] };
    expect(await pasoSupabase(env, m)).toMatchObject({ status: 'done', error_code: 'parcial:2' });
    expect(detalle()).toMatchObject({ miradas: { advisors: false, sql_rls: true }, proyecto_pausado: true });
  });

  it(`más lints que el cupo de CPU: guarda ${TOPE_BORRADORES}, no auto-verifica advisors y lo anota (lints_truncados, lints_descartados)`, async () => {
    resp.sec = { lints: Array.from({ length: 230 }, (_, i) => lint('rls_references_user_metadata', i)) };
    const r = await pasoSupabase(env, m);
    expect(r).toEqual({ status: 'done', findings: TOPE_BORRADORES, error_code: 'lints_truncados' });
    expect(lotes()).toHaveLength(1);
    expect(lotes()[0]?.rows).toHaveLength(TOPE_BORRADORES);
    expect(lotes()[0]?.complete).toBe(false);
    expect(verificadas()).toEqual(SQL_TODAS);
    // 30 sobre el tope duro de 200 y 150 más por el cupo de CPU; se miró igual, así que miradas.advisors sigue en true.
    expect(detalle()).toEqual({ miradas: { advisors: true, sql_rls: true, sql_politicas: true, sql_rpc: true },
      lints_descartados: { security: 230 - TOPE_BORRADORES, performance: 0 } });
  });

  it('los SQL entran primero en el cupo; los advisors se quedan con el resto, nunca menos del mínimo', async () => {
    const politicas = (n: number) => Array.from({ length: n }, (_, i) =>
      ({ schemaname: 'public', tablename: `p${i}`, policyname: 'todo', cmd: 'ALL', roles: ['anon'] }));
    resp.sec = { lints: Array.from({ length: 30 }, (_, i) => lint('auth_rls_initplan', i)) };
    resp.s2 = politicas(30);
    expect(await pasoSupabase(env, m)).toEqual({ status: 'done', findings: TOPE_BORRADORES, error_code: 'lints_truncados' });
    expect(upserts[0]?.rows.filter((x) => x.rule_id.startsWith('SB_ADVISOR_'))).toHaveLength(TOPE_BORRADORES - 30);
    expect(detalle()?.lints_descartados).toEqual({ security: 60 - TOPE_BORRADORES, performance: 0 });
    resp.s2 = politicas(TOPE_BORRADORES);
    upserts = [];
    expect(await pasoSupabase(env, m)).toMatchObject({ findings: TOPE_BORRADORES + TOPE_LINTS_MIN });
    expect(upserts[0]?.rows.filter((x) => x.rule_id.startsWith('SB_ADVISOR_'))).toHaveLength(TOPE_LINTS_MIN);
  });

  it('lints recortados con SQL sano: cada SQL verifica su regla (un SB_RLS_DISABLED arreglado no se queda open)', async () => {
    resp.perf = { lints: Array.from({ length: 60 }, (_, i) => lint('unused_index', i, 'INFO')) };
    expect(await pasoSupabase(env, m)).toEqual({ status: 'done', findings: TOPE_BORRADORES, error_code: 'lints_truncados' });
    expect(lotes()).toEqual([{ rows: expect.any(Array), complete: false }]);
    expect(upserts.filter((u) => u.complete).map((u) => u.rule).sort()).toEqual(SQL_TODAS);   // nunca p_complete sin p_rule
    expect(verificadas()).toEqual(SQL_TODAS);
    expect(detalle()?.miradas).toEqual({ advisors: true, sql_rls: true, sql_politicas: true, sql_rpc: true });
    // Presupuesto: 5 a Supabase y 8 a la base (conexión 2, lote 1, verificación 3, coverage 2), lejos del tope de 40.
    expect(llamadas).toHaveLength(5);
    expect(doble.ops.length + doble.rpcs.length).toBe(8);
  });

  it('una fuente SQL caída: verifica las reglas de los otros dos SQL, no la suya ni los advisors', async () => {
    resp.s2 = 403;
    resp.sec = { lints: [lint('auth_users_exposed', 1, 'ERROR')] };
    expect(await pasoSupabase(env, m)).toEqual({ status: 'done', findings: 1, error_code: 'parcial:1' });
    expect(lotes()).toEqual([{ rows: [expect.objectContaining({ rule_id: 'SB_ADVISOR_AUTH_USERS_EXPOSED' })], complete: false }]);
    expect(verificadas()).toEqual(['SB_RLS_DISABLED', 'SB_RPC_ANON_NO_LIMIT']);
  });

  it('el cupo cuenta los hallazgos que darán los SQL, no sus filas: pre_request, sobrecargas y políticas repetidas', async () => {
    resp.perf = { lints: Array.from({ length: 11 }, (_, i) => lint('unused_index', i, 'INFO')) };
    resp.s3 = [
      ...Array.from({ length: 45 }, (_, i) => ({ esquema: 'public', funcion: `con_freno_${i}`, definer: false, hay_pre_request: true })),
      ...Array.from({ length: 20 }, (_, i) => ({ esquema: 'public', funcion: 'buscar', definer: false, hay_pre_request: 'false',
        args: `a${i} int` })),
    ];
    resp.s2 = Array.from({ length: 30 }, () => ({ schemaname: 'public', tablename: 'pedidos', policyname: 'todo', cmd: 'ALL',
      roles: ['anon'] }));
    // 11 lints + 1 RPC (las 20 sobrecargas) + 1 política: cabe todo, así que ni recorte ni verificación por regla.
    expect(await pasoSupabase(env, m)).toEqual({ status: 'done', findings: 13 });
    expect(upserts).toEqual([{ rows: expect.any(Array), complete: true }]);
    expect(detalle()).not.toHaveProperty('lints_descartados');
  });

  it('250 copias del mismo lint son 1 hallazgo: sin lints_truncados y auto-verifica', async () => {
    resp.sec = { lints: Array.from({ length: 250 }, () => lint('auth_users_exposed', 1, 'ERROR')) };
    expect(await pasoSupabase(env, m)).toEqual({ status: 'done', findings: 1 });
    expect(upserts).toEqual([{ rows: [expect.objectContaining({ rule_id: 'SB_ADVISOR_AUTH_USERS_EXPOSED' })], complete: true }]);
    expect(detalle()).not.toHaveProperty('lints_descartados');
  });

  it(`CPU: con los dos advisors llenos procesa ${TOPE_BORRADORES} borradores como mucho y el coste ya no crece con los lints`, async () => {
    const real = (name: string, i: number, level: string) => ({ name, level, facing: 'EXTERNAL', title: 'Auth RLS Initialization Plan',
      categories: ['PERFORMANCE'], description: 'Detects if calls to current_setting() and auth.<function>() in RLS policies are '
        + 'being unnecessarily re-evaluated for each row', cache_key: `${name}_public_tabla_${i}_p_${i}`,
      detail: `Table public.tabla_${i} has a row level security policy p_${i} that re-evaluates current_setting() or `
        + 'auth.<function>() for each row. This produces suboptimal query performance at scale. Resolve the issue by replacing '
        + 'auth.<function>() with (select auth.<function>()).',
      remediation: 'https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan',
      metadata: { schema: 'public', name: `tabla_${i}`, type: 'table' } });
    const sec = JSON.stringify({ lints: Array.from({ length: MAX_LINTS_POR_ADVISOR }, (_, i) =>
      real(i % 3 ? 'auth_rls_initplan' : 'multiple_permissive_policies', i, 'WARN')) });
    const perf = JSON.stringify({ lints: Array.from({ length: MAX_LINTS_POR_ADVISOR }, (_, i) => real('unused_index', i, 'INFO')) });
    // CPU del hilo (lo que cobra Workers; no el reloj ni los hilos de GC), por lotes (en Windows el contador avanza a
    // saltos de ≈ 15,6 ms) y con el JIT caliente, como un isolate que ya corrió. fetch sin vi.fn y registros vaciados:
    // que la prueba no acumule respuestas de 150 KB y el GC no cuente como coste del paso.
    vi.stubGlobal('fetch', responder);
    const cpu = async (veces: number, f: () => unknown) => {
      upserts = [];
      doble.ops.length = 0;
      doble.rpcs.length = 0;
      const t = process.threadCpuUsage();
      for (let i = 0; i < veces; i++) await f();
      const d = process.threadCpuUsage(t);
      return (d.user + d.system) / 1000 / veces;
    };
    const paso = () => pasoSupabase(env, m);
    // Lo que costaría sin el cupo: evaluar y redactar los 400 lints (sin el sha256 ni el filtro: se queda corto).
    const sinCupo = () => {
      for (const b of evaluarSupabase({ advisors: [...JSON.parse(sec).lints, ...JSON.parse(perf).lints] as LintAdvisor[] })) {
        redact({ title: b.title, resource: b.resource, evidence: b.evidence });
      }
    };
    await cpu(5, paso);
    let limpio = Infinity;
    for (let i = 0; i < 3; i++) limpio = Math.min(limpio, await cpu(20, paso));
    resp.sec = sec;
    resp.perf = perf;
    await cpu(5, paso);
    await cpu(3, sinCupo);
    // Rondas alternas (la carga de la máquina afecta a los dos por igual) y el mejor de cada uno: la carga solo suma.
    let lleno = Infinity, ref = Infinity;
    for (let i = 0; i < 4; i++) {
      lleno = Math.min(lleno, await cpu(20, paso));
      expect(lotes().every((u) => u.rows.length === TOPE_BORRADORES)).toBe(true);
      ref = Math.min(ref, await cpu(5, sinCupo));
    }
    // Lo que AÑADEN los advisors llenos sobre un proyecto limpio (parse de 2 × 150 KB y ≤ 50 borradores) frente a
    // procesar los 400. En esta máquina, a solas: ≈ 4-5,5 ms frente a ≈ 25-35 ms (sin el cupo, el paso añadía ≈ 32 ms:
    // proporción ≈ 1); con la suite entera en paralelo, los dos ≈ el doble. La proporción no depende de la carga ni de la
    // máquina; el número absoluto sí, por eso no se compara con los 10 ms de Free.
    expect(lleno - limpio).toBeLessThan(ref * 0.5);
  });

  it('cable trampa: la fila descartada deja sin mirar su fuente y error_code empieza por tripwire', async () => {
    resp.s1 = [{ esquema: 'public', tabla: `x_${PAT}`, rls_activa: false, anon_select: true }];   // redact() exige \b
    resp.s2 = [{ schemaname: 'public', tablename: 'pedidos', policyname: 'todo', cmd: 'ALL', roles: ['anon'] }];
    expect(await pasoSupabase(env, m)).toEqual({ status: 'done', findings: 1, error_code: 'tripwire' });
    expect(lotes().every((u) => !u.complete)).toBe(true);
    expect(upserts.flatMap((u) => u.rows.map((x) => x.rule_id))).toEqual(['SB_POLICY_ALLOW_ALL']);
    // Solo se verifica la regla del SQL que el descarte no pudo tocar (SQL 3b no dio filas); advisors tampoco (sin p_rule).
    expect(verificadas()).toEqual(['SB_RPC_ANON_NO_LIMIT']);
    // sql_politicas también dio filas: la descartada podía ser suya, así que tampoco se da por mirada.
    expect(detalle()?.miradas).toEqual({ advisors: true, sql_rls: false, sql_politicas: false, sql_rpc: true });
  });

  it('cable trampa con una fuente caída: tripwire antepuesto a parcial:N', async () => {
    resp.s1 = [{ esquema: 'public', tabla: `x_${PAT}`, rls_activa: false, anon_select: true }];
    resp.s3 = 403;
    expect(await pasoSupabase(env, m)).toEqual({ status: 'done', findings: 0, error_code: 'tripwire,parcial:1' });
    expect(lotes()).toEqual([]);   // la única fila se descartó: no hay lote
    expect(verificadas()).toEqual(['SB_POLICY_ALLOW_ALL']);
    expect(detalle()).toEqual({ miradas: { advisors: true, sql_rls: false, sql_politicas: true, sql_rpc: false },
      sin_mirar: { sql_rpc: 'forbidden' } });
  });

  it('si no puede escribir coverage tras guardar, lanza unavailable (la cola reintenta; sin miradas no hay «mirado»)', async () => {
    estado.client = dbDoble({
      tabla: (op: Op) => {
        if (op.table === 'connections') return { data: { id: CONN, meta: { project_ref: REF }, capabilities: {} } };
        if (op.table === 'scan_runs' && op.action === 'update') return { error: { code: '08006' } };
        if (op.table === 'scan_runs') return { data: { params: {}, coverage: {} } };
        return undefined;
      },
    }).client;
    await expect(pasoSupabase(env, m)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
