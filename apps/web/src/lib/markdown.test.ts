import { describe, expect, it } from 'vitest';
import { fixtures as fx } from '@vanguard/contracts';
import { bloques, enLinea } from './markdown';

describe('markdown seguro', () => {
  it('reconoce títulos, párrafos y listas del overview del fixture', () => {
    const bs = bloques(fx.wikiDoc.overview_md);
    expect(bs[0]).toMatchObject({ t: 'h', nivel: 1 });
    expect(bs.filter((b) => b.t === 'h' && b.nivel === 2)).toHaveLength(5);
    expect(bs.some((b) => b.t === 'ul' && b.items.length === 6)).toBe(true);
    expect(bs.some((b) => b.t === 'ol' && b.items.length === 5)).toBe(true);
  });
  it('deja HTML, enlaces e imágenes como texto literal', () => {
    const malo = '<script>alert(1)</script> [x](javascript:alert(1)) ![i](https://evil.test/i.png)';
    const [p] = bloques(malo);
    expect(p).toEqual({ t: 'p', texto: malo });
    expect(enLinea(malo)).toEqual([malo]);                  // un solo nodo de texto: React lo escapa
  });
  it('negrita y código en línea', () => {
    const r = enLinea('hay **una llave** en `src/x.ts` hoy');
    expect(r).toHaveLength(5);
    expect(r[0]).toBe('hay ');
  });
});
