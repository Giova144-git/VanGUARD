import { describe, expect, it } from 'vitest';
import { codigoMd, escaparMd } from './md-escape';

describe('escapes de Markdown', () => {
  it('escaparMd deja títulos y áreas como texto plano', () => {
    expect(escaparMd('# Hola **mundo**')).toBe('\\# Hola \\*\\*mundo\\*\\*');
    expect(escaparMd('[clic](javascript:alert(1))')).toBe('\\[clic\\]\\(javascript\\:alert\\(1\\)\\)');
    expect(escaparMd('<img src=x onerror=alert(1)>')).toBe('\\<img src\\=x onerror\\=alert\\(1\\)\\>');
    expect(escaparMd('línea\n## inyectada')).toBe('línea \\#\\# inyectada');
    expect(escaparMd('src/app_v2')).toBe('src/app\\_v2');
  });
  it('codigoMd elige una valla más larga que cualquier racha de comillas invertidas', () => {
    expect(codigoMd('src/x.ts')).toBe('`src/x.ts`');
    expect(codigoMd('a`b')).toBe('``a`b``');
    expect(codigoMd('`x`')).toBe('`` `x` ``');
    expect(codigoMd('ruta\n## titulo')).toBe('`ruta ## titulo`');
  });
});
