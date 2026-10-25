// Fixtures de la sandbox (E4): join da una copia por sesión (dueño), latido y salir, y me.orgs[].sandbox.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@vanguard/contracts';
import type { ApiError } from '../errores';

const sesion = vi.hoisted(() => ({ tipo: 'correo' as 'correo' | 'anonima' }));
vi.mock('../supabase-doble', () => ({ tipoSesionFalsa: () => sesion.tipo }));
const { fixtureFetch } = await import('./router');

const pedir = <T>(ruta: string, method = 'GET', body?: unknown) => fixtureFetch<T>(ruta, { method, body });
const fallo = (p: Promise<unknown>) => p.then(() => { throw new Error('no falló'); }, (e: unknown) => e as ApiError);

describe('sandbox en fixtures', () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } });
  });

  it('con cuenta: join crea SU copia (owner, sandbox) sin unirla como viewer a la demo; salir la borra', async () => {
    sesion.tipo = 'correo';
    const { org_id, sandbox } = await pedir<{ org_id: string; sandbox: boolean }>('/api/demo/join', 'POST', {});
    expect(sandbox).toBe(true);
    expect((await pedir<{ org_id: string }>('/api/demo/join', 'POST', {})).org_id).toBe(org_id);   // la misma
    const me = await pedir<Me>('/api/me');
    expect(me.orgs.find((o) => o.id === org_id)).toMatchObject({ role: 'owner', sandbox: true });
    expect(me.orgs.some((o) => o.role === 'viewer')).toBe(false);
    await pedir(`/api/orgs/${org_id}/overview`);                                     // es miembro: tiene datos
    expect(await pedir('/api/demo/latido', 'POST', { org_id })).toBeUndefined();
    expect(await pedir('/api/demo/salir', 'POST', { org_id })).toBeUndefined();
    expect((await pedir<Me>('/api/me')).orgs.some((o) => o.id === org_id)).toBe(false);
    expect(await fallo(pedir('/api/demo/latido', 'POST', { org_id }))).toMatchObject({ status: 404 });
  });

  it('cerrando: un latido antes de 20 s la conserva (recarga); sin latido, a los 20 s ya no existe (cierre)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      sesion.tipo = 'correo';
      const t0 = new Date('2026-10-25T10:00:00Z').getTime();
      vi.setSystemTime(t0);
      const { org_id } = await pedir<{ org_id: string }>('/api/demo/join', 'POST', {});
      expect(await pedir('/api/demo/cerrando', 'POST', { org_id })).toBeUndefined();
      vi.setSystemTime(t0 + 5_000);
      await pedir('/api/demo/latido', 'POST', { org_id });
      vi.setSystemTime(t0 + 60_000);
      expect((await pedir<Me>('/api/me')).orgs.some((o) => o.id === org_id)).toBe(true);
      await pedir('/api/demo/cerrando', 'POST', { org_id });
      vi.setSystemTime(t0 + 81_000);
      expect((await pedir<Me>('/api/me')).orgs.some((o) => o.id === org_id)).toBe(false);
      expect(await fallo(pedir('/api/demo/latido', 'POST', { org_id }))).toMatchObject({ status: 404 });
    } finally { vi.useRealTimers(); }
  });

  it('el invitado solo ve su copia y en ella escribe', async () => {
    sesion.tipo = 'anonima';
    expect((await pedir<Me>('/api/me')).orgs.map((o) => o.role)).toEqual(['viewer']);   // sin copia, el viewer de siempre
    const { org_id } = await pedir<{ org_id: string }>('/api/demo/join', 'POST', {});
    const me = await pedir<Me>('/api/me');
    expect(me.orgs).toEqual([expect.objectContaining({ id: org_id, role: 'owner', sandbox: true })]);
    await expect(pedir(`/api/orgs/${org_id}/incidents/simulate`, 'POST', { kind: 'ip_flood' })).resolves.toBeTruthy();
  });
});
