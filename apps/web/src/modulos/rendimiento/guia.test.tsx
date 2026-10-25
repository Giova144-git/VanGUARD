// Guía de Rendimiento: el viewer y el anónimo de «Ver demo» no ven «Medir ahora», así que su guía no les da esa orden;
// y ninguna promete causas ni un arreglo para la IA mientras el BACK no evalúe PF_REGRESSION en una medición nueva.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuiaModulo } from '@/componentes/vg/GuiaModulo';
import { GUIAS } from '@/lib/guias';

const pintar = (soloLectura?: boolean) => renderToStaticMarkup(<GuiaModulo id="performance" soloLectura={soloLectura} />);

describe('guía de Rendimiento', () => {
  it('el admin recibe los pasos para medir; quien solo lee, «Un administrador pulsa…»', () => {
    const admin = pintar();
    expect(admin).toContain('Escribe la URL de cualquier web pública');
    expect(admin).toContain('Elige móvil o escritorio y pulsa «Medir ahora»');
    const lectura = pintar(true);
    expect(lectura).toContain('Un administrador escribe la URL');
    expect(lectura).not.toContain('Escribe la URL');
    expect(lectura).not.toContain('Elige móvil o escritorio');
  });

  it('solo documenta lo que hay: puntaje, métricas y la comparación, sin causas ni arreglo para la IA', () => {
    for (const html of [pintar(), pintar(true)]) {
      expect(html).toContain('la medición anterior');
      expect(html).not.toMatch(/arreglo|causas|prompt|tu IA/i);
    }
  });

  it('un módulo sin pasos de lectura enseña los mismos pasos a todos', () => {
    expect(GUIAS.codebase.pasosLectura).toBeUndefined();
    expect(renderToStaticMarkup(<GuiaModulo id="codebase" soloLectura />)).toBe(renderToStaticMarkup(<GuiaModulo id="codebase" />));
  });
});
