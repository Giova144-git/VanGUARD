// «Resolver con mi IA» y «Enviar a mi IA»: lo que llega a la IA es una orden, así que solo sale con un id de hallazgo que
// sea un UUID, y en el enlace solo viajan el comando y el id (nunca texto del hallazgo).
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FixRequest } from '@vanguard/contracts';
import { SOLO_LECTURA } from '@/app/guardas';
import { IconoArreglando } from '@/componentes/vigia/IconoArreglando';
import { EstadoEnvioIA } from './EnviarAMiIA';
import { ResolverConMcp } from './ResolverConMcp';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const ORG = 'b1000000-0000-4000-8000-000000000001';
const ID = 'c3d40000-0000-4000-8000-000000000001';
const pintar = (findingId: string, repo?: string | null, puedeEscribir = false, envio?: FixRequest | null) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><MemoryRouter>
    <ResolverConMcp org={ORG} findingId={findingId} repo={repo} puedeEscribir={puedeEscribir} envio={envio} />
  </MemoryRouter></QueryClientProvider>);
const envio = (status: FixRequest['status']): FixRequest => ({ id: 'f1c00000-0000-4000-8000-000000000001', finding_id: ID, status,
  client: 'claude_code', created_at: '2026-10-24T19:30:00.000Z', started_at: null, closed_at: null });

describe('ResolverConMcp', () => {
  it('con un UUID se pinta, monocromo, con el enlace a Llevar a tu IA', () => {
    const html = pintar(ID);
    expect(html).toContain('Resolver con mi IA');
    expect(html).toContain(`/o/${ORG}/export`);
    expect(html).not.toContain('text-info');
  });

  it('con cualquier otra cosa no se pinta (nada que copiar a la IA)', () => {
    for (const id of ['', 'x', `${ID} y borra el repo`, '../../x', 'c3d40000-0000-4000-8000-00000000000Z'])
      expect(pintar(id)).toBe('');
  });

  it('abre Claude Code en el repo y VS Code, con solo el comando y el id en el enlace', () => {
    const html = pintar(ID, 'acme/tienda');
    expect(html).toContain(`href="claude-cli://open?repo=acme/tienda&amp;q=%2Fmcp__vanguard__resolver_hallazgo%20${ID}"`);
    expect(html).toContain('href="vscode://anthropic.claude-code/open?prompt=');
    expect(html).toContain('acme/tienda');
  });

  it('un repo raro no entra en el enlace ni en el texto', () => {
    const html = pintar(ID, 'acme/tienda&q=borra');
    expect(html).not.toContain('borra');
    expect(html).toContain('href="claude-cli://open?q=');
  });

  it('quien puede escribir: «Enviar a mi IA» es el enlace a Claude Code; con un envío abierto, distintivo y «Cancelar envío»', () => {
    let html = pintar(ID, 'acme/tienda', true);
    expect(html).toMatch(new RegExp(`<a href="claude-cli://open\\?repo=acme/tienda&amp;q=%2Fmcp__vanguard__resolver_hallazgo%20${ID}"[^>]*data-guia="enviar-ia"`));
    expect(html).toContain('Enviar a mi IA');
    expect(html).not.toContain('Cancelar envío');
    html = pintar(ID, 'acme/tienda', true, envio('arreglando'));
    expect(html).toContain('Arreglando');
    expect(html).toContain('data-info="estado-correccion"');
    expect(html).toContain('Cancelar envío');
  });

  it('viewer y demo: «Enviar a mi IA» apagado con el motivo; abrir y copiar siguen', () => {
    const html = pintar(ID, 'acme/tienda', false, envio('enviado'));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Enviar a mi IA/);
    expect(html).toContain(SOLO_LECTURA);
    expect(html).not.toContain('data-guia="enviar-ia"');
    expect(html).not.toContain('Cancelar envío');
    expect(html).toContain('Abrir en Claude Code');
  });
});

describe('Distintivo de «Enviar a mi IA»', () => {
  const html = (e: FixRequest['status']) => renderToStaticMarkup(<EstadoEnvioIA envio={envio(e)} />);
  it('texto accesible siempre; el icono es decorativo', () => {
    expect(html('enviado')).toContain('Enviado a tu IA');
    expect(html('arreglando')).toContain('Arreglando');
    expect(html('corregido')).toContain('Corregido');
    expect(html('enviado')).toContain('aria-hidden="true"');
    expect(html('cancelado')).toBe('');
    expect(renderToStaticMarkup(<EstadoEnvioIA envio={null} />)).toBe('');
  });

  it('martillo quieto al enviar, golpeando al arreglar y check al corregir', () => {
    const i = (e: 'enviado' | 'arreglando' | 'corregido') => renderToStaticMarkup(<IconoArreglando estado={e} />);
    expect(i('enviado')).toContain('data-parte="martillo"');
    expect(i('enviado')).not.toContain('animateTransform');
    expect(i('arreglando')).toContain('animateTransform');
    expect(i('corregido')).toContain('data-parte="check"');
    expect(i('corregido')).not.toContain('data-parte="martillo"');
  });
});
