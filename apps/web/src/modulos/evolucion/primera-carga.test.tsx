// Bandera de la evolución en la PRIMERA carga (condición para subirla por partes): no solo el 404. E51 con 404, 403, 500, red,
// contrato roto en desarrollo o un cuerpo fuera de contrato en producción (api() lo deja pasar y el ZodError sale del
// parse de consultas.ts) deja el Resumen y la Auditoría con el mismo HTML que sin leer E51: ni ErrorBloque, ni
// role="alert", ni el título. El error no se pone a mano en la caché: sale de correr el queryFn del hook con api()
// simulado. Tras una lectura buena, un fallo deja lo último que hubo. /evolution, página propia: con 404 «llega pronto»;
// con lo demás, ErrorBloque con «Reintentar», sin tumbar la ruta. Sin jsdom: renderToStaticMarkup, como Cambios.test.tsx.
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, AuditDelta, ConnectionPublic, Evolution, Finding, Overview } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import PaginaResumen from '@/modulos/resumen/PaginaResumen';
import PaginaEvolucion from './PaginaEvolucion';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api }));

const ORG = fx.me.orgs[0]!.id;
const ID = fx.scanDone.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', me: fx.meViewer, puedeEscribir: false };
const CLAVE_DELTA = ['org', ORG, 'scan', ID, 'delta'];
const CLAVE_EVO = ['org', ORG, 'evolution', 30];
const OVERVIEW = Overview.parse({ ...fx.overview, last_scan: { id: ID, status: 'succeeded', finished_at: fx.scanDone.finished_at } });
const ABIERTOS = z.array(Finding).parse(fx.findings).filter((f) => f.status === 'open');

// Lo que puede salir de api() en la primera carga en vez de un cuerpo bueno. `forma`: lo que api() devuelve en producción
// con un cuerpo que no cumple el esquema (solo avisa en consola); el parse del hook lo convierte en ZodError.
type Fallo = { nombre: string; respuesta: () => Promise<unknown>; mensaje: string };
const falla = (e: Error) => () => Promise.reject(e);
const fallos = (forma: unknown): Fallo[] => [
  { nombre: '404 (aún sin desplegar)', respuesta: falla(new ApiError(404, 'not_found', 'Ruta inexistente', 'req_bandera')), mensaje: '' },
  { nombre: '403', respuesta: falla(new ApiError(403, 'forbidden', 'No tienes acceso', 'req_bandera')), mensaje: 'No tienes acceso' },
  { nombre: '500', respuesta: falla(new ApiError(500, 'internal', 'No pudimos leer la evolución', 'req_bandera')), mensaje: 'No pudimos leer la evolución' },
  { nombre: 'red (ApiError 0 de api())', respuesta: falla(new ApiError(0, 'network', 'Sin conexión con VanGUARD')), mensaje: 'Sin conexión con VanGUARD' },
  { nombre: 'red (TypeError fuera de api())', respuesta: falla(new TypeError('Failed to fetch')), mensaje: 'Algo falló' },
  { nombre: 'contrato roto en desarrollo', respuesta: falla(new ApiError(200, 'contract_mismatch', 'La respuesta no cumple el contrato')), mensaje: 'La respuesta no cumple el contrato' },
  { nombre: 'forma fuera de contrato en producción (ZodError)', respuesta: () => Promise.resolve(forma), mensaje: 'Algo falló' },
];
const FALLOS_E51 = fallos({ available: true, scan_run_id: ID, first: 'no', counts: null });
const FALLOS_E52 = fallos({ days: 30, points: 'x', totals: null });
const de = (l: Fallo[], nombre: string) => l.find((f) => f.nombre === nombre)!.respuesta;

type Pagina = { nodo: ReactNode; ruta: string; patron: string; datos: [QueryKey, unknown][] };
const RESUMEN: Pagina = { nodo: <PaginaResumen />, ruta: `/o/${ORG}/overview`, patron: '/o/:orgId/overview',
  datos: [[['org', ORG, 'overview'], OVERVIEW], [['org', ORG, 'connections'], z.array(ConnectionPublic).parse(fx.connections)]] };
const AUDITORIA: Pagina = { nodo: <PaginaAuditoria />, ruta: `/o/${ORG}/audit/${ID}`, patron: '/o/:orgId/audit/:scanId',
  datos: [[['org', ORG, 'scan', ID], fx.scanDone], [['org', ORG, 'findings', { status: 'open' }], ABIERTOS], [['org', ORG, 'overview'], OVERVIEW]] };
const EVOLUCION: Pagina = { nodo: <PaginaEvolucion />, ruta: `/o/${ORG}/evolution`, patron: '/o/:orgId/evolution', datos: [] };

function pintar(qc: QueryClient, p: Pagina, org: OrgActual) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[p.ruta]}>
      <OrgDePrueba org={org}><Routes><Route path={p.patron} element={p.nodo} /></Routes></OrgDePrueba>
    </MemoryRouter></QueryClientProvider>);
}

// La primera pasada registra la consulta con las opciones de su hook (en el servidor no se pide nada) y pinta la página
// sin E51/E52 leída; luego se corre el queryFn del hook con api() simulado y se vuelve a pintar. Sin retryOnMount: el
// error queda a la vista, el peor caso (en el navegador se vería tras el reintento al montar).
async function primeraCarga(p: Pagina, org: OrgActual, clave: QueryKey, respuesta: () => Promise<unknown>, previo?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  for (const [k, v] of p.datos) qc.setQueryData(k, v);
  if (previo !== undefined) qc.setQueryData(clave, previo);
  const antes = pintar(qc, p, org);
  api.mockReset();
  api.mockImplementation(respuesta);
  await qc.getQueryCache().find({ queryKey: clave, exact: true })!.fetch().catch(() => undefined);
  return { antes, despues: pintar(qc, p, org), estado: qc.getQueryState(clave)! };
}

const MARCAS_E51 = ['role="alert"', 'Reintentar', 'req_bandera', 'Cambios desde la auditoría anterior', 'Desde la auditoría anterior',
  'Ver evolución', '/evolution', '>Nuevo<', 'Comparando con la auditoría anterior', 'no hay cambios que mostrar', 'primera auditoría con historial'];

describe('primera carga · el parse del hook convierte cada fallo en error de la consulta, sin datos', () => {
  it.each(FALLOS_E51)('E51 · $nombre', async ({ respuesta, nombre }) => {
    const { estado } = await primeraCarga(AUDITORIA, ADMIN, CLAVE_DELTA, respuesta);
    expect(api).toHaveBeenCalledExactlyOnceWith(`/api/orgs/${ORG}/scans/${ID}/delta`, expect.anything());   // el queryFn del hook
    expect(estado.status).toBe('error');
    expect(estado.data).toBeUndefined();
    if (nombre.includes('ZodError')) expect(estado.error).toBeInstanceOf(z.ZodError);
  });
  it.each(FALLOS_E52)('E52 · $nombre', async ({ respuesta, nombre }) => {
    const { estado } = await primeraCarga(EVOLUCION, ADMIN, CLAVE_EVO, respuesta);
    expect(api).toHaveBeenCalledExactlyOnceWith(`/api/orgs/${ORG}/evolution?days=30`, expect.anything());
    expect(estado.status).toBe('error');
    expect(estado.data).toBeUndefined();
    if (nombre.includes('ZodError')) expect(estado.error).toBeInstanceOf(z.ZodError);
  });
});

describe('primera carga · Resumen y Auditoría (páginas que ya existían) quedan exactamente como sin la función', () => {
  for (const [nombre, pagina] of [['Resumen', RESUMEN], ['Auditoría', AUDITORIA]] as const)
    for (const org of [ADMIN, VIEWER])
      it.each(FALLOS_E51)(`${nombre} (${org.role}) · E51 $nombre`, async ({ respuesta }) => {
        const { antes, despues } = await primeraCarga(pagina, org, CLAVE_DELTA, respuesta);
        for (const m of MARCAS_E51) expect(antes, m).not.toContain(m);   // sin E51 leída, la página de antes de la función
        expect(despues).toBe(antes);
      });

  it('la Auditoría sigue con todo lo suyo: puntaje, resumen y «Hallazgos abiertos» sin la etiqueta «Nuevo»', async () => {
    const { despues } = await primeraCarga(AUDITORIA, ADMIN, CLAVE_DELTA, de(FALLOS_E51, '500'));
    expect(despues).toContain('Auditoría terminada');
    expect(despues).toContain('Hallazgos abiertos');
    expect(despues).not.toContain('>Nuevo<');
  });
});

describe('después de una lectura buena · un fallo al refrescar deja lo último que hubo, sin rojo', () => {
  const DELTA = AuditDelta.parse(fx.auditDelta);
  for (const [nombre, pagina, marca] of [['Resumen', RESUMEN, 'Desde la auditoría anterior'], ['Auditoría', AUDITORIA, 'Cambios desde la auditoría anterior']] as const)
    it.each(FALLOS_E51)(`${nombre} · E51 $nombre`, async ({ respuesta }) => {
      const { antes, despues, estado } = await primeraCarga(pagina, ADMIN, CLAVE_DELTA, respuesta, DELTA);
      expect(estado.status).toBe('error');
      expect(estado.data).toEqual(DELTA);
      expect(antes).toContain(marca);
      expect(despues).toBe(antes);
      expect(despues).not.toContain('role="alert"');
    });
});

describe('/evolution (página propia) en la primera carga', () => {
  it.each(FALLOS_E52)('E52 · $nombre: «llega pronto» con 404; si no, ErrorBloque con «Reintentar», sin tumbar la página', async ({ respuesta, mensaje }) => {
    const { despues } = await primeraCarga(EVOLUCION, ADMIN, CLAVE_EVO, respuesta);
    expect(despues).toContain('Evolución');
    expect(despues).toContain('¿Cómo leer la evolución?');
    if (!mensaje) {
      expect(despues).toContain('La evolución llega pronto');
      expect(despues).not.toContain('role="alert"');
      expect(despues).not.toContain('req_bandera');
      return;
    }
    expect(despues).not.toContain('La evolución llega pronto');
    expect(despues.match(/role="alert"/g)).toHaveLength(1);
    expect(despues).toContain(mensaje);
    expect(despues).toContain('Reintentar');
    expect(despues).toContain('aria-label="Periodo"');            // el periodo sigue ahí: cambiarlo es otra forma de reintentar
  });

  it('E52 con datos y luego un 500: se quedan las cifras con el error encima', async () => {
    const { despues } = await primeraCarga(EVOLUCION, ADMIN, CLAVE_EVO, de(FALLOS_E52, '500'), Evolution.parse(fx.evolution));
    expect(despues).toContain('Puntaje en la última auditoría');
    expect(despues.match(/role="alert"/g)).toHaveLength(1);
  });
});
