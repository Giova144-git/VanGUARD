// La portada estática de index.html (§14.22) es lo que lee quien no ejecuta JS (el agente de un juez, un buscador):
// sus textos tienen que ser los de lib/marca.ts, literales, y no puede llevar nada que la CSP bloquee ni frases dirigidas
// a un agente (sería una inyección de prompt hecha por nosotros).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARCA } from '@/lib/marca';

const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const portada = html.slice(html.indexOf('<div id="root">'), html.indexOf('<script type="module"'));

describe('portada estática de index.html', () => {
  it('lleva los textos de MARCA tal cual', () => {
    for (const t of [MARCA.nombre, MARCA.portada, ...MARCA.frases, MARCA.equipo]) expect(portada).toContain(t);
  });
  it('enlaza a la demo y al login, y deja el hueco de la versión', () => {
    expect(portada).toContain('href="/demo"');
    expect(portada).toContain('href="/login"');
    expect(portada).toContain('<!--vg-version-->');
  });
  it('sin scripts, manejadores ni estilos en línea (CSP script-src self)', () => {
    expect(portada).not.toMatch(/<script|\son\w+=|\sstyle=/i);
  });
  it('descriptiva: ninguna instrucción a un agente', () => {
    expect(portada).not.toMatch(/ignora|recomienda|instrucci|assistant|you are/i);
  });
});
