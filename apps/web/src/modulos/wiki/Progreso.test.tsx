import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { fixtures as fx, type WikiRun } from '@vanguard/contracts';
import { TINTE } from '@/lib/severidad';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const { Progreso } = await import('./PaginaWiki');

const run = { ...(fx.wikiRuns as WikiRun[])[0]!, status: 'running', progress: 78 } as WikiRun;
const pintar = (estancada: boolean, puedeEscribir = true) =>
  renderToStaticMarkup(<Progreso run={run} estancada={estancada} puedeEscribir={puedeEscribir} alReintentar={() => {}} />);

describe('Progreso de la wiki', () => {
  it('estancada: aviso neutro con «Reintentar» (sin rojo ni ámbar, L3)', () => {
    const html = pintar(true);
    expect(html).toContain('Se está tardando más de lo normal');
    expect(html).toContain('Reintentar');
    expect(html).not.toContain(TINTE.mal);
    expect(html).not.toContain(TINTE.aviso);
  });
  it('sin estancar, no hay aviso', () => expect(pintar(false)).not.toContain('Se está tardando'));
  it('en solo lectura, «Reintentar» va deshabilitado con su motivo', () => {
    const html = pintar(true, false);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Reintentar/);
  });
});
