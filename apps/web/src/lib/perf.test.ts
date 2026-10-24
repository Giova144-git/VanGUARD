import { describe, expect, it } from 'vitest';
import { fixtures as fx, type PerfRunExt } from '@vanguard/contracts';
import { agrupar, empeora, mediana, mismaSerie } from './perf';

const runs = fx.perfRuns as unknown as PerfRunExt[];

describe('perf', () => {
  it('mediana con nulos e impares/pares', () => {
    expect(mediana([3, null, 1, 2])).toBe(2);
    expect(mediana([1, 2, 3, 4])).toBe(2.5);
    expect(mediana([null])).toBeNull();
  });
  it('agrupa las 12 corridas de los fixtures en 4 mediciones de 3 repeticiones', () => {
    const ms = agrupar(runs);
    expect(ms).toHaveLength(4);
    expect(ms.every((m) => m.n === 3)).toBe(true);
    const movil = ms.filter((m) => m.strategy === 'mobile');
    expect(movil.map((m) => m.perf_score)).toEqual([97, 41]);     // v1-sana y v2-regresion
    expect(movil[1]!.lcp_ms).toBe(6200);
  });
  it('agrupa por run_group cuando viene', () => {
    const g = runs.slice(0, 2).map((r) => ({ ...r, run_group: '00000000-0000-4000-8000-0000000000aa' }));
    expect(agrupar(g)).toHaveLength(1);
  });
  it('corta la serie si cambia el major de Lighthouse y detecta regresiones', () => {
    const ms = agrupar(runs).filter((m) => m.strategy === 'mobile');
    expect(mismaSerie([{ ...ms[0]!, lighthouse: '12.0.0' }, ms[1]!])).toHaveLength(1);
    expect(empeora('perf_score', 97, 41)).toBe(true);
    expect(empeora('lcp_ms', 1450, 6200)).toBe(true);
    expect(empeora('cls', 0.3, 0.1)).toBe(false);
  });
});
