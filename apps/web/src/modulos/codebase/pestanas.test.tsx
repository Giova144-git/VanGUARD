// Codebase con varios repos (varias-codebases §6.2, F2): una pestaña por repo con su chapa, ?revision= elige la pestaña
// cuya lista lo trae, cada tarjeta va por su conexión y con un solo repo la pantalla queda como antes (sin pestañas).
// Sin jsdom: renderToStaticMarkup con la caché precargada, como PantallaModulo.test.tsx.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, CodeReviewState, ConnectionPublic } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { chapaGithub } from '@/modulos/conexiones/TarjetaConexion';
import PaginaCodebase, { chipPestana } from './PaginaCodebase';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const CX = z.array(ConnectionPublic).parse(fx.connections);
const GH = CX.find((c) => c.provider === 'github')!;
const GH2 = ConnectionPublic.parse(fx.conexionGithub2);
const REPO_2 = GH2.meta.repo_full_name as string;
const ESTADO_1 = CodeReviewState.parse(fx.codeReviewState);
const REV_2 = { ...ESTADO_1.recent[1]!, id: 'c4000000-0000-4000-8000-0000000000e2' };
const ESTADO_2 = CodeReviewState.parse({ ...fx.codeReviewStateRepo2, recent: [REV_2] });

function pagina(conexiones: ConnectionPublic[], ruta = `/o/${ORG}/codebase`, estado2: CodeReviewState | ApiError = ESTADO_2) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['org', ORG, 'module', 'codebase'], fx.moduleState.codebase);
  qc.setQueryData(['org', ORG, 'connections'], conexiones);
  qc.setQueryData(['org', ORG, 'alert-prefs'], fx.alertPrefs);
  qc.setQueryData(['org', ORG, 'revision', GH.id], ESTADO_1);
  if (estado2 instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: ['org', ORG, 'revision', GH2.id] }).setState({ status: 'error', error: estado2, fetchStatus: 'idle' });
  else qc.setQueryData(['org', ORG, 'revision', GH2.id], estado2);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}><OrgDePrueba org={ADMIN}><PaginaCodebase /></OrgDePrueba></MemoryRouter>
    </QueryClientProvider>,
  );
}
// El botón de cada pestaña con su estado (Radix pinta aria-selected); el texto de dentro sin etiquetas.
const pestanas = (html: string) => [...html.matchAll(/<button[^>]*role="tab"[^>]*aria-selected="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)]
  .map(([, sel, txt]) => ({ elegida: sel === 'true', texto: txt!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }));

describe('PaginaCodebase · varias codebases', () => {
  it('con un repo, como antes: sin pestañas, «Analizar repo ahora» y su tarjeta de revisión', () => {
    const html = pagina(CX);
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('Analizar repo ahora');
    expect(html).not.toContain('Analizar este repo');
    expect(html).toContain('Revisión automática de código');
    expect(html).not.toContain('La auditoría completa revisa el repo principal');
  });

  it('con dos, una pestaña por repo con la chapa de su revisión; la primera elegida; sin «Analizar todos» hasta B3', () => {
    const html = pagina([...CX, GH2]);
    expect(html).toContain('role="tablist"');
    expect(pestanas(html)).toEqual([
      { elegida: true, texto: `${GH.meta.repo_full_name} Activa` },
      { elegida: false, texto: `${REPO_2} Apagada` },
    ]);
    expect(html).toContain('Analizar este repo');
    expect(html).toContain('La auditoría completa revisa el repo principal. Los demás, con su botón.');
    expect(html).not.toContain('Analizar todos');
    expect(html.match(/Revisión automática de código/g)).toHaveLength(1);   // solo la pestaña elegida
  });

  it('?repo=<connection_id> elige la pestaña; ?revision= sin ?repo= elige la que trae esa revisión', () => {
    expect(pestanas(pagina([...CX, GH2], `/o/${ORG}/codebase?repo=${GH2.id}`)).map((p) => p.elegida)).toEqual([false, true]);
    const html = pagina([...CX, GH2], `/o/${ORG}/codebase?revision=${REV_2.id}`);
    expect(pestanas(html).map((p) => p.elegida)).toEqual([false, true]);
    expect(html).toContain(`id="revision-${REV_2.id}"`);
    expect(html).toContain('aria-expanded="true"');                       // la revisión del enlace, abierta
    expect(pestanas(pagina([...CX, GH2], `/o/${ORG}/codebase?revision=${ESTADO_1.recent[0]!.id}`)).map((p) => p.elegida)).toEqual([true, false]);
  });

  it('una pestaña cuyo E45 da 404 sale con «—» y sin tarjeta (bandera por 404)', () => {
    const html = pagina([...CX, GH2], `/o/${ORG}/codebase?repo=${GH2.id}`, new ApiError(404, 'not_found', 'Ruta inexistente'));
    expect(pestanas(html)[1]).toEqual({ elegida: true, texto: `${REPO_2} —` });
    expect(html).not.toContain('Revisión automática de código');
    expect(html).toContain('Analizar este repo');
  });

  it('las parejas viejas de «Reconectar» salen una vez, con la activa', () => {
    const vieja = { ...GH, id: 'c0000000-0000-4000-8000-0000000000a1', status: 'revoked' as const };
    expect(pagina([vieja, ...CX])).not.toContain('role="tablist"');
  });
});

describe('chapas de varios repos', () => {
  it('chipPestana: Activa, Apagada, Error, y «—» sin dato o con la config de otro repo', () => {
    expect(chipPestana(ESTADO_1, GH.id)).toEqual({ texto: 'Activa', rol: 'bien' });
    expect(chipPestana(ESTADO_2, GH2.id)).toEqual({ texto: 'Apagada', rol: 'neutra' });
    expect(chipPestana({ ...ESTADO_1, reason: 'conexion_inactiva' }, GH.id).texto).toBe('Error');
    expect(chipPestana(undefined, GH.id).texto).toBe('—');
    expect(chipPestana(ESTADO_1, GH2.id).texto).toBe('—');
  });

  it('chapaGithub: «N repos» en verde; si uno falla, la chapa del que falla', () => {
    expect(chapaGithub([GH, GH2])).toEqual({ texto: '2 repos', rol: 'bien' });
    expect(chapaGithub([GH, { ...GH2, status: 'revoked' }])).toEqual({ texto: 'Token revocado', rol: 'mal' });
    expect(chapaGithub([GH])?.texto).toMatch(/^Conectado/);
    expect(chapaGithub([])).toBeNull();
  });
});
