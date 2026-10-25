// Cada paso de los recorridos señala un data-guia que algún componente pinta de verdad; en móvil las entradas del riel
// se juntan en el botón del menú, y la bienvenida usa textos fijos y una clave de localStorage limpia.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAVE_BIENVENIDA } from './contexto';
import { adaptarPasos, BIENVENIDA, PASO_MENU, textoDe, TOURS, type PasoTour } from './tours';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const tsx = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? tsx(join(dir, e.name)) : e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx') ? [join(dir, e.name)] : []);

const fuentes = tsx(SRC).map((f) => readFileSync(f, 'utf8'));
const literales = new Set(fuentes.flatMap((s) => [...s.matchAll(/data-guia=["']([^"']+)["']/g)].map((m) => m[1]!)));
const plantillaNav = readFileSync(join(SRC, 'app', 'AppShell.tsx'), 'utf8').includes('data-guia={`nav-${');
const existe = (objetivo: string) => literales.has(objetivo) || (objetivo.startsWith('nav-') && plantillaNav);

describe('TOURS', () => {
  for (const [id, tour] of Object.entries(TOURS)) {
    it(`«${id}»: cada objetivo existe como data-guia`, () => {
      for (const { objetivo } of tour.pasos) expect(existe(objetivo), `data-guia="${objetivo}"`).toBe(true);
    });
  }

  it('el paso del menú (móvil) también señala algo que existe', () => {
    expect(existe(PASO_MENU.objetivo)).toBe(true);
  });

  it('los textos son fijos: sin plantillas ni marcadores, y cortos para la burbuja', () => {
    const textos = [...Object.values(TOURS).flatMap((t) => [t.final, ...t.pasos.flatMap((p: PasoTour) => [p.texto, p.textoLectura ?? ''])]),
      ...Object.values(BIENVENIDA), PASO_MENU.texto].filter(Boolean);
    for (const t of textos) {
      expect(t, t).not.toMatch(/[{}<>$]/);
      expect(t.length, t).toBeLessThanOrEqual(180);
    }
  });
});

describe('bienvenida', () => {
  it('se presenta como Vigía, habla del arrastre con la IA por MCP y termina en el ojo', () => {
    expect(BIENVENIDA.saludo).toMatch(/Soy Vigía/);
    expect(BIENVENIDA.futuro).toMatch(/arrastrarme/);
    expect(BIENVENIDA.futuro).toMatch(/MCP.*«Llevar a tu IA»/);
    expect(TOURS.bienvenida.pasos.at(-1)?.objetivo).toBe('vigia');
  });

  it('la clave del recuerdo no lleva token, secret ni code', () => {
    expect(CLAVE_BIENVENIDA).toBe('vg-vigia-bienvenida');
    expect(CLAVE_BIENVENIDA).not.toMatch(/token|secret|code/i);
  });
});

describe('adaptarPasos', () => {
  const pasos = TOURS.bienvenida.pasos;

  it('con el riel a la vista, no cambia nada', () => {
    expect(adaptarPasos(pasos, true)).toEqual(pasos);
  });

  it('sin el riel, las entradas del riel se juntan en un solo paso que señala el menú, donde estaba la primera', () => {
    const movil = adaptarPasos(pasos, false);
    expect(movil.map((p) => p.objetivo)).toEqual(['menu', 'buscar', 'vigia']);
    expect(movil[0]).toBe(PASO_MENU);
  });

  it('sin entradas del riel, o con ruta propia, deja el recorrido igual', () => {
    expect(adaptarPasos(TOURS['conectar-ia'].pasos, false)).toEqual(TOURS['conectar-ia'].pasos);
    const conRuta = [{ objetivo: 'nav-audit', ruta: 'audit', texto: 'x' }];
    expect(adaptarPasos(conRuta, false)).toEqual(conRuta);
  });

  it('el orden del resto se respeta', () => {
    const mezcla = [{ objetivo: 'a', texto: 'a' }, { objetivo: 'nav-x', texto: 'x' }, { objetivo: 'b', texto: 'b' }, { objetivo: 'nav-y', texto: 'y' }];
    expect(adaptarPasos(mezcla, false).map((p) => p.objetivo)).toEqual(['a', 'menu', 'b']);
  });
});

describe('textoDe', () => {
  it('en solo lectura usa textoLectura si lo hay', () => {
    const p = { objetivo: 'x', texto: 'escribe', textoLectura: 'lee' };
    expect(textoDe(p, false)).toBe('escribe');
    expect(textoDe(p, true)).toBe('lee');
    expect(textoDe({ objetivo: 'x', texto: 'solo' }, true)).toBe('solo');
  });
});
