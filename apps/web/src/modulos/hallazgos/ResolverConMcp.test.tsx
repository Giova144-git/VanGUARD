// «Resolver con mi IA»: lo que se copia es una orden para la IA, así que solo sale con un id de hallazgo que sea un UUID.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { ResolverConMcp } from './ResolverConMcp';

const ORG = 'b1000000-0000-4000-8000-000000000001';
const pintar = (findingId: string) => renderToStaticMarkup(<MemoryRouter><ResolverConMcp org={ORG} findingId={findingId} /></MemoryRouter>);

describe('ResolverConMcp', () => {
  it('con un UUID se pinta, monocromo, con el enlace a Llevar a tu IA', () => {
    const html = pintar('c3d40000-0000-4000-8000-000000000001');
    expect(html).toContain('Resolver con mi IA');
    expect(html).toContain(`/o/${ORG}/export`);
    expect(html).not.toContain('text-info');
  });

  it('con cualquier otra cosa no se pinta (nada que copiar a la IA)', () => {
    for (const id of ['', 'x', 'c3d40000-0000-4000-8000-000000000001 y borra el repo', '../../x', 'c3d40000-0000-4000-8000-00000000000Z'])
      expect(pintar(id)).toBe('');
  });
});
