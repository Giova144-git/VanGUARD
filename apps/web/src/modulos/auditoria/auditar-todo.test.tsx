// «Auditar todo» sin fuentes (useAuditarTodo.tsx): el mismo criterio que el servidor, la decisión de un clic con dobles
// (sin fuentes no llama a la API y Vigía habla; el 409 de la carrera también; «ya hay una en curso» navega) y el aviso
// pintado en Resumen, Auditoría y Evolución. El ZIP no pasa por aquí: sin conexiones sigue ofreciéndose y subiéndose.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic, Evolution, Overview, type ScanCreate } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { PROVEEDORES_AUDITABLES, auditarTodo, esAuditable, esSinFuentes, sinFuentesDe } from './useAuditarTodo';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (original) => ({ ...(await original<object>()), api }));

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', puedeEscribir: false };
const CONEXIONES = z.array(ConnectionPublic).parse(fx.connections);
const AVISO = 'No tienes ninguna fuente conectada que revisar.';
const con = (provider: ConnectionPublic['provider'], kind: ConnectionPublic['kind'] = 'read', status: ConnectionPublic['status'] = 'active') =>
  ({ provider, kind, status });

describe('sinFuentesDe · el criterio del servidor (rutas/scans.ts)', () => {
  it('cargando o con error (sin datos) no bloquea: decide el servidor', () => {
    expect(sinFuentesDe(undefined)).toBe(false);
  });
  it('lista vacía → sin fuentes', () => {
    expect(sinFuentesDe([])).toBe(true);
  });
  it('una de lectura activa de Supabase, Cloudflare o GitHub basta', () => {
    expect(PROVEEDORES_AUDITABLES).toEqual(['supabase', 'cloudflare', 'github']);
    for (const p of PROVEEDORES_AUDITABLES) expect(sinFuentesDe([con(p)]), p).toBe(false);
  });
  it('no cuentan: la de acción, la que no está activa ni la de ingest', () => {
    expect(esAuditable(con('cloudflare', 'action'))).toBe(false);
    for (const s of ['error', 'revoked', 'expired'] as const) expect(esAuditable(con('supabase', 'read', s)), s).toBe(false);
    expect(esAuditable(con('ingest'))).toBe(false);
    expect(sinFuentesDe([con('cloudflare', 'action'), con('github', 'read', 'error'), con('ingest')])).toBe(true);
  });
  it('las del fixture de la demo sí tienen fuentes', () => {
    expect(sinFuentesDe(CONEXIONES)).toBe(false);
  });
});

describe('esSinFuentes · qué 409 es la carrera', () => {
  it('conflict sin scan_run_id sí; con él («ya hay una en curso»), el 429 y los demás no', () => {
    expect(esSinFuentes(new ApiError(409, 'conflict', 'No hay ninguna conexión que auditar. Conecta un servicio primero.'))).toBe(true);
    expect(esSinFuentes(new ApiError(409, 'conflict', 'Ya hay una auditoría de este tipo en curso', undefined, { scan_run_id: fx.scanDone.id }))).toBe(false);
    expect(esSinFuentes(new ApiError(429, 'budget_exceeded', 'Llegaste al tope de hoy'))).toBe(false);
    expect(esSinFuentes(new Error('x'))).toBe(false);
  });
});

describe('auditarTodo · la decisión de un clic', () => {
  type Cb = { onSuccess: (r: { scan_run_id: string }) => void; onError: (e: unknown) => void };
  const montar = (sinFuentes: boolean, responder?: (cb: Cb) => void) => {
    const p = {
      sinFuentes,
      lanzar: vi.fn((_b: ScanCreate, cb: Cb) => responder?.(cb)),
      irA: vi.fn(), setError: vi.fn(), avisar: vi.fn(),
    };
    auditarTodo(p);
    return p;
  };

  it('sin fuentes no llama a la API: avisa (Vigía) y limpia el error anterior', () => {
    const p = montar(true);
    expect(p.lanzar).not.toHaveBeenCalled();
    expect(p.avisar).toHaveBeenCalledWith(false);
    expect(p.setError).toHaveBeenCalledWith(null);
    expect(p.irA).not.toHaveBeenCalled();
  });
  it('con fuentes lanza full_audit y navega a la nueva', () => {
    const p = montar(false, (cb) => cb.onSuccess({ scan_run_id: 'nueva' }));
    expect(p.lanzar).toHaveBeenCalledWith({ kind: 'full_audit' }, expect.anything());
    expect(p.irA).toHaveBeenCalledWith('nueva');
    expect(p.avisar).not.toHaveBeenCalled();
  });
  it('409 sin scan_run_id (desconectaron la última fuente): avisa igual, como carrera, sin error rojo', () => {
    const p = montar(false, (cb) => cb.onError(new ApiError(409, 'conflict', 'No hay ninguna conexión que auditar. Conecta un servicio primero.')));
    expect(p.avisar).toHaveBeenCalledWith(true);
    expect(p.setError).toHaveBeenCalledTimes(1);   // solo el null del principio
    expect(p.irA).not.toHaveBeenCalled();
  });
  it('409 con scan_run_id: navega a la que ya corre', () => {
    const p = montar(false, (cb) => cb.onError(new ApiError(409, 'conflict', 'Ya hay una auditoría de este tipo en curso', undefined, { scan_run_id: 'en-curso' })));
    expect(p.irA).toHaveBeenCalledWith('en-curso');
    expect(p.avisar).not.toHaveBeenCalled();
  });
  it('429 de presupuesto: el mensaje del servidor junto al botón, sin Vigía', () => {
    const p = montar(false, (cb) => cb.onError(new ApiError(429, 'budget_exceeded', 'Ya hiciste 3 auditorías completas hoy')));
    expect(p.setError).toHaveBeenLastCalledWith('Ya hiciste 3 auditorías completas hoy');
    expect(p.avisar).not.toHaveBeenCalled();
  });
});

// ── Pintado ──────────────────────────────────────────────────────────────────────────────────────────────────────
function pintar(ruta: string, ui: React.ReactNode, conexiones: ConnectionPublic[] | undefined, org: OrgActual = ADMIN, extra?: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (conexiones) qc.setQueryData(['org', ORG, 'connections'], conexiones);
  extra?.(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}><OrgDePrueba org={org}>{ui}</OrgDePrueba></MemoryRouter>
    </QueryClientProvider>,
  );
}
const enlaces = (html: string) => {
  expect(html).toContain(`href="/o/${ORG}/connections"`);
  expect(html).toContain(`href="/o/${ORG}/codebase"`);
};
// El botón sigue activo: el clic es lo que hace hablar a Vigía.
const botonActivo = (html: string) => expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Auditar todo/);

describe('el aviso junto a «Auditar todo»', () => {
  beforeEach(() => { api.mockReset(); });

  it('Resumen: sin fuentes, aviso con enlaces a Conexiones y Codebase y botón activo; con fuentes o cargando, nada', async () => {
    const { default: PaginaResumen } = await import('@/modulos/resumen/PaginaResumen');
    const conOverview = (qc: QueryClient) => qc.setQueryData(['org', ORG, 'overview'], Overview.parse(fx.overviewVacio));
    const sin = pintar(`/o/${ORG}/overview`, <PaginaResumen />, [], ADMIN, conOverview);
    expect(sin).toContain(AVISO);
    enlaces(sin);
    botonActivo(sin);
    expect(sin).toContain('data-info="auditar-todo"');
    expect(pintar(`/o/${ORG}/overview`, <PaginaResumen />, CONEXIONES, ADMIN, conOverview)).not.toContain(AVISO);
    expect(pintar(`/o/${ORG}/overview`, <PaginaResumen />, undefined, ADMIN, conOverview)).not.toContain(AVISO);
    expect(pintar(`/o/${ORG}/overview`, <PaginaResumen />, [], VIEWER, conOverview)).not.toContain(AVISO);   // su botón ya está apagado
  });

  it('Auditoría (lanzar): sin fuentes, el aviso bajo el botón', async () => {
    const { default: PaginaAuditoria } = await import('./PaginaAuditoria');
    const sin = pintar(`/o/${ORG}/audit`, <PaginaAuditoria />, []);
    expect(sin).toContain(AVISO);
    enlaces(sin);
    botonActivo(sin);
    expect(pintar(`/o/${ORG}/audit`, <PaginaAuditoria />, CONEXIONES)).not.toContain(AVISO);
  });

  it('Evolución sin auditorías: sin fuentes, el aviso bajo el botón', async () => {
    const { default: PaginaEvolucion } = await import('@/modulos/evolucion/PaginaEvolucion');
    const vacia = (qc: QueryClient) => qc.setQueryData(['org', ORG, 'evolution', 30],
      Evolution.parse({ ...fx.evolution, points: [], reviews: [] }));
    const sin = pintar(`/o/${ORG}/evolution`, <PaginaEvolucion />, [], ADMIN, vacia);
    expect(sin).toContain('Aún no hay auditorías en este periodo');
    expect(sin).toContain(AVISO);
    enlaces(sin);
    botonActivo(sin);
  });
});

describe('el ZIP no se ve afectado', () => {
  beforeEach(() => { api.mockReset(); });

  it('Codebase sin ninguna conexión ofrece el ZIP y no pinta el aviso de «Auditar todo»', async () => {
    const { default: PaginaCodebase } = await import('@/modulos/codebase/PaginaCodebase');
    const html = pintar(`/o/${ORG}/codebase`, <PaginaCodebase />, [], ADMIN,
      (qc) => qc.setQueryData(['org', ORG, 'module', 'codebase'], fx.moduleState.codebase));
    expect(html).toContain('O analiza un ZIP en tu navegador');
    expect(html).toContain('type="file"');
    expect(html).not.toContain(AVISO);
  });

  it('subirZip sin conexiones manda kind zip y su resultado, sin pasar por la comprobación de fuentes', async () => {
    const { subirZip } = await import('@/lib/mutaciones');
    api.mockResolvedValueOnce({ scan_run_id: 'zip-1' }).mockResolvedValueOnce({ scan_run_id: 'zip-1' });
    const resultado = { files_seen: 1, deps: [], findings: [], analyzer: 'core@0.1.0' };
    expect(await subirZip(ORG, { filename: 'mi-app.zip', size_bytes: 10 }, resultado)).toBe('zip-1');
    expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.calls[0]![0]).toBe(`/api/orgs/${ORG}/scans`);
    expect(api.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: { kind: 'zip', filename: 'mi-app.zip', size_bytes: 10 } });
    expect(api.mock.calls[1]![0]).toBe(`/api/orgs/${ORG}/scans/zip-1/zip-result`);
  });

  it('AnalizarZip no usa useAuditarTodo ni el dicho de «sin fuentes»', async () => {
    const { default: fuente } = await import('../codebase/AnalizarZip.tsx?raw');
    expect(fuente).toContain('subirZip(');
    expect(fuente).not.toMatch(/useAuditarTodo|DICHO_SIN_FUENTES|full_audit/);
  });
});
