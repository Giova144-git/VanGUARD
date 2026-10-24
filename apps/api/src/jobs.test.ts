import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanStep } from '@vanguard/contracts';
import { dbDoble, type Op } from './test/db-doble.ts';
import { envDoble, mensajeDoble } from './test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('./lib/db.ts', () => ({ db: () => estado.client }));
const { cierreDlq, registrarPaso, runJob, siguientePaso, pasosDe } = await import('./jobs.ts');
const { ProviderError } = await import('./lib/http.ts');

const SCAN = '5a1c0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
let steps: ScanStep[];
let reclamados: Set<string>;
let doble: ReturnType<typeof dbDoble>;

beforeEach(() => {
  steps = pasosDe('full_audit').map((name) => ({ name, status: 'pending' as const }));
  reclamados = new Set();
  doble = dbDoble({
    tabla: (op: Op) => {
      if (op.table === 'scan_runs' && op.action === 'select') return { data: { id: SCAN, org_id: ORG, kind: 'full_audit', status: 'running', steps } };
      if (op.table === 'scan_runs' && op.action === 'update') {
        const p = op.payload as { steps?: ScanStep[] };
        if (p.steps) steps = p.steps;
      }
      return undefined;
    },
    // vg_claim_step: true solo la primera vez por paso (o al retomar).
    rpc: (name, a) => {
      if (name !== 'vg_claim_step') return undefined;
      const k = String(a.p_paso);
      if (reclamados.has(k) && a.p_retomar !== true) return { data: false };
      reclamados.add(k);
      return { data: true };
    },
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const msg = (paso: string, extra: Record<string, unknown> = {}) =>
  mensajeDoble({ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: paso as 'supabase', ...extra });

describe('cadena de pasos', () => {
  it('siguientePaso recorre fuentes → puntaje → resumen_ia y termina', () => {
    expect(siguientePaso('full_audit', 'supabase')).toBe('cloudflare');
    expect(siguientePaso('full_audit', 'repo')).toBe('puntaje');
    expect(siguientePaso('full_audit', 'puntaje')).toBe('resumen_ia');
    expect(siguientePaso('full_audit', 'resumen_ia')).toBeNull();
    expect(siguientePaso('repo', 'repo')).toBe('puntaje');
    expect(siguientePaso('zip', 'zip')).toBe('puntaje');
  });
});

describe('runJob', () => {
  it('el mismo mensaje dos veces → el paso corre una sola vez', async () => {
    const fn = vi.fn(async () => ({ status: 'done' as const, findings: 3 }));
    registrarPaso('supabase', fn);
    const d = envDoble();
    const m1 = msg('supabase'); const m2 = msg('supabase');
    await runJob(d.env, m1); await runJob(d.env, m2);
    expect(fn).toHaveBeenCalledOnce();
    expect(m1.ack).toHaveBeenCalled(); expect(m2.ack).toHaveBeenCalled();
    expect(d.enviados).toEqual([{ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: 'cloudflare' }]);
    expect(steps.find((s) => s.name === 'supabase')).toEqual({ name: 'supabase', status: 'done', findings: 3 });
  });

  it('error transitorio → retry a 10 s y luego a 20 s; superado el límite → failed y sigue la cadena', async () => {
    registrarPaso('supabase', async () => { throw new ProviderError('unavailable', 503); });
    const d = envDoble();
    const a1 = msg('supabase');
    await runJob(d.env, a1);
    expect(a1.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    const a2 = Object.assign(msg('supabase'), { attempts: 2 });
    await runJob(d.env, a2);
    expect(a2.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    const a3 = Object.assign(msg('supabase'), { attempts: 3 });
    await runJob(d.env, a3);
    expect(a3.retry).not.toHaveBeenCalled();
    expect(steps.find((s) => s.name === 'supabase')).toMatchObject({ status: 'failed', error_code: 'unavailable' });
    expect(d.enviados.at(-1)).toMatchObject({ paso: 'cloudflare' });
  });

  it('un 401 del proveedor no se reintenta: failed y se encola el siguiente', async () => {
    registrarPaso('cloudflare', async () => { throw new ProviderError('unauthorized', 401); });
    const d = envDoble();
    const m = msg('cloudflare');
    await runJob(d.env, m);
    expect(m.retry).not.toHaveBeenCalled();
    expect(steps.find((s) => s.name === 'cloudflare')).toMatchObject({ status: 'failed', error_code: 'unauthorized' });
    expect(d.enviados).toEqual([expect.objectContaining({ paso: 'repo' })]);
  });

  it('continuar re-encola el mismo paso con cursor y deja el paso en running', async () => {
    registrarPaso('repo', async () => ({ continuar: { cursor: 'osv', deps: [['npm', 'lodash', '4.17.15', 0]] } }));
    const d = envDoble();
    await runJob(d.env, msg('repo'));
    expect(d.enviados).toEqual([{ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: 'repo', cursor: 'osv',
      deps: [['npm', 'lodash', '4.17.15', 0]] }]);
  });

  it('resumen_ia cierra con fin: succeeded aunque falle una fuente; failed si fallan todas', async () => {
    registrarPaso('resumen_ia', async () => ({ status: 'done' as const }));
    steps = steps.map((s) => (s.name === 'resumen_ia' ? s : { ...s, status: s.name === 'repo' ? 'failed' : 'done' }));
    await runJob(envDoble().env, msg('resumen_ia'));
    const fin = doble.ops.filter((o) => o.table === 'scan_runs' && o.action === 'update').at(-1);
    expect(fin?.payload).toMatchObject({ status: 'succeeded', progress: 100 });

    reclamados.clear();
    steps = steps.map((s) => (s.name === 'resumen_ia' ? { ...s, status: 'pending' } : { ...s, status: 'failed' }));
    await runJob(envDoble().env, msg('resumen_ia'));
    const fin2 = doble.ops.filter((o) => o.table === 'scan_runs' && o.action === 'update').at(-1);
    expect(fin2?.payload).toMatchObject({ status: 'failed' });
  });
});

describe('cierreDlq', () => {
  it('mensaje de vg-jobs-dlq → paso failed con dlq y la cadena sigue', async () => {
    const d = envDoble();
    const m = msg('repo');
    await cierreDlq(d.env, m);
    expect(steps.find((s) => s.name === 'repo')).toMatchObject({ status: 'failed', error_code: 'dlq' });
    expect(d.enviados).toEqual([expect.objectContaining({ paso: 'puntaje' })]);
    expect(m.ack).toHaveBeenCalled();
  });
});
