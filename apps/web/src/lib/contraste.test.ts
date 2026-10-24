import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contraste, tokensDe } from './contraste';

const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8');

describe.each([['claro', ':root'], ['oscuro', '.dark']])('contraste del tema %s', (_nombre, selector) => {
  const t = tokensDe(css, selector);
  const fondos = ['background', 'card', 'muted'] as const;

  it('lee los tokens de globals.css', () => {
    for (const k of ['mal', 'aviso', 'bien', 'info', 'texto-3', 'borde-fuerte', ...fondos]) expect(t[k], k).toMatch(/^#/);
  });
  it.each(['mal', 'aviso', 'bien', 'info'])('%s ≥ 4,5:1 contra background, card y muted', (rol) => {
    for (const f of fondos) expect(contraste(t[rol]!, t[f]!), `${rol} sobre ${f}`).toBeGreaterThanOrEqual(4.5);
  });
  it('marca: su texto ≥ 4,5:1 sobre el botón sólido y la marca ≥ 4,5:1 como texto sobre los fondos', () => {
    expect(contraste(t['marca-texto']!, t.marca!)).toBeGreaterThanOrEqual(4.5);
    for (const f of fondos) expect(contraste(t.marca!, t[f]!), `marca sobre ${f}`).toBeGreaterThanOrEqual(4.5);
  });
  it('marca monocroma (brand/README.md): es el color del texto y su texto es el fondo; nunca un color de estado', () => {
    expect(t.marca!.toUpperCase()).toBe(t.foreground!.toUpperCase());
    expect(t['marca-texto']!.toUpperCase()).toBe(t.background!.toUpperCase());
    for (const rol of ['mal', 'aviso', 'bien', 'info']) expect(t.marca!.toUpperCase(), rol).not.toBe(t[rol]!.toUpperCase());
  });
  it('texto secundario (muted-foreground) ≥ 4,5:1 contra background, card y muted', () => {
    for (const f of fondos) expect(contraste(t['muted-foreground']!, t[f]!), `muted-foreground sobre ${f}`).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['texto-3', 'borde-fuerte'])('%s ≥ 3:1 contra background, card y muted', (rol) => {
    for (const f of fondos) expect(contraste(t[rol]!, t[f]!), `${rol} sobre ${f}`).toBeGreaterThanOrEqual(3);
  });
});
