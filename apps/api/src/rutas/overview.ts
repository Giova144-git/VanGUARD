import { Hono } from 'hono';
import { Overview, Severity, type AhoraItem } from '@vanguard/contracts';
import { score } from '@vanguard/core';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { calcularCobertura } from '../scans/cobertura.ts';

// E5 · GET /api/orgs/:org/overview · user · P0. Puntaje sobre los hallazgos open (marcar «corregido» lo mueve sin
// re-auditar), cobertura de §15.9, «ahora» = hasta 10 filas: incidentes abiertos y luego hallazgos, por severidad.
export const overview = new Hono<AppEnv>();

const MODULO_DE_REGLA: Record<string, AhoraItem['module']> = { CF: 'cloudflare', SB: 'supabase', CB: 'codebase', PF: 'performance' };

overview.get('/orgs/:org/overview', async (c) => {
  const admin = db(c.env);
  const orgId = c.get('orgId');
  const [fs, inc, last, cov, ai] = await Promise.all([
    admin.from('findings').select('id, module, rule_id, severity, confirmed, title, resource').eq('org_id', orgId).eq('status', 'open')
      .order('severity_rank', { ascending: false }).order('confirmed', { ascending: false }).order('last_seen_at', { ascending: false }).limit(500),
    admin.from('incidents').select('id, rule_ids, severity, title, resource').eq('org_id', orgId).in('status', ['open', 'ack'])
      .order('severity_rank', { ascending: false }).limit(10),
    admin.from('scan_runs').select('id, status, finished_at').eq('org_id', orgId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    calcularCobertura(c.env, orgId),
    c.env.IA_CORTE === '1' ? Promise.resolve({ data: { enabled: false, level: 'off' }, error: null })
      : admin.rpc('vg_ai_status', { p_org: orgId }),
  ]);
  if (fs.error || inc.error) {
    log('error', 'overview.error', { rid: c.get('rid'), code: fs.error?.code ?? inc.error?.code ?? null });
    throw new ApiError('internal', 'No pudimos armar el resumen');
  }
  const hallazgos = (fs.data ?? []) as { id: string; module: AhoraItem['module']; rule_id: string; severity: Severity; confirmed: boolean;
    title: string; resource: string }[];
  const incidentes = (inc.data ?? []) as { id: string; rule_ids: string[]; severity: Severity; title: string; resource: string }[];
  const counts = Object.fromEntries(Severity.options.map((s) => [s, hallazgos.filter((f) => f.severity === s).length]));
  const p = cov.seen === 0 ? null : score(hallazgos);
  const ahora: AhoraItem[] = [
    ...incidentes.map((i) => ({ kind: 'incident' as const, id: i.id, module: MODULO_DE_REGLA[(i.rule_ids[0] ?? '').slice(0, 2)] ?? 'cloudflare',
      rule_id: i.rule_ids[0] ?? 'CF_UNKNOWN', severity: i.severity, title: i.title, resource: i.resource })),
    ...hallazgos.map((f) => ({ kind: 'finding' as const, id: f.id, module: f.module, rule_id: f.rule_id, severity: f.severity,
      title: f.title, resource: f.resource })),
  ].slice(0, 10);
  const l = last.data as { id: string; status: string; finished_at: string | null } | null;
  const aiData = (ai.data ?? null) as { enabled?: boolean; level?: string } | null;
  return c.json(Overview.parse({
    score: p?.score ?? null, band: p?.band ?? null, coverage: cov, counts, open_incidents: incidentes.length,
    last_scan: l ? { id: l.id, status: l.status, finished_at: l.finished_at ? iso(l.finished_at) : null } : null,
    ...(aiData ? { ai: { enabled: aiData.enabled === true, level: aiData.level ?? 'off' } } : {}),
    ahora,
  }));
});
