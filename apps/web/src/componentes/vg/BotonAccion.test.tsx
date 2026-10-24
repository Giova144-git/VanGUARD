import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BotonAccion } from './BotonAccion';

// El <Button> que pinta BotonAccion, sin montar nada: basta con mirar sus props.
type Props = { onClick?: (e: { preventDefault: () => void }) => void; 'aria-busy'?: boolean };
const boton = (el: ReactElement) => ((el.props as { children: ReactElement[] }).children[0] as ReactElement<Props>).props;

describe('BotonAccion', () => {
  it('ocupado frena el clic aunque quien lo usa pase su onClick (no hay doble envío)', () => {
    const alClic = vi.fn();
    const p = boton(BotonAccion({ ocupado: true, onClick: alClic, children: 'Subir' }) as ReactElement);
    const e = { preventDefault: vi.fn() };
    p.onClick?.(e);
    expect(alClic).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(p['aria-busy']).toBe(true);
  });

  it('sin ocupado, el clic llega', () => {
    const alClic = vi.fn();
    boton(BotonAccion({ onClick: alClic, children: 'Subir' }) as ReactElement).onClick?.({ preventDefault: vi.fn() });
    expect(alClic).toHaveBeenCalledTimes(1);
  });
});
