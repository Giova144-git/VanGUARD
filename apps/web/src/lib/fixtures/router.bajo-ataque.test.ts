// E55 del router de fixtures con inundaciones sin host (el nombre de la conexión de ingesta no es un host), que la demo no
// trae: se añaden a fx.incidents. El orden es el de ofreceBajoAtaque de core y leerOfertaBajoAtaque del BACK: no_aplica →
// cerrado → sin_host. Un incidente resuelto sin host es «cerrado» (E56: 409 resolved), no «sin_host» (422); y sin host,
// hostname null e ips 0.
import { describe, expect, it, vi } from 'vitest';
import { fixtures as fx } from '@vanguard/contracts';
import type { ApiError } from '../errores';
import { fixtureFetch } from './router';

const IDS = vi.hoisted(() => ({ cerrado: 'ab000000-0000-4000-8000-0000000000c1', abierto: 'ab000000-0000-4000-8000-0000000000c2' }));
vi.mock('../supabase-doble', () => ({ tipoSesionFalsa: () => 'correo' }));
vi.mock('@vanguard/contracts', async (importOriginal) => {
  const r = await importOriginal<typeof import('@vanguard/contracts')>();
  const { host: _host, ...sinHost } = r.fixtures.incidentDetail.details;
  const { notifications: _n, actions: _a, timeline: _t, ...base } = r.fixtures.incidentDetail;
  const inundacion = { ...base, details: sinHost };
  return { ...r, fixtures: { ...r.fixtures, incidents: [...r.fixtures.incidents,
    { ...inundacion, id: IDS.cerrado, code: 'C1C1C1', status: 'resolved', resolved_at: '2026-10-24T19:30:00.000Z' },
    { ...inundacion, id: IDS.abierto, code: 'C2C2C2' }] } };
});

const DEMO = fx.me.orgs[0]!.id;
const E55 = (id: string) => `/api/orgs/${DEMO}/incidents/${id}/under-attack`;
const pedir = (ruta: string, method = 'GET') => fixtureFetch<Record<string, unknown>>(ruta, { method, body: method === 'POST' ? {} : undefined });
const fallo = (ruta: string) => pedir(ruta, 'POST').then(() => { throw new Error(`${ruta} no falló`); }, (e: unknown) => e as ApiError);

describe('E55 de fixtures sin host, en el orden de leerOfertaBajoAtaque', () => {
  it('resuelto y sin host: cerrado (no sin_host), hostname null e ips 0; E56 da 409 resolved', async () => {
    expect(await pedir(E55(IDS.cerrado))).toMatchObject({ ofrece: false, motivo: 'cerrado', hostname: null, ips: 0, scopes: [], copiar: null, activo: null });
    expect(await fallo(`${E55(IDS.cerrado)}/propose`)).toMatchObject({ status: 409, details: { reason: 'resolved' } });
  });

  it('abierto y sin host: sin_host, hostname null e ips 0; E56 da 422 sin_host', async () => {
    expect(await pedir(E55(IDS.abierto))).toMatchObject({ ofrece: false, motivo: 'sin_host', hostname: null, ips: 0, scopes: [], copiar: null });
    expect(await fallo(`${E55(IDS.abierto)}/propose`)).toMatchObject({ status: 422, details: { reason: 'sin_host' } });
  });

  it('la inundación de la demo, con host, sigue con la oferta de siempre', async () => {
    expect(await pedir(E55(fx.incidentDetail.id))).toEqual(fx.underAttackOffer);
  });
});
