// F12 (asignaciones/evolucion-entre-revisiones.md §9.3): la línea «Desde la auditoría anterior» del Resumen y la etiqueta
// «Nuevo» de «Hallazgos abiertos» en la auditoría, las dos con E51. Sin E51 (404) no se pinta ninguna.
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, AuditDelta, ConnectionPublic, Finding, Overview } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import PaginaResumen from '@/modulos/resumen/PaginaResumen';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const ID = fx.scanDone.id;
const CLAVE_DELTA = ['org', ORG, 'scan', ID, 'delta'];
const OVERVIEW = Overview.parse({ ...fx.overview, last_scan: { id: ID, status: 'succeeded', finished_at: fx.scanDone.finished_at } });

function pintar(nodo: ReactNode, ruta: string, datos: [QueryKey, unknown][], delta: unknown, patron = '/o/:orgId/*') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  for (const [k, v] of datos) qc.setQueryData(k, v);
  if (delta instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: CLAVE_DELTA }).setState({ status: 'error', error: delta, fetchStatus: 'idle' });
  else qc.setQueryData(CLAVE_DELTA, delta);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[ruta]}>
      <OrgDePrueba org={ADMIN}><Routes><Route path={patron} element={nodo} /></Routes></OrgDePrueba>
    </MemoryRouter></QueryClientProvider>);
}
const texto = (html: string) => html.replace(/<[^>]+>/g, '');
const NO_DESPLEGADO = new ApiError(404, 'not_found', 'Ruta inexistente');

describe('Resumen · desde la auditoría anterior', () => {
  const resumen = (delta: unknown) => pintar(<PaginaResumen />, `/o/${ORG}/overview`, [
    [['org', ORG, 'overview'], OVERVIEW], [['org', ORG, 'connections'], z.array(ConnectionPublic).parse(fx.connections)]], delta);

  it('con E51: nuevos y corregidos de la última auditoría y el enlace a la evolución', () => {
    const html = resumen(AuditDelta.parse(fx.auditDelta));
    expect(texto(html)).toContain('Desde la auditoría anterior: 7 nuevos · 2 corregidos · Ver evolución');
    expect(html).toContain(`href="/o/${ORG}/evolution"`);
  });
  it('404, primera foto o sin foto: nada', () => {
    expect(resumen(NO_DESPLEGADO)).not.toContain('Desde la auditoría anterior');
    expect(resumen({ ...fx.auditDelta, first: true, previous: null })).not.toContain('Desde la auditoría anterior');
    expect(resumen({ available: false, scan_run_id: ID, reason: 'sin_foto' })).not.toContain('Desde la auditoría anterior');
  });
});

describe('Auditoría · «Nuevo» en «Hallazgos abiertos»', () => {
  const abiertos = z.array(Finding).parse(fx.findings).filter((f) => f.status === 'open');
  const auditoria = (delta: unknown) => pintar(<PaginaAuditoria />, `/o/${ORG}/audit/${ID}`, [
    [['org', ORG, 'scan', ID], fx.scanDone], [['org', ORG, 'findings', { status: 'open' }], abiertos], [['org', ORG, 'overview'], OVERVIEW]], delta, '/o/:orgId/audit/:scanId');
  const nuevos = (html: string) => (html.match(/>Nuevo</g) ?? []).length;

  it('solo los nuevos frente a la anterior llevan la etiqueta', () => {
    const html = auditoria(AuditDelta.parse(fx.auditDelta));
    expect(nuevos(html)).toBe(7);                                // los 7 nuevos del sábado; los 5 que se mantienen, sin ella
    expect(texto(html)).toContain('Cambios desde la auditoría anterior');
  });
  it('sin E51 (404) ni en la primera foto, ninguna etiqueta ni bloque de cambios', () => {
    const html = auditoria(NO_DESPLEGADO);
    expect(nuevos(html)).toBe(0);
    expect(html).not.toContain('Cambios desde la auditoría anterior');
    expect(texto(html)).toContain('Hallazgos abiertos');
    expect(nuevos(auditoria({ ...fx.auditDelta, first: true, previous: null }))).toBe(0);
  });
});
