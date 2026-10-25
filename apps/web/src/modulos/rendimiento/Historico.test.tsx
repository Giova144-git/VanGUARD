// Histórico de Rendimiento con pocas mediciones: la medición base de una org es 1 de móvil + 1 de escritorio (una pasada
// de PSI cada una), y con eso ya se tiene que ver algo. La gráfica y «frente a la anterior» piden >= 2 de la misma
// estrategia. Casos 1+1, 2+0, 0+0, 1+0, 0+1 y 2+1 (móvil + escritorio). Sin jsdom: renderToStaticMarkup.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { fixtures as fx, type PerfRunExt } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/componentes/vg/GraficaComparativa', () => ({ GraficaComparativa: () => <div data-prueba="grafica" /> }));
const { default: PaginaRendimiento } = await import('./PaginaRendimiento');

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', me: fx.meViewer, puedeEscribir: false };
const URL = 'https://vanguard-demo-victima.pages.dev/';
const TABLA_ULTIMAS = 'aria-label="Última medición de cada estrategia"';
const PROXIMA = 'Con la próxima medición verás la comparación con la anterior.';

// Una medición de «Medir ahora»: una fila (rep 1) con su run_group.
let n = 0;
function medicion(strategy: 'mobile' | 'desktop', perf: number, lcp: number, version: string | null = null): PerfRunExt {
  n += 1;
  const hex = n.toString(16).padStart(12, '0');
  return {
    id: `d1000000-0000-4000-8000-${hex}`, run_group: `d2000000-0000-4000-8000-${hex}`, rep: 1, is_representative: true,
    url: URL, strategy, source: 'psi', lighthouse_version: '13.5.0', trigger: 'manual', version_label: version, runtime_error: null,
    scores: { performance: perf }, metrics: { lcp_ms: lcp, tbt_ms: 100, cls: 0.01, fcp_ms: 900, si_ms: 1200, ttfb_ms: 120 },
    created_at: new Date(Date.parse('2026-10-25T12:00:00.000Z') + n * 60_000).toISOString(),
  };
}
const de = (movil: number, escritorio: number) => [
  ...Array.from({ length: movil }, (_, i) => medicion('mobile', 0.5 + i / 10, 4000 - i * 100, i === 0 ? 'base' : null)),
  ...Array.from({ length: escritorio }, (_, i) => medicion('desktop', 0.8 + i / 10, 1500 - i * 100)),
];

function pintar(runs: PerfRunExt[], org = ADMIN) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const datos: [QueryKey, unknown][] = [[['org', org.id, 'module', 'performance'], fx.moduleState.performance],
    [['org', org.id, 'connections'], fx.connections], [['org', org.id, 'perf'], runs]];
  for (const [k, v] of datos) qc.setQueryData(k, v);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[`/o/${org.id}/performance`]}>
      <OrgDePrueba org={org}><PaginaRendimiento /></OrgDePrueba>
    </MemoryRouter></QueryClientProvider>);
}
// Filas de la tabla «Última medición de cada estrategia» (desde md): su primera celda es la estrategia.
const estrategiasDeUltimas = (html: string) => {
  const tabla = html.split(TABLA_ULTIMAS)[1]?.split('</table>')[0] ?? '';
  return [...tabla.matchAll(/<tr class="h-12[^"]*"><td class="pr-3 font-medium">([^<]+)<\/td>/g)].map((m) => m[1]);
};

describe('Histórico con pocas mediciones', () => {
  it('1 + 1 (la medición base): la última de cada estrategia con sus cifras y «con la próxima medición…»; sin gráfica', () => {
    const html = pintar(de(1, 1));
    expect(html).toContain('aria-labelledby="t-historico"');
    expect(estrategiasDeUltimas(html)).toEqual(['Móvil', 'Escritorio']);
    expect(html).toContain(PROXIMA);
    expect(html).toContain('>base</bdi>');                                    // la etiqueta de versión, en <bdi>
    expect(html).toContain('Sin etiqueta');
    expect(html).toMatch(/<td class="pr-3">50<\/td>/);                        // puntaje de móvil
    expect(html).toMatch(/<td class="pr-3">80<\/td>/);                        // puntaje de escritorio
    expect(html).not.toContain('data-prueba="grafica"');
    expect(html).not.toContain('Frente a la anterior');
    expect(html).not.toContain('aria-label="Métrica"');
    expect(html).not.toContain('aria-label="Estrategia"');                    // la tabla ya trae las dos
    expect(html).not.toMatch(/repetici/);
  });

  it('2 + 0: la gráfica y «frente a la anterior» de móvil, con los grupos de estrategia y métrica', () => {
    const html = pintar(de(2, 0));
    expect(html).toContain('data-prueba="grafica"');
    expect(html).toContain('Frente a la anterior (Puntaje)');
    expect(html).toContain('aria-label="Métrica"');
    expect(html).toMatch(/aria-label="Estrategia"><button type="button" aria-pressed="true"[^>]*><span class="block truncate"><bdi dir="ltr">Móvil/);
    expect(html).not.toContain(TABLA_ULTIMAS);
    expect(html).not.toContain(PROXIMA);
  });

  it('0 + 0: no se pinta el histórico', () => {
    const html = pintar([]);
    expect(html).not.toContain('aria-labelledby="t-historico"');
    expect(html).not.toContain(TABLA_ULTIMAS);
  });

  it('1 + 0 y 0 + 1: la única que hay, con su estrategia, y «con la próxima medición…»', () => {
    const movil = pintar(de(1, 0));
    expect(estrategiasDeUltimas(movil)).toEqual(['Móvil']);
    expect(movil).toContain(PROXIMA);
    expect(movil).not.toContain('data-prueba="grafica"');
    const escritorio = pintar(de(0, 1));
    expect(escritorio).toContain('aria-labelledby="t-historico"');
    expect(estrategiasDeUltimas(escritorio)).toEqual(['Escritorio']);
    expect(escritorio).toContain(PROXIMA);
  });

  it('1 + 2: abre en escritorio, la que tiene con qué comparar', () => {
    const html = pintar(de(1, 2));
    expect(html).toContain('data-prueba="grafica"');
    expect(html).toMatch(/aria-label="Estrategia">(?:(?!<\/div>).)*aria-pressed="true"[^>]*><span class="block truncate"><bdi dir="ltr">Escritorio/s);
  });

  it('el viewer ve el mismo histórico (1 + 1) que el admin', () => {
    const viewer = pintar(de(1, 1), VIEWER);
    expect(estrategiasDeUltimas(viewer)).toEqual(['Móvil', 'Escritorio']);
    expect(viewer).toContain(PROXIMA);
    expect(viewer).not.toContain('aria-labelledby="t-medir"');
  });
});
