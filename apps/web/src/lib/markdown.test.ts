import { describe, expect, it } from 'vitest';
import { fixtures as fx } from '@vanguard/contracts';
import { bloques, enLinea } from './markdown';

describe('markdown seguro', () => {
  it('reconoce títulos, párrafos y listas del overview del fixture', () => {
    // Lo esperado sale del propio texto del fixture: el test no se rompe si el ORQUESTADOR ajusta el contenido.
    const md = fx.wikiDoc.overview_md;
    const lineas = md.split('\n').map((l) => l.trim());
    const bs = bloques(md);
    expect(bs[0]).toMatchObject({ t: 'h', nivel: 1 });
    expect(bs.filter((b) => b.t === 'h' && b.nivel === 2)).toHaveLength(lineas.filter((l) => /^##\s/.test(l)).length);
    const items = (t: 'ul' | 'ol') => bs.flatMap((b) => (b.t === t ? b.items : [])).length;
    expect(items('ul')).toBe(lineas.filter((l) => /^[-*]\s/.test(l)).length);
    expect(items('ol')).toBe(lineas.filter((l) => /^\d{1,2}[.)]\s/.test(l)).length);
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
