// Controles bidi (Trojan Source, CVE-2021-42574) en el detalle de un hallazgo: regla, motivo, modelo y el <pre> del
// prompt salen con ⟨U+202E⟩ a la vista, nunca con el control crudo. Pintado con renderToStaticMarkup, sin jsdom.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, Finding, FixPromptResponse } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { DetalleHallazgo } from './DetalleHallazgo';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const RLO = String.fromCodePoint(0x202e);
const VISTO = '⟨U+202E⟩';

describe('DetalleHallazgo · controles bidi', () => {
  it('rule_id, motivo, modelo y el prompt del <pre> salen con ⟨U+202E⟩; los técnicos, en <bdi dir="ltr">', () => {
    const f = { ...Finding.parse(fx.findings[0]), has_fix_prompt: true, status: 'ignored' as const, status_reason: `porque ${RLO}sí`, rule_id: `CB_${RLO}X` };
    const fix = { ...FixPromptResponse.parse(fx.fixPrompt), prompt: `Arregla src/lib/${RLO}sj.nimda`, model: `claude${RLO}` };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['org', ORG, 'finding', f.id], f);
    qc.setQueryData(['org', ORG, 'fix', f.id], fix);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/o/${ORG}/findings/${f.id}`]}>
          <OrgDePrueba org={ADMIN}><DetalleHallazgo org={ORG} id={f.id} puedeEscribir /></OrgDePrueba>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).not.toContain(RLO);
    expect(html).toContain(`<bdi dir="ltr">CB_${VISTO}X</bdi>`);
    expect(html).toContain(`Motivo: porque ${VISTO}sí`);
    expect(html).toContain(`<bdi dir="ltr">claude${VISTO}</bdi>`);
    expect(html).toContain(`whitespace-pre-wrap"><bdi dir="ltr">Arregla src/lib/${VISTO}sj.nimda</bdi></pre>`);
  });
});
