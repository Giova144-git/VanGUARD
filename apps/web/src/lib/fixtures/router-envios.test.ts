// «Enviar a mi IA» en modo fixtures (E58/E58b): la cola de la demo trae los tres estados; crear es idempotente, una nueva
// pasa sola a «arreglando» (como si la IA la tomara por MCP), marcar corregido la cierra y el anónimo de la demo → 403.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures as fx, FixRequest } from '@vanguard/contracts';
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
const fallo = (ruta: string, method?: string, body?: unknown) =>
  pedir(ruta, method, body).then(() => { throw new Error(`${ruta} no falló`); }, (e: unknown) => e as ApiError);
const cola = async () => FixRequest.array().parse(await pedir(`/api/orgs/${DEMO}/fix-requests`));

beforeAll(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-25T12:00:00.000Z') });
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
beforeEach(() => { sesion.tipo = 'correo'; });

describe('fixtures · cola «Enviar a mi IA»', () => {
  it('la demo trae enviado, arreglando y corregido', async () => {
    expect((await cola()).map((x) => x.status).sort()).toEqual(['arreglando', 'corregido', 'enviado']);
  });

  it('crear es idempotente, pasa a arreglando a los 8 s y «Marcar corregido» la cierra', async () => {
    const libre = fx.findings.find((f) => f.status === 'open' && !fx.fixRequests.some((x) => x.finding_id === f.id))!;
    const a = FixRequest.parse(await pedir(`/api/orgs/${DEMO}/findings/${libre.id}/fix-requests`, 'POST', { client: 'claude_code' }));
    const b = FixRequest.parse(await pedir(`/api/orgs/${DEMO}/findings/${libre.id}/fix-requests`, 'POST', { client: 'vscode' }));
    expect(b.id).toBe(a.id);
    expect(a.status).toBe('enviado');
    await vi.advanceTimersByTimeAsync(9_000);
    expect((await cola()).find((x) => x.finding_id === libre.id)?.status).toBe('arreglando');
    await pedir(`/api/orgs/${DEMO}/findings/${libre.id}`, 'PATCH', { status: 'fixed' });
    expect((await cola()).find((x) => x.finding_id === libre.id)?.status).toBe('corregido');
    expect(await fallo(`/api/orgs/${DEMO}/findings/${libre.id}/fix-requests`, 'POST')).toMatchObject({ status: 409 });
  });

  it('cancelar; anónimo de la demo → 403', async () => {
    const f = fx.fixRequests.find((x) => x.status === 'enviado')!.finding_id;
    await pedir(`/api/orgs/${DEMO}/findings/${f}/fix-requests`, 'DELETE');
    expect((await cola()).find((x) => x.finding_id === f)?.status).toBe('cancelado');
    sesion.tipo = 'anonima';
    expect(await fallo(`/api/orgs/${DEMO}/findings/${f}/fix-requests`, 'POST')).toMatchObject({ status: 403 });
  });
});
