import { describe, expect, it } from 'vitest';
import { apuntar, avanzar, entreCuadros, GANANCIA, haciaPuntero, preparar, RANGO, reposo, sacada, transformacion } from './mirada';

describe('mirada del isotipo', () => {
  it('el destino no sale del ojo: elipse de 17 de ancho, 8 arriba y 6 abajo', () => {
    const m = reposo();
    apuntar(m, 5, 0); expect(m.tx).toBeCloseTo(RANGO.x);
    apuntar(m, 0, -5); expect(m.ty).toBeCloseTo(-RANGO.arriba);
    apuntar(m, 0, 5); expect(m.ty).toBeCloseTo(RANGO.abajo);
    apuntar(m, 3, 3); expect(Math.hypot(m.tx / RANGO.x, m.ty / RANGO.abajo)).toBeCloseTo(1);
    apuntar(m, 0.2, -0.1); expect([m.tx, m.ty]).toEqual([0.2 * RANGO.x, -0.1 * RANGO.arriba]);
  });

  it('el resorte llega al destino y avisa de que ya no hacen falta más cuadros', () => {
    const m = reposo();
    apuntar(m, 1, 0);
    let cuadros = 0;
    while (avanzar(m)) if (++cuadros > 600) break;
    expect(cuadros).toBeLessThan(600);
    expect(m.x).toBeCloseTo(RANGO.x, 1);
    expect(avanzar(m)).toBe(false);
  });

  it('en reposo no transforma nada; de lado, la pupila se ve de perfil (scaleX 0,9)', () => {
    const m = reposo();
    expect(transformacion(m)).toBe('translate(0.00px, 0.00px) scaleX(1.000)');
    m.x = -RANGO.x;
    expect(transformacion(m)).toBe('translate(-17.00px, 0.00px) scaleX(0.900)');
  });

  it('sacada: salto rápido dentro del ojo; a veces, al centro', () => {
    const m = reposo();
    sacada(m, () => 0.1);   // r = 0 (0,1 < 0,3): el centro
    expect([m.tx, m.ty, m.k]).toEqual([0, 0, 0.22]);
    const valores = [0.25, 0.9, 1];
    sacada(m, () => valores.shift()!);
    expect(m.tx).toBeCloseTo(0);
    expect(m.ty).toBeCloseTo(0.9 * 0.8 * RANGO.abajo);
    apuntar(m, 0, 0);
    expect(m.k).toBe(0.07);   // seguir al puntero vuelve al resorte suave
  });

  it('puntero a un cuarto de pantalla del ojo ya es el borde (×2); justo encima, el centro', () => {
    const m = reposo();
    const pantalla = { ancho: 1280, alto: 720 };
    expect(GANANCIA).toBe(2);
    haciaPuntero(m, 100 + 320, 50, { x: 100, y: 50 }, pantalla);
    expect(m.tx).toBeCloseTo(RANGO.x);
    haciaPuntero(m, 100 + 160, 50, { x: 100, y: 50 }, pantalla);
    expect(m.tx).toBeCloseTo(RANGO.x / 2);
    haciaPuntero(m, 100, 50, { x: 100, y: 50 }, pantalla);
    expect([m.tx, m.ty]).toEqual([0, 0]);
  });

  it('parpadeo: interpola entre los dos cuadros vecinos con la plantilla del primero', () => {
    const c = preparar(['M0 0 C1 1 2 2 10 10', 'M10 0 C1 1 2 2 20 10', 'M10 -4 C1 1 2 2 20 30']);
    expect(c.nums.map((n) => n.length)).toEqual([8, 8, 8]);
    expect(entreCuadros(c, 0)).toBe('M0.00 0.00 C1.00 1.00 2.00 2.00 10.00 10.00');
    expect(entreCuadros(c, 0.25)).toBe('M5.00 0.00 C1.00 1.00 2.00 2.00 15.00 10.00');
    expect(entreCuadros(c, 1)).toBe('M10.00 -4.00 C1.00 1.00 2.00 2.00 20.00 30.00');
    expect(entreCuadros(c, 7)).toBe(entreCuadros(c, 1));   // fuera de [0, 1] se queda en el borde
    expect(entreCuadros(c, -1)).toBe(entreCuadros(c, 0));
  });
});
