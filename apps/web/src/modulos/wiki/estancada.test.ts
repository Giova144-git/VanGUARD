import { describe, expect, it } from 'vitest';
import { fixtures as fx, type WikiRun } from '@vanguard/contracts';
import { ESTANCADA_MS, estaEstancada, firmaRun } from './estancada';

const base = (fx.wikiRuns as WikiRun[])[0]!;
const run = (cambios: Partial<WikiRun>): WikiRun => ({ ...base, ...cambios });

describe('firmaRun', () => {
  it('cambia cuando avanza el progreso o un paso', () => {
    const a = firmaRun(run({ status: 'running', progress: 78 }));
    expect(firmaRun(run({ status: 'running', progress: 78 }))).toBe(a);
    expect(firmaRun(run({ status: 'running', progress: 84 }))).not.toBe(a);
    expect(firmaRun(run({ status: 'running', progress: 78, steps: [] }))).not.toBe(a);
  });
  it('una corrida terminada no se vigila', () => {
    for (const status of ['succeeded', 'failed'] as const) expect(firmaRun(run({ status }))).toBeNull();
    expect(firmaRun(undefined)).toBeNull();
  });
});

describe('estaEstancada', () => {
  const firma = firmaRun(run({ status: 'running', progress: 78 }));
  it('3 min sin cambios → estancada; antes, no', () => {
    expect(estaEstancada(firma, 0, ESTANCADA_MS - 1)).toBe(false);
    expect(estaEstancada(firma, 0, ESTANCADA_MS)).toBe(true);
  });
  it('sin firma (terminada) nunca está estancada', () => expect(estaEstancada(null, 0, 10 * ESTANCADA_MS)).toBe(false));
});
