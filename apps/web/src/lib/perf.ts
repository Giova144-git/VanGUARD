// Histórico de Rendimiento de solo lectura (S14 §14.13, RND-15a de S10): E24 devuelve repeticiones crudas (3 por
// medición); aquí se agrupan por run_group (o, si no viene, por tanda: misma URL y estrategia con < 5 min entre
// corridas) y se toma la mediana de cada métrica. Umbrales de «bueno» y «malo» de S10 §10.3.
import type { PerfRunExt } from '@vanguard/contracts';

export type Estrategia = 'mobile' | 'desktop';
export type Metrica = 'perf_score' | 'lcp_ms' | 'tbt_ms' | 'cls';
export type Medicion = {
  clave: string; url: string; strategy: Estrategia; at: string; n: number; version: string | null; lighthouse: string | null;
  perf_score: number | null; lcp_ms: number | null; tbt_ms: number | null; cls: number | null;
};

const TANDA_MS = 5 * 60_000;

export function mediana(xs: (number | null | undefined)[]): number | null {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

export function agrupar(runs: PerfRunExt[]): Medicion[] {
  const orden = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const grupos = new Map<string, PerfRunExt[]>();
  const ultimo = new Map<string, { clave: string; t: number }>();       // por url+estrategia: la tanda abierta
  for (const r of orden) {
    const serie = `${r.url}|${r.strategy}`;
    let clave = r.run_group ?? null;
    if (!clave) {
      const u = ultimo.get(serie);
      const t = Date.parse(r.created_at);
      clave = u && t - u.t < TANDA_MS ? u.clave : `${serie}|${r.created_at}`;
      ultimo.set(serie, { clave, t });
    }
    grupos.set(clave, [...(grupos.get(clave) ?? []), r]);
  }
  return [...grupos.entries()].map(([clave, rs]) => {
    const p = rs[0]!;
    const perf = mediana(rs.map((r) => r.scores.performance));
    return {
      clave, url: p.url, strategy: p.strategy, at: rs[rs.length - 1]!.created_at, n: rs.length,
      version: rs.find((r) => r.version_label)?.version_label ?? null, lighthouse: p.lighthouse_version,
      perf_score: perf == null ? null : Math.round(perf * 100),
      lcp_ms: mediana(rs.map((r) => r.metrics.lcp_ms)), tbt_ms: mediana(rs.map((r) => r.metrics.tbt_ms)), cls: mediana(rs.map((r) => r.metrics.cls)),
    };
  }).sort((a, b) => a.at.localeCompare(b.at));
}

// La serie se corta si cambia el major de lighthouse_version (S10): solo se compara dentro del mismo major.
export function mismaSerie(ms: Medicion[]): Medicion[] {
  const ultimo = ms[ms.length - 1]?.lighthouse?.split('.')[0];
  return ultimo ? ms.filter((m) => m.lighthouse?.split('.')[0] === ultimo) : ms;
}

export const UMBRALES: Record<Exclude<Metrica, 'perf_score'>, Record<Estrategia, { bueno: number; malo: number }>> = {
  lcp_ms: { mobile: { bueno: 2500, malo: 4000 }, desktop: { bueno: 1200, malo: 2400 } },
  tbt_ms: { mobile: { bueno: 200, malo: 600 }, desktop: { bueno: 150, malo: 350 } },
  cls: { mobile: { bueno: 0.1, malo: 0.25 }, desktop: { bueno: 0.1, malo: 0.25 } },
};

// ¿Empeoró frente a la anterior? Puntaje: baja; LCP/TBT/CLS: suben.
export function empeora(m: Metrica, antes: number | null, ahora: number | null): boolean {
  if (antes == null || ahora == null) return false;
  return m === 'perf_score' ? ahora < antes : ahora > antes;
}
