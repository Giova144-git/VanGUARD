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
  it.each(['texto-3', 'borde-fuerte'])('%s ≥ 3:1 contra background, card y muted', (rol) => {
    for (const f of fondos) expect(contraste(t[rol]!, t[f]!), `${rol} sobre ${f}`).toBeGreaterThanOrEqual(3);
  });
});
