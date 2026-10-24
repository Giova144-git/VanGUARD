// Corridas de Lighthouse vía PSI (E24): 3 repeticiones por estrategia de v1-sana (tanda T_PERF_V1, antes de la auditoría,
// así la cobertura 4 de 4 de scanDone es real: §15.9 cuenta Rendimiento con cualquier perf_runs) y de v2-regresion
// (tanda T_PERF_V2, antes de T_ESTADO), la versión con CSS y JS bloqueantes, imagen pesada y un script lento (S10 §10.11).
// Mismo orden que S10 (v1-sana y luego v2-regresion, que se queda desplegada); las horas caen en la ventana del sábado
// de estos fixtures. Orden: más recientes primero (created_at descendente).
import type { PerfRun } from '../api.ts';
import { HOST_VICTIMA, PERF_RUN_BASE, T_PERF_V1, T_PERF_V2 } from './ids.ts';

type Medida = { perf: number; lcp: number; tbt: number; cls: number; fcp: number; si: number; ttfb: number };
const OBJETIVO = `https://${HOST_VICTIMA}/`;
const mas = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000).toISOString();

const corrida = (n: number, strategy: 'mobile' | 'desktop', at: string, m: Medida): PerfRun => ({
  id: PERF_RUN_BASE + n.toString(16).padStart(2, '0'), url: OBJETIVO, strategy, source: 'psi', lighthouse_version: '13.5.0',
  scores: { performance: m.perf, accessibility: 0.91, 'best-practices': 0.96, seo: 0.92 },
  metrics: { lcp_ms: m.lcp, tbt_ms: m.tbt, cls: m.cls, fcp_ms: m.fcp, si_ms: m.si, ttfb_ms: m.ttfb },
  created_at: at,
});

// Escritorio y móvil van en paralelo: repeticiones a +1/+20/+39 s (escritorio) y +2/+21/+40 s (móvil) del inicio de la tanda.
const corridas: PerfRun[] = [
  // v1-sana
  corrida(1, 'desktop', mas(T_PERF_V1, 1), { perf: 0.99, lcp: 560, tbt: 10, cls: 0, fcp: 320, si: 470, ttfb: 112 }),
  corrida(2, 'desktop', mas(T_PERF_V1, 20), { perf: 1, lcp: 520, tbt: 0, cls: 0, fcp: 300, si: 450, ttfb: 110 }),
  corrida(3, 'desktop', mas(T_PERF_V1, 39), { perf: 1, lcp: 500, tbt: 0, cls: 0, fcp: 290, si: 430, ttfb: 105 }),
  corrida(4, 'mobile', mas(T_PERF_V1, 2), { perf: 0.96, lcp: 1520, tbt: 55, cls: 0, fcp: 930, si: 1340, ttfb: 126 }),
  corrida(5, 'mobile', mas(T_PERF_V1, 21), { perf: 0.97, lcp: 1450, tbt: 40, cls: 0, fcp: 900, si: 1300, ttfb: 120 }),
  corrida(6, 'mobile', mas(T_PERF_V1, 40), { perf: 0.97, lcp: 1410, tbt: 35, cls: 0, fcp: 880, si: 1270, ttfb: 118 }),
  // v2-regresion
  corrida(7, 'desktop', mas(T_PERF_V2, 1), { perf: 0.66, lcp: 2380, tbt: 335, cls: 0.29, fcp: 1140, si: 2190, ttfb: 120 }),
  corrida(8, 'desktop', mas(T_PERF_V2, 20), { perf: 0.68, lcp: 2300, tbt: 310, cls: 0.29, fcp: 1100, si: 2100, ttfb: 115 }),
  corrida(9, 'desktop', mas(T_PERF_V2, 39), { perf: 0.70, lcp: 2210, tbt: 290, cls: 0.29, fcp: 1050, si: 2000, ttfb: 110 }),
  corrida(10, 'mobile', mas(T_PERF_V2, 2), { perf: 0.39, lcp: 6450, tbt: 870, cls: 0.31, fcp: 3180, si: 5750, ttfb: 140 }),
  corrida(11, 'mobile', mas(T_PERF_V2, 21), { perf: 0.41, lcp: 6200, tbt: 820, cls: 0.31, fcp: 3100, si: 5600, ttfb: 130 }),
  corrida(12, 'mobile', mas(T_PERF_V2, 40), { perf: 0.43, lcp: 5980, tbt: 790, cls: 0.31, fcp: 3050, si: 5500, ttfb: 125 }),
];

export const perfRuns = corridas.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) satisfies PerfRun[];
