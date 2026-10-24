// rank() de S15 15.9: mismo orden que severity_rank de §05 (critical 5 … info 1), nunca alfabético.
import { describe, it, expect } from 'vitest';
import { SEVERIDADES, rank, maxSeverity, minSeverity, porSeveridad, peorSeveridad } from './severity.ts';

describe('severity', () => {
  it('rank: critical 5 … info 1', () => {
    expect(SEVERIDADES.map(rank)).toEqual([5, 4, 3, 2, 1]);
  });
  it('max/min no comparan por texto (greatest() en SQL daría high)', () => {
    expect(maxSeverity('critical', 'high')).toBe('critical');
    expect(maxSeverity('high', 'critical')).toBe('critical');
    expect(minSeverity('high', 'medium')).toBe('medium');
  });
  it('porSeveridad ordena de más grave a menos', () => {
    expect((['low', 'critical', 'info', 'medium', 'high'] as const).slice().sort(porSeveridad)).toEqual(SEVERIDADES);
  });
  it('peorSeveridad', () => {
    expect(peorSeveridad([])).toBeNull();
    expect(peorSeveridad(['medium', 'high', 'low'])).toBe('high');
  });
});
