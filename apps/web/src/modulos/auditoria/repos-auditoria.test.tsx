// Auditoría con varios repos (varias-codebases §6.4, F4b): una línea por repo bajo el paso «Codebase» con ScanRun.repos
// de 2 o más; el paso con `parcial` sale «Hecho en parte» aunque no haya líneas. Sin jsdom: renderToStaticMarkup.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, ScanRun } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import PaginaAuditoria from './PaginaAuditoria';
import { PINTA_PASO, estadoPaso, lineaRepo } from './pasos';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const DOS = ScanRun.parse(fx.scanDoneDosRepos);
const RLO = '‮';

function auditoria(run: ScanRun) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['org', ORG, 'scan', run.id], run);
  qc.setQueryData(['org', ORG, 'findings', { status: 'open' }], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/o/${ORG}/audit/${run.id}`]}>
        <OrgDePrueba org={ADMIN}><Routes><Route path="/o/:orgId/audit/:scanId" element={<PaginaAuditoria />} /></Routes></OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('lineaRepo', () => {
  it('estado en texto, hallazgos y motivo del fallo', () => {
    expect(lineaRepo({ status: 'done', findings: 7 }, false)).toEqual({ estado: 'Hecho', motivo: '', hallazgos: 7 });
    expect(lineaRepo({ status: 'done', findings: 2, error_code: 'osv_unavailable' }, false).estado).toBe('Hecho en parte');
    expect(lineaRepo({ status: 'failed', error_code: 'unauthorized' }, false)).toMatchObject({ estado: 'Falló', motivo: 'Token revocado' });
    expect(lineaRepo({ status: 'skipped', error_code: 'no_connection' }, false)).toMatchObject({ estado: 'Sin mirar', motivo: 'Conexión quitada' });
    expect(lineaRepo({ status: 'failed', error_code: 'forbidden' }, false).motivo).toBe('No pudimos revisarlo');
    expect(lineaRepo({ status: 'pending' }, true).estado).toBe('Pendiente');
    expect(lineaRepo({ status: 'pending' }, false).estado).toBe('Sin revisar');
  });
  it('códigos y estados fuera de contrato no lanzan ni pintan el prototipo', () => {
    for (const k of ['__proto__', 'constructor', 'toString']) {
      expect(lineaRepo({ status: 'failed', error_code: k }, false).motivo).toBe('No pudimos revisarlo');
      expect(lineaRepo({ status: k as never }, false).estado).toBe('—');
    }
  });
  it('el paso «Codebase» con parcial sale «Hecho en parte», no en verde', () => {
    const e = estadoPaso({ coverage: DOS.coverage }, { name: 'repo', status: 'done', error_code: 'parcial' });
    expect(PINTA_PASO[e].texto).toBe('Hecho en parte');
  });
});

describe('PaginaAuditoria · una línea por repo', () => {
  it('con dos repos, sus líneas bajo el paso; con uno o sin repos, ninguna', () => {
    const html = auditoria(DOS);
    expect(html).toContain('aria-label="Repos revisados"');
    for (const r of DOS.repos!) expect(html).toContain(`<bdi dir="ltr" class="font-mono break-all">${r.repo_full_name}</bdi>`);
    expect(html).toContain('· Hecho · 7 hallazgos');
    expect(html).toContain('· Hecho · 0 hallazgos');
    expect(auditoria({ ...DOS, repos: DOS.repos!.slice(0, 1) })).not.toContain('Repos revisados');
    expect(auditoria(ScanRun.parse(fx.scanDone))).not.toContain('Repos revisados');
  });

  it('entradas fuera de contrato (api() en producción las deja pasar) se descartan sin tumbar la auditoría', () => {
    const malas = [null, { connection_id: DOS.repos![0]!.connection_id, status: 'done' }, { ...DOS.repos![1]!, repo_full_name: 7 }] as unknown as ScanRun['repos'];
    expect(() => auditoria({ ...DOS, repos: [...DOS.repos!, ...malas!] })).not.toThrow();
    const html = auditoria({ ...DOS, repos: [...DOS.repos!, ...malas!] });
    expect(html.match(/<li class="flex flex-wrap items-baseline/g)).toHaveLength(2);
    // Con una sola entrada válida no hay lista (hacen falta 2 repos).
    expect(auditoria({ ...DOS, repos: [DOS.repos![0]!, ...malas!] })).not.toContain('Repos revisados');
  });

  it('un repo con el token revocado lo dice; el nombre sale con sus controles bidi a la vista', () => {
    const repos = [DOS.repos![0]!, { ...DOS.repos![1]!, repo_full_name: `equipo/${RLO}landing`, status: 'failed' as const, error_code: 'unauthorized', findings: undefined }];
    const html = auditoria({ ...DOS, repos, steps: DOS.steps.map((s) => (s.name === 'repo' ? { ...s, error_code: 'parcial' } : s)) });
    expect(html).toContain('· Falló · Token revocado');
    expect(html).toContain('Hecho en parte');
    expect(html).not.toContain(RLO);
    expect(html).toContain('equipo/⟨U+202E⟩landing');
  });
});
