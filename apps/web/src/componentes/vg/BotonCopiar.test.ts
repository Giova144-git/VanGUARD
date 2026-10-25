// Riesgo (c) del informe de pausa: el textarea de respaldo de «Copiar» enseña los controles bidi, no los aplica.
import { describe, expect, it } from 'vitest';
import { textoAMano } from './BotonCopiar';

describe('textoAMano', () => {
  it('marca los controles de dirección invisibles', () => {
    expect(textoAMano('git rm src/lib/‮sj.nimda')).toBe('git rm src/lib/⟨U+202E⟩sj.nimda');
    expect(textoAMano('a⁦b⁩')).toBe('a⟨U+2066⟩b⟨U+2069⟩');
  });
  it('un texto normal, también en árabe o hebreo, sale igual', () => {
    for (const t of ['Para activarlo a mano en Cloudflare:\n1. Abre Rules', 'مرحبا', 'שלום']) expect(textoAMano(t)).toBe(t);
  });
});
