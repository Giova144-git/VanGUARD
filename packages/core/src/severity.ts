// Orden de severidades (S15 15.9, nota resuelta): en TS se compara siempre con rank(), nunca por texto, porque
// 'critical' < 'high' alfabéticamente. Mismos valores que la columna generada severity_rank de §05 y private.sev_rank().
import type { Severity } from '@vanguard/contracts';

/** De más grave a menos grave. */
export const SEVERIDADES = ['critical', 'high', 'medium', 'low', 'info'] as const satisfies readonly Severity[];
export const SEV_RANK: Readonly<Record<Severity, number>> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

export const rank = (s: Severity): number => SEV_RANK[s];
export const maxSeverity = (a: Severity, b: Severity): Severity => (rank(a) >= rank(b) ? a : b);
export const minSeverity = (a: Severity, b: Severity): Severity => (rank(a) <= rank(b) ? a : b);
/** Para sort(): la más grave primero. */
export const porSeveridad = (a: Severity, b: Severity): number => rank(b) - rank(a);
/** La mayor de una lista; null si está vacía (agrupación por IP, CB_DEP_VULN con varios avisos). */
export function peorSeveridad(xs: readonly Severity[]): Severity | null {
  let peor: Severity | null = null;
  for (const s of xs) peor = peor === null ? s : maxSeverity(peor, s);
  return peor;
}
