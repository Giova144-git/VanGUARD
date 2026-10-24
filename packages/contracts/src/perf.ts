// Rendimiento histórico (§10.9). §15.5 manda: aquí NO se redefine PerfRun ni ScanCreate, solo se extienden con
// campos opcionales. zod quita las claves que el esquema no declara: sin PerfRunExt el BACK perdería run_group,
// rep o version_label al validar la respuesta de E24.
import { z } from 'zod';
import { Id, Ts } from './comun.ts';
import { PerfRun } from './api.ts';

export const Strategy = z.enum(['mobile', 'desktop']);
export type Strategy = z.infer<typeof Strategy>;
const ms = z.number().nonnegative().nullable();
export const Version = z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/);
export type Version = z.infer<typeof Version>;
export const PerfMetrics = PerfRun.shape.metrics.extend({
  tti_ms: ms.optional(), total_bytes: ms.optional(), script_bytes: ms.optional(), request_count: ms.optional() });
export type PerfMetrics = z.infer<typeof PerfMetrics>;
export const PerfRunExt = PerfRun.extend({ metrics: PerfMetrics, run_group: Id.optional(), rep: z.number().int().optional(),
  is_representative: z.boolean().optional(), trigger: z.enum(['manual', 'deploy', 'schedule', 'seed']).optional(),
  version_label: z.string().nullable().optional(), runtime_error: z.string().nullable().optional() });
export type PerfRunExt = z.infer<typeof PerfRunExt>;

export const PerfCause = z.object({ cause_id: z.string(), audit_id: z.string(), metric: z.enum(['FCP', 'LCP', 'TBT', 'CLS', 'INP']),
  savings: z.number(), label: z.string(), resource_url: z.string().optional(), resource_key: z.string().optional(),
  entity: z.string().optional(), first_party: z.boolean().optional(), repo_file: z.string().nullable(),
  repo_confidence: z.enum(['exacta', 'probable', 'ninguna']), selector: z.string().max(200).optional(),
  wasted_ms: z.number().optional(), wasted_bytes: z.number().optional(), change: z.enum(['nuevo', 'peor', 'igual', 'mejor']).optional() });
export type PerfCause = z.infer<typeof PerfCause>;
export const LcpBreakdown = z.object({ dominant: z.string().nullable(), selector: z.string().max(200).nullable(),
  parts: z.array(z.object({ subpart: z.string(), label: z.string(), duration_ms: z.number() })) });
export type LcpBreakdown = z.infer<typeof LcpBreakdown>;
export const PerfDiagnosis = z.object({ lcp: LcpBreakdown, causes: z.array(PerfCause).max(30) });
export type PerfDiagnosis = z.infer<typeof PerfDiagnosis>;

export const PerfPoint = z.object({ run_group: Id, url: z.string(), strategy: Strategy, at: Ts, n: z.number().int(),
  indicativo: z.boolean(), version_label: z.string().nullable(), commit_sha: z.string().nullable(),
  trigger: z.enum(['manual', 'deploy', 'schedule', 'seed']), lighthouse_version: z.string().nullable(),
  perf_score: z.number().int().min(0).max(100).nullable(), lcp_ms: ms, tbt_ms: ms, cls: ms, fcp_ms: ms, si_ms: ms, ttfb_ms: ms,
  delta: z.object({ perf_score: z.number(), lcp_ms: z.number(), tbt_ms: z.number(), cls: z.number() }).partial().nullable() });
export type PerfPoint = z.infer<typeof PerfPoint>;
export const PerfComparison = z.object({ comparable: z.boolean(), reason: z.string().optional(), base: PerfPoint.nullable(), head: PerfPoint,
  regressed: z.boolean(),
  regressions: z.array(z.object({ metric: z.string(), base: z.number(), head: z.number(), delta: z.number(), rel: z.number().nullable() })),
  lcp: z.object({ base: LcpBreakdown.nullable(), head: LcpBreakdown.nullable() }), causes: z.array(PerfCause), finding_id: Id.nullable() });
export type PerfComparison = z.infer<typeof PerfComparison>;
export const PerfTargets = z.object({ allowed_zones: z.array(z.string()), targets: z.array(z.object({ url: z.string(), last_at: Ts,
  score_mobile: z.number().int().nullable(), score_desktop: z.number().int().nullable(), points: z.number().int() })) });
export type PerfTargets = z.infer<typeof PerfTargets>;
// P2: aviso de despliegue para medir la versión nueva.
export const DeployHook = z.object({ url: z.string().max(2048), commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  version_label: Version.optional(), environment: z.enum(['production', 'preview']).default('production') });
export type DeployHook = z.infer<typeof DeployHook>;
