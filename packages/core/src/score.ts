// Puntaje de blindaje y cobertura (S15 15.9 literal, canónicas A9.2): 0–100 siempre con «vemos N de 4 fuentes» al lado.
// Lo usan el paso `puntaje`, `fin`, `resumen_ia` (IA-2) y E5 sobre los hallazgos `status='open'`. Puro: sin red ni base.
import type { Coverage, Module } from '@vanguard/contracts';

// ── Puntaje (literal de 15.9) ─────────────────────────────────────────────────────────────────────────────────────
const W = { critical: 25, high: 10, medium: 4, low: 1, info: 0 } as const;
export function score(fs: { module: string; severity: keyof typeof W; confirmed: boolean }[]) {
  const porModulo = new Map<string, number>();
  for (const f of fs) porModulo.set(f.module, (porModulo.get(f.module) ?? 0) + W[f.severity] * (f.confirmed ? 1.5 : 1));
  let s = 100; for (const v of porModulo.values()) s -= Math.min(40, v);
  if (fs.some((f) => f.severity === 'critical' && f.confirmed)) s = Math.min(s, 49);
  s = Math.max(0, Math.round(s));
  return { score: s, band: s <= 49 ? 'red' : s <= 79 ? 'amber' : 'green' } as const;
}

export type Banda = 'red' | 'amber' | 'green';
export const PESOS: Readonly<typeof W> = W;
/** Banda de un puntaje ya calculado (IA-2 la saca del `score` que escribió `puntaje`): 0–49 rojo, 50–79 ámbar, 80–100 verde. */
export const banda = (s: number): Banda => (s <= 49 ? 'red' : s <= 79 ? 'amber' : 'green');

// ── Cobertura (15.9): un módulo cuenta como «visto» si su última lectura fue correcta. total = 4 ───────────────────
export const MODULOS = ['supabase', 'cloudflare', 'codebase', 'performance'] as const satisfies readonly Module[];
const MIN = 60_000, DIA = 86_400_000;
export type SenalesCobertura = {
  /** `scan_runs.steps` de la última auditoría (y, si se quiere, el del último ZIP); «correcto» = status 'done'. */
  pasos: readonly { name: string; status: string }[];
  /** Fin del último paso `supabase` correcto en cualquier auditoría (ISO). Sin él, la muestra de salud no suma. */
  ultimoPasoSupabaseOk?: string | null;
  /** Última muestra `sb_service_ok` con `labels.service='db'` (ISO). */
  muestraSupabaseDb?: string | null;
  /** Última muestra `cf_req_5m` (ISO). */
  muestraCloudflare?: string | null;
  /** `created_at` del último `perf_runs` de la org (ISO; la fila sembrada cuenta). */
  ultimoPerfRun?: string | null;
};
export function coverage(s: SenalesCobertura, now: Date = new Date()): Coverage {
  const t = now.getTime();
  const dentro = (iso: string | null | undefined, ms: number) => {
    if (!iso) return false;
    const x = Date.parse(iso);
    return Number.isFinite(x) && t - x <= ms;
  };
  const ok = (n: string) => s.pasos.some((p) => p.name === n && p.status === 'done');
  const visto: Record<Module, boolean> = {
    // Una conexión nunca auditada no suma por tener salud: nunca verde sin mirar.
    supabase: ok('supabase') || (dentro(s.muestraSupabaseDb, 5 * MIN) && dentro(s.ultimoPasoSupabaseOk, 7 * DIA)),
    cloudflare: ok('cloudflare') || dentro(s.muestraCloudflare, 10 * MIN),
    codebase: ok('repo') || ok('zip'),
    performance: dentro(s.ultimoPerfRun, 7 * DIA),
  };
  const missing = MODULOS.filter((m) => !visto[m]);
  return { seen: MODULOS.length - missing.length, total: MODULOS.length, missing };
}

/** Lo que piden Overview y ScanRun: con `seen = 0`, `score` y `band` son null. */
export function puntajeConCobertura(fs: Parameters<typeof score>[0], cov: Coverage):
  { score: number | null; band: Banda | null; coverage: Coverage } {
  if (cov.seen === 0) return { score: null, band: null, coverage: cov };
  const r = score(fs);
  return { score: r.score, band: r.band, coverage: cov };
}
