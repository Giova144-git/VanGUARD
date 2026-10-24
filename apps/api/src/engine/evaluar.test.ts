import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { dedupeKeyEdge, type IncidenteEdgeConClave } from '@vanguard/core';
import { dbDoble, eqDe, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown, aviso: vi.fn() }));
vi.mock('../lib/db.ts', () => ({ db: () => { if (!estado.client) throw new Error('sin base'); return estado.client; } }));
vi.mock('../notify/despachador.ts', () => ({ avisarIncidente: estado.aviso }));

const { COSTE_AVISO, PRESUPUESTO_MOTOR, aRespuestaUpsert, evaluarEnVivo, planEvaluacion } = await import('./evaluar.ts');

const ORG = '0f6c0000-0000-4000-8000-000000000001';
const CONN = '1c0e0000-0000-4000-8000-000000000001';
const ATACANTE = '186.92.14.7';
const LEGITIMA = '190.1.2.3';
const T0 = Date.parse('2026-10-24T19:01:00.000Z');
const RANGO: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

// ── Doble con estado de las RPC de 0005/0006: misma semántica que el SQL, en memoria ───────────────────────────────
type Hit = { ip: string; ts: number; path: string; status: number; ua: string; auth: boolean; latency_ms: number };
type Inc = { id: string; code: string; dedupe: string; rule_ids: string[]; severity: string; status: string;
  started_at: string; resolved_at: number | null; muted_until: string | null; event_count: number; details: Record<string, unknown> };

let hits: Hit[];
let ultimaEval: number | null;
let incs: Inc[];
let fallo: Partial<Record<string, Resp>>;
let doble: ReturnType<typeof dbDoble>;
let logs: MockInstance<typeof console.log>;

const pg = (ms: number) => new Date(ms).toISOString().replace('Z', '+00:00');   // como lo devuelve PostgREST

function ventana(seg: number) {
  const desde = Date.now() - seg * 1000;
  const vivos = hits.filter((h) => h.ts > desde);
  const porIp = new Map<string, Hit[]>();
  for (const h of vivos) porIp.set(h.ip, [...(porIp.get(h.ip) ?? []), h]);
  return [...porIp].map(([ip, xs]) => {
    const lat = xs.map((x) => x.latency_ms).sort((a, b) => a - b);
    const uas = new Map<string, number>();
    for (const x of xs) uas.set(x.ua, (uas.get(x.ua) ?? 0) + 1);
    return { ip, n: xs.length,
      paths_4xx: new Set(xs.filter((x) => x.status === 403 || x.status === 404).map((x) => x.path)).size,
      probe_hits: xs.filter((x) => /^\/(\.env|\.git\/config|wp-login\.php|phpmyadmin|server-status)/.test(x.path)).length,
      admin_ok: xs.filter((x) => x.status >= 200 && x.status <= 399 && !x.auth && /^\/(admin|api\/admin|wp-admin)(\/|$)/.test(x.path)).length,
      n5xx: xs.filter((x) => x.status >= 500).length, p95_ms: lat[Math.ceil(0.95 * lat.length) - 1] ?? null,
      ua_top: [...uas].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, total: vivos.length };
  }).sort((a, b) => b.n - a.n).slice(0, 20);
}

function upsert(a: Record<string, unknown>) {
  const ahora = Date.now();
  let v = incs.find((i) => i.dedupe === a.p_dedupe && i.status !== 'resolved');
  let reabierto = false;
  if (!v) {
    v = incs.filter((i) => i.dedupe === a.p_dedupe && i.status === 'resolved' && i.resolved_at! > ahora - 600_000).at(-1);
    reabierto = !!v;
  }
  const sev = String(a.p_severity), reglas = a.p_rules as string[];
  if (!v) {
    const n = incs.length + 1;
    const nuevo: Inc = { id: `9e0b0000-0000-4000-8000-00000000000${n}`, code: `A1F3C${n}`, dedupe: String(a.p_dedupe),
      rule_ids: reglas, severity: sev, status: 'open', started_at: String(a.p_started ?? pg(ahora)), resolved_at: null,
      muted_until: null, event_count: 1, details: { ...(a.p_details as object), detected_at: pg(ahora) } };
    incs.push(nuevo);
    return [{ id: nuevo.id, code: nuevo.code, severity: sev, prev_severity: null, is_new: true, reopened: false, status: 'open', muted_until: null }];
  }
  const prev = v.severity;
  if (RANGO[sev]! > RANGO[prev]!) v.severity = sev;
  v.rule_ids = [...new Set([...v.rule_ids, ...reglas])].sort();
  v.event_count++;
  if (reabierto) { v.status = 'open'; v.resolved_at = null; }
  return [{ id: v.id, code: v.code, severity: v.severity, prev_severity: prev, is_new: false, reopened: reabierto, status: v.status,
    muted_until: v.muted_until }];
}

function rpc(name: string, a: Record<string, unknown>): Resp {
  const f = fallo[name];
  if (f) { delete fallo[name]; return f; }
  if (a.p_org !== ORG) return { error: { code: '42501' } };
  if (name === 'vg_try_eval') {
    // 0006: actualiza solo si la última fue hace MÁS de 5 s; si no, null.
    if (ultimaEval !== null && Date.now() - ultimaEval <= 5000) return { data: null };
    ultimaEval = Date.now();
    return { data: true };
  }
  if (name === 'vg_edge_window') return { data: ventana(Number(a.p_seconds)) };
  if (name === 'vg_ip_first_seen') {
    const ts = hits.filter((h) => h.ip === a.p_ip && h.ts > Date.now() - Number(a.p_seconds) * 1000).map((h) => h.ts);
    return { data: ts.length ? pg(Math.min(...ts)) : null };
  }
  if (name === 'vg_upsert_incident') return { data: upsert(a) };
  return { error: { code: 'PGRST202' } };
}

// n peticiones de `ip` repartidas en los últimos `durante` ms.
function lote(ip: string, n: number, o: Partial<Hit> & { rutas?: (i: number) => string } = {}, durante = 4000) {
  for (let i = 0; i < n; i++) {
    hits.push({ ip, ts: Date.now() - durante + Math.floor((durante * i) / n), path: o.rutas?.(i) ?? o.path ?? '/',
      status: o.status ?? 200, ua: o.ua ?? 'Mozilla/5.0', auth: o.auth ?? false, latency_ms: o.latency_ms ?? 120 });
  }
}
const sqlmap = (ip = ATACANTE, n = 30) => lote(ip, n, { ua: 'sqlmap/1.8', status: 404, rutas: (i) => `/sondeo-${i}` });

const evaluar = () => evaluarEnVivo(envDoble().env, { orgId: ORG, connectionId: CONN, rid: 'rid-1' });
const llamadas = (name: string) => doble.rpcs.filter((r) => r.name === name);
const eventos = () => logs.mock.calls.map((x) => JSON.parse(String(x[0])) as Record<string, unknown>);
const resumen = () => eventos().filter((e) => e.event === 'motor.evaluacion').at(-1);
const avanzar = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  hits = [];
  ultimaEval = null;
  incs = [];
  fallo = {};
  doble = dbDoble({
    rpc,
    tabla: (op) => {
      if (op.table === 'connections' && eqDe(op, 'id') === CONN && eqDe(op, 'org_id') === ORG) {
        return { data: { label: 'demo.officialvanguard.com', meta: { hostname: 'demo.officialvanguard.com' } } };
      }
      if (op.table === 'incidents' && op.action === 'select') {
        const f = fallo.abiertos;
        if (f) { delete fallo.abiertos; return f; }
        const claves = (op.filters.find(([c, o]) => c === 'dedupe_key' && o === 'in')?.[2] ?? []) as string[];
        const estados = (op.filters.find(([c, o]) => c === 'status' && o === 'in')?.[2] ?? []) as string[];
        return { data: eqDe(op, 'org_id') !== ORG ? [] : incs.filter((i) => claves.includes(i.dedupe) && estados.includes(i.status))
          .map((i) => ({ dedupe_key: i.dedupe, severity: i.severity })) };
      }
      return undefined;
    },
  });
  estado.client = doble.client;
  estado.aviso.mockReset();
  estado.aviso.mockResolvedValue(undefined);
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('evaluarEnVivo · ataque sqlmap (S15 15.9)', () => {
  it('abre UN incidente CF_UA_TOOL + CF_PATH_SCAN con los parámetros reales de vg_upsert_incident y avisa una vez', async () => {
    lote(LEGITIMA, 50);                    // tráfico normal: 50 peticiones de navegador, ninguna regla
    sqlmap();
    await evaluar();

    expect(doble.rpcs.map((r) => r.name)).toEqual(['vg_try_eval', 'vg_edge_window', 'vg_ip_first_seen', 'vg_upsert_incident']);
    expect(llamadas('vg_try_eval')[0]!.args).toEqual({ p_org: ORG });
    expect(llamadas('vg_edge_window')[0]!.args).toEqual({ p_org: ORG, p_seconds: 60 });
    expect(llamadas('vg_ip_first_seen')[0]!.args).toEqual({ p_org: ORG, p_ip: ATACANTE, p_seconds: 120 });
    const p = llamadas('vg_upsert_incident')[0]!.args;
    expect(Object.keys(p).sort()).toEqual(['p_conn', 'p_dedupe', 'p_details', 'p_ip', 'p_org', 'p_resource', 'p_rules', 'p_severity',
      'p_started', 'p_title']);
    expect(p).toMatchObject({ p_org: ORG, p_conn: CONN, p_dedupe: await dedupeKeyEdge(ORG, ATACANTE), p_rules: ['CF_UA_TOOL', 'CF_PATH_SCAN'],
      p_severity: 'high', p_resource: `ip:${ATACANTE}`, p_ip: ATACANTE, p_started: pg(T0 - 4000) });
    expect(p.p_dedupe).toMatch(/^[0-9a-f]{64}$/);
    // Título con la IP recortada; la completa solo en resource, p_ip y details.
    expect(p.p_title).toBe('Escaneo de rutas con sqlmap desde 186.92.x.x');
    expect(p.p_details).toMatchObject({ ip: ATACANTE, host: 'demo.officialvanguard.com', source: 'ingest', ua_top: 'sqlmap/1.8',
      n_60s: 30, total_60s: 80, paths_4xx: 30, admin_ok: 0 });

    expect(incs).toHaveLength(1);
    expect(estado.aviso).toHaveBeenCalledOnce();
    expect(estado.aviso).toHaveBeenCalledWith(expect.anything(), ORG, incs[0]!.id,
      { is_new: true, prev_severity: null, reopened: false }, 'rid-1');
    expect(resumen()).toMatchObject({ level: 'info', rid: 'rid-1', filas: 2, incidentes: 1, procesados: 1, nuevos: 1, avisos: 1,
      pendientes: 0, errores: 0 });
    // Ni la IP completa ni el UA crudo en los logs.
    expect(JSON.stringify(eventos())).not.toContain('14.7');
  });

  it('segundo lote a los 2 s: vg_try_eval da null y no evalúa (ni ventana, ni upsert, ni aviso, ni log)', async () => {
    sqlmap();
    await evaluar();
    avanzar(2000);
    sqlmap(ATACANTE, 10);
    const antes = doble.rpcs.length;
    await evaluar();
    expect(doble.rpcs.slice(antes).map((r) => r.name)).toEqual(['vg_try_eval']);
    expect(estado.aviso).toHaveBeenCalledOnce();
    expect(eventos().filter((e) => e.event === 'motor.evaluacion')).toHaveLength(1);
  });

  it('a los 6 s con el mismo atacante: mismo incidente (dedupe) y sin segundo aviso', async () => {
    sqlmap();
    await evaluar();
    avanzar(6000);
    sqlmap(ATACANTE, 20);
    await evaluar();
    const upserts = llamadas('vg_upsert_incident');
    expect(upserts).toHaveLength(2);
    expect(upserts[1]!.args.p_dedupe).toBe(upserts[0]!.args.p_dedupe);
    expect(incs).toHaveLength(1);
    expect(incs[0]!.event_count).toBe(2);
    expect(estado.aviso).toHaveBeenCalledOnce();
    expect(resumen()).toMatchObject({ procesados: 1, nuevos: 0, avisos: 0 });
  });

  it('sube a critical (/admin 200 sin sesión): mismo incidente y un segundo aviso con prev_severity high', async () => {
    sqlmap();
    await evaluar();
    avanzar(6000);
    lote(ATACANTE, 3, { ua: 'sqlmap/1.8', path: '/admin', status: 200 }, 1000);
    await evaluar();
    const p = llamadas('vg_upsert_incident')[1]!.args;
    expect(p.p_severity).toBe('critical');
    expect(p.p_rules).toEqual(['CF_UA_TOOL', 'CF_PATH_SCAN', 'CF_ADMIN_EXPOSED']);
    expect(incs).toHaveLength(1);
    expect(incs[0]!.severity).toBe('critical');
    expect(estado.aviso).toHaveBeenCalledTimes(2);
    expect(estado.aviso).toHaveBeenLastCalledWith(expect.anything(), ORG, incs[0]!.id,
      { is_new: false, prev_severity: 'high', reopened: false }, 'rid-1');
  });

  it('reaparece < 10 min después de resolverse: reabre el mismo y avisa con reopened (el despachador elige plantilla)', async () => {
    sqlmap();
    await evaluar();
    incs[0]!.status = 'resolved';
    incs[0]!.resolved_at = Date.now();
    avanzar(5 * 60_000);
    sqlmap();
    await evaluar();
    expect(incs).toHaveLength(1);
    expect(incs[0]!.status).toBe('open');
    expect(estado.aviso).toHaveBeenLastCalledWith(expect.anything(), ORG, incs[0]!.id,
      { is_new: false, prev_severity: 'high', reopened: true }, 'rid-1');
  });

  it('sin reglas disparadas (solo tráfico normal) no llama a vg_upsert_incident ni avisa', async () => {
    lote(LEGITIMA, 80);
    await evaluar();
    expect(doble.rpcs.map((r) => r.name)).toEqual(['vg_try_eval', 'vg_edge_window']);
    expect(estado.aviso).not.toHaveBeenCalled();
    expect(resumen()).toMatchObject({ filas: 1, incidentes: 0 });
  });
});

describe('evaluarEnVivo · presupuesto de subpeticiones (≤ 40 con la ingesta)', () => {
  // Lo que de verdad se pidió en esta evaluación (RPC + tablas) más la reserva de cada aviso.
  const gastado = (desde: { rpcs: number; ops: number }, avisos: number) =>
    doble.rpcs.length - desde.rpcs + doble.ops.length - desde.ops + avisos * COSTE_AVISO;
  const marca = () => ({ rpcs: doble.rpcs.length, ops: doble.ops.length });

  it('6 atacantes nuevos a la vez: critical primero, un aviso por evaluación y el resto en la siguiente sin perder avisos', async () => {
    for (let k = 1; k <= 5; k++) sqlmap(`186.92.14.${10 + k}`, 25);
    lote('201.0.0.9', 2, { path: '/admin', status: 200 }, 1000);    // /admin abierto: critical, aunque sea el de menos volumen
    await evaluar();
    expect(llamadas('vg_upsert_incident').map((u) => u.args.p_severity)).toEqual(['critical']);
    expect(estado.aviso).toHaveBeenCalledOnce();
    const r1 = resumen()!;
    expect(r1).toMatchObject({ incidentes: 6, procesados: 1, pendientes: 5, level: 'warn' });
    expect(gastado({ rpcs: 0, ops: 0 }, 1)).toBeLessThanOrEqual(PRESUPUESTO_MOTOR);
    expect(Number(r1.subpeticiones)).toBeLessThanOrEqual(PRESUPUESTO_MOTOR);

    for (let ronda = 0; ronda < 5; ronda++) {
      avanzar(6000);
      const m = marca(), avisos = estado.aviso.mock.calls.length;
      await evaluar();
      // Cada ronda abre (y avisa) uno nuevo y además refresca los ya abiertos.
      expect(estado.aviso.mock.calls.length - avisos).toBe(1);
      expect(gastado(m, 1)).toBeLessThanOrEqual(PRESUPUESTO_MOTOR);
      expect(Number(resumen()!.subpeticiones)).toBeLessThanOrEqual(PRESUPUESTO_MOTOR);
    }
    expect(incs).toHaveLength(6);
    expect(estado.aviso).toHaveBeenCalledTimes(6);
    expect(estado.aviso.mock.calls.every((c) => (c[3] as { is_new: boolean }).is_new)).toBe(true);
  });

  it('16 atacantes ya abiertos: los abiertos no se comen el presupuesto de una IP nueva (ni la dejan sin incidente)', async () => {
    const ips = Array.from({ length: 16 }, (_, k) => `186.92.15.${k + 1}`);
    for (let ronda = 0; ronda < 20 && incs.length < 16; ronda++) {
      for (const ip of ips) sqlmap(ip, 25);
      await evaluar();
      avanzar(6000);
    }
    expect(incs).toHaveLength(16);
    expect(estado.aviso).toHaveBeenCalledTimes(16);
    // Todos abiertos y sin cambios: solo refrescos baratos, acotados al presupuesto.
    for (const ip of ips) sqlmap(ip, 25);
    const m = marca();
    await evaluar();
    expect(estado.aviso).toHaveBeenCalledTimes(16);
    expect(gastado(m, 0)).toBeLessThanOrEqual(PRESUPUESTO_MOTOR);
    expect(resumen()).toMatchObject({ incidentes: 16, avisos: 0, errores: 0 });
    expect(Number(resumen()!.procesados) + Number(resumen()!.pendientes)).toBe(16);
    // Llega uno nuevo con los 16 abiertos delante: entra primero.
    avanzar(6000);
    for (const ip of ips) sqlmap(ip, 25);
    sqlmap('186.92.16.1', 25);
    const antes = llamadas('vg_upsert_incident').length;
    await evaluar();
    expect(llamadas('vg_upsert_incident')[antes]!.args.p_ip).toBe('186.92.16.1');
    expect(incs).toHaveLength(17);
    expect(estado.aviso).toHaveBeenCalledTimes(17);
  });

  it('si no se pueden leer los abiertos, todos cuentan como aviso (reserva del lado seguro) y se sigue', async () => {
    sqlmap();
    fallo.abiertos = { error: { code: '57014' } };
    await evaluar();
    expect(incs).toHaveLength(1);
    expect(estado.aviso).toHaveBeenCalledOnce();
    expect(eventos().some((e) => e.event === 'motor.abiertos_error')).toBe(true);
  });
});

describe('planEvaluacion', () => {
  const inc = (dedupe_key: string, severity: 'critical' | 'high') => ({ dedupe_key, severity }) as IncidenteEdgeConClave;
  it('primero los que avisarán (nuevos o que suben), critical antes; luego los que solo actualizan', () => {
    const xs = [inc('a', 'critical'), inc('b', 'critical'), inc('c', 'high'), inc('d', 'high')];
    const abiertos = new Map<string, 'critical' | 'high'>([['a', 'critical'], ['b', 'high'], ['c', 'high']]);
    expect(planEvaluacion(xs, abiertos).map((p) => [p.inc.dedupe_key, p.avisara])).toEqual([
      ['b', true], ['d', true], ['a', false], ['c', false]]);
    expect(planEvaluacion(xs, null).every((p) => p.avisara)).toBe(true);
  });
});

describe('evaluarEnVivo · nunca lanza', () => {
  it('error de vg_try_eval: no sigue y deja un warn', async () => {
    sqlmap();
    fallo.vg_try_eval = { error: { code: '57014' } };
    await expect(evaluar()).resolves.toBeUndefined();
    expect(doble.rpcs.map((r) => r.name)).toEqual(['vg_try_eval']);
    expect(eventos().map((e) => e.event)).toEqual(['motor.try_eval_error']);
  });

  it('23505 del índice parcial: reintenta la RPC una vez y sigue', async () => {
    sqlmap();
    fallo.vg_upsert_incident = { error: { code: '23505' } };
    await evaluar();
    expect(llamadas('vg_upsert_incident')).toHaveLength(2);
    expect(incs).toHaveLength(1);
    expect(estado.aviso).toHaveBeenCalledOnce();
  });

  it('otro error del upsert: sin aviso, errores = 1 y sin reintento', async () => {
    sqlmap();
    fallo.vg_upsert_incident = { error: { code: '23514' } };
    await evaluar();
    expect(llamadas('vg_upsert_incident')).toHaveLength(1);
    expect(estado.aviso).not.toHaveBeenCalled();
    expect(eventos().find((e) => e.event === 'motor.upsert_error')).toMatchObject({ level: 'error', code: '23514' });
    expect(resumen()).toMatchObject({ errores: 1, level: 'warn' });
  });

  it('vg_ip_first_seen falla: p_started null (la RPC usa now()) y el incidente se abre igual', async () => {
    sqlmap();
    fallo.vg_ip_first_seen = { error: { code: '57014' } };
    await evaluar();
    expect(llamadas('vg_upsert_incident')[0]!.args.p_started).toBeNull();
    expect(estado.aviso).toHaveBeenCalledOnce();
  });

  it('el despachador lanza o la base no está configurada: evaluarEnVivo resuelve y lo registra', async () => {
    sqlmap();
    estado.aviso.mockRejectedValueOnce(new TypeError('x'));
    await expect(evaluar()).resolves.toBeUndefined();
    expect(eventos().find((e) => e.event === 'motor.aviso_error')).toMatchObject({ name: 'TypeError' });

    estado.client = null;
    await expect(evaluar()).resolves.toBeUndefined();
    expect(eventos().at(-1)).toMatchObject({ event: 'motor.error', level: 'error' });
  });
});

describe('aRespuestaUpsert', () => {
  it('toma la primera fila del returns table y descarta formas inválidas', () => {
    const fila = { id: 'i1', code: 'A1F3C9', severity: 'critical', prev_severity: 'high', is_new: false, reopened: false,
      status: 'ack', muted_until: null };
    expect(aRespuestaUpsert([fila])).toEqual(fila);
    expect(aRespuestaUpsert({ ...fila, prev_severity: null })?.prev_severity).toBeNull();
    expect(aRespuestaUpsert([])).toBeNull();
    expect(aRespuestaUpsert([{ ...fila, severity: 'grave' }])).toBeNull();
    expect(aRespuestaUpsert(null)).toBeNull();
  });
});
