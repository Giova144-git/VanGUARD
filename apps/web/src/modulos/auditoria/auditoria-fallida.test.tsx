// Auditoría que el limpiador marca failed después de guardar sus pasos: sin «Preparando…», barra en gris, el error con
// «Reintentar auditoría» y, debajo, el resumen y los hallazgos ya guardados. Sin jsdom: renderToStaticMarkup.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, ScanRun, type Finding } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import PaginaAuditoria from './PaginaAuditoria';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const HECHA = ScanRun.parse(fx.scanDone);
const ERROR = 'La auditoría se interrumpió; vuelve a lanzarla';
const RESUMEN = { resumen: 'Rota la clave service_role.', top: [], relaciones: [], model: 'claude-opus-5-5' } as unknown as ScanRun['summary'];
const HALLAZGO = { id: '9fee42bb-eceb-4b80-b116-07764416708a', title: 'Clave service_role de Supabase en el código', resource: 'index.html:7', severity: 'critical', module: 'codebase', connection_id: null } as unknown as Finding;

function auditoria(run: ScanRun, hallazgos: Finding[] = [HALLAZGO]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['org', ORG, 'scan', run.id], run);
  qc.setQueryData(['org', ORG, 'findings', { status: 'open' }], hallazgos);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/o/${ORG}/audit/${run.id}`]}>
        <OrgDePrueba org={ADMIN}><Routes><Route path="/o/:orgId/audit/:scanId" element={<PaginaAuditoria />} /></Routes></OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const cortada = (extra: Partial<ScanRun> = {}): ScanRun => ({
  ...HECHA, status: 'failed', progress: 95, step: null, error: ERROR, summary: RESUMEN,
  steps: HECHA.steps.map((s) => ({ ...s, status: 'done' as const })), ...extra,
});

describe('auditoría failed con datos guardados', () => {
  it('dice que se interrumpió, no «Preparando…», y deja la barra en gris (parada)', () => {
    const html = auditoria(cortada());
    expect(html).not.toContain('Preparando…');
    expect(html).toContain('Auditoría interrumpida');
    expect(html).toContain('h-full transition-[width] bg-texto-3');
    expect(html).not.toContain('bg-info');
    expect(html).toContain(ERROR);
    expect(html).toContain('Reintentar auditoría');
  });

  it('enseña el resumen y los hallazgos que alcanzó a guardar', () => {
    const html = auditoria(cortada());
    expect(html).toContain('Lo que alcanzó a guardar antes de cortarse sigue abajo.');
    expect(html).toContain('Rota la clave service_role.');
    expect(html).toContain('Hallazgos abiertos');
    expect(html).toContain('Clave service_role de Supabase en el código');
  });

  it('sin resumen guardado no dice «IA en pausa»: solo los hallazgos', () => {
    const html = auditoria(cortada({ summary: null }));
    expect(html).not.toContain('Resumen con IA en pausa');
    expect(html).toContain('Hallazgos abiertos');
  });

  it('cortada antes de terminar ningún paso no enseña nada guardado', () => {
    const html = auditoria(cortada({ summary: null, steps: HECHA.steps.map((s) => ({ ...s, status: 'pending' as const })) }));
    expect(html).not.toContain('Lo que alcanzó a guardar');
    expect(html).not.toContain('Hallazgos abiertos');
    expect(html).toContain('Reintentar auditoría');
  });
});
