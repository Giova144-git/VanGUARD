// Vigía se pinta en cualquier pose y dirección, con su accesibilidad, las gafas-isotipo y la mano que señala.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DIRECCIONES, ID_EXPRESIONES, POSES } from './formas';
import { Vigia } from './Vigia';

const raiz = (html: string) => html.match(/<g class="vg-raiz" style="transform:([^"]*)"/)?.[1] ?? '';
const cuenta = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

describe('Vigia', () => {
  it('cada pose se pinta, con su data-pose, un lente por ojo con su pupila y oculta a lectores de pantalla', () => {
    for (const pose of POSES) {
      const html = renderToStaticMarkup(<Vigia pose={pose} />);
      expect(html).toContain(`data-pose="${pose}"`);
      expect(cuenta(html, /<clipPath/g), pose).toBe(2);
      expect(cuenta(html, /data-mirada="(izq|der)"/g), pose).toBe(2);
      expect(cuenta(html, /class="vg-mano vg-mano-/g), pose).toBe(2);
      expect(html, pose).not.toContain('vg-brazo');
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain('role="img"');
    }
  });

  it('al apuntar, se pinta en las 8 direcciones', () => {
    for (const dir of DIRECCIONES) {
      const html = renderToStaticMarkup(<Vigia pose="apuntar" dir={dir} />);
      expect(html).toContain('data-pose="apuntar"');
      expect(cuenta(html, /<clipPath/g)).toBe(2);
    }
  });

  it('cada expresión se pinta con su data-expresion', () => {
    for (const e of ID_EXPRESIONES) expect(renderToStaticMarkup(<Vigia expresion={e} />)).toContain(`data-expresion="${e}"`);
  });

  it('las manos van delante de la cabeza: la melena nunca las tapa', () => {
    const html = renderToStaticMarkup(<Vigia pose="apuntar" dir="se" />);
    expect(html.lastIndexOf('class="vg-cabeza"')).toBeLessThan(html.indexOf('class="vg-mano '));
  });

  it('solo al reparar aparecen las esquirlas del taller', () => {
    expect(renderToStaticMarkup(<Vigia pose="reparar" />)).toContain('vg-taller');
    expect(renderToStaticMarkup(<Vigia pose="reposo" />)).not.toContain('vg-taller');
  });

  it('con título es una imagen con nombre', () => {
    const html = renderToStaticMarkup(<Vigia titulo="Vigía, tu guía" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Vigía, tu guía"');
    expect(html).not.toContain('aria-hidden');
  });

  it('señala con la mano del lado del objetivo, sin poner la cara en espejo', () => {
    for (const [dir, lado] of [['o', 'izq'], ['no', 'izq'], ['e', 'der'], ['n', 'der'], ['s', 'der']] as const) {
      const html = renderToStaticMarkup(<Vigia pose="apuntar" dir={dir} />);
      expect(html, dir).toContain(`vg-mano-${lado} vg-mano-apunta`);
      expect(cuenta(html, /vg-mano-apunta/g), dir).toBe(1);
      expect(raiz(html), dir).not.toContain('scaleX(-1)');
    }
  });

  it('al volar hacia la izquierda va en espejo para que la melena quede detrás de la marcha', () => {
    expect(raiz(renderToStaticMarkup(<Vigia pose="volar" inclinacion={-10} />))).toContain('scaleX(-1)');
    expect(raiz(renderToStaticMarkup(<Vigia pose="volar" inclinacion={10} />))).not.toContain('scaleX(-1)');
  });
});
