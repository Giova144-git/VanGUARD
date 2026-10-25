// «Modo bajo ataque»: la bandera del servidor (asignaciones/modo-bajo-ataque.md §9) oculta la tarjeta ante CUALQUIER fallo
// de la primera lectura de E55 (404, 5xx, red o una forma fuera de contrato), no solo el 404, y el incidente, que ya
// existía, queda con el mismo HTML que si la función no existiera: ni ErrorBloque, ni role="alert", ni la tarjeta. Tras
// una lectura buena, un fallo pasajero deja lo último; un 404 (el corte del domingo) la quita. La lectura pasa por el
// queryFn real de useOfertaBajoAtaque con api() simulada. Sin jsdom: renderToStaticMarkup y la caché a mano.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, IncidentDetail } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { useOfertaBajoAtaque } from '@/lib/consultas';
import { ApiError } from '@/lib/errores';
import { BajoAtaque } from './BajoAtaque';
import PaginaIncidente from './PaginaIncidente';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api }));
// «Como si la función no existiera»: con `apagada.si` la tarjeta ni se monta ni consulta, y el incidente es el de antes.
const apagada = vi.hoisted(() => ({ si: false }));
vi.mock('./BajoAtaque', async (importOriginal) => {
  const real = await importOriginal<typeof import('./BajoAtaque')>();
  return { ...real, BajoAtaque: (p: Parameters<typeof real.BajoAtaque>[0]) => (apagada.si ? null : createElement(real.BajoAtaque, p)) };
});

const ORG = fx.me.orgs[0]!.id;
const INC = fx.incidentDetail.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const E55 = `/api/orgs/${ORG}/incidents/${INC}/under-attack`;
const CLAVE = ['org', ORG, 'under-attack', INC];
// La inundación de la demo (CF_IP_FLOOD: la tarjeta se monta) y la misma con el modo ya activo en el incidente (otra
// pestaña, o activado antes del corte): también se monta, por `ejecutada`.
const INUNDACION = IncidentDetail.parse(fx.incidentDetail);
const CON_MODO = IncidentDetail.parse({ ...fx.incidentDetail, status: 'mitigated',
  actions: [{ id: 'ac000000-0000-4000-8000-000000000001', kind: 'under_attack_on', target: 'demo.officialvanguard.com', status: 'executed',
    created_at: '2026-10-24T19:12:00.000Z', undone_at: null, expires_at: '2099-10-24T19:42:00.000Z', approval_id: null }] });

// Lo que puede devolver api() en la primera lectura: el rechazo tal como lo modela lib/api.ts (aError, ApiError 0 de
// red, contract_mismatch en desarrollo) o, en producción, el cuerpo crudo que no cumple el esquema (ZodError del parse).
const FALLOS: [string, () => Promise<unknown>][] = [
  ['404 (BACK sin la ruta, o quitada en el corte)', () => Promise.reject(new ApiError(404, 'not_found', 'Ruta inexistente'))],
  ['500', () => Promise.reject(new ApiError(500, 'internal', 'Algo falló', 'req_e55'))],
  ['503 de Cloudflare con cuerpo HTML', () => Promise.reject(new ApiError(503, 'internal', 'Algo falló'))],
  ['403', () => Promise.reject(new ApiError(403, 'forbidden', 'Sin acceso a esta organización'))],
  ['red (ApiError 0 de api())', () => Promise.reject(new ApiError(0, 'network', 'Sin conexión con VanGUARD'))],
  ['red (TypeError de fetch sin envolver)', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['contract_mismatch (api() en desarrollo)', () => Promise.reject(new ApiError(200, 'contract_mismatch', `La respuesta de ${E55} no cumple el contrato`))],
  ['forma fuera de contrato: un motivo nuevo', () => Promise.resolve({ ...fx.underAttackOffer, motivo: 'motivo_nuevo' })],
  ['forma fuera de contrato: sin ips', () => Promise.resolve({ ...fx.underAttackOffer, ips: undefined })],
  ['cuerpo vacío o no JSON (null)', () => Promise.resolve(null)],
  ['una página HTML en vez de JSON', () => Promise.resolve('<!doctype html><title>VanGUARD</title>')],
];
const ES_ZOD = /forma fuera de contrato|cuerpo vacío|página HTML/;

// retryOnMount: false. Cada renderToStaticMarkup monta un observador nuevo, y con el valor por defecto una consulta en
// error y sin datos se pinta como «cargando» (la reintentaría al montar): la prueba pasaría sin ver nunca el error. Así se
// pinta lo que ve en el navegador la tarjeta ya montada cuando falla su lectura.
const nuevaCache = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
function conCache(qc: QueryClient, hijo: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/o/${ORG}/incidents/${INC}`]}>
        <OrgDePrueba org={ADMIN}>{hijo}</OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const tarjeta = (qc: QueryClient, i: IncidentDetail) => conCache(qc,
  <BajoAtaque org={ORG} incidentId={INC} puedeEscribir ejecutada={i.actions.find((a) => a.kind === 'under_attack_on' && a.status === 'executed')} />);
// El incidente entero con las conexiones de la demo (hay Modo blindaje: también se pinta «Bloquear esta IP»).
function pagina(qc: QueryClient, i: IncidentDetail) {
  qc.setQueryData(['org', ORG, 'incident', INC], i);
  qc.setQueryData(['org', ORG, 'connections'], fx.connections);
  return conCache(qc, <Routes><Route path="/o/:orgId/incidents/:incidentId" element={<PaginaIncidente />} /></Routes>);
}
// Lo que devuelve el hook al pintar, el mismo estado que lee la tarjeta.
function vista(qc: QueryClient) {
  let r: ReturnType<typeof useOfertaBajoAtaque> | undefined;
  function Sonda() { r = useOfertaBajoAtaque(ORG, INC); return null; }
  conCache(qc, <Sonda />);
  return r!;
}
function sinLaFuncion(i: IncidentDetail) {
  apagada.si = true;
  try { return pagina(nuevaCache(), i); } finally { apagada.si = false; }
}

// Una lectura de E55 por el queryFn del hook: el primer pintado crea la consulta con sus opciones (en el servidor no
// corren efectos, así que no pide), se lanza su fetch con lo que responda api() y se vuelve a pintar.
async function leer(qc: QueryClient, respuesta: () => Promise<unknown>) {
  api.mockImplementation((ruta: string) => (ruta === E55 ? respuesta() : Promise.reject(new Error(`ruta inesperada: ${ruta}`))));
  const q = qc.getQueryCache().find({ queryKey: CLAVE });
  expect(q?.options.queryFn).toBeTypeOf('function');
  await q!.fetch().catch(() => undefined);
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-24T19:20:00.000Z')); });   // el cronómetro no cambia entre pintados
afterEach(() => { vi.useRealTimers(); api.mockReset(); });

describe('BajoAtaque · la bandera oculta cualquier fallo de la primera lectura de E55', () => {
  it('un incidente sin inundación ni modo activo ni monta la tarjeta: E55 no se consulta', () => {
    const qc = nuevaCache();
    const sin = IncidentDetail.parse({ ...fx.incidentDetail, rule_ids: fx.incidentDetail.rule_ids.filter((r) => r !== 'CF_IP_FLOOD') });
    expect(pagina(qc, sin)).toBe(sinLaFuncion(sin));
    expect(qc.getQueryCache().find({ queryKey: CLAVE })).toBeUndefined();
  });

  it.each(FALLOS)('E55 con %s: la tarjeta no pinta nada', async (nombre, respuesta) => {
    const qc = nuevaCache();
    expect(tarjeta(qc, INUNDACION)).toBe('');                               // cargando: nada
    await leer(qc, respuesta);
    const v = vista(qc);                                                    // la tarjeta lo ve en error, sin datos
    expect(v.isError).toBe(true);
    expect(v.data).toBeUndefined();
    if (ES_ZOD.test(nombre)) expect(v.error).toBeInstanceOf(z.ZodError);
    expect(api).toHaveBeenCalledWith(E55, expect.objectContaining({ esquema: expect.anything() }));
    expect(tarjeta(qc, INUNDACION)).toBe('');
    expect(tarjeta(qc, CON_MODO)).toBe('');                                 // ni con el modo activo en el incidente
  });

  describe.each([['una inundación', INUNDACION], ['el modo ya activo en el incidente', CON_MODO]] as const)('el incidente con %s', (_, i) => {
    it.each(FALLOS)('E55 con %s: el mismo HTML que sin la función, sin ErrorBloque ni role="alert"', async (_n, respuesta) => {
      const antes = sinLaFuncion(i);
      const qc = nuevaCache();
      expect(pagina(qc, i)).toBe(antes);
      await leer(qc, respuesta);
      expect(vista(qc).isError).toBe(true);
      const html = pagina(qc, i);
      expect(html).toBe(antes);
      expect(html).toContain('Bloquear esta IP');                           // la página de antes sigue entera
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('Activar modo bajo ataque');
      expect(html).not.toContain('Desactivar ahora');
      expect(html).not.toContain('aria-label="Modo bajo ataque"');
    });
  });
});

// La duración de la vista previa y de la nota del botón sale de ttl_s: uno fuera de contrato (300..3600 entero) no llega a
// pintarse, ni como «1 min» ni como «NaN min»; tras una lectura buena se queda la duración de esa lectura.
describe('BajoAtaque · ttl_s fuera de contrato en E55', () => {
  const SIN_PERMISO = { ...fx.underAttackOfferSinPermiso, ttl_s: 3600 };
  const RAROS: [string, unknown][] = [['0', 0], ['60', 60], ['7200', 7200], ['ausente', undefined], ['1800.5', 1800.5], ['«1800»', '1800'], ['null', null]];
  const ofertas = [['permiso ok', fx.underAttackOffer], ['sin_permiso', fx.underAttackOfferSinPermiso],
    ['sin_conexion', { ...fx.underAttackOfferSinPermiso, motivo: 'sin_conexion', zone_name: null, connection_id: null, permiso: null }]] as const;

  it.each(RAROS)('ttl_s %s en la primera lectura: la tarjeta no pinta nada (ni botón ni vista previa)', async (_n, ttl_s) => {
    for (const [, oferta] of ofertas) {
      const qc = nuevaCache();
      tarjeta(qc, INUNDACION);
      await leer(qc, () => Promise.resolve({ ...oferta, ttl_s }));
      expect(vista(qc).error).toBeInstanceOf(z.ZodError);
      expect(tarjeta(qc, INUNDACION)).toBe('');
    }
  });

  it.each(RAROS)('ttl_s %s después de una lectura buena: sigue la duración de esa lectura', async (_n, ttl_s) => {
    const qc = nuevaCache();
    tarjeta(qc, INUNDACION);
    await leer(qc, () => Promise.resolve(SIN_PERMISO));
    expect(tarjeta(qc, INUNDACION)).toContain('pasará un desafío de Cloudflare durante 1 h.');
    await leer(qc, () => Promise.resolve({ ...SIN_PERMISO, ttl_s }));
    const html = tarjeta(qc, INUNDACION);
    expect(html).toContain('pasará un desafío de Cloudflare durante 1 h.');
    expect(html).not.toMatch(/NaN|durante 1 min|durante 0 min|durante 2 h/);
  });
});

describe('BajoAtaque · tras una lectura buena de E55', () => {
  it.each(FALLOS.filter(([n]) => !n.startsWith('404')))('un fallo después (%s) deja la última oferta, sin role="alert"', async (_n, respuesta) => {
    const qc = nuevaCache();
    pagina(qc, INUNDACION);
    await leer(qc, () => Promise.resolve(fx.underAttackOffer));
    expect(tarjeta(qc, INUNDACION)).toContain('Activar modo bajo ataque');
    await leer(qc, respuesta);
    const v = vista(qc);                                                    // en error, con la última oferta
    expect(v.isError).toBe(true);
    expect(v.data).toEqual(fx.underAttackOffer);
    const html = pagina(qc, INUNDACION);
    expect(html).toContain('Activar modo bajo ataque');
    expect(html).not.toContain('role="alert"');
  });

  it('con el modo activo, un 500 después no esconde «Desactivar ahora»', async () => {
    const qc = nuevaCache();
    pagina(qc, CON_MODO);
    const activo = { action_id: CON_MODO.actions[0]!.id, scope: 'host', target: 'demo.officialvanguard.com',
      created_at: '2026-10-24T19:12:00.000Z', expires_at: '2099-10-24T19:42:00.000Z', retirada_fallida: false };
    await leer(qc, () => Promise.resolve({ ...fx.underAttackOffer, activo }));
    await leer(qc, () => Promise.reject(new ApiError(500, 'internal', 'Algo falló')));
    expect(pagina(qc, CON_MODO)).toContain('Desactivar ahora');
  });

  it('un 404 después (la ruta quitada en el corte del domingo) quita la tarjeta: el incidente vuelve al HTML sin la función', async () => {
    const antes = sinLaFuncion(INUNDACION);
    const qc = nuevaCache();
    pagina(qc, INUNDACION);
    await leer(qc, () => Promise.resolve(fx.underAttackOffer));
    expect(pagina(qc, INUNDACION)).not.toBe(antes);
    await leer(qc, () => Promise.reject(new ApiError(404, 'not_found', 'Ruta inexistente')));
    expect(pagina(qc, INUNDACION)).toBe(antes);
  });
});
