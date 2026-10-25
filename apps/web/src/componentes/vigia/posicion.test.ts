// Dónde se pone Vigía: la dirección hacia el objetivo (las 8), que no se salga de la ventana y la burbuja de texto, que
// tampoco se sale ni tapa lo señalado.
import { describe, expect, it } from 'vitest';
import { TAM, alCentro, burbuja, dir8, dirHacia, inicio, pixeles, rastro, junto, solape, type Caja } from './posicion';

const VISTA = { w: 1280, h: 800 };
const MARGEN = 12;
const dentro = (c: Caja) => {
  expect(c.x).toBeGreaterThanOrEqual(MARGEN);
  expect(c.y).toBeGreaterThanOrEqual(MARGEN);
  expect(c.x + c.w).toBeLessThanOrEqual(VISTA.w - MARGEN);
  expect(c.y + c.h).toBeLessThanOrEqual(VISTA.h - MARGEN);
};

describe('dir8', () => {
  it('los 8 vectores cardinales y diagonales (y hacia abajo)', () => {
    const casos: [number, number, string][] = [
      [1, 0, 'e'], [1, 1, 'se'], [0, 1, 's'], [-1, 1, 'so'], [-1, 0, 'o'], [-1, -1, 'no'], [0, -1, 'n'], [1, -1, 'ne'],
    ];
    for (const [dx, dy, d] of casos) expect(dir8(dx, dy), `${dx},${dy}`).toBe(d);
  });

  it('sin vector, mira al sur', () => {
    expect(dir8(0, 0)).toBe('s');
  });
});

describe('junto', () => {
  it('con el objetivo a la izquierda, se pone a su derecha y señala hacia el oeste', () => {
    const objetivo = { x: 20, y: 300, w: 200, h: 40 };
    const { caja, dir } = junto(objetivo, VISTA);
    expect(caja.x).toBeGreaterThanOrEqual(objetivo.x + objetivo.w);
    expect(['o', 'no', 'so']).toContain(dir);
    dentro(caja);
  });

  it('con el objetivo pegado al borde derecho, no se sale de la ventana', () => {
    const { caja, dir } = junto({ x: 1180, y: 300, w: 100, h: 40 }, VISTA);
    dentro(caja);
    expect(['e', 'ne', 'se']).toContain(dir);
  });

  it('si nada cabe, se queda dentro igualmente', () => {
    dentro(junto({ x: 0, y: 0, w: 1280, h: 800 }, VISTA).caja);
  });

  it('la caja siempre mide TAM', () => {
    for (const o of [{ x: 20, y: 300, w: 200, h: 40 }, { x: 1180, y: 760, w: 100, h: 40 }, { x: 600, y: 0, w: 80, h: 30 }, { x: 0, y: 0, w: 1280, h: 800 }]) {
      const { caja } = junto(o, VISTA);
      expect({ w: caja.w, h: caja.h }).toEqual(TAM);
    }
  });
});

describe('dirHacia y junto: las 8 direcciones', () => {
  const v = { x: 600, y: 300, ...TAM };
  // La cara queda en el centro en x y casi a la mitad en y: el objetivo se coloca respecto a él.
  const cara = { x: v.x + v.w / 2, y: v.y + v.h * (128 / 256) };
  const en = (dx: number, dy: number): Caja => ({ x: cara.x + dx - 10, y: cara.y + dy - 10, w: 20, h: 20 });

  it('señala hacia cada uno de los 8 lados', () => {
    const casos: [number, number, string][] = [
      [300, 0, 'e'], [250, 250, 'se'], [0, 300, 's'], [-250, 250, 'so'], [-300, 0, 'o'], [-250, -250, 'no'], [0, -300, 'n'], [250, -250, 'ne'],
    ];
    for (const [dx, dy, d] of casos) expect(dirHacia(v, en(dx, dy)), `${dx},${dy}`).toBe(d);
  });

  it('a una fila ancha que queda arriba a la izquierda le señala la esquina (noroeste), no el centro lejano', () => {
    const fila = { x: 12, y: 128, w: 216, h: 44 };
    const sitio = { x: fila.x + fila.w + 14, y: fila.y + fila.h + 14, ...TAM };   // hueco «abajo a la derecha»
    expect(dirHacia(sitio, fila)).toBe('no');
  });

  it('junto elige un hueco libre y apunta hacia el objetivo en cada zona de la ventana', () => {
    const vista = { w: 1400, h: 900 };
    const casos: [Caja, string[]][] = [
      [{ x: 12, y: 400, w: 216, h: 44 }, ['o']],                   // riel: Vigía a la derecha
      [{ x: 1300, y: 400, w: 88, h: 40 }, ['e']],                  // pegado a la derecha: Vigía a la izquierda
      [{ x: 650, y: 12, w: 100, h: 30 }, ['n', 'no']],             // arriba en el centro: Vigía debajo, a la derecha
      [{ x: 1348, y: 8, w: 40, h: 40 }, ['ne', 'n']],              // esquina de la cabecera
      [{ x: 650, y: 850, w: 100, h: 40 }, ['o', 'so', 's', 'se']], // abajo del todo
    ];
    for (const [o, dirs] of casos) {
      const { caja, dir } = junto(o, vista);
      expect(solape(caja, o), JSON.stringify(o)).toBe(0);
      expect(dirs, JSON.stringify(o)).toContain(dir);
    }
  });

  it('con la cara dentro del objetivo, apunta a su centro', () => {
    expect(dirHacia(v, { x: v.x - 100, y: v.y - 300, w: v.w + 200, h: 400 })).toBe('n');
  });
});

describe('burbuja', () => {
  const vigia = (x: number, y: number): Caja => ({ x, y, ...TAM });
  const caja = (b: { x: number; y: number }, w: number, h: number): Caja => ({ x: b.x, y: b.y, w, h });

  it('va arriba si hay sitio y abajo si Vigía está arriba del todo', () => {
    const arriba = burbuja(vigia(500, 400), VISTA, 200, 80);
    expect(arriba.lado).toBe('arriba');
    expect(arriba.y + 80).toBeLessThanOrEqual(400);
    const abajo = burbuja(vigia(500, 12), VISTA, 200, 80);
    expect(abajo.lado).toBe('abajo');
    expect(abajo.y).toBeGreaterThanOrEqual(12 + TAM.h);
  });

  it('la x nunca se sale de la ventana', () => {
    for (const x of [-100, 0, 12, 500, 1150, 1250, 2000]) {
      const b = burbuja(vigia(x, 400), VISTA, 200, 80);
      expect(b.x).toBeGreaterThanOrEqual(MARGEN);
      expect(b.x + 200).toBeLessThanOrEqual(VISTA.w - MARGEN);
    }
  });

  it('en ninguna posición de Vigía se sale de la ventana, tampoco en un móvil', () => {
    for (const v of [VISTA, { w: 375, h: 667 }, { w: 667, h: 375 }]) {
      const ancho = Math.min(300, v.w - 24);
      for (let x = 0; x <= v.w; x += 37) for (let y = 0; y <= v.h; y += 41) {
        const b = burbuja(vigia(x, y), v, ancho, 170);
        expect(b.x).toBeGreaterThanOrEqual(MARGEN);
        expect(b.y).toBeGreaterThanOrEqual(MARGEN);
        expect(b.x + ancho).toBeLessThanOrEqual(v.w - MARGEN);
        expect(b.y + 170).toBeLessThanOrEqual(v.h - MARGEN);
      }
    }
  });

  it('no tapa el objetivo: con Vigía debajo de él, la burbuja no se pone encima', () => {
    const objetivo = { x: 520, y: 200, w: 160, h: 40 };
    const v = junto(objetivo, VISTA, TAM);
    const b = burbuja(v.caja, VISTA, 300, 170, objetivo);
    expect(solape(caja(b, 300, 170), objetivo)).toBe(0);
    expect(solape(caja(b, 300, 170), v.caja)).toBe(0);
  });

  it('no tapa el objetivo en las entradas del riel ni en los botones de la cabecera', () => {
    const vista = { w: 1400, h: 900 };
    const objetivos = [{ x: 12, y: 128, w: 216, h: 44 }, { x: 12, y: 820, w: 216, h: 44 }, { x: 1300, y: 8, w: 40, h: 40 }, { x: 1348, y: 8, w: 40, h: 40 }];
    for (const o of objetivos) {
      const v = junto(o, vista);
      const b = burbuja(v.caja, vista, 300, 170, o);
      expect(solape(caja(b, 300, 170), o), JSON.stringify(o)).toBe(0);
    }
  });
});

describe('inicio y alCentro', () => {
  it('quedan dentro de la ventana, en escritorio y en móvil', () => {
    for (const vista of [VISTA, { w: 375, h: 667 }]) {
      for (const c of [inicio(vista), alCentro(vista)]) {
        expect(c.x).toBeGreaterThanOrEqual(MARGEN);
        expect(c.y).toBeGreaterThanOrEqual(MARGEN);
        expect(c.x + c.w).toBeLessThanOrEqual(vista.w - MARGEN);
        expect(c.y + c.h).toBeLessThanOrEqual(vista.h - MARGEN);
      }
    }
  });

  it('en el centro deja sitio arriba para la burbuja', () => {
    const c = alCentro({ w: 375, h: 667 });
    expect(burbuja(c, { w: 375, h: 667 }, 300, 190).lado).toBe('arriba');
  });
});

describe('teletransporte', () => {
  const caja = (x: number, y = 0): Caja => ({ x, y, w: 100, h: 100 });
  it('los píxeles salen de la figura hacia fuera, siempre iguales', () => {
    const p = pixeles(16);
    expect(p).toHaveLength(16);
    expect(pixeles(16)).toEqual(p);
    for (const q of p) {
      expect(q.x).toBeGreaterThan(5); expect(q.x).toBeLessThan(95);
      expect((q.x - 50) * q.dx + (q.y - 46) * q.dy, JSON.stringify(q)).toBeGreaterThan(0);   // hacia fuera
      expect(Math.hypot(q.dx, q.dy)).toBeGreaterThan(30);
    }
    expect(new Set(p.map((q) => q.tono))).toEqual(new Set(['cian', 'violeta']));
  });

  it('el rastro va del centro del origen al del destino, con el retraso creciendo hacia el destino', () => {
    const r = rastro(caja(0), caja(1000), 10);
    expect(r).toHaveLength(10);
    expect(r[0]!.x).toBeLessThan(r[9]!.x);
    for (const q of r) { expect(q.x).toBeGreaterThanOrEqual(50); expect(q.x).toBeLessThanOrEqual(1050); expect(Math.abs(q.y - 50)).toBeLessThanOrEqual(11); }
    for (let i = 1; i < r.length; i++) expect(r[i]!.d).toBeGreaterThanOrEqual(r[i - 1]!.d);
    expect(rastro(caja(10, 10), caja(10, 10), 10)).toEqual([]);
  });
});
