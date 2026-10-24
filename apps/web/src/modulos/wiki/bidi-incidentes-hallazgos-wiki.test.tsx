// Controles bidi (Trojan Source, CVE-2021-42574) en la wiki: repo@rama, commit, modelos, avisos, títulos de página y
// detalle de los pasos salen con ⟨U+202E⟩ a la vista, nunca con el control crudo; los técnicos, en <bdi dir="ltr">.
// El Markdown lo sanea <Markdown> por dentro (lib/markdown.tsx). Pintado con renderToStaticMarkup, sin jsdom.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, WikiDoc, WikiEstimate, WikiRun } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import PaginaWiki, { Estimacion, Progreso } from './PaginaWiki';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const RLO = String.fromCodePoint(0x202e);
const VISTO = '⟨U+202E⟩';
const MODELOS = { fast: `haiku${RLO}`, smart: `sonnet${RLO}` };

describe('Estimacion · controles bidi', () => {
  it('repo@rama, commit, modelos del desglose y de abajo y avisos salen con ⟨U+202E⟩', () => {
    const base = WikiEstimate.parse(fx.wikiEstimate);
    const e = { ...base, branch: `main${RLO}`, commit_sha: `ab${RLO}${'c'.repeat(37)}`, models: MODELOS, avisos: [`aviso${RLO}`],
      est: { ...base.est, desglose: base.est.desglose.map((d) => ({ ...d, modelo: `modelo${RLO}` })) } };
    const html = renderToStaticMarkup(<Estimacion e={e} ocupado={false} alGenerar={() => {}} alRegenerar={async () => {}} alVer={() => {}} />);
    expect(html).not.toContain(RLO);
    expect(html).toContain(`<bdi dir="ltr">${base.repo_full_name}@main${VISTO}</bdi>`);
    expect(html).toContain(`ab${VISTO}cccc`);
    expect(html).toContain(`<bdi dir="ltr">modelo${VISTO}</bdi>`);
    expect(html).toContain(`<bdi dir="ltr">haiku${VISTO}</bdi>`);
    expect(html).toContain(`<bdi dir="ltr">sonnet${VISTO}</bdi>`);
    expect(html).toContain(`aviso${VISTO}`);
  });
});

describe('Progreso · controles bidi', () => {
  it('el detalle de cada paso y el error de la corrida salen con ⟨U+202E⟩', () => {
    const base = WikiRun.parse(fx.wikiRunRunning);
    const run = { ...base, status: 'failed' as const, error: `fallo${RLO}`, steps: base.steps.map((s) => ({ ...s, detalle: `detalle${RLO}` })) };
    const html = renderToStaticMarkup(<Progreso run={run} estancada={false} puedeEscribir alReintentar={() => {}} />);
    expect(html).not.toContain(RLO);
    expect(html).toContain(`detalle${VISTO}`);
    expect(html).toContain(`fallo${VISTO}`);
  });
});

describe('PaginaWiki · controles bidi', () => {
  it('documento (repo@rama, modelos, títulos y avisos) e historial (rama) salen con ⟨U+202E⟩', () => {
    const run = WikiRun.parse(fx.wikiRunDone);
    const base = WikiDoc.parse(fx.wikiDoc);
    const doc = { ...base, branch: `main${RLO}`, models: MODELOS, avisos: [`aviso${RLO}`],
      paginas: base.paginas.map((p, k) => ({ ...p, titulo: `titulo${k}${RLO}` })) };
    const runs = [{ ...run, branch: `rama${RLO}` }];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['org', ORG, 'wiki', 'run', run.id], run);
    qc.setQueryData(['org', ORG, 'wiki', 'doc', run.id], doc);
    qc.setQueryData(['org', ORG, 'wiki', 'runs', null], runs);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/o/${ORG}/wiki?run=${run.id}`]}>
          <OrgDePrueba org={ADMIN}><Routes><Route path="/o/:orgId/wiki" element={<PaginaWiki />} /></Routes></OrgDePrueba>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).not.toContain(RLO);
    expect(html).toContain(`<bdi dir="ltr">${base.repo_full_name}@main${VISTO}</bdi>`);
    expect(html).toContain(`<bdi dir="ltr">haiku${VISTO}</bdi> y <bdi dir="ltr">sonnet${VISTO}</bdi>`);
    expect(html).toContain(`titulo0${VISTO}`);
    expect(html).toContain(`aviso${VISTO}`);
    expect(html).toContain(`<bdi dir="ltr">rama${VISTO}</bdi>`);
  });
});
