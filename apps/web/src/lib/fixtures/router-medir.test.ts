// «Medir ahora» en modo fixtures (F-17): E11 con kind 'lighthouse' simula al BACK real (rutas/scans.ts y scans/psi.ts):
// sin zona de Cloudflare, los mismos rechazos y mensajes de urlMedible, el 409 de la que está en curso, el tope diario
// y, al terminar, UNA fila nueva (rep 1, run_group = el scan) en perf/runs. Mismo arnés que router.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures as fx, Org, PerfRunExt, ScanRun } from '@vanguard/contracts';
import { z } from 'zod';
import type { ApiError } from '../errores';
import { fixtureFetch } from './router';

const sesion = vi.hoisted(() => ({ tipo: 'correo' as 'correo' | 'anonima' | null }));
vi.mock('../supabase-doble', () => ({ tipoSesionFalsa: () => sesion.tipo }));

const DEMO = fx.me.orgs[0]!.id;
const AJENA = '0f0f0f0f-0000-4000-8000-000000000001';
const URL_DEMO = 'https://demo.officialvanguard.com/';
const VICTIMA = 'https://vanguard-demo-victima.pages.dev/';
const MEDIR = { kind: 'lighthouse', url: URL_DEMO, strategy: 'mobile', version_label: 'v3' };

async function pedir<T = unknown>(ruta: string, method = 'GET', body?: unknown): Promise<T> {
  const p = fixtureFetch<T>(ruta, { method, body });
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(300);
  return p;
}
const fallo = (ruta: string, method?: string, body?: unknown) =>
  pedir(ruta, method, body).then(() => { throw new Error(`${ruta} no falló`); }, (e: unknown) => e as ApiError);
const rechazo = (motivo: string, mensaje: string) =>
  ({ status: 422, code: 'invalid_body', message: mensaje, details: { reason: motivo, field_errors: { url: [mensaje] } } });

beforeAll(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-25T12:00:00.000Z') });
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
beforeEach(() => { sesion.tipo = 'correo'; });

describe('fixtures · Medir ahora', () => {
  it('rechaza lo que rechazaría el BACK: anónimo 403, http 422, org ajena 404 y cada motivo de urlMedible con su mensaje', async () => {
    const scans = `/api/orgs/${DEMO}/scans`;
    sesion.tipo = 'anonima';
    expect(await fallo(scans, 'POST', MEDIR)).toMatchObject({ status: 403 });
    sesion.tipo = 'correo';
    expect(await fallo(scans, 'POST', { ...MEDIR, url: 'http://demo.officialvanguard.com/' })).toMatchObject({ status: 422, code: 'invalid_body' });
    expect(await fallo(`/api/orgs/${AJENA}/scans`, 'POST', MEDIR)).toMatchObject({ status: 404 });
    const casos: [string, string, string][] = [
      ['https://127.0.0.1/', 'ip', 'No medimos direcciones IP: usa el dominio del sitio'],
      ['https://[::1]/', 'ip', 'No medimos direcciones IP: usa el dominio del sitio'],
      ['https://localhost/', 'interno', 'No medimos hosts locales ni de red interna'],
      ['https://nas.local/', 'interno', 'No medimos hosts locales ni de red interna'],
      ['https://api.internal/', 'interno', 'No medimos hosts locales ni de red interna'],
      ['https://tienda.com:8443/', 'puerto', 'Solo medimos el puerto estándar de https (443)'],
      ['https://yo:clave@tienda.com/', 'credenciales', 'Quita el usuario y la contraseña de la URL'],
      ['https://officialvanguard.com/', 'propio', 'Esa URL es de VanGUARD: mide la de tu sitio'],
      ['https://www.officialvanguard.com/precios', 'propio', 'Esa URL es de VanGUARD: mide la de tu sitio'],
      [`https://tienda.com/${'ghp_'}${'a'.repeat(24)}`, 'secreto', 'La URL parece llevar un secreto: quítalo antes de medir'],
    ];
    for (const [url, motivo, mensaje] of casos) expect(await fallo(scans, 'POST', { ...MEDIR, url }), url).toMatchObject(rechazo(motivo, mensaje));
  });

  it('sin zona de Cloudflare: una org nueva (sin conexiones) mide la víctima real; la de demo.officialvanguard.com, solo la demo', async () => {
    const org = Org.parse(await pedir('/api/orgs', 'POST', { name: 'Tienda nueva' }));
    expect(z.array(z.unknown()).parse(await pedir(`/api/orgs/${org.id}/connections`))).toEqual([]);
    expect(await fallo(`/api/orgs/${org.id}/scans`, 'POST', { ...MEDIR, url: URL_DEMO })).toMatchObject(rechazo('propio', 'Esa URL es de VanGUARD: mide la de tu sitio'));
    const { scan_run_id: id } = await pedir<{ scan_run_id: string }>(`/api/orgs/${org.id}/scans`, 'POST', { kind: 'lighthouse', url: `${VICTIMA}?utm=1#x`, strategy: 'desktop' });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(ScanRun.parse(await pedir(`/api/orgs/${org.id}/scans/${id}`))).toMatchObject({ status: 'succeeded' });
    const runs = z.array(PerfRunExt).parse(await pedir(`/api/orgs/${org.id}/perf/runs?limit=30`));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ url: VICTIMA, strategy: 'desktop', run_group: id, rep: 1, version_label: null });   // https://host/ruta, sin query
  });

  it('202 → la auditoría kind lighthouse corre en el paso psi y termina; 409 con su id mientras corre; UNA fila más en perf/runs', async () => {
    const antes = z.array(z.unknown()).parse(await pedir(`/api/orgs/${DEMO}/perf/runs?limit=30`)).length;
    const { scan_run_id: id } = await pedir<{ scan_run_id: string }>(`/api/orgs/${DEMO}/scans`, 'POST', MEDIR);
    const corriendo = ScanRun.parse(await pedir(`/api/orgs/${DEMO}/scans/${id}`));
    expect(corriendo).toMatchObject({ kind: 'lighthouse', status: 'running', step: 'psi', steps: [{ name: 'psi', status: 'running' }] });
    // Móvil y escritorio son dos peticiones: la segunda, mientras corre la primera, da el 409 con el id de la que corre.
    expect(await fallo(`/api/orgs/${DEMO}/scans`, 'POST', { ...MEDIR, strategy: 'desktop' }))
      .toMatchObject({ status: 409, code: 'conflict', message: 'Ya hay una medición de rendimiento en curso: espera a que termine', details: { scan_run_id: id } });
    expect(await fallo(`/api/orgs/${AJENA}/scans/${id}`)).toMatchObject({ status: 404 });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(ScanRun.parse(await pedir(`/api/orgs/${DEMO}/scans/${id}`))).toMatchObject({ status: 'succeeded', progress: 100, step: null });
    const runs = z.array(PerfRunExt).parse(await pedir(`/api/orgs/${DEMO}/perf/runs?limit=30`));   // cumplen E24
    expect(runs.length).toBe(Math.min(30, antes + 1));
    expect(runs[0]).toMatchObject({ url: URL_DEMO, strategy: 'mobile', version_label: 'v3', trigger: 'manual', run_group: id, rep: 1,
      is_representative: true, lighthouse_version: '13.5.0' });
    expect(runs.filter((r) => r.run_group === id)).toHaveLength(1);
  });

  it('tope diario: la medición 21 del día en la demo da 429 budget_exceeded con el mensaje del servidor', async () => {
    let r: unknown = null;
    for (let i = 0; i < 25 && !r; i++) {
      await vi.advanceTimersByTimeAsync(8_000);                                          // que no quede ninguna en curso
      r = await pedir(`/api/orgs/${DEMO}/scans`, 'POST', MEDIR).then(() => null, (e: unknown) => e);
    }
    expect(r).toMatchObject({ status: 429, code: 'budget_exceeded', message: 'Ya hiciste 20 mediciones de rendimiento hoy, el máximo diario. Vuelve mañana.' });
  });
});
