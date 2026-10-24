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
// open_incidents y counts son count exactos: el tope de 10 solo vale para «ahora».
export const overview = new Hono<AppEnv>();

const TOPE_PUNTAJE = 2000;   // el mismo del paso puntaje (scans/index.ts)
const MODULO_DE_REGLA: Record<string, AhoraItem['module']> = { CF: 'cloudflare', SB: 'supabase', CB: 'codebase', PF: 'performance' };

overview.get('/orgs/:org/overview', async (c) => c.json(await armarOverview(c.env, c.get('orgId'), c.get('rid'))));

/** El Overview de E5; también lo usa get_overview del MCP (S13 §13.7: «calculado con la misma función que E5»). */
export async function armarOverview(env: CloudflareBindings, orgId: string, rid: string): Promise<Overview> {
  const admin = db(env);
  const abiertos = () => admin.from('findings').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'open');
  const [[fs, top, inc, nInc, last, cov, ai], porSeveridad] = await Promise.all([
    Promise.all([
      // Puntaje sobre todos los open, como el paso puntaje (mismo tope y solo las columnas que usa score()).
      admin.from('findings').select('module, severity, confirmed').eq('org_id', orgId).eq('status', 'open')
        .order('severity_rank', { ascending: false }).limit(TOPE_PUNTAJE),
      admin.from('findings').select('id, module, rule_id, severity, confirmed, title, resource').eq('org_id', orgId).eq('status', 'open')
        .order('severity_rank', { ascending: false }).order('confirmed', { ascending: false }).order('last_seen_at', { ascending: false }).limit(10),
      admin.from('incidents').select('id, rule_ids, severity, title, resource').eq('org_id', orgId).in('status', ['open', 'ack'])
        .order('severity_rank', { ascending: false }).limit(10),
      admin.from('incidents').select('id', { count: 'exact', head: true }).eq('org_id', orgId).in('status', ['open', 'ack']),
      admin.from('scan_runs').select('id, status, finished_at').eq('org_id', orgId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      calcularCobertura(env, orgId),
      env.IA_CORTE === '1' ? Promise.resolve({ data: { enabled: false, level: 'off' }, error: null })
        : admin.rpc('vg_ai_status', { p_org: orgId }),
    ]),
    // counts exactos por severidad (5 head, sin filas): no dependen del tope de arriba.
    Promise.all(Severity.options.map((s) => abiertos().eq('severity', s))),
  ]);
  const err = fs.error ?? top.error ?? inc.error ?? nInc.error ?? porSeveridad.find((r) => r.error)?.error;
  if (err) {
    log('error', 'overview.error', { rid, code: err.code ?? null });
    throw new ApiError('internal', 'No pudimos armar el resumen');
  }
  const paraPuntaje = (fs.data ?? []) as { module: AhoraItem['module']; severity: Severity; confirmed: boolean }[];
  const hallazgos = (top.data ?? []) as { id: string; module: AhoraItem['module']; rule_id: string; severity: Severity; confirmed: boolean;
    title: string; resource: string }[];
  const incidentes = (inc.data ?? []) as { id: string; rule_ids: string[]; severity: Severity; title: string; resource: string }[];
  const counts = Object.fromEntries(Severity.options.map((s, i) => [s, porSeveridad[i]?.count ?? 0]));
  const p = cov.seen === 0 ? null : score(paraPuntaje);
  const ahora: AhoraItem[] = [
    ...incidentes.map((i) => ({ kind: 'incident' as const, id: i.id, module: MODULO_DE_REGLA[(i.rule_ids[0] ?? '').slice(0, 2)] ?? 'cloudflare',
      rule_id: i.rule_ids[0] ?? 'CF_UNKNOWN', severity: i.severity, title: i.title, resource: i.resource })),
    ...hallazgos.map((f) => ({ kind: 'finding' as const, id: f.id, module: f.module, rule_id: f.rule_id, severity: f.severity,
      title: f.title, resource: f.resource })),
  ].slice(0, 10);
  const l = last.data as { id: string; status: string; finished_at: string | null } | null;
  const aiData = (ai.data ?? null) as { enabled?: boolean; level?: string } | null;
  return Overview.parse({
    score: p?.score ?? null, band: p?.band ?? null, coverage: cov, counts, open_incidents: nInc.count ?? incidentes.length,
    last_scan: l ? { id: l.id, status: l.status, finished_at: l.finished_at ? iso(l.finished_at) : null } : null,
    ...(aiData ? { ai: { enabled: aiData.enabled === true, level: aiData.level ?? 'off' } } : {}),
    ahora,
  });
}
