import { describe, expect, it } from 'vitest';
import { WikiEstimate } from '@vanguard/contracts';
import { avisoTecho, costoDe, estimarCorrida, precioDe, PRECIOS, SALIDA_ESTIMADA, sumarConsumo, techoDesglose, techoPaso,
  tokensDe } from './estimar.ts';
import { MAX_TOKENS_SALIDA } from './prompts.ts';
import type { EstadoWiki, Limites } from './tipos.ts';

const LIMITES: Limites = { maxCandidatos: 400, maxArchivos: 150, maxAreas: 12, maxArchivosPorArea: 25,
  maxBytesArchivo: 60_000, charsPorArchivo: 3000, charsPorArea: 24_000, maxTokensPrompt: 90_000 };
const MODELOS = { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' };

function estado(candidatos: { path: string; size: number }[], extra: Partial<EstadoWiki> = {}): EstadoWiki {
  return {
    version: 1, ref: { repo_full_name: 'acme/tienda' },
    meta: { full_name: 'acme/tienda', description: 'Tienda', language: 'TypeScript', private: false,
      default_branch: 'main', branch: 'main', commit_sha: 'b'.repeat(40) },
    files_total: candidatos.length + 10, candidatos, truncado: false, areas: [], pendientes: [], resumenes: [],
    consumo: { input_tokens: 0, output_tokens: 0, cost_usd: 0 }, avisos: [], ...extra,
  };
}

describe('tokensDe', () => {
  it('caracteres / 3,5 redondeado hacia arriba', () => {
    expect(tokensDe('')).toBe(0);
    expect(tokensDe('a')).toBe(1);
    expect(tokensDe('x'.repeat(7))).toBe(2);
    expect(tokensDe('x'.repeat(8))).toBe(3);
  });
});

describe('PRECIOS y costoDe', () => {
  it('tiene las tarifas de la spec', () => {
    expect(PRECIOS['claude-haiku-5-5']).toEqual({ entrada: 0.10, salida: 0.50, lecturaCache: 0.01, escrituraCache: 0.125 });
    expect(PRECIOS['claude-sonnet-5-5']).toEqual({ entrada: 2, salida: 10, lecturaCache: 0.10, escrituraCache: 2.5 });
  });
  it('cobra entrada, salida, lectura y escritura de caché por separado', () => {
    const uso = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000 };
    expect(costoDe('claude-haiku-5-5', uso)).toBeCloseTo(0.735, 9);
    expect(costoDe('claude-sonnet-5-5', uso)).toBeCloseTo(14.6, 9);
    expect(costoDe('claude-sonnet-5-5', { input_tokens: 10_000, output_tokens: 2_000 })).toBeCloseTo(0.04, 9);
  });
  it('reconoce ids con sufijo y cobra caro a un modelo desconocido', () => {
    expect(precioDe('claude-haiku-5-5-20261001')).toBe(PRECIOS['claude-haiku-5-5']);
    expect(precioDe('modelo-raro')).toBeNull();
    expect(costoDe('modelo-raro', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(2);
  });
  it('sumarConsumo acumula tokens (con caché) y costo', () => {
    const c = sumarConsumo({ input_tokens: 10, output_tokens: 5, cost_usd: 0.001 },
      { modelo: 'claude-haiku-5-5', uso: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500 } });
    expect(c.input_tokens).toBe(1510);
    expect(c.output_tokens).toBe(105);
    expect(c.cost_usd).toBeCloseTo(0.001 + (1000 * 0.1 + 100 * 0.5 + 500 * 0.01) / 1e6, 9);
  });
});

describe('estimarCorrida', () => {
  const candidatos = [
    { path: 'README.md', size: 4000 }, { path: 'package.json', size: 800 },
    ...Array.from({ length: 30 }, (_, i) => ({ path: `apps/api/src/m${i}.ts`, size: 5000 })),
    ...Array.from({ length: 6 }, (_, i) => ({ path: `apps/web/src/p${i}.tsx`, size: 1000 })),
    ...Array.from({ length: 3 }, (_, i) => ({ path: `docs/d${i}.md`, size: 2000 })),
  ];

  it('cumple el contrato WikiEstimate y desglosa triage, áreas y síntesis', () => {
    const e = estimarCorrida(estado(candidatos), MODELOS, LIMITES);
    expect(WikiEstimate.safeParse({ ...e, cached_run_id: null }).success).toBe(true);
    const [t, a, s] = e.est.desglose;
    expect(t).toMatchObject({ paso: 'triage', modelo: 'claude-haiku-5-5', llamadas: 1, output_tokens: SALIDA_ESTIMADA.triage });
    expect(a).toMatchObject({ paso: 'area', modelo: 'claude-haiku-5-5', llamadas: 4, output_tokens: 4 * SALIDA_ESTIMADA.area });
    expect(s).toMatchObject({ paso: 'sintesis', modelo: 'claude-sonnet-5-5', llamadas: 1, output_tokens: SALIDA_ESTIMADA.sintesis });
    expect(e.areas_max).toBe(4);                       // (raiz), apps/api, apps/web, docs
    // apps/api: 8 archivos de 3.000 caracteres llenan los 24.000 del área, más 3 de reserva (misma preselección que pasoArea).
    expect(e.files_a_leer_max).toBe(2 + 11 + 6 + 3);
    expect(e.files_candidatos).toBe(candidatos.length);
    expect(e.est.input_tokens).toBe(t!.input_tokens + a!.input_tokens + s!.input_tokens);
    expect(e.est.usd).toBeCloseTo(t!.usd + a!.usd + s!.usd, 6);
    expect(e.est.usd).toBeGreaterThan(0);
    expect(e.est.usd).toBeLessThan(0.2);               // un repo chico cuesta centavos
    expect(e.models).toEqual(MODELOS);
  });

  it('el área grande se acota al presupuesto por área y lo avisa', () => {
    const e = estimarCorrida(estado(candidatos), MODELOS, LIMITES);
    expect(e.avisos.some((x) => x.includes('24000 caracteres'))).toBe(true);
    const area = e.est.desglose.find((d) => d.paso === 'area')!;
    expect(area.input_tokens / area.llamadas).toBeLessThan(90_000);
  });

  it('aplica la guarda de tokens por área y avisa que se recorta', () => {
    const grandes = Array.from({ length: 25 }, (_, i) => ({ path: `src/core/g${i}.ts`, size: 60_000 }));
    const e = estimarCorrida(estado(grandes), MODELOS,
      { ...LIMITES, charsPorArchivo: 60_000, charsPorArea: 2_000_000, maxTokensPrompt: 50_000 });
    const area = e.est.desglose.find((d) => d.paso === 'area')!;
    expect(area.input_tokens).toBe(50_000);
    expect(e.avisos.some((x) => x.includes('supera la guarda de 50000 tokens'))).toBe(true);
  });

  it('respeta maxArchivos y maxCandidatos y conserva los avisos del árbol', () => {
    const muchos = Array.from({ length: 500 }, (_, i) => ({ path: `lib/x${i}.ts`, size: 100 }));
    const e = estimarCorrida(estado(muchos, { truncado: true, avisos: ['GitHub truncó el árbol.'] }), MODELOS, LIMITES);
    expect(e.files_a_leer_max).toBe(25);               // 150 seleccionados, todos en «lib»: 25 por paso
    expect(e.truncado).toBe(true);
    expect(e.avisos[0]).toBe('GitHub truncó el árbol.');
    expect(e.avisos.some((x) => x.includes('ve los 400'))).toBe(true);
    expect(e.avisos.length).toBeLessThanOrEqual(10);
  });

  it('sin candidatos no hay llamadas ni costo', () => {
    const e = estimarCorrida(estado([]), MODELOS, LIMITES);
    expect(e.est).toEqual({ input_tokens: 0, output_tokens: 0, usd: 0, desglose: [] });
    expect(e.avisos.some((x) => x.includes('No hay archivos'))).toBe(true);
  });

  it('el último aviso da el techo con las salidas al tope de max_tokens, y siempre cabe', () => {
    const e = estimarCorrida(estado(candidatos, { avisos: Array.from({ length: 12 }, (_, i) => `aviso ${i}`) }), MODELOS, LIMITES);
    const techo = techoDesglose(e.est.desglose);
    expect(techo).toBeGreaterThan(e.est.usd);
    expect(e.avisos).toHaveLength(10);
    expect(e.avisos.at(-1)).toBe(avisoTecho(techo));
    expect(techo).toBeCloseTo(e.est.desglose.reduce((s, d) => s + costoDe(d.modelo,
      { input_tokens: d.input_tokens, output_tokens: MAX_TOKENS_SALIDA[d.paso as 'triage'] * d.llamadas }), 0), 6);
  });

  it('techoPaso acota cada paso por arriba, para cortar ANTES de pagar', () => {
    const base = estado(candidatos);
    const conAreas: EstadoWiki = { ...base, areas: [{ nombre: 'apps/api', archivos: candidatos.slice(2, 32).map((c) => c.path) }],
      pendientes: ['apps/api'] };
    const tri = techoPaso({ paso: 'triage' }, base, MODELOS, LIMITES);
    const area = techoPaso({ paso: 'area', area: 'apps/api' }, conAreas, MODELOS, LIMITES);
    const listo: EstadoWiki = { ...conAreas, pendientes: [],
      resumenes: [{ area: 'apps/api', texto: 'x'.repeat(1500), archivos: ['apps/api/src/m0.ts'] }] };
    const sin = techoPaso({ paso: 'sintesis' }, listo, MODELOS, LIMITES);
    const e = estimarCorrida(base, MODELOS, LIMITES);
    const [t, , s] = e.est.desglose;
    expect(tri).toBeGreaterThan(t!.usd);
    expect(area).toBeGreaterThan(costoDe(MODELOS.fast, { input_tokens: 0, output_tokens: MAX_TOKENS_SALIDA.area }));
    expect(sin).toBeGreaterThanOrEqual(costoDe(MODELOS.smart, { input_tokens: 0, output_tokens: MAX_TOKENS_SALIDA.sintesis }));
    expect(sin).toBeGreaterThan(s!.usd * 0.5);
    expect(techoPaso({ paso: 'area', area: 'no-existe' }, conAreas, MODELOS, LIMITES)).toBeGreaterThan(0);
  });

  it('avisa si un modelo no tiene precio', () => {
    const e = estimarCorrida(estado(candidatos), { fast: 'claude-haiku-5-5', smart: 'otro-modelo' }, LIMITES);
    expect(e.avisos.some((x) => x.includes('otro-modelo'))).toBe(true);
  });
});
