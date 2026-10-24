// Con la API de hoy, E24 (perf/runs) responde 404: el histórico no se pinta y la página no sale en rojo.
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { fixtures as fx } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { TINTE } from '@/lib/severidad';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const { default: PaginaRendimiento } = await import('./PaginaRendimiento');

const ORG = fx.me.orgs[0]!.id;
const ORG_ACTUAL: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };

async function pintar(error: ApiError) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  qc.setQueryData(['org', ORG, 'module', 'performance'], fx.moduleState.performance);
  qc.setQueryData(['org', ORG, 'connections'], fx.connections);
  await qc.prefetchQuery({ queryKey: ['org', ORG, 'perf'], queryFn: () => Promise.reject(error) });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[`/o/${ORG}/performance`]}>
      <OrgDePrueba org={ORG_ACTUAL}><PaginaRendimiento /></OrgDePrueba>
    </MemoryRouter></QueryClientProvider>);
}

describe('Rendimiento sin E24', () => {
  it('404: sin histórico y sin bloque rojo ni «Reintentar» del histórico', async () => {
    const html = await pintar(new ApiError(404, 'not_found', 'Ruta inexistente', 'req_perf_404'));
    expect(html).not.toContain('Ruta inexistente');
    expect(html).not.toContain('req_perf_404');
    expect(html).not.toContain(TINTE.mal);
  });
  it('control: un 500 sí sale en rojo con su request_id', async () => {
    const html = await pintar(new ApiError(500, 'internal', 'Fallo del servidor', 'req_perf_500'));
    expect(html).toContain('req_perf_500');
  });
});
