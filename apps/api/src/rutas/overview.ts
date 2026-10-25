import { Hono } from 'hono';
import { Overview, Severity, type AhoraItem } from '@vanguard/contracts';
import { score } from '@vanguard/core';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { calcularCobertura } from '../scans/cobertura.ts';
import { esConexionSimulador } from '../lib/simulador.ts';
import { esVistaPrevia } from '../mw/prod-host.ts';

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
  const [[fs, top, inc, nInc, last, cov, ai, ok, ing], porSeveridad] = await Promise.all([
    Promise.all([
      // Puntaje sobre todos los open, como el paso puntaje (mismo tope y solo las columnas que usa score()).
      admin.from('findings').select('module, severity, confirmed').eq('org_id', orgId).eq('status', 'open')
        .order('severity_rank', { ascending: false }).limit(TOPE_PUNTAJE),
      admin.from('findings').select('id, module, rule_id, severity, confirmed, title, resource, connection_id')
        .eq('org_id', orgId).eq('status', 'open')
        .order('severity_rank', { ascending: false }).order('confirmed', { ascending: false }).order('last_seen_at', { ascending: false }).limit(10),
      admin.from('incidents').select('id, rule_ids, severity, title, resource').eq('org_id', orgId).in('status', ['open', 'ack'])
        .order('severity_rank', { ascending: false }).limit(10),
      admin.from('incidents').select('id', { count: 'exact', head: true }).eq('org_id', orgId).in('status', ['open', 'ack']),
      // La última AUDITORÍA: una medición de Rendimiento («Medir ahora», kind lighthouse) no lo es.
      admin.from('scan_runs').select('id, status, finished_at').eq('org_id', orgId).neq('kind', 'lighthouse')
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
      calcularCobertura(env, orgId),
      env.IA_CORTE === '1' ? Promise.resolve({ data: { enabled: false, level: 'off' }, error: null })
        : admin.rpc('vg_ai_status', { p_org: orgId }),
      // ux-revision-develop P0-1/P0-2: la última full_audit TERMINADA y lo que miró cada módulo en ella.
      admin.from('scan_runs').select('id, steps, finished_at').eq('org_id', orgId).eq('kind', 'full_audit').eq('status', 'succeeded')
        .order('finished_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
      // P0-4: las conexiones ingest de la org (la del simulador de E57 no es tráfico de la app del cliente).
      admin.from('connections').select('id, meta').eq('org_id', orgId).eq('provider', 'ingest').limit(20),
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
    title: string; resource: string; connection_id: string | null }[];
  const incidentes = (inc.data ?? []) as { id: string; rule_ids: string[]; severity: Severity; title: string; resource: string }[];
  const counts = Object.fromEntries(Severity.options.map((s, i) => [s, porSeveridad[i]?.count ?? 0]));
  const p = cov.seen === 0 ? null : score(paraPuntaje);
  const ahora: AhoraItem[] = [
    ...incidentes.map((i) => ({ kind: 'incident' as const, id: i.id, module: MODULO_DE_REGLA[(i.rule_ids[0] ?? '').slice(0, 2)] ?? 'cloudflare',
      rule_id: i.rule_ids[0] ?? 'CF_UNKNOWN', severity: i.severity, title: i.title, resource: i.resource })),
    // El repo de cada hallazgo viaja por connection_id (varias-codebases.md §2.4): chip del FRONT con ≥ 2 repos.
    ...hallazgos.map((f) => ({ kind: 'finding' as const, id: f.id, module: f.module, rule_id: f.rule_id, severity: f.severity,
      title: f.title, resource: f.resource, connection_id: f.connection_id ?? null })),
  ].slice(0, 10);
  const l = last.data as { id: string; status: string; finished_at: string | null } | null;
  const aiData = (ai.data ?? null) as { enabled?: boolean; level?: string } | null;
  const buena = ok.error ? null : (ok.data as { id: string; steps: unknown; finished_at: string | null } | null);
  // Último evento de ingesta de las conexiones de la app (sin la del simulador). Sin conexiones, sin consulta: null.
  const ingesta = ing.error ? [] : ((ing.data ?? []) as { id: string; meta: unknown }[]).filter((x) => !esConexionSimulador(x));
  let ultimaIngesta: string | null = null;
  if (ingesta.length) {
    const { data: h, error: eh } = await admin.from('edge_hits').select('ts').eq('org_id', orgId)
      .in('connection_id', ingesta.map((x) => x.id)).order('ts', { ascending: false }).limit(1).maybeSingle();
    if (eh) log('warn', 'overview.ingesta_error', { rid, code: eh.code ?? null });
    const ts = (h as { ts?: string } | null)?.ts;
    ultimaIngesta = ts ? iso(ts) : null;
  }
  if (ok.error || ing.error) log('warn', 'overview.ux_error', { rid, code: ok.error?.code ?? ing.error?.code ?? null });
  return Overview.parse({
    score: p?.score ?? null, band: p?.band ?? null, coverage: cov, counts, open_incidents: nInc.count ?? incidentes.length,
    last_scan: l ? { id: l.id, status: l.status, finished_at: l.finished_at ? iso(l.finished_at) : null } : null,
    ...(aiData ? { ai: { enabled: aiData.enabled === true, level: aiData.level ?? 'off' } } : {}),
    ahora,
    ...(ok.error ? {} : {
      last_ok_scan: buena?.finished_at ? { id: buena.id, finished_at: iso(buena.finished_at) } : null,
      module_checks: revisionModulos(buena?.steps),
    }),
    ...(ing.error ? {} : { last_ingest_at: ultimaIngesta }),
    preview: esVistaPrevia(env),
  });
}

/** P0-1: lo que miró cada módulo en la última full_audit terminada. done = su paso quedó done; fallido = failed;
 *  sin_revisar = skipped, pending o sin auditoría terminada. Rendimiento no es un paso de full_audit: no sale. */
export function revisionModulos(steps: unknown): Partial<Record<'supabase' | 'cloudflare' | 'codebase', 'done' | 'sin_revisar' | 'fallido'>> {
  const xs = (Array.isArray(steps) ? steps : []) as { name?: unknown; status?: unknown }[];
  const de = (paso: string) => {
    const s = xs.find((x) => x.name === paso)?.status;
    return s === 'done' ? 'done' as const : s === 'failed' ? 'fallido' as const : 'sin_revisar' as const;
  };
  return { supabase: de('supabase'), cloudflare: de('cloudflare'), codebase: de('repo') };
}
