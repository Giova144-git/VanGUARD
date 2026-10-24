// Casos de S15 15.13 para score.ts: sin hallazgos → 100; 1 critical confirmado → ≤ 49; un módulo resta ≤ 40;
// bandas 49/50 y 79/80. Más la cobertura de 15.9.
import { describe, it, expect } from 'vitest';
import { score, banda, coverage, puntajeConCobertura, type SenalesCobertura } from './score.ts';

type F = Parameters<typeof score>[0][number];
const n = (k: number, f: F): F[] => Array.from({ length: k }, () => ({ ...f }));
const low = (module: string): F => ({ module, severity: 'low', confirmed: false });
const high = (module: string): F => ({ module, severity: 'high', confirmed: false });

describe('score (15.13)', () => {
  it('sin hallazgos → 100 verde', () => {
    expect(score([])).toEqual({ score: 100, band: 'green' });
  });
  it('1 critical confirmado → ≤ 49 y rojo, aunque pese solo 37,5', () => {
    const r = score([{ module: 'codebase', severity: 'critical', confirmed: true }]);
    expect(r.score).toBeLessThanOrEqual(49);
    expect(r.band).toBe('red');
  });
  it('1 critical sin confirmar → 75 (sin tope de 49)', () => {
    expect(score([{ module: 'supabase', severity: 'critical', confirmed: false }]).score).toBe(75);
  });
  it('un módulo resta como mucho 40', () => {
    expect(score(n(10, high('supabase'))).score).toBe(60);                 // 100 de peso → resta 40
    expect(score([...n(10, high('supabase')), ...n(10, high('cloudflare'))]).score).toBe(20);
  });
  it('× 1,5 si confirmed e info pesa 0', () => {
    expect(score([{ module: 'codebase', severity: 'high', confirmed: true }]).score).toBe(85);
    expect(score(n(50, { module: 'supabase', severity: 'info', confirmed: true })).score).toBe(100);
  });
  it('nunca baja de 0', () => {
    const fs = (['supabase', 'cloudflare', 'codebase', 'performance'] as const).flatMap((m) => n(5, high(m)));
    expect(score(fs).score).toBe(0);
  });
  it('bandas 49/50 y 79/80', () => {
    expect(score([...n(10, high('a')), ...n(11, low('b'))])).toEqual({ score: 49, band: 'red' });
    expect(score([...n(10, high('a')), ...n(10, low('b'))])).toEqual({ score: 50, band: 'amber' });
    expect(score(n(21, low('a')))).toEqual({ score: 79, band: 'amber' });
    expect(score(n(20, low('a')))).toEqual({ score: 80, band: 'green' });
  });
  it('banda() coincide con la de score() en todo 0–100', () => {
    // Reparte un déficit de d puntos en `low` de varios módulos, ≤ 40 por módulo.
    const conDeficit = (d: number) => { const fs: F[] = []; for (let i = 0; d > 0; i++) { const k = Math.min(40, d); fs.push(...n(k, low('m' + i))); d -= k; } return fs; };
    for (let s = 0; s <= 100; s++) {
      const r = score(conDeficit(100 - s));
      expect(r.score).toBe(s);
      expect(banda(s)).toBe(r.band);
    }
  });
});

const AHORA = new Date('2026-10-24T18:00:00.000Z');
const hace = (ms: number) => new Date(AHORA.getTime() - ms).toISOString();
const MIN = 60_000, DIA = 86_400_000;

describe('coverage (15.9)', () => {
  it('sin señales → 0 de 4 y faltan los 4 en orden fijo', () => {
    expect(coverage({ pasos: [] }, AHORA)).toEqual({ seen: 0, total: 4, missing: ['supabase', 'cloudflare', 'codebase', 'performance'] });
  });
  it('auditoría completa con perf de hace 6 días → 4 de 4', () => {
    const s: SenalesCobertura = {
      pasos: [{ name: 'supabase', status: 'done' }, { name: 'cloudflare', status: 'done' }, { name: 'repo', status: 'done' }],
      ultimoPerfRun: hace(6 * DIA),
    };
    expect(coverage(s, AHORA)).toEqual({ seen: 4, total: 4, missing: [] });
  });
  it('paso fallido o saltado no cuenta; zip sí cuenta como codebase', () => {
    const c = coverage({ pasos: [{ name: 'supabase', status: 'failed' }, { name: 'repo', status: 'skipped' }, { name: 'zip', status: 'done' }] }, AHORA);
    expect(c.missing).toEqual(['supabase', 'cloudflare', 'performance']);
  });
  it('salud de Supabase reciente solo suma si hubo un paso supabase correcto en 7 días', () => {
    expect(coverage({ pasos: [], muestraSupabaseDb: hace(2 * MIN) }, AHORA).missing).toContain('supabase');
    expect(coverage({ pasos: [], muestraSupabaseDb: hace(2 * MIN), ultimoPasoSupabaseOk: hace(8 * DIA) }, AHORA).missing).toContain('supabase');
    expect(coverage({ pasos: [], muestraSupabaseDb: hace(2 * MIN), ultimoPasoSupabaseOk: hace(3 * DIA) }, AHORA).missing).not.toContain('supabase');
    expect(coverage({ pasos: [], muestraSupabaseDb: hace(6 * MIN), ultimoPasoSupabaseOk: hace(3 * DIA) }, AHORA).missing).toContain('supabase');
  });
  it('cf_req_5m de los últimos 10 min cuenta como Cloudflare; perf de hace 8 días no', () => {
    const c = coverage({ pasos: [], muestraCloudflare: hace(9 * MIN), ultimoPerfRun: hace(8 * DIA) }, AHORA);
    expect(c).toEqual({ seen: 1, total: 4, missing: ['supabase', 'codebase', 'performance'] });
    expect(coverage({ pasos: [], muestraCloudflare: hace(11 * MIN) }, AHORA).seen).toBe(0);
  });
});

describe('puntajeConCobertura', () => {
  it('con seen = 0, score y band son null', () => {
    const cov = coverage({ pasos: [] }, AHORA);
    expect(puntajeConCobertura([high('supabase')], cov)).toEqual({ score: null, band: null, coverage: cov });
  });
  it('con algo visto, el puntaje de score()', () => {
    const cov = coverage({ pasos: [{ name: 'repo', status: 'done' }] }, AHORA);
    expect(puntajeConCobertura([high('codebase')], cov)).toEqual({ score: 90, band: 'green', coverage: cov });
  });
});
