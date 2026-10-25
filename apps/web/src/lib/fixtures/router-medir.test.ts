// «Medir ahora» en modo fixtures (F-17): E11 con kind 'lighthouse' simula la medición de S10 §10.4 y al terminar deja
// un punto nuevo (3 repeticiones, un run_group) en perf/runs. Mismo arnés que router.test.ts: reloj falso y sesión doble.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures as fx, PerfRunExt, ScanRun } from '@vanguard/contracts';
import { z } from 'zod';
import type { ApiError } from '../errores';
import { fixtureFetch } from './router';

const sesion = vi.hoisted(() => ({ tipo: 'correo' as 'correo' | 'anonima' | null }));
vi.mock('../supabase-doble', () => ({ tipoSesionFalsa: () => sesion.tipo }));

const DEMO = fx.me.orgs[0]!.id;
const AJENA = '0f0f0f0f-0000-4000-8000-000000000001';
const URL_DEMO = 'https://demo.officialvanguard.com/';
const MEDIR = { kind: 'lighthouse', url: URL_DEMO, strategy: 'mobile', version_label: 'v3' };

async function pedir<T = unknown>(ruta: string, method = 'GET', body?: unknown): Promise<T> {
  const p = fixtureFetch<T>(ruta, { method, body });
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(300);
  return p;
}
const fallo = (ruta: string, method?: string, body?: unknown) =>
  pedir(ruta, method, body).then(() => { throw new Error(`${ruta} no falló`); }, (e: unknown) => e as ApiError);

beforeAll(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-25T12:00:00.000Z') });
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
beforeEach(() => { sesion.tipo = 'correo'; });

describe('fixtures · Medir ahora', () => {
  it('rechaza lo que rechazaría el BACK: anónimo 403, http 422, fuera de las zonas 422, org ajena 404', async () => {
    sesion.tipo = 'anonima';
    expect(await fallo(`/api/orgs/${DEMO}/scans`, 'POST', MEDIR)).toMatchObject({ status: 403 });
    sesion.tipo = 'correo';
    expect(await fallo(`/api/orgs/${DEMO}/scans`, 'POST', { ...MEDIR, url: 'http://demo.officialvanguard.com/' })).toMatchObject({ status: 422, code: 'invalid_body' });
    expect(await fallo(`/api/orgs/${DEMO}/scans`, 'POST', { ...MEDIR, url: 'https://officialvanguard.com.evil.test/' }))
      .toMatchObject({ status: 422, message: 'Solo dominios de tus zonas: officialvanguard.com' });
    expect(await fallo(`/api/orgs/${AJENA}/scans`, 'POST', MEDIR)).toMatchObject({ status: 404 });
  });

  it('202 → la auditoría kind lighthouse avanza por psi-mobile y termina; 409 con su id mientras corre; un punto más en perf/runs', async () => {
    const antes = z.array(z.unknown()).parse(await pedir(`/api/orgs/${DEMO}/perf/runs?limit=30`)).length;
    const { scan_run_id: id } = await pedir<{ scan_run_id: string }>(`/api/orgs/${DEMO}/scans`, 'POST', MEDIR);
    const corriendo = ScanRun.parse(await pedir(`/api/orgs/${DEMO}/scans/${id}`));
    expect(corriendo).toMatchObject({ kind: 'lighthouse', status: 'running', step: 'psi-mobile', steps: [{ name: 'psi', status: 'running' }] });
    expect(await fallo(`/api/orgs/${DEMO}/scans`, 'POST', MEDIR)).toMatchObject({ status: 409, details: { scan_run_id: id } });
    expect(await fallo(`/api/orgs/${AJENA}/scans/${id}`)).toMatchObject({ status: 404 });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(ScanRun.parse(await pedir(`/api/orgs/${DEMO}/scans/${id}`))).toMatchObject({ status: 'succeeded', progress: 100, step: null });
    const runs = z.array(PerfRunExt).parse(await pedir(`/api/orgs/${DEMO}/perf/runs?limit=30`));   // cumplen E24
    expect(runs.length).toBe(Math.min(30, antes + 3));
    const nuevas = runs.slice(0, 3);
    expect(new Set(nuevas.map((r) => r.run_group)).size).toBe(1);
    expect(nuevas.every((r) => r.url === URL_DEMO && r.strategy === 'mobile' && r.version_label === 'v3' && r.trigger === 'manual')).toBe(true);
  });
});
