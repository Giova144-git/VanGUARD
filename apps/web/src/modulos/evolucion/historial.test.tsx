// Historial de fallas (E13h/E13t): la página con sus filtros en la URL, cada fila con data-hallazgo y sus fechas, la
// línea de tiempo y los cálculos del periodo de Evolución. El título y el recurso son del cliente: van escapados.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, FindingHistoryItem, type FindingTimeline } from '@vanguard/contracts';
import { z } from 'zod';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { corregidaEnPeriodo, esFiltro, ESTADOS_FILTRO, nuevaEnPeriodo } from '@/lib/historial';
import { esIdInfo } from '@/componentes/vigia/info';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const { default: PaginaHistorial } = await import('./PaginaHistorial');
const { FilaFalla, fechasFila } = await import('./FilaFalla');
const { ListaEventos } = await import('./LineaTiempoFalla');

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const LISTA = z.array(FindingHistoryItem).parse(fx.historialFallas);

function pintar(nodo: React.ReactNode, ruta: string, datos: [readonly unknown[], unknown][] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  for (const [k, v] of datos) {
    if (v instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: k }).setState({ status: 'error', error: v, fetchStatus: 'idle' });
    else qc.setQueryData(k, v);
  }
  return renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[ruta]}>
    <OrgDePrueba org={ADMIN}>{nodo}</OrgDePrueba></MemoryRouter></QueryClientProvider>);
}
const texto = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const RUTA = `/o/${ORG}/evolution/history`;

describe('PaginaHistorial', () => {
  it('todas las fallas, cada una con data-hallazgo, su estado y sus fechas; filtros con su Info', () => {
    const html = pintar(<PaginaHistorial />, RUTA, [[['org', ORG, 'history', 'lista', { limit: 200 }], LISTA]]);
    const filas = [...html.matchAll(/data-hallazgo="([^"]+)"/g)].map((m) => m[1]);
    expect(filas).toEqual(LISTA.map((f) => f.id));
    expect(texto(html)).toContain(`${LISTA.length} fallas`);
    for (const e of ['Abierta', 'Corregida', 'Verificada ✓', 'Ignorada']) expect(texto(html)).toContain(e);
    expect(texto(html)).toContain('Reapareció');
    for (const id of ['historial-fallas', 'historial-filtro-estado', 'historial-filtro-modulo', 'historial-filtro-gravedad',
      'historial-filtro-periodo', 'historial-orden']) {
      expect(html, id).toContain(`data-info="${id}"`);
      expect(esIdInfo(id), id).toBe(true);
    }
  });

  it('los filtros salen de la URL y van a la consulta (estado, módulo, gravedad, días y orden)', () => {
    const filtro = { limit: 200, status: 'verified', module: 'codebase', severity: 'high', days: 30, order: 'asc' };
    const una = LISTA.filter((f) => f.status === 'verified' && f.module === 'codebase');
    const html = pintar(<PaginaHistorial />, `${RUTA}?estado=verified&modulo=codebase&gravedad=high&dias=30&orden=asc`,
      [[['org', ORG, 'history', 'lista', filtro], una]]);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Verificadas</);
    expect(html).toMatch(/<option value="codebase" selected="">Codebase/);
    expect(html).toMatch(/<option value="asc" selected="">/);
    expect([...html.matchAll(/data-hallazgo="([^"]+)"/g)].length).toBe(una.length);
  });

  it('un valor de filtro desconocido en la URL se ignora (Todas)', () => {
    const html = pintar(<PaginaHistorial />, `${RUTA}?estado=__proto__&modulo=<x>`, [[['org', ORG, 'history', 'lista', { limit: 200 }], LISTA]]);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Todas</);
    expect(esFiltro(ESTADOS_FILTRO, '__proto__')).toBe(false);
  });

  it('sin fallas con esos filtros, lo dice; 404 de E13h, «llega pronto»', () => {
    expect(texto(pintar(<PaginaHistorial />, `${RUTA}?estado=ignored`, [[['org', ORG, 'history', 'lista', { limit: 200, status: 'ignored' }], []]])))
      .toContain('Ninguna falla con estos filtros');
    expect(texto(pintar(<PaginaHistorial />, RUTA, [[['org', ORG, 'history', 'lista', { limit: 200 }], new ApiError(404, 'not_found', 'x')]])))
      .toContain('El historial llega pronto');
  });

  it('?falla=<id> («Ver historial» del clic derecho): su línea de tiempo arriba, abierta', () => {
    const t: FindingTimeline = fx.lineaTiempoFalla;
    const html = pintar(<PaginaHistorial />, `${RUTA}?falla=${t.item.id}`, [
      [['org', ORG, 'history', 'lista', { limit: 200 }], LISTA], [['org', ORG, 'history', 'falla', t.item.id], t]]);
    expect(texto(html)).toContain('Línea de tiempo de la falla');
    expect(html).toContain('data-evento="reaparecido"');
    expect(html).toContain('data-info="historial-linea-tiempo"');
  });
});

describe('FilaFalla', () => {
  const f = LISTA.find((x) => x.status === 'verified' && x.fixed_at)!;
  it('fechas de la fila en hora de Caracas', () => {
    expect(fechasFila(f)).toMatch(/^Detectada \d\d-10 \d\d:\d\d · Corregida \d\d-10 \d\d:\d\d · Verificada \d\d-10 \d\d:\d\d$/);
    const abierta = LISTA.find((x) => x.status === 'open' && x.reopen_count > 0)!;
    expect(fechasFila(abierta)).toMatch(/Reapareció .* · Vista /);
  });
  it('título y recurso hostiles quedan como texto', () => {
    const html = pintar(<ul><FilaFalla org={ORG} f={{ ...f, title: '<img src=x onerror=alert(1)>', resource: '</bdi><script>x</script>' }}
      abierta={false} onAlternar={() => {}} /></ul>, RUTA);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain(`data-hallazgo="${f.id}"`);
    expect(html).toMatch(/aria-expanded="false"/);
  });
});

describe('ListaEventos', () => {
  it('cada hito con su texto y su hora; «visto» va hueco', () => {
    const html = pintar(<ListaEventos eventos={fx.lineaTiempoFalla.events} reaperturas={2} />, RUTA);
    const t = texto(html);
    for (const e of ['Detectada', 'Una auditoría ya no la vio', 'Reapareció', 'Vista por última vez']) expect(t).toContain(e);
    expect(t).toContain('Ha reaparecido 2 veces');
    expect([...html.matchAll(/<time dateTime="([^"]+)"/g)].map((m) => m[1])).toEqual(fx.lineaTiempoFalla.events.map((e) => new Date(e.at).toISOString()));
  });
  it('una fecha que no es fecha no rompe ni se pinta tal cual', () => {
    const html = pintar(<ListaEventos eventos={[{ kind: 'corregido', at: '<b>ayer</b>', client: null }]} reaperturas={0} />, RUTA);
    expect(html).not.toContain('<b>');
    expect(html).toContain('—');
  });
});

describe('periodo de Evolución', () => {
  const ahora = Date.parse('2026-10-25T12:00:00.000Z');
  it('nuevas: detectadas o reaparecidas en el periodo; corregidas: marcadas o verificadas y aún cerradas', () => {
    const nuevas = LISTA.filter((f) => nuevaEnPeriodo(f, 2, ahora)).map((f) => f.id);
    const corregidas = LISTA.filter((f) => corregidaEnPeriodo(f, 2, ahora)).map((f) => f.id);
    expect(nuevas).toContain(fx.lineaTiempoFalla.item.id);                       // reapareció el sábado
    expect(corregidas.length).toBeGreaterThan(0);
    for (const id of corregidas) expect(['fixed', 'verified']).toContain(LISTA.find((f) => f.id === id)!.status);
    expect(LISTA.filter((f) => corregidaEnPeriodo(f, 90, ahora)).length).toBe(LISTA.filter((f) => f.status === 'fixed' || f.status === 'verified').length);
  });
});
