import { describe, expect, it } from 'vitest';
import { sinBidi } from './bidi';

describe('sinBidi', () => {
  it('hace visibles los controles de dirección', () => {
    expect(sinBidi('src/lib/‮sj.nimda')).toBe('src/lib/⟨U+202E⟩sj.nimda');
    expect(sinBidi('⁦a⁩‏؜')).toBe('⟨U+2066⟩a⟨U+2069⟩⟨U+200F⟩⟨U+061C⟩');
  });
  it('no toca texto normal ni letras RTL', () => {
    expect(sinBidi('203.0.113.7')).toBe('203.0.113.7');
    expect(sinBidi('مرحبا שלום')).toBe('مرحبا שלום');
  });
});
