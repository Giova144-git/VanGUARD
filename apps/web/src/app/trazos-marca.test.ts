// trazos-marca.ts es una copia recortada de brand/: si la marca cambia allí y no aquí, el isotipo vivo dejaría de
// coincidir con la máscara que se ve mientras carga (y se notaría el salto al cambiar una por otra).
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MarcaViva from './MarcaViva';
import { DURACION_MS, PARPADOS, RECORTE } from './parpadeo-marca';
import { COMPACTO, HUECO, NOMBRE, NORMAL, VIEWBOX, VIEWBOX_LOGO } from './trazos-marca';

const leer = (ruta: string) => readFileSync(new URL(ruta, import.meta.url), 'utf8');
const datos = leer('../../../../brand/mark-data.js');
const M = JSON.parse(datos.slice(datos.indexOf('=') + 1).trim().replace(/;\s*$/, '')) as {
  viewBox: string; gap: number; shapes: { id: string; d: string; iris?: boolean }[]; compact: { id: string; d: string; iris?: boolean }[];
  blink: { dur: number; lids: Record<string, string[]>; clip: string[] };
};
const W = JSON.parse(leer('../../../../brand/wordmark.json')) as { van: string; guard: string };
const svg = (f: string) => leer(`../../public/marca/${f}`);
const caminos = (s: string) => [...s.matchAll(/ d="([^"]+)"/g)].map((x) => x[1]);
const recorte = (xs: typeof M.shapes) => xs.map((s) => ({ id: s.id, iris: !!s.iris, d: s.d }));

describe('trazos del isotipo vivo', () => {
  it('son los de brand/mark-data.js y brand/wordmark.json', () => {
    expect(VIEWBOX).toBe(M.viewBox);
    expect(HUECO).toBe(M.gap);
    expect(NORMAL).toEqual(recorte(M.shapes));
    expect(COMPACTO).toEqual(recorte(M.compact));
    expect([NOMBRE.van, NOMBRE.guard]).toEqual([W.van, W.guard]);
    expect(DURACION_MS).toBe(M.blink.dur * 1000);
    expect(PARPADOS).toEqual(M.blink.lids);
    expect(RECORTE).toEqual(M.blink.clip);
  });

  it('pintan lo mismo que las máscaras de public/marca/', () => {
    const logo = svg('logo.svg'), simbolo = svg('simbolo.svg'), compacto = svg('simbolo-compacto.svg');
    expect(logo).toContain(`viewBox="${VIEWBOX_LOGO}"`);
    expect(logo).toContain(`transform="${NOMBRE.transform}"`);
    expect(logo).toContain(`stroke-width="${HUECO}"`);
    expect(new Set(caminos(logo))).toEqual(new Set([...NORMAL.map((t) => t.d), NOMBRE.van, NOMBRE.guard]));
    expect(new Set(caminos(simbolo))).toEqual(new Set(NORMAL.map((t) => t.d)));
    expect(compacto).toContain(`stroke-width="${+(HUECO * 1.3).toFixed(2)}"`);
    expect(new Set(caminos(compacto))).toEqual(new Set(COMPACTO.map((t) => t.d)));
  });

  it('MarcaViva: la pupila va dos veces (el hueco de la máscara y el trazo) y cada instancia tiene su máscara', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(MarcaViva, { forma: 'nombre', onListo: () => {} }), createElement(MarcaViva, { forma: 'compacta', onListo: () => {} })));
    expect(html.match(/data-mirada/g)).toHaveLength(4);
    for (const t of NORMAL.filter((x) => x.iris)) expect(html.split(t.d)).toHaveLength(3);
    const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map((x) => x[1]);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toContain(`mask="url(#${id})"`);
    expect(html).toContain(NOMBRE.guard);
    expect(html).not.toMatch(/<script|\son\w+=/i);
  });

  it('parpadean los tres párpados y el recorte de la pupila; la compacta no parpadea (como en brand/)', () => {
    const normal = renderToStaticMarkup(createElement(MarcaViva, { forma: 'simbolo', onListo: () => {} }));
    expect([...normal.matchAll(/data-parpado="([^"]+)"/g)].map((x) => x[1]).sort()).toEqual([...Object.keys(PARPADOS), 'clip'].sort());
    expect(normal).toContain('<clipPath');
    expect(normal).not.toContain('clip-path=');   // en reposo no recorta: le comería la punta a la V
    expect(normal).not.toContain(NOMBRE.guard);
    const compacta = renderToStaticMarkup(createElement(MarcaViva, { forma: 'compacta', onListo: () => {} }));
    expect(compacta).not.toMatch(/data-parpado|<clipPath/);
  });
});
