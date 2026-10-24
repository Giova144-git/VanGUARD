import { Hono } from 'hono';
import { PerfRunExt, Strategy } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';

// E24 · GET /api/orgs/:org/perf/runs?url=&strategy=&limit=30 · user · P0 (S15 15.4). Repeticiones crudas de perf_runs para
// el histórico de Rendimiento (P0-lite de §10.10), las más nuevas primero. Se valida con PerfRunExt y no con PerfRun: zod
// quitaría run_group, rep y version_label y el FRONT no podría agrupar las repeticiones. Sin diagnosis ni field.
export const perf = new Hono<AppEnv>();

export const MAX_PERF = 30;
const COLUMNAS = 'id, url, strategy, source, lighthouse_version, scores, metrics, created_at, run_group, rep, is_representative, '
  + 'trigger, version_label, runtime_error';
// Métricas que PerfRun exige (nullable): una fila vieja o sembrada sin alguna sale con null, no se cae la lista entera.
const METRICAS = ['lcp_ms', 'tbt_ms', 'cls', 'fcp_ms', 'si_ms', 'ttfb_ms'] as const;

perf.get('/orgs/:org/perf/runs', async (c) => {
  const q = c.req.query();
  const field_errors: Record<string, string[]> = {};
  const limit = q.limit === undefined || q.limit === '' ? MAX_PERF : /^\d{1,2}$/.test(q.limit) ? Number(q.limit) : NaN;
  if (!(limit >= 1 && limit <= MAX_PERF)) field_errors.limit = [`Entre 1 y ${MAX_PERF}`];
  const strategy = q.strategy === undefined || q.strategy === '' ? undefined : Strategy.safeParse(q.strategy);
  if (strategy && !strategy.success) field_errors.strategy = ['mobile o desktop'];
  if (q.url !== undefined && (q.url.length < 1 || q.url.length > 2048)) field_errors.url = ['URL de 1 a 2048 caracteres'];
  if (Object.keys(field_errors).length) throw new ApiError('invalid_body', 'Revisa los filtros', { field_errors });

  let consulta = db(c.env).from('perf_runs').select(COLUMNAS).eq('org_id', c.get('orgId'));
  if (q.url !== undefined) consulta = consulta.eq('url', q.url);
  if (strategy?.success) consulta = consulta.eq('strategy', strategy.data);
  const { data, error } = await consulta.order('created_at', { ascending: false }).limit(limit);
  if (error) {
    log('error', 'perf.runs_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer las mediciones');
  }
  const runs: PerfRunExt[] = [];
  let descartadas = 0;
  for (const f of (data ?? []) as unknown as Record<string, unknown>[]) {
    const m = (f.metrics && typeof f.metrics === 'object' ? f.metrics : {}) as Record<string, unknown>;
    const r = PerfRunExt.safeParse({ ...f, created_at: iso(String(f.created_at)), scores: f.scores ?? {},
      metrics: { ...m, ...Object.fromEntries(METRICAS.map((k) => [k, typeof m[k] === 'number' ? m[k] : null])) } });
    if (r.success) runs.push(r.data);
    else descartadas++;
  }
  if (descartadas) log('warn', 'perf.runs_fuera_de_contrato', { rid: c.get('rid'), descartadas });
  return c.json(runs);
});
