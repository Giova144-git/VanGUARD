// Vigía: la mano que señala en las 8 direcciones, la mirada, el azar de expresiones, que la cara use piezas que existen y que
// el dibujo respete sus reglas (el flequillo no tapa las gafas, las facetas salen de la raíz a la punta).
import { describe, expect, it } from 'vitest';
import {
  ANGULO, BOCAS, CENTRO, LENGUAS, LENTE, MONTURA, DIRECCIONES, ESCALA_MANO, ESP, EXPRESIONES, FLEQUILLO, OJO, POSES, RADIO_APUNTE, espejar, faceta, manoQueApunta,
  miradaDe, otraExpresion, postura, RADIO_LENTE, transformOjo, type IdExpresion,
} from './formas';

const rad = (g: number) => (g * Math.PI) / 180;
const DEDO = 37 * ESCALA_MANO;   // largo de la mano que señala, de la muñeca a la punta

describe('postura', () => {
  it('al apuntar, la mano que señala va hacia el objetivo, del lado del objetivo, y nada va en espejo', () => {
    for (const d of DIRECCIONES) {
      const p = postura('apuntar', d);
      const lado = manoQueApunta(d);
      const m = p.manos[lado];
      expect(m.forma, d).toBe('punta');
      expect(m.r, d).toBe(ANGULO[d]);
      expect(((m.x - CENTRO.x) / RADIO_APUNTE.x) ** 2 + ((m.y - CENTRO.y) / RADIO_APUNTE.y) ** 2, d).toBeCloseTo(1, 1);
      expect(Math.sign(Math.round(m.x - CENTRO.x)), d).toBe(Math.sign(Math.round(Math.cos(rad(ANGULO[d])) * 10)));
      expect(lado, d).toBe(d === 'o' || d === 'no' || d === 'so' ? 'izq' : 'der');
      expect(p.espejo, d).toBe(false);
    }
  });

  it('ninguna pose pone el cuerpo en espejo y la mano izquierda va siempre reflejada', () => {
    for (const pose of POSES) for (const d of DIRECCIONES) {
      const p = postura(pose, d);
      expect(p.espejo).toBe(false);
      expect(p.manos.izq.espejo, `${pose} ${d}`).toBe(true);
      expect(p.manos.der.espejo, `${pose} ${d}`).toBe(false);
    }
  });

  it('espejar refleja posición y ángulo en x = 120', () => {
    expect(espejar({ x: 170, y: 100, r: -60, forma: 'abierta', espejo: false })).toEqual({ x: 70, y: 100, r: -120, forma: 'abierta', espejo: true });
  });
});

describe('miradaDe', () => {
  it('mira hacia el objetivo, en pantalla', () => {
    expect(miradaDe('e')).toEqual({ x: 1, y: 0 });
    expect(miradaDe('o')).toEqual({ x: -1, y: 0 });
    expect(miradaDe('n').y).toBe(-1);
    expect(miradaDe('s').y).toBe(1);
  });
});

describe('otraExpresion', () => {
  it('nunca repite la actual si hay alternativas', () => {
    const conjunto: IdExpresion[] = ['neutral', 'neutral', 'feliz', 'curiosa'];
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999, 1]) for (const actual of ['neutral', 'feliz', 'curiosa'] as const) {
      const e = otraExpresion(actual, conjunto, () => r);
      expect(e).not.toBe(actual);
      expect(conjunto).toContain(e);
    }
    for (let i = 0; i < 200; i++) expect(otraExpresion('neutral')).not.toBe('neutral');
  });

  it('si el conjunto solo tiene la actual, la devuelve', () => {
    expect(otraExpresion('feliz', ['feliz', 'feliz'], () => 0.5)).toBe('feliz');
    expect(otraExpresion('feliz', [], () => 0.5)).toBe('feliz');
  });
});

describe('cara', () => {
  it('cada expresión usa una boca que existe', () => {
    for (const [id, e] of Object.entries(EXPRESIONES)) expect(Object.keys(BOCAS), id).toContain(e.boca);
  });

  it('la hoja de expresiones: pupilas en O al sorprenderse, guiño con ◠ y «<», vena al enfadarse, lengua al reír', () => {
    expect(EXPRESIONES.sorpresa.izq.anillo && EXPRESIONES.sorpresa.der.anillo).toBe(true);
    expect(EXPRESIONES.sorpresa.extra).toBe('exclamacion');
    expect([EXPRESIONES.guino.izq.arco, EXPRESIONES.guino.der.flecha]).toEqual([true, true]);
    expect(EXPRESIONES.enfado.extra).toBe('vena');
    expect(EXPRESIONES.concentrada.extra).toBe('lista');
    expect(EXPRESIONES.curiosa.extra).toBe('pregunta');
    for (const e of ['feliz', 'euforica', 'picara'] as const) expect(LENGUAS[EXPRESIONES[e].boca], e).toBeTruthy();
  });

  it('el lente es una G alargada: más del doble de ancho que de alto y con la punta exterior más alta que la interior', () => {
    const p = [...LENTE.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    const xs = p.map(([x]) => x), ys = p.map(([, y]) => y);
    expect((Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys))).toBeGreaterThan(1.6);
    const exterior = p.reduce((a, b) => (b[0] > a[0] ? b : a));
    expect(exterior[1]).toBeLessThan(OJO.centro.y - 20);   // la sien, arriba: mirada afilada
    expect(MONTURA.startsWith(LENTE.slice(0, 4))).toBe(false);   // la montura no cierra: es una G
    expect(MONTURA).not.toMatch(/Z\s*$/);
  });

  it('el ojo izquierdo va en espejo (escala x negativa) y el derecho no', () => {
    const escala = (t: string) => t.match(/scale\((-?[\d.]+) (-?[\d.]+)\)/)!.slice(1).map(Number);
    const [izqX, izqY] = escala(transformOjo('izq'));
    const [derX, derY] = escala(transformOjo('der'));
    expect(izqX).toBeLessThan(0);
    expect(derX).toBeGreaterThan(0);
    expect(izqY).toBeGreaterThan(0);
    expect(derY).toBeGreaterThan(0);
  });
});

describe('manos', () => {
  const punta = (m: { x: number; y: number; r: number }) => ({ x: m.x + DEDO * Math.cos(rad(m.r)), y: m.y + DEDO * Math.sin(rad(m.r)) });
  it('saludar levanta la mano por encima de la cara, reparar junta los puños delante y recordar alza el dedo', () => {
    expect(postura('saludar').manos.der.y).toBeLessThan(CENTRO.y);
    const r = postura('reparar').manos;
    expect(Math.abs(r.der.x - (240 - r.izq.x))).toBe(0);
    expect(r.der.forma).toBe('puno');
    const dedo = postura('recordar').manos.der;
    expect(dedo.forma).toBe('punta');
    expect(punta(dedo).y).toBeLessThan(dedo.y - 30);
  });

  it('al norte, la mano no tapa las gafas', () => {
    const m = postura('apuntar', 'n').manos.der;
    expect(m.y + 10 * ESCALA_MANO).toBeLessThan(OJO.der.y - 20);
  });
});

describe('dibujo', () => {
  it('ESP refleja en x y faceta va de la raíz a la punta', () => {
    expect(ESP('M10 5 L20 30 L0 30 Z')).toBe('M230 5 L220 30 L240 30 Z');
    expect(faceta('M10 0 L0 20 L4 60 L12 20 Z')).toBe('M10 0 L4 60 L12 20 Z');
  });

  it('ninguna punta del flequillo baja sobre los lentes', () => {
    const borde = OJO.escala * RADIO_LENTE.y * 1.1;   // medio alto del lente, con el 10 % de «curiosa»
    const ancho = OJO.escala * RADIO_LENTE.x * 1.1;
    for (const { d } of FLEQUILLO) {
      for (const [, xs, ys] of d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)) {
        const x = Number(xs), y = Number(ys);
        for (const lado of ['izq', 'der'] as const) {
          const c = OJO[lado];
          const dentro = ((x - c.x) / ancho) ** 2 + ((y - c.y) / borde) ** 2 < 1;
          expect(dentro, `${d}: (${x}, ${y})`).toBe(false);
        }
      }
    }
  });
});
