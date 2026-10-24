// Controles bidi (Trojan Source, CVE-2021-42574) en incidentes: el texto que llega del servidor sale con ⟨U+202E⟩ a la
// vista, nunca con el control crudo, y el técnico (origen, destinatario) aislado en <bdi dir="ltr">. Pintado con
// renderToStaticMarkup, sin jsdom, como seguridad/xss.test.tsx.
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, Incident, IncidentDetail, ProposeResponse, type ActionPublic } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { Propuesta } from './BloquearIp';
import PaginaIncidente from './PaginaIncidente';
import PaginaIncidentes from './PaginaIncidentes';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const RLO = String.fromCodePoint(0x202e);
const VISTO = '⟨U+202E⟩';

function pintar(nodo: ReactNode, ruta: string, patron: string, datos: [QueryKey, unknown][]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [k, v] of datos) qc.setQueryData(k, v);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}>
        <OrgDePrueba org={ADMIN}><Routes><Route path={patron} element={nodo} /></Routes></OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PaginaIncidentes · controles bidi', () => {
  it('el código y el origen de la fila salen con ⟨U+202E⟩; el origen, en <bdi dir="ltr">', () => {
    const lista = z.array(Incident).parse(fx.incidents).map((i, k) => (k === 0 ? { ...i, code: `A${RLO}1F3C`, resource: `ip:203.0.113.7${RLO}` } : i));
    const html = pintar(<PaginaIncidentes />, `/o/${ORG}/incidents`, '/o/:orgId/incidents', [[['org', ORG, 'incidents', 'open'], lista]]);
    expect(html).not.toContain(RLO);
    expect(html).toContain(`>A${VISTO}1F3C</span>`);
    expect(html).toContain(`<bdi dir="ltr">203.0.113.7${VISTO}</bdi>`);
  });
});

describe('PaginaIncidente · controles bidi', () => {
  it('código, reglas, destinatario del aviso y tipo y estado de una acción fuera de contrato salen con ⟨U+202E⟩', () => {
    const base = IncidentDetail.parse(fx.incidentDetail);
    const accion = { id: base.id, kind: `tipo${RLO}`, target: '203.0.113.7', status: `estado${RLO}`, created_at: base.started_at,
      undone_at: null, expires_at: null, approval_id: null } as unknown as ActionPublic;
    const i = { ...base, code: `B${RLO}7E20`, rule_ids: [`CF_${RLO}X`],
      notifications: base.notifications.map((n, k) => (k === 0 ? { ...n, recipient_masked: `+58${RLO}•••12` } : n)), actions: [accion] };
    const html = pintar(<PaginaIncidente />, `/o/${ORG}/incidents/${i.id}`, '/o/:orgId/incidents/:incidentId', [[['org', ORG, 'incident', i.id], i]]);
    expect(html).not.toContain(RLO);
    expect(html).toContain(`>B${VISTO}7E20</span>`);
    expect(html).toContain(`CF_${VISTO}X`);
    expect(html).toContain(`<bdi dir="ltr">+58${VISTO}•••12</bdi>`);
    expect(html).toContain(`tipo${VISTO}`);
    expect(html).toContain(`estado${VISTO}`);
  });
});

describe('Propuesta de BloquearIp · controles bidi', () => {
  it('efecto, avisos y código del servidor salen con ⟨U+202E⟩', () => {
    const p = { ...ProposeResponse.parse(fx.actionProposal), efecto: `Bloquear ${RLO}x`, avisos: [`aviso${RLO}`], delivery: 'in_app' as const, code: `48${RLO}2913` };
    const html = renderToStaticMarkup(<Propuesta p={p} codigo="" alCambiarCodigo={() => {}} escribiendo={false}
      alConfirmar={() => {}} alCancelar={() => {}} alVencer={() => {}} />);
    expect(html).not.toContain(RLO);
    expect(html).toContain(`Bloquear ${VISTO}x`);
    expect(html).toContain(`aviso${VISTO}`);
    expect(html).toContain(`48${VISTO}2913`);
  });

  it('sin código (fuera de contrato en «in_app») sale «—»', () => {
    const p = { ...ProposeResponse.parse(fx.actionProposal), delivery: 'in_app' as const, code: null };
    const html = renderToStaticMarkup(<Propuesta p={p} codigo="" alCambiarCodigo={() => {}} escribiendo={false}
      alConfirmar={() => {}} alCancelar={() => {}} alVencer={() => {}} />);
    expect(html).toContain('tu código es <span class="font-mono font-semibold text-foreground">—</span>');
  });
});
