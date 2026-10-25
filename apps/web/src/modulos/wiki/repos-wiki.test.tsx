// Wiki por repo (varias-codebases §4.1 y §6.3, F3): la página lista todos los repos conectados, activos o no y sin
// repetidos, y abre sola la última wiki lista del repo elegido, también para el viewer con la conexión caída. Sin
// jsdom: renderToStaticMarkup con la caché precargada (los efectos no corren, por eso la wiki se elige al pintar).
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic, WikiDoc, WikiRun } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { reposGithub } from '@/lib/repos';
import { wikiAnterior } from './texto';
import PaginaWiki from './PaginaWiki';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', puedeEscribir: false };
const CX = z.array(ConnectionPublic).parse(fx.connections);
const GH = CX.find((c) => c.provider === 'github')!;
const GH2 = ConnectionPublic.parse(fx.conexionGithub2);
const REPO = GH.meta.repo_full_name as string;
const REPO_2 = GH2.meta.repo_full_name as string;
const RUNS = z.array(WikiRun).parse(fx.wikiRuns);
const LISTA = wikiAnterior(RUNS, { repo_full_name: REPO })!;
const RLO = '‮';

function pagina(org: OrgActual, conexiones: ConnectionPublic[], ruta = `/o/${ORG}/wiki`, extra: [QueryKey, unknown][] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['org', ORG, 'connections'], conexiones);
  qc.setQueryData(['org', ORG, 'wiki', 'runs', REPO], RUNS);
  qc.setQueryData(['org', ORG, 'wiki', 'runs', REPO_2], []);
  qc.setQueryData(['org', ORG, 'wiki', 'run', LISTA.id], LISTA);
  qc.setQueryData(['org', ORG, 'wiki', 'doc', LISTA.id], WikiDoc.parse({ ...fx.wikiDoc, run_id: LISTA.id }));
  for (const [k, v] of extra) qc.setQueryData(k, v);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}><OrgDePrueba org={org}><PaginaWiki /></OrgDePrueba></MemoryRouter>
    </QueryClientProvider>,
  );
}
const revocada = (c: ConnectionPublic, extra: Partial<ConnectionPublic> = {}): ConnectionPublic => ({ ...c, status: 'revoked', ...extra });

describe('reposGithub', () => {
  it('un repo por nombre en minúsculas, en el orden de E7; de cada grupo la activa, si no la más antigua', () => {
    const vieja = revocada(GH, { id: 'c0000000-0000-4000-8000-0000000000a1' });
    const nueva = { ...GH, meta: { ...GH.meta, repo_full_name: REPO.toUpperCase() } };
    expect(reposGithub([vieja, GH2, nueva]).map((c) => c.id)).toEqual([GH.id, GH2.id]);
    const otraVieja = revocada(GH, { id: 'c0000000-0000-4000-8000-0000000000a2' });
    expect(reposGithub([vieja, otraVieja]).map((c) => c.id)).toEqual([vieja.id]);
    // La conexión de estados del bloqueo de merge (kind 'action') no es un repo.
    expect(reposGithub([{ ...GH2, id: 'c0000000-0000-4000-8000-000000000006', kind: 'action' }, GH])).toEqual([GH]);
  });
});

describe('PaginaWiki · varios repos', () => {
  it('el viewer con la conexión revocada (y repetida) ve el repo una vez y su última wiki lista se abre sola, sin generar', () => {
    const html = pagina(VIEWER, [revocada(GH, { id: 'c0000000-0000-4000-8000-0000000000a1' }), revocada(GH)]);
    expect(html.match(/aria-label="Repos conectados"/g)).toHaveLength(1);
    expect(html).toContain('Tu repo<');
    expect(html.match(/Conexión no activa/g)).toHaveLength(1);       // una fila, no dos
    expect(html).toContain('Wiki lista');
    expect(html).toContain('aria-label="Wiki del repo"');            // el documento, sin pulsar la fila del historial
    expect(html).toContain(`aria-current="true"`);
    expect(html).not.toContain('Estimar costo');
    expect(html).not.toContain('Generar wiki');
    expect(html).not.toContain('Otro repo público');
  });

  it('con dos repos lista los dos; ?repo= elige el segundo, sin wiki y sin documento abierto', () => {
    const dos = pagina(VIEWER, [...CX, GH2]);
    expect(dos).toContain('Tus repos (2)');
    expect(dos).toContain(`<bdi dir="ltr">${REPO_2}</bdi>`);
    expect(dos).toContain('Sin wiki');
    const segundo = pagina(VIEWER, [...CX, GH2], `/o/${ORG}/wiki?repo=${REPO_2}`);
    expect(segundo).toContain('Aún no hay wikis de este repo.');
    expect(segundo).not.toContain('aria-label="Wiki del repo"');
    expect(segundo).toMatch(new RegExp(`aria-current="true"[^>]*>[^]*?${REPO_2.replace('/', '\\/')}`));
  });

  it('?run= manda sobre la última lista: el historial marca la pedida', () => {
    const otra = RUNS.find((r) => r.id !== LISTA.id)!;
    const html = pagina(VIEWER, CX, `/o/${ORG}/wiki?run=${otra.id}`, [[['org', ORG, 'wiki', 'run', otra.id], otra],
      [['org', ORG, 'wiki', 'doc', otra.id], WikiDoc.parse({ ...fx.wikiDoc, run_id: otra.id })]]);
    expect(html).toContain('aria-label="Wiki del repo"');
    expect(html.match(/aria-current="true"/g)?.length).toBe(2);       // la fila del repo y la de la corrida pedida
  });

  it('el admin estima el repo elegido con su conexión; con ella caída, «Reconecta el repo para generar otra»', () => {
    const activa = pagina(ADMIN, CX);
    expect(activa).toContain('Generar la wiki de');
    expect(activa).toContain('Estimar costo');
    expect(activa).toContain('Otro repo público');
    const caida = pagina(ADMIN, [revocada(GH)]);
    expect(caida).toContain('Reconecta el repo para generar otra');
    expect(caida).toContain(`href="/o/${ORG}/connections/github?repo=${encodeURIComponent(REPO)}"`);
    expect(caida).not.toContain('Generar la wiki de');
  });

  it('a 375 px un repo largo parte en «Generar la wiki de», en el aviso de la conexión caída y en el historial', () => {
    expect(pagina(ADMIN, CX)).toContain(`Generar la wiki de <bdi dir="ltr" class="font-mono font-semibold break-all">${REPO}</bdi>`);
    expect(pagina(ADMIN, [revocada(GH)])).toContain(`<bdi dir="ltr" class="font-mono break-all">${REPO}</bdi>: la conexión no está activa.`);
    expect(pagina(VIEWER, CX)).toMatch(/Historial<span class="[^"]*break-all[^"]*"> · <bdi dir="ltr">/);
  });

  it('sin conexiones GitHub, la página de siempre: sin lista y con el campo del repo a la vista', () => {
    const html = pagina(ADMIN, CX.filter((c) => c.provider !== 'github'));
    expect(html).not.toContain('aria-label="Repos conectados"');
    expect(html).not.toContain('Otro repo público');
    expect(html).toContain('id="wiki-repo"');
  });

  it('una corrida fuera de contrato (sin repo; api() en producción la deja pasar) no tumba la página del viewer', () => {
    const rota = { ...RUNS[0]!, id: 'c5000000-0000-4000-8000-0000000000f1', repo_full_name: null, finished_at: '2030-01-01T00:00:00.000Z' };
    const conRota = [rota, ...RUNS] as unknown as WikiRun[];
    expect(wikiAnterior(conRota, { repo_full_name: REPO })?.id).toBe(LISTA.id);
    const html = pagina(VIEWER, [...CX, GH2], `/o/${ORG}/wiki`, [[['org', ORG, 'wiki', 'runs', REPO], conRota]]);
    expect(html).toContain('Wiki lista');
    expect(html).toContain('aria-label="Wiki del repo"');            // la buena se abre igual
  });

  it('el nombre del repo sale con sus controles bidi a la vista y en <bdi dir="ltr">', () => {
    const malo = { ...GH2, meta: { ...GH2.meta, repo_full_name: `equipo/${RLO}landing` } };
    const html = pagina(VIEWER, [...CX, malo]);
    expect(html).not.toContain(RLO);
    expect(html).toContain('<bdi dir="ltr">equipo/⟨U+202E⟩landing</bdi>');
  });
});
