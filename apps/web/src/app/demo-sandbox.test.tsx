// La copia temporal de la demo en la web: permisos, ULTIMA_ORG, la etiqueta con su Info, la página /demo y los avisos
// de otras pestañas. Sin jsdom: renderToStaticMarkup y funciones puras.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { INFO } from '@/componentes/vigia/info';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const { puedeEscribirEn } = await import('./guardas');
const { EtiquetaSandbox } = await import('./DemoSandbox');
const { VistaDemo, PREPARANDO_OTRA, NO_RECREADA } = await import('./paginas/Demo');
const { esDeOtraPestana } = await import('./sesion');

describe('sandbox en la web', () => {
  it('puedeEscribir: el dueño de su sandbox escribe aunque sea invitado; el viewer no', () => {
    expect(puedeEscribirEn({ role: 'owner' })).toBe(true);
    expect(puedeEscribirEn({ role: 'admin' })).toBe(true);
    expect(puedeEscribirEn({ role: 'viewer' })).toBe(false);
  });

  it('la etiqueta «Demo · tu copia temporal» lleva su Info, que habla de la simulación y del borrado', () => {
    const html = renderToStaticMarkup(<EtiquetaSandbox />);
    expect(html).toContain('Demo · tu copia temporal');
    expect(html).toContain('data-info="demo-sandbox"');
    expect(INFO['demo-sandbox'].texto).toMatch(/simulan/);
    expect(INFO['demo-sandbox'].texto).toMatch(/cerrar el navegador/);
  });

  it('/demo: mientras prepara, no dice «solo lectura»; con error, enseña el mensaje de la API', () => {
    const cargando = renderToStaticMarkup(<MemoryRouter><VistaDemo error={null} /></MemoryRouter>);
    expect(cargando).toContain('Preparando tu copia de la demo');
    expect(cargando).not.toMatch(/solo lectura/i);
    const error = renderToStaticMarkup(<MemoryRouter><VistaDemo error="Ya hay 3 demos abiertas desde tu red" /></MemoryRouter>);
    expect(error).toContain('Ya hay 3 demos abiertas desde tu red');
  });

  it('/demo?caducada: Vigía dice que prepara otra; si ya se intentó, «Volver a la demo» y nunca «No tienes acceso»', () => {
    const prepara = renderToStaticMarkup(<MemoryRouter><VistaDemo error={null} caducada /></MemoryRouter>);
    expect(prepara).toContain(PREPARANDO_OTRA);
    expect(prepara).toContain('data-pose="pensar"');
    const fallo = renderToStaticMarkup(<MemoryRouter><VistaDemo error={NO_RECREADA} caducada alReintentar={() => {}} /></MemoryRouter>);
    expect(fallo).toContain('Volver a la demo');
    expect(fallo).not.toContain('No tienes acceso');
    expect(fallo).not.toContain('/login');
  });

  it('un aviso de auth cuya sesión no es la guardada en esta pestaña es de otra pestaña', () => {
    expect(esDeOtraPestana({ user: { id: 'anon' } }, 'anon')).toBe(false);
    expect(esDeOtraPestana(null, null)).toBe(false);
    expect(esDeOtraPestana(null, 'ana')).toBe(true);                // el invitado de otra pestaña salió: esta sigue
    expect(esDeOtraPestana({ user: { id: 'ana' } }, 'anon')).toBe(true);
  });
});
