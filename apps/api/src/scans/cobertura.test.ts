import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanStep } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';

// Cobertura de §15.9 y el detalle por módulo de coverage (formato compartido de miradas). Sin red: doble de la base.
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const { calcularCobertura, escribirDetalleModulo, ultimoIntento } = await import('./cobertura.ts');

const ORG = '0f6c0000-0000-4000-8000-000000000001';
const SCAN = '5a1c0000-0000-4000-8000-000000000001';
const env = {} as CloudflareBindings;
const paso = (name: ScanStep['name'], status: ScanStep['status']): ScanStep => ({ name, status });

describe('ultimoIntento', () => {
  it('toma el primer done|failed de las auditorías (más nuevas primero) y salta running, pending y skipped', () => {
    const scans = [
      { steps: [paso('supabase', 'running'), paso('repo', 'skipped')] },
      { steps: [paso('supabase', 'failed'), paso('repo', 'pending')] },
      { steps: [paso('supabase', 'done'), paso('zip', 'done')] },
    ];
    expect(ultimoIntento(scans, ['supabase'])).toBe('failed');
    expect(ultimoIntento(scans, ['repo', 'zip'])).toBe('done');
    expect(ultimoIntento(scans, ['cloudflare'])).toBeNull();
    expect(ultimoIntento([], ['supabase'])).toBeNull();
  });
});

describe('calcularCobertura', () => {
  let scans: { steps: ScanStep[] | null }[];
  let cuentas: { perf: number; sb: number; cf: number };
  beforeEach(() => {
    scans = [];
    cuentas = { perf: 0, sb: 0, cf: 0 };
    estado.client = dbDoble({
      tabla: (op: Op): Resp | undefined => {
        expect(eqDe(op, 'org_id')).toBe(ORG);
        if (op.table === 'scan_runs') return { data: scans };
        if (op.table === 'perf_runs') return { count: cuentas.perf };
        if (op.table === 'metric_samples') return { count: eqDe(op, 'metric') === 'sb_service_ok' ? cuentas.sb : cuentas.cf };
        return undefined;
      },
    }).client;
  });

  it('cuenta los módulos cuyo último intento terminó done; failed entra en missing', async () => {
    scans = [{ steps: [paso('supabase', 'done'), paso('cloudflare', 'failed'), paso('repo', 'skipped')] }];
    cuentas.perf = 1;
    expect(await calcularCobertura(env, ORG)).toEqual({ seen: 2, total: 4, missing: ['cloudflare', 'codebase'] });
  });

  it('la salud de Supabase solo suma con un paso supabase done en 7 días; cf_req_5m suma Cloudflare', async () => {
    scans = [{ steps: [paso('supabase', 'failed')] }, { steps: [paso('supabase', 'done')] }];
    cuentas = { perf: 0, sb: 1, cf: 1 };
    expect(await calcularCobertura(env, ORG)).toEqual({ seen: 2, total: 4, missing: ['codebase', 'performance'] });
    scans = [{ steps: [paso('supabase', 'failed')] }, { steps: null }];
    expect(await calcularCobertura(env, ORG)).toEqual({ seen: 1, total: 4, missing: ['supabase', 'codebase', 'performance'] });
  });
});

describe('escribirDetalleModulo', () => {
  let cobertura: unknown;
  let fallos: { lectura?: boolean; escritura?: boolean; condicion?: boolean };
  let updates: Op[];
  // Escrituras de otro paso que caen entre una lectura y la escritura siguiente (una por lectura, en orden).
  let intrusos: ((c: unknown) => unknown)[];
  beforeEach(() => {
    fallos = {};
    updates = [];
    intrusos = [];
    cobertura = { seen: 3, total: 4, missing: ['performance'],
      detail: { codebase: { miradas: { secretos: true }, hallazgos_omitidos: 2 }, supabase: { miradas: { advisors: true }, viejo: 1 } } };
    estado.client = dbDoble({
      tabla: (op: Op): Resp | undefined => {
        if (op.table !== 'scan_runs') return undefined;
        expect(eqDe(op, 'id')).toBe(SCAN);
        expect(eqDe(op, 'org_id')).toBe(ORG);
        if (op.action === 'update') {
          updates.push(op);
          if (fallos.escritura) return { error: { code: '08006' } };
          // Como PostgREST con coverage=eq.<json>: solo escribe si la fila sigue igual (jsonb compara el valor).
          const cond = eqDe(op, 'coverage');
          if (cond !== undefined && fallos.condicion) return { error: { code: '42883' } };
          if (cond !== undefined && JSON.stringify(JSON.parse(String(cond))) !== JSON.stringify(cobertura)) return { data: [] };
          cobertura = (op.payload as { coverage: unknown }).coverage;
          return { data: [{ id: SCAN }] };
        }
        if (fallos.lectura) return { error: { code: '08006' } };
        const leida = cobertura;
        const intruso = intrusos.shift();
        if (intruso) cobertura = intruso(cobertura);
        return { data: { coverage: leida } };
      },
    }).client;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const m = { scan_run_id: SCAN, org_id: ORG };
  const conCloudflare = (c: unknown) => {
    const x = c as { detail: Record<string, unknown> };
    return { ...x, detail: { ...x.detail, cloudflare: { miradas: { zona: true } } } };
  };
  const eventos = () => vi.mocked(console.log).mock.calls.map(([s]) => JSON.parse(String(s)) as Record<string, unknown>);

  it('sustituye el detalle de su módulo sin pisar el resto de coverage ni el de otros módulos', async () => {
    await escribirDetalleModulo(env, m, 'supabase', { miradas: { advisors: false, sql_rls: true, sql_politicas: true, sql_rpc: true } });
    expect(cobertura).toEqual({ seen: 3, total: 4, missing: ['performance'], detail: {
      codebase: { miradas: { secretos: true }, hallazgos_omitidos: 2 },
      supabase: { miradas: { advisors: false, sql_rls: true, sql_politicas: true, sql_rpc: true } } } });
    await escribirDetalleModulo(env, m, 'cloudflare', { miradas: { zona: true } });
    expect((cobertura as { detail: Record<string, unknown> }).detail).toMatchObject({ cloudflare: { miradas: { zona: true } },
      supabase: { miradas: { advisors: false } }, codebase: { hallazgos_omitidos: 2 } });
  });

  it('la escritura va condicionada a la coverage leída: 1 lectura y 1 escritura si nadie escribió entre medias', async () => {
    const leida = cobertura;
    await escribirDetalleModulo(env, m, 'supabase', { miradas: { advisors: true } });
    expect(updates).toHaveLength(1);
    expect(JSON.parse(String(eqDe(updates[0]!, 'coverage')))).toEqual(leida);
  });

  it('otro paso escribe entre la lectura y la escritura: relee y no pisa su detalle', async () => {
    intrusos = [conCloudflare];
    await escribirDetalleModulo(env, m, 'supabase', { miradas: { advisors: false } });
    expect(updates).toHaveLength(2);
    expect((cobertura as { detail: Record<string, unknown> }).detail).toEqual({
      codebase: { miradas: { secretos: true }, hallazgos_omitidos: 2 }, cloudflare: { miradas: { zona: true } },
      supabase: { miradas: { advisors: false } } });
    expect(eventos()).toEqual([]);
  });

  it('si vuelve a cambiar tras releer, escribe sin condición con lo último leído (como antes) y lo registra', async () => {
    intrusos = [conCloudflare, (c) => ({ ...(c as object), seen: 4 })];
    await escribirDetalleModulo(env, m, 'supabase', { miradas: { advisors: false } });
    expect(updates.map((u) => eqDe(u, 'coverage') !== undefined)).toEqual([true, true, false]);
    expect(cobertura).toMatchObject({ seen: 3, detail: { cloudflare: { miradas: { zona: true } }, supabase: { miradas: { advisors: false } } } });
    expect(eventos()).toContainEqual(expect.objectContaining({ event: 'coverage.sin_condicion', modulo: 'supabase', motivo: 'carrera' }));
  });

  it('si la base rechaza la condición, escribe sin ella a la primera (sin releer)', async () => {
    fallos.condicion = true;
    await escribirDetalleModulo(env, m, 'cloudflare', { miradas: { zona: true } });
    expect(updates.map((u) => eqDe(u, 'coverage') !== undefined)).toEqual([true, false]);
    expect(cobertura).toMatchObject({ detail: { cloudflare: { miradas: { zona: true } }, codebase: { hallazgos_omitidos: 2 } } });
    expect(eventos()).toContainEqual(expect.objectContaining({ event: 'coverage.sin_condicion', motivo: 'error' }));
  });

  it('coverage nula o sin detail: crea detail con solo su módulo (con nula, escritura directa)', async () => {
    cobertura = null;
    await escribirDetalleModulo(env, m, 'cloudflare', { miradas: { zona: false } });
    expect(cobertura).toEqual({ detail: { cloudflare: { miradas: { zona: false } } } });
    expect(updates).toHaveLength(1);
    expect(eqDe(updates[0]!, 'coverage')).toBeUndefined();
  });

  it('si la base falla al leer o al escribir, lanza unavailable', async () => {
    fallos.lectura = true;
    await expect(escribirDetalleModulo(env, m, 'supabase', { miradas: {} })).rejects.toMatchObject({ code: 'unavailable' });
    expect(updates).toEqual([]);
    fallos = { escritura: true };
    await expect(escribirDetalleModulo(env, m, 'supabase', { miradas: {} })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
