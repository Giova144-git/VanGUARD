// Historial de fallas en modo fixtures (E13h/E13t): la demo trae fallas en los cuatro estados con fechas variadas, los
// filtros, la línea de tiempo con la cola de la IA y las fotos, y un PATCH o un «Reabrir» que mueven las fechas como el
// trigger de 0025.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures as fx, FindingHistoryItem, FindingTimeline } from '@vanguard/contracts';
import type { ApiError } from '../errores';
import { fixtureFetch } from './router';

const sesion = vi.hoisted(() => ({ tipo: 'correo' as 'correo' | 'anonima' | null }));
vi.mock('../supabase-doble', () => ({ tipoSesionFalsa: () => sesion.tipo }));

const DEMO = fx.me.orgs[0]!.id;
async function pedir<T = unknown>(ruta: string, method = 'GET', body?: unknown): Promise<T> {
  const p = fixtureFetch<T>(ruta, { method, body });
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(300);
  return p;
}
const historial = async (q = '') => FindingHistoryItem.array().parse(await pedir(`/api/orgs/${DEMO}/findings/history${q}`));
const linea = async (id: string) => FindingTimeline.parse(await pedir(`/api/orgs/${DEMO}/findings/${id}/timeline`));

beforeAll(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-25T12:00:00.000Z') });
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
beforeEach(() => { sesion.tipo = 'correo'; });

describe('fixtures · historial de fallas', () => {
  it('E13h: todas las de la demo, en los cuatro estados, del último cambio al más viejo', async () => {
    const h = await historial();
    expect(new Set(h.map((f) => f.status))).toEqual(new Set(['open', 'fixed', 'verified', 'ignored']));
    expect(h.map((f) => f.id).sort()).toEqual(fx.historialFallas.map((f) => f.id).sort());
    for (let i = 1; i < h.length; i++) expect(Date.parse(h[i - 1]!.changed_at)).toBeGreaterThanOrEqual(Date.parse(h[i]!.changed_at));
    const asc = await historial('?order=asc');
    for (let i = 1; i < asc.length; i++) expect(Date.parse(asc[i - 1]!.changed_at)).toBeLessThanOrEqual(Date.parse(asc[i]!.changed_at));
  });

  it('filtros: estado, módulo, gravedad y días por el último cambio', async () => {
    expect((await historial('?status=verified')).every((f) => f.status === 'verified')).toBe(true);
    expect((await historial('?module=codebase&severity=high')).every((f) => f.module === 'codebase' && f.severity === 'high')).toBe(true);
    const ult = await historial('?days=1');
    expect(ult.every((f) => Date.parse(f.changed_at) >= Date.parse('2026-10-24T12:00:00.000Z'))).toBe(true);
    expect(ult.length).toBeLessThan((await historial()).length);
    const e = await pedir(`/api/orgs/${DEMO}/findings/history?status=abierta`).catch((x: unknown) => x as ApiError);
    expect(e).toMatchObject({ status: 422 });
  });

  it('E13t: la regresión de RLS (salió el jueves, reapareció el sábado) y el índice que arregló tu IA', async () => {
    expect((await linea(fx.lineaTiempoFalla.item.id)).events.map((x) => x.kind)).toEqual(fx.lineaTiempoFalla.events.map((x) => x.kind));
    const indice = fx.historialFallas.find((f) => f.rule_id === 'SB_ADVISOR_UNUSED_INDEX')!;
    expect((await linea(indice.id)).events.map((x) => x.kind)).toEqual(['detectado', 'enviado_ia', 'arreglando', 'corregido', 'visto', 'verificado']);
  });

  it('«Marcar corregido» pone fixed_at y «Reabrir» lo quita; ignorar pone ignored_at', async () => {
    const id = fx.findings.find((f) => f.rule_id === 'SB_RPC_ANON_NO_LIMIT')!.id;
    await pedir(`/api/orgs/${DEMO}/findings/${id}`, 'PATCH', { status: 'fixed' });
    let f = (await historial()).find((x) => x.id === id)!;
    expect(f.status).toBe('fixed');
    expect(Date.parse(f.fixed_at!)).toBeGreaterThanOrEqual(Date.parse('2026-10-25T12:00:00.000Z'));
    expect(f.changed_at).toBe(f.fixed_at);
    expect((await historial())[0]!.id).toBe(id);                                  // el cambio más reciente, arriba
    await pedir(`/api/orgs/${DEMO}/findings/${id}`, 'PATCH', { status: 'open' });
    f = (await historial()).find((x) => x.id === id)!;
    expect([f.status, f.fixed_at]).toEqual(['open', null]);
    await pedir(`/api/orgs/${DEMO}/findings/${id}`, 'PATCH', { status: 'ignored', reason: 'Es de pruebas' });
    expect((await linea(id)).events.map((x) => x.kind)).toContain('ignorado');
  });

  it('una falla de otra org o inexistente → 404', async () => {
    const e = await pedir(`/api/orgs/${DEMO}/findings/f0000000-0000-4000-8000-0000000000ee/timeline`).catch((x: unknown) => x as ApiError);
    expect(e).toMatchObject({ status: 404 });
  });
});
