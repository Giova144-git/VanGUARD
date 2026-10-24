// IDOR por URL (PLAN_MAESTRO §15.3, F-14). Un id de /findings/:id, ?finding=, /incidents/:id, /audit/:id o ?run= que no
// es un UUID se trata como «no existe» SIN llamar a la API. El 404 del BACK a un UUID de otra org se pinta igual, sin el
// texto del servidor, sin «Reintentar» ni request_id: la UI no distingue «no existe» de «es de otra org». Tras un 404 no
// se sondea, y api() no sale de /api aunque le llegue un camino con «..», «%2e», «#», «//» o «\».
// El lado del BACK (404 a una org que no está en me.orgs y a ids de otra org) ya lo prueba src/lib/fixtures/router.test.ts.
// Sin jsdom: renderToStaticMarkup, como xss.test.tsx. En SSR no corren efectos y React Query no pide nada al pintar, así
// que para ver qué pediría la página al montarse se suscribe un QueryObserver a cada consulta que dejó el render.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, QueryObserver, type Query, type QueryKey, type QueryObserverOptions } from '@tanstack/react-query';
import { fixtures as fx } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { useIncidente, useScan, useWikiRun } from '@/lib/consultas';
import { ApiError } from '@/lib/errores';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import { DetalleEnPanel } from '@/modulos/hallazgos/DetalleEnPanel';
import PaginaHallazgo from '@/modulos/hallazgos/PaginaHallazgo';
import PaginaIncidente from '@/modulos/incidentes/PaginaIncidente';
import PaginaWiki from '@/modulos/wiki/PaginaWiki';

// Doble de api(): cuenta las llamadas y no responde nunca (la consulta se queda en vuelo, sin datos ni error que pintar).
const api = vi.hoisted(() => vi.fn((_ruta: string, _o?: unknown) => new Promise<never>(() => {})));
vi.mock('@/lib/api', () => ({ api }));
// supabase-js pide VITE_SUPABASE_URL al importarse. La sesión solo la lee el api() real del último bloque.
const auth = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({ data: { session: null } })), refreshSession: vi.fn(async () => ({ data: { session: null } })),
}));
vi.mock('@/lib/supabase', () => ({ supabase: { auth } }));
// PanelDetalle lee window.matchMedia al pintar; aquí solo importa lo que lleva dentro.
vi.mock('@/componentes/vg/PanelDetalle', async () => {
  const { createElement } = await import('react');
  return { PanelDetalle: ({ titulo, children }: { titulo: string; children: ReactNode }) => createElement('aside', { 'aria-label': titulo }, children) };
});

const ORG = fx.me.orgs[0]!.id;
const VALIDO = '0f0f0f0f-0000-4000-8000-0000000000aa';        // bien formado y de ninguna org de los fixtures
const ORG_ACTUAL: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const NO_EXISTE = 'no existe o no es de esta organización';

const IDS: [string, string][] = [
  ['../../me', '../../me'], ['..%2F..%2Fme', '..%2F..%2Fme'], ['x?y', 'x?y'], ['<script>', '<script>'],
  ['de 2 KB que empieza por un UUID', VALIDO + '0'.repeat(2048 - VALIDO.length)], ['%2e%2e', '%2e%2e'],
  ['UUID seguido de /../me', `${VALIDO}/../me`], ['UUID con salto de línea al final', `${VALIDO}\n`],
];

// Cómo llega el id a la URL: codificado (el componente recibe justo ese id) y, si no cambia la ruta, tal cual (el router
// lo decodifica una vez: «%2e%2e» llega como «..»). Un «/» crudo en el camino ya no casa con la ruta: no se prueba.
const formas = (id: string, enCamino: boolean): [string, string][] => {
  const cod = encodeURIComponent(id);
  return cod === id || (enCamino && id.includes('/')) ? [['codificado', cod]] : [['codificado', cod], ['tal cual', id]];
};

type Pantalla = { nombre: string; nodo: ReactNode; patron: string; enCamino: boolean; url: (s: string) => string; clave: (id: string) => QueryKey; detalle: string };
const PANTALLAS: Pantalla[] = [
  { nombre: 'DetalleHallazgo en /findings/:id', nodo: <PaginaHallazgo />, patron: '/o/:orgId/findings/:findingId', enCamino: true,
    url: (s) => `/o/${ORG}/findings/${s}`, clave: (id) => ['org', ORG, 'finding', id], detalle: 'findings' },
  { nombre: 'DetalleHallazgo en el panel ?finding=', nodo: <DetalleEnPanel />, patron: '/o/:orgId/overview', enCamino: false,
    url: (s) => `/o/${ORG}/overview?finding=${s}`, clave: (id) => ['org', ORG, 'finding', id], detalle: 'findings' },
  { nombre: 'PaginaIncidente en /incidents/:id', nodo: <PaginaIncidente />, patron: '/o/:orgId/incidents/:incidentId', enCamino: true,
    url: (s) => `/o/${ORG}/incidents/${s}`, clave: (id) => ['org', ORG, 'incident', id], detalle: 'incidents' },
  { nombre: 'PaginaAuditoria en /audit/:id', nodo: <PaginaAuditoria />, patron: '/o/:orgId/audit/:scanId', enCamino: true,
    url: (s) => `/o/${ORG}/audit/${s}`, clave: (id) => ['org', ORG, 'scan', id], detalle: 'scans' },
  { nombre: 'PaginaWiki con ?run=', nodo: <PaginaWiki />, patron: '/o/:orgId/wiki', enCamino: false,
    url: (s) => `/o/${ORG}/wiki?run=${s}`, clave: (id) => ['org', ORG, 'wiki', 'run', id], detalle: 'wiki/runs' },
];

const cliente = (q: { retryOnMount?: boolean } = {}) => new QueryClient({ defaultOptions: { queries: { retry: false, ...q } } });

function pintar(p: Pantalla, url: string, qc: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <OrgDePrueba org={ORG_ACTUAL}><Routes><Route path={p.patron} element={p.nodo} /></Routes></OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Lo que hace el navegador al montar: un observador por consulta, con las opciones que dejó el render (enabled, queryFn…).
async function montar(qc: QueryClient) {
  const bajas = qc.getQueryCache().getAll().map((q) => new QueryObserver(qc, q.options as QueryObserverOptions).subscribe(() => {}));
  await new Promise((r) => setTimeout(r, 0));
  for (const b of bajas) b();
}
const pedidas = () => api.mock.calls.map(([r]) => r);

// ── 1 y 2. Ids malformados y UUID de otra org, en cada pantalla que lee un id de la URL ──
describe.each(PANTALLAS)('IDOR · $nombre', (p) => {
  const detalle = new RegExp(`^/api/orgs/${ORG}/${p.detalle}/`);
  beforeEach(() => { api.mockClear(); });

  it.each(IDS.flatMap(([n, id]) => formas(id, p.enCamino).map(([f, s]): [string, string, string, string] => [n, f, id, s])))(
    'id %s (%s en la URL): «no existe», sin «Reintentar» y sin pedir nada con ese id', async (_n, _f, id, s) => {
      const qc = cliente();
      const html = pintar(p, p.url(s), qc);
      expect(html).toContain(NO_EXISTE);
      expect(html).not.toContain('Reintentar');
      await montar(qc);
      for (const r of pedidas()) {
        expect(r).not.toMatch(detalle);
        expect(r).not.toContain(id);
        expect(r).not.toContain(encodeURIComponent(id));
      }
    });

  it('control: un UUID sin datos sí se pide al montar (el doble ve las llamadas)', async () => {
    const qc = cliente();
    expect(pintar(p, p.url(VALIDO), qc)).not.toContain(NO_EXISTE);
    await montar(qc);
    expect(pedidas().filter((r) => detalle.test(r))).toEqual([`/api/orgs/${ORG}/${p.detalle}/${VALIDO}`]);
  });

  // retryOnMount: false deja la consulta como la ve la página ya montada cuando llega el 404. Sin él, un error sin datos
  // sale en el primer render como «pendiente», porque al montarse se volvería a pedir.
  it('UUID de otra org con 404 not_found: «no existe», sin el texto del servidor, sin «Reintentar» y sin request_id', async () => {
    const qc = cliente({ retryOnMount: false });
    const e = new ApiError(404, 'not_found', 'Mensaje del servidor ⟦404⟧', 'req_idor_404');
    await qc.prefetchQuery({ queryKey: p.clave(VALIDO), queryFn: () => Promise.reject(e) });
    expect(qc.getQueryState(p.clave(VALIDO))).toMatchObject({ status: 'error', error: e });
    const html = pintar(p, p.url(VALIDO), qc);
    expect(html).toContain(NO_EXISTE);
    for (const x of ['Mensaje del servidor', 'req_idor_404', 'not_found', 'Reintentar']) expect(html).not.toContain(x);
  });

  it('control: un 500 al mismo UUID sí sale como error, con «Reintentar» y su request_id', async () => {
    const qc = cliente({ retryOnMount: false });
    await qc.prefetchQuery({ queryKey: p.clave(VALIDO), queryFn: () => Promise.reject(new ApiError(500, 'internal', 'Fallo del servidor', 'req_idor_500')) });
    const html = pintar(p, p.url(VALIDO), qc);
    expect(html).not.toContain(NO_EXISTE);
    expect(html).toContain('Reintentar');
    expect(html).toContain('req_idor_500');
  });
});

// ── 3. Tras un 404 no se sondea ────────────────────────────────────────────────
// es404 no se exporta: se evalúa la función refetchInterval que el hook deja en la consulta, como hace QueryObserver.
describe('IDOR · un 404 corta el sondeo', () => {
  function Sonda({ usar }: { usar: () => unknown }) { usar(); return null; }
  const HOOKS: [string, QueryKey, () => unknown, unknown][] = [
    ['useScan', ['org', ORG, 'scan', VALIDO], () => useScan(ORG, VALIDO), { ...fx.scanRunning, id: VALIDO }],
    ['useWikiRun', ['org', ORG, 'wiki', 'run', VALIDO], () => useWikiRun(ORG, VALIDO), { ...fx.wikiRunRunning, id: VALIDO }],
    ['useIncidente', ['org', ORG, 'incident', VALIDO], () => useIncidente(ORG, VALIDO), { ...fx.incidentDetail, id: VALIDO }],
  ];

  async function intervalo(clave: QueryKey, usar: () => unknown, error: ApiError | null, datos?: unknown) {
    const qc = cliente();
    if (datos !== undefined) qc.setQueryData(clave, datos);
    if (error) await qc.prefetchQuery({ queryKey: clave, queryFn: () => Promise.reject(error) });   // con datos, los conserva
    renderToStaticMarkup(<QueryClientProvider client={qc}><Sonda usar={usar} /></QueryClientProvider>);
    const q = qc.getQueryCache().find({ queryKey: clave, exact: true })!;
    const f = (q.options as { refetchInterval?: unknown }).refetchInterval;
    expect(f).toBeTypeOf('function');
    return (f as (q: Query) => number | false | undefined)(q);
  }

  it.each(HOOKS)('%s devuelve false con un 404, sin datos y con una corrida en curso', async (_n, clave, usar, enCurso) => {
    const e = new ApiError(404, 'not_found', 'No existe');
    expect(await intervalo(clave, usar, e)).toBe(false);
    expect(await intervalo(clave, usar, e, enCurso)).toBe(false);
  });

  it.each(HOOKS)('control: %s sigue con su intervalo sin error, con un 500 o con un 503', async (_n, clave, usar, enCurso) => {
    expect(await intervalo(clave, usar, null, enCurso)).toBeGreaterThan(0);
    expect(await intervalo(clave, usar, new ApiError(500, 'internal', 'x'), enCurso)).toBeGreaterThan(0);
    expect(await intervalo(clave, usar, new ApiError(503, 'unavailable', 'x'))).toBeGreaterThan(0);
  });
});

// ── 4. api() valida el camino antes de leer la sesión y de llamar a fetch (lib/ids.ts caminoValido) ──
describe('IDOR · api() no sale de /api', () => {
  const fetchFalso = vi.fn(async (_r: RequestInfo | URL, _i?: RequestInit) => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
  let apiReal: typeof import('@/lib/api').api;
  beforeAll(async () => {
    apiReal = (await vi.importActual<typeof import('@/lib/api')>('@/lib/api')).api;
    vi.stubGlobal('fetch', fetchFalso);
  });
  afterAll(() => { vi.unstubAllGlobals(); });
  beforeEach(() => { fetchFalso.mockClear(); auth.getSession.mockClear(); });

  it.each<[string, string, ('POST' | 'DELETE')?]>([
    ['«..» crudo', `/api/orgs/${ORG}/findings/../../me`],
    ['«..» con %2F', `/api/orgs/${ORG}/findings/..%2F..%2Fme`],
    ['«%2e%2e»', `/api/orgs/${ORG}/scans/%2e%2e`],
    ['«%2E%2E» en un POST', `/api/orgs/${ORG}/incidents/%2E%2E/ack`, 'POST'],
    ['«.» suelto', '/api/./me'],
    ['«#» en el camino', `/api/orgs/${ORG}/incidents/x#y`],
    ['«#» detrás de la consulta', `/api/orgs/${ORG}/findings?status=open#x`],
    ['«//» dentro', '/api//me'],
    ['«//» al principio', '//evil.test/api/me'],
    ['una URL absoluta', 'https://evil.test/api/me'],
    ['«\\»', `/api/orgs\\${ORG}/overview`],
    ['«\\» con «..» en un DELETE', `/api/orgs/${ORG}/wiki/runs/..\\..\\me`, 'DELETE'],
    ['«<script>»', `/api/orgs/${ORG}/findings/<script>`],
    ['un camino fuera de /api', '/ingest/x'],
  ])('%s: ApiError internal sin leer la sesión ni llamar a fetch', async (_n, ruta, method) => {
    const e = await apiReal(ruta, { method, body: method === 'POST' ? {} : undefined }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 0, code: 'internal' });
    expect(fetchFalso).not.toHaveBeenCalled();
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it('control: una ruta sana sí sale por fetch, tal cual', async () => {
    expect(await apiReal(`/api/orgs/${ORG}/findings?status=open`)).toEqual([]);
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    expect(fetchFalso.mock.calls[0]![0]).toBe(`/api/orgs/${ORG}/findings?status=open`);
  });
});
