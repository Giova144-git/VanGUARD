// Chip del repo (varias-codebases §6.4, F4a, no se recorta): en «Ahora» del Resumen, en la lista de hallazgos de la
// auditoría y en el detalle, solo cuando la org tiene 2 o más repos. Sin jsdom: renderToStaticMarkup con la caché a mano.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic, Finding, Overview, ScanRun } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import PaginaResumen from '@/modulos/resumen/PaginaResumen';
import { DetalleHallazgo } from './DetalleHallazgo';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const CX = z.array(ConnectionPublic).parse(fx.connections);
const GH = CX.find((c) => c.provider === 'github')!;
const GH2 = ConnectionPublic.parse(fx.conexionGithub2);
const REPO = GH.meta.repo_full_name as string;
const HALLAZGOS = z.array(Finding).parse(fx.findings);
const DE_CODIGO = HALLAZGOS.find((f) => f.connection_id === GH.id)!;
const RLO = '‮';
const CHIP = (repo: string) => `<span class="sr-only">Repo: </span><bdi dir="ltr" class="break-all">${repo}</bdi>`;

function pintar(nodo: React.ReactNode, conexiones: ConnectionPublic[], ruta: string, patron: string, datos: [QueryKey, unknown][] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['org', ORG, 'connections'], conexiones);
  for (const [k, v] of datos) qc.setQueryData(k, v);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}><OrgDePrueba org={ADMIN}><Routes><Route path={patron} element={nodo} /></Routes></OrgDePrueba></MemoryRouter>
    </QueryClientProvider>,
  );
}

// «Ahora» con el connection_id de cada hallazgo (E5 con B4).
const OVERVIEW = Overview.parse({ ...fx.overview,
  ahora: fx.overview.ahora.map((a) => (a.kind === 'finding' ? { ...a, connection_id: HALLAZGOS.find((f) => f.id === a.id)?.connection_id ?? null } : a)) });
const resumen = (cx: ConnectionPublic[], o = OVERVIEW) => pintar(<PaginaResumen />, cx, `/o/${ORG}/overview`, '/o/:orgId/overview', [[['org', ORG, 'overview'], o]]);

describe('chip del repo', () => {
  it('«Ahora» del Resumen: con dos repos, el hallazgo de código lleva el repo; con uno, nada', () => {
    const dos = resumen([...CX, GH2]);
    expect(dos).toContain(CHIP(REPO));
    expect(dos.split(CHIP(REPO)).length - 1).toBe(OVERVIEW.ahora.filter((a) => a.kind === 'finding' && a.connection_id === GH.id).length);
    expect(resumen(CX)).not.toContain('Repo: ');
    // Un BACK sin B4 no manda connection_id: sin chip, sin romper.
    expect(resumen([...CX, GH2], Overview.parse(fx.overview))).not.toContain('Repo: ');
  });

  it('detalle del hallazgo: con dos repos, el chip junto al módulo; las parejas viejas de «Reconectar» dan el mismo nombre', () => {
    const detalle = (cx: ConnectionPublic[], f: Finding = DE_CODIGO) => pintar(<DetalleHallazgo org={ORG} id={f.id} puedeEscribir />, cx,
      `/o/${ORG}/findings/${f.id}`, '/o/:orgId/findings/:id', [[['org', ORG, 'finding', f.id], f]]);
    expect(detalle([...CX, GH2])).toContain(CHIP(REPO));
    expect(detalle(CX)).not.toContain('Repo: ');
    const vieja = { ...GH, id: 'c0000000-0000-4000-8000-0000000000a1', status: 'revoked' as const };
    expect(detalle([vieja, ...CX, GH2], { ...DE_CODIGO, connection_id: vieja.id })).toContain(CHIP(REPO));
  });

  it('lista de hallazgos abiertos de la auditoría: chip con dos repos', () => {
    const run = ScanRun.parse(fx.scanDone);
    const html = pintar(<PaginaAuditoria />, [...CX, GH2], `/o/${ORG}/audit/${run.id}`, '/o/:orgId/audit/:scanId', [
      [['org', ORG, 'scan', run.id], run], [['org', ORG, 'findings', { status: 'open' }], HALLAZGOS.filter((f) => f.status === 'open')]]);
    expect(html).toContain('Hallazgos abiertos');
    expect(html).toContain(CHIP(REPO));
  });

  it('el nombre del repo sale con sus controles bidi a la vista', () => {
    const malo = { ...GH, meta: { ...GH.meta, repo_full_name: `equipo/${RLO}tienda` } };
    const html = resumen([malo, GH2]);
    expect(html).not.toContain(RLO);
    expect(html).toContain(CHIP('equipo/⟨U+202E⟩tienda'));
  });
});
