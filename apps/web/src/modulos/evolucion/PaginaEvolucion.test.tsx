// Página «Evolución» (asignaciones/evolucion-entre-revisiones.md §6.4 y §9.3): 404 → «llega pronto», 0 puntos (vacío con
// «Auditar todo» apagado para el viewer), 1 punto, los fixtures con la gráfica accesible y el título recortado.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, Evolution } from '@vanguard/contracts';
import { OrgDePrueba, SOLO_LECTURA, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { TINTE } from '@/lib/severidad';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const { default: PaginaEvolucion } = await import('./PaginaEvolucion');

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', me: fx.meViewer, puedeEscribir: false };
const EVO = Evolution.parse(fx.evolution);
const VACIA: Evolution = { ...EVO, points: [], reviews: [], incidents: [], truncated: false,
  totals: { ...EVO.totals, versions: 0, snapshots: 0, score_first: null, fixed_checked: 0, ignored: 0, gone: 0 },
  mttr: { verified: 0, hours_avg: null, hours_median: null } };

function pintar(datos: Evolution | ApiError, org: OrgActual = ADMIN) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });   // sin retryOnMount: el error se pinta
  const clave = ['org', ORG, 'evolution', 30];
  if (datos instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: clave }).setState({ status: 'error', error: datos, fetchStatus: 'idle' });
  else qc.setQueryData(clave, datos);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[`/o/${ORG}/evolution`]}>
      <OrgDePrueba org={org}><PaginaEvolucion /></OrgDePrueba>
    </MemoryRouter></QueryClientProvider>);
}
const texto = (html: string) => html.replace(/<[^>]+>/g, '');

describe('PaginaEvolucion', () => {
  it('404 (E52 aún sin desplegar): «La evolución llega pronto», sin rojo ni periodo', () => {
    const html = pintar(new ApiError(404, 'not_found', 'Ruta inexistente', 'req_evo_404'));
    expect(html).toContain('La evolución llega pronto');
    expect(html).not.toContain('req_evo_404');
    expect(html).not.toContain(TINTE.mal);
    expect(html).not.toContain('aria-label="Periodo"');
  });

  it('un fallo de verdad sale en rojo con su request_id y «Reintentar»', () => {
    const html = pintar(new ApiError(500, 'internal', 'No pudimos leer la evolución', 'req_evo_500'));
    expect(html).toContain('req_evo_500');
    expect(html).toContain('Reintentar');
  });

  it('con los fixtures: cifras del periodo, gráfica con aria-label, versiones y enlaces a cada auditoría', () => {
    const html = pintar(EVO);
    const t = texto(html);
    expect(t).toContain('Puntaje en la última auditoría20');
    expect(t).toContain('Abiertos al cerrarla12');
    expect(t).toContain('Nuevos en 30 días8');
    expect(t).toContain('Corregidos en 30 días6');
    expect(t).toContain('5 comprobados');
    expect(t).toContain('1 d 19 h');
    expect(t).toContain('mediana 2 d · 5 hallazgos');
    expect(html).toMatch(/role="img" aria-label="Puntaje por auditoría: mar\.? 20 · 14:02 20, mié\.? 21 · 14:03 20, jue\.? 22 · 14:02 42, vie\.? 23 · 14:04 57, [^"]+ 20"/);
    expect(t).toContain('Puntaje por auditoría');
    expect(t).not.toContain('últimas');
    expect(t).toContain('Anterior al historial');
    expect(t).toContain('Punto de partida');
    for (const p of EVO.points) expect(html).toContain(`/o/${ORG}/audit/${p.scan_run_id}`);
    expect(t).not.toContain('Con la próxima auditoría verás qué cambió');
    expect(t).toContain('Rendimiento no entra en las auditorías');
    expect(t).toContain('¿Cómo leer la evolución?');
  });

  it('con la gráfica recortada el título dice «últimas N auditorías»', () => {
    expect(texto(pintar({ ...EVO, points: EVO.points.slice(-3), truncated: true }))).toContain('Puntaje por auditoría · últimas 3 auditorías');
  });

  it('0 puntos: el vacío con «Auditar todo», apagado y con su motivo para el viewer', () => {
    const viewer = pintar(VACIA, VIEWER);
    expect(viewer).toContain('Aún no hay auditorías en este periodo');
    expect(viewer).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Auditar todo/);
    expect(viewer).toContain(SOLO_LECTURA);
    expect(viewer).not.toContain('role="img"');
    expect(pintar(VACIA)).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Auditar todo/);
  });

  it('1 punto con foto: cifras y «Con la próxima auditoría verás qué cambió», sin gráfica', () => {
    const uno = { ...EVO, points: [{ ...EVO.points[1]! }], totals: { ...EVO.totals, versions: 1, snapshots: 1 } };
    const t = texto(pintar(uno));
    expect(t).toContain('Con la próxima auditoría verás qué cambió');
    expect(t).toContain('Abiertos al cerrarla11');
    expect(pintar(uno)).not.toContain('role="img"');
  });
});
