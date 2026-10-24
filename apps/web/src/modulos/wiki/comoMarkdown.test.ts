import { describe, expect, it } from 'vitest';
import { fixtures as fx, type WikiDoc } from '@vanguard/contracts';
import { comoMarkdown, topeUsd } from './texto';

const base = fx.wikiDoc as unknown as WikiDoc;

describe('comoMarkdown', () => {
  it('escapa título, área y rutas que vienen del repo del cliente', () => {
    const d: WikiDoc = { ...base, paginas: [{ id: 'x', titulo: '# Pwn [clic](javascript:1)', area: 'src/<b>**x**',
      resumen_md: 'Resumen.', archivos: ['a`b.ts', 'src/ok.ts'] }] };
    const md = comoMarkdown(d);
    expect(md).toContain('## \\# Pwn \\[clic\\]\\(javascript\\:1\\)');
    expect(md).toContain('_Área: src/\\<b\\>\\*\\*x\\*\\*_');
    expect(md).toContain('Archivos: ``a`b.ts``, `src/ok.ts`');
    expect(md).not.toContain('](javascript');
  });
  it('incluye el overview tal cual y el mapa en su valla mermaid', () => {
    const md = comoMarkdown(base);
    expect(md.startsWith(base.overview_md.trim())).toBe(true);
    if (base.mermaid) expect(md).toContain('```mermaid\n' + base.mermaid + '\n```');
  });
});

describe('topeUsd', () => {
  it('estimación × 1,5 redondeada a centavos, entre 0,01 y 5 USD', () => {
    expect(topeUsd(0.0799)).toBe(0.12);
    expect(topeUsd(0)).toBe(0.01);
    expect(topeUsd(10)).toBe(5);
  });
});
