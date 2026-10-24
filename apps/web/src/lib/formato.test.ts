import { describe, expect, it } from 'vitest';
import { bytes, cronometro, cuando, decimal, duracion, miles, pct, usd } from './formato';

describe('formato', () => {
  it('miles con punto y «—» sin dato', () => {
    expect(miles(9000)).toBe('9.000');
    expect(miles(1234567)).toBe('1.234.567');
    expect(miles(-12000)).toBe('-12.000');
    expect(miles(null)).toBe('—');
    expect(miles(Number.NaN)).toBe('—');
  });
  it('decimal con coma', () => {
    expect(decimal(0.2)).toBe('0,2');
    expect(decimal(1234.56, 2)).toBe('1.234,56');
  });
  it('porcentaje y dólares', () => {
    expect(pct(90)).toBe('90 %');
    expect(usd(0.42)).toBe('0,42 USD');
  });
  it('duración sin «1 min 60 s»', () => {
    expect(duracion(344)).toBe('344 ms');
    expect(duracion(5000)).toBe('5,0 s');
    expect(duracion(124000)).toBe('2 min 4 s');
    expect(duracion(119600)).toBe('2 min 0 s');
  });
  it('bytes', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1468006)).toBe('1,4 MB');
  });
  it('cronómetro', () => {
    expect(cronometro(72000)).toBe('01:12');
    expect(cronometro(-5)).toBe('00:00');
  });
  it('cuando: hora sola si es hoy en Caracas, fecha si no', () => {
    const ahora = new Date('2026-10-24T22:00:00Z');                       // 18:00 en Caracas
    expect(cuando('2026-10-24T19:01:00Z', ahora)).toBe('15:01');
    expect(cuando('2026-10-23T02:35:00Z', ahora)).toBe('22-10 22:35');
    expect(cuando(null, ahora)).toBe('—');
  });
});
