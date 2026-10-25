// Galería /vigia: pinta la rosa de 8 direcciones con el reposo en el centro, todas las poses y todas las expresiones, y
// lee la combinación del probador de la URL. Sin jsdom: renderToStaticMarkup dentro de un MemoryRouter.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { ID_EXPRESIONES, POSES } from '@/componentes/vigia/formas';
import VigiaGaleria from './VigiaGaleria';

const pintar = (url = '/vigia') => renderToStaticMarkup(<MemoryRouter initialEntries={[url]}><VigiaGaleria /></MemoryRouter>);
const bloque = (html: string, prueba: string) => html.split(`data-prueba="${prueba}"`)[1]!.split('</section>')[0]!;
const cuenta = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

describe('VigiaGaleria', () => {
  it('la rosa tiene 9 casillas: 8 direcciones apuntando y el reposo en el centro', () => {
    const rosa = bloque(pintar(), 'rosa');
    expect(cuenta(rosa, /<svg/g)).toBe(9);
    expect(cuenta(rosa, /data-pose="apuntar"/g)).toBe(8);
    const poses = [...rosa.matchAll(/data-pose="(\w+)"/g)].map((m) => m[1]);
    expect(poses[4]).toBe('reposo');
    for (const n of ['noroeste', 'norte', 'noreste', 'oeste', 'este', 'suroeste', 'sur', 'sureste']) expect(rosa).toContain(`>${n}<`);
  });

  it('hay una ficha por pose y una por expresión', () => {
    const html = pintar();
    const poses = bloque(html, 'poses');
    for (const p of POSES) expect(poses).toContain(`data-pose="${p}"`);
    const expresiones = bloque(html, 'expresiones');
    for (const e of ID_EXPRESIONES) expect(expresiones).toContain(`data-expresion="${e}"`);
  });

  it('el probador lee pose, dirección, expresión y fase de la URL (y descarta valores inventados)', () => {
    const html = pintar('/vigia?pose=apuntar&dir=no&exp=feliz&fase=entrar');
    expect(html).toContain('aria-label="Vigía: apuntar hacia el noroeste"');
    expect(html).toMatch(/data-pose="apuntar" data-fase="entrar" data-expresion="feliz"/);
    const raro = pintar('/vigia?pose=<script>&dir=zz&fase=x');
    expect(raro).toContain('aria-label="Vigía: reposo"');
    expect(raro).not.toContain('<script>');
  });
});
