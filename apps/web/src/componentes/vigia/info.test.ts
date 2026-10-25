// Cada data-info que pinta algún componente tiene su texto en INFO, y no sobra ninguno; las entradas del riel van con la
// plantilla nav-<id> de AppShell. Los textos son fijos y caben en la burbuja de Vigía.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV } from '@/lib/nav';
import { esIdInfo, INFO } from './info';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const tsx = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? tsx(join(dir, e.name)) : e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx') ? [join(dir, e.name)] : []);

const fuentes = tsx(SRC).map((f) => ({ f, s: readFileSync(f, 'utf8') }));
const literales = new Set(fuentes.flatMap(({ s }) => [...s.matchAll(/data-info=["']([^"']+)["']/g)].map((m) => m[1]!)));
const expresiones = fuentes.flatMap(({ f, s }) => [...s.matchAll(/data-info=\{(`[^`]*`|[^}]*)\}/g)].map((m) => ({ f, e: m[1]! })));
const PLANTILLA_NAV = '`nav-${entrada.id}`';
const usados = new Set([...literales, ...(expresiones.some((x) => x.e === PLANTILLA_NAV) ? NAV.map((n) => `nav-${n.id}`) : [])]);

describe('INFO', () => {
  it('cada data-info del código tiene su texto', () => {
    for (const id of literales) expect(esIdInfo(id), `data-info="${id}"`).toBe(true);
  });

  it('no sobran entradas: cada clave la pinta algún componente', () => {
    for (const id of Object.keys(INFO)) expect(usados.has(id), id).toBe(true);
  });

  it('cada entrada del riel tiene su texto (AppShell: data-info={`nav-${id}`})', () => {
    expect(expresiones.some((x) => x.e === PLANTILLA_NAV && x.f.endsWith(join('app', 'AppShell.tsx')))).toBe(true);
    for (const n of NAV) expect(esIdInfo(`nav-${n.id}`), n.id).toBe(true);
  });

  it('los data-info con llaves solo reenvían la prop (`info`) o son la plantilla del riel: nada que llegue del servidor', () => {
    for (const { f, e } of expresiones) expect([PLANTILLA_NAV, 'info'], `${f}: data-info={${e}}`).toContain(e);
  });

  it('entre 20 y 120 explicaciones, cortas y fijas', () => {
    const n = Object.keys(INFO).length;
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThanOrEqual(120);
    for (const { titulo, texto } of Object.values(INFO)) {
      for (const t of [titulo, texto]) expect(t, t).not.toMatch(/[{}<>$`]/);
      expect(titulo.length, titulo).toBeLessThanOrEqual(40);
      expect(texto.length, texto).toBeLessThanOrEqual(300);
      expect(texto.split(/[.!?](?:\s|$)/).filter((x) => x.trim()).length, texto).toBeLessThanOrEqual(3);
    }
  });

  it('esIdInfo no cae en el prototipo', () => {
    for (const x of ['__proto__', 'constructor', 'toString', '', null, 3]) expect(esIdInfo(x)).toBe(false);
  });
});
