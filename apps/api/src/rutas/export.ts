import { Hono } from 'hono';
import { Module, Severity, VanguardExport } from '@vanguard/contracts';
import { armarExport, CORE_VERSION, LIMITES_EXPORT, nombreArchivoExport, renderMarkdown, score, stableStringify,
  type FilaHallazgoExport, type FilaIncidenteExport } from '@vanguard/core';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError, fail } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { calcularCobertura } from '../scans/cobertura.ts';

// E25 · GET /api/orgs/:org/export?format=md|json · user · P0 («Llevar a tu IA» / «Copiar para mi IA», S13 13.6).
// Es lectura: viewer y anónimo de la demo también exportan; `ips=full` solo owner/admin con correo (S13 13.2). Lee con
// lista blanca de columnas (nunca contacts, approvals, connection_secrets, edge_hits ni incidents.details), arma
// VanguardExport con armarExport() de core (todo pasa por redactarParaExport antes de serializar) y lo valida contra el
// contrato. Nunca llama al modelo. RL_COSTLY con clave u:<user_id> (S15 15.3). 11 subpeticiones: 7 lecturas + 4 de la
// cobertura de E5. Topes en LIMITES_EXPORT para caber en los 10 ms de CPU de Workers Free.
// La monta el integrador con rutas.route('/', exportRuta): hereda auth, RL_API, orgMember y anonReadOnly de app.ts.
export const exportRuta = new Hono<AppEnv>();

const COLUMNAS_HALLAZGO = 'id, module, rule_id, severity, confirmed, origin, title, resource, status, evidence, fix_prompt, '
  + 'fix_model, suspected_injection, first_seen_at, last_seen_at, verified_at';
const COLUMNAS_INCIDENTE = 'id, code, rule_ids, severity, title, resource, status, event_count, started_at, last_event_at, '
  + 'acked_at, mitigated_at, resolved_at, suspected_injection';
// De connections.meta solo esto (S13 13.2): fuera last4, capabilities, last_error, account_id y zone_id.
const META_PERMITIDA = ['project_ref', 'zone_name', 'plan', 'repo_full_name', 'default_branch'] as const;
const TOPE_PUNTAJE = 2000;   // el mismo de E5: puntaje y counts sobre los open, como el panel
const DIA_MS = 86_400_000;
const TIPO = { md: 'text/markdown; charset=utf-8', json: 'application/json' } as const;
const PENDIENTES = new Set(['csv', 'sarif']);   // P1/P2: «formato aún no implementado → 404» (S15 E25)

type Parametros = { format: 'md' | 'json'; ips: 'mask_24' | 'full'; module: Module | null; status: 'open' | 'all' };

function parametros(q: Record<string, string>): Parametros {
  const format = q.format ?? 'md';
  if (PENDIENTES.has(format)) throw new ApiError('not_found', 'Ese formato todavía no está disponible. Usa md o json.');
  const ips = q.ips ?? 'mask', status = q.status ?? 'open';
  const modulo = q.module === undefined ? null : Module.safeParse(q.module);
  const errores: Record<string, string[]> = {};
  if (format !== 'md' && format !== 'json') errores.format = ['Usa md o json'];
  if (ips !== 'mask' && ips !== 'full') errores.ips = ['Usa mask o full'];
  if (status !== 'open' && status !== 'all') errores.status = ['Usa open o all'];
  if (modulo && !modulo.success) errores.module = ['Módulo no válido'];
  if (Object.keys(errores).length) throw new ApiError('invalid_body', 'Revisa los parámetros marcados', { field_errors: errores });
  return { format: format === 'json' ? 'json' : 'md', ips: ips === 'full' ? 'full' : 'mask_24', module: modulo?.data ?? null,
    status: status === 'all' ? 'all' : 'open' };
}

type FilaConexion = { provider: string; kind: string; label: string | null; status: string; scopes: unknown; meta: unknown };
const conexion = (x: FilaConexion) => {
  const meta = (x.meta && typeof x.meta === 'object' && !Array.isArray(x.meta) ? x.meta : {}) as Record<string, unknown>;
  return { provider: x.provider, kind: x.kind, label: x.label ?? '', status: x.status,
    scopes: Array.isArray(x.scopes) ? x.scopes.filter((s): s is string => typeof s === 'string') : [],
    meta: Object.fromEntries(META_PERMITIDA.flatMap((k) => (typeof meta[k] === 'string' ? [[k, meta[k] as string]] : []))) };
};
type FilaPerf = { url: string; strategy: string; scores: unknown; metrics: unknown; created_at: string };

exportRuta.get('/orgs/:org/export', async (c) => {
  const p = parametros(c.req.query());
  const rol = c.get('role');
  if (p.ips === 'full' && (c.get('isAnon') || c.get('sandbox') || (rol !== 'owner' && rol !== 'admin'))) {
    // En la demo la IP atacante es la del hotspot de un integrante (S13 13.2): completa solo para quien administra, y
    // nunca desde una sandbox (0026), cuyos incidentes son copia de los de la demo.
    throw new ApiError('forbidden', 'Solo un administrador puede exportar las IPs completas');
  }
  const { success } = await c.env.RL_COSTLY.limit({ key: `u:${c.get('userId')}` });
  if (!success) {
    c.header('Retry-After', '60');
    return fail(c, 'rate_limited', 'Demasiadas exportaciones seguidas. Espera un minuto.');
  }

  const admin = db(c.env);
  const orgId = c.get('orgId');
  const ahora = new Date();
  let hallazgos = admin.from('findings').select(COLUMNAS_HALLAZGO, { count: 'exact' }).eq('org_id', orgId);
  if (p.status === 'open') hallazgos = hallazgos.eq('status', 'open');
  if (p.module) hallazgos = hallazgos.eq('module', p.module);
  const [org, fs, abiertos, inc, ultima, conns, perf, cov] = await Promise.all([
    admin.from('orgs').select('name, slug, is_demo').eq('id', orgId).maybeSingle(),
    // Los más graves primero: el tope deja fuera los de menor severidad (core vuelve a ordenar con desempate por id).
    hallazgos.order('severity_rank', { ascending: false }).order('rule_id').order('resource').order('id')
      .limit(LIMITES_EXPORT.hallazgos),
    admin.from('findings').select('module, severity, confirmed').eq('org_id', orgId).eq('status', 'open')
      .order('severity_rank', { ascending: false }).limit(TOPE_PUNTAJE),
    admin.from('incidents').select(COLUMNAS_INCIDENTE, { count: 'exact' }).eq('org_id', orgId)
      .gte('last_event_at', new Date(ahora.getTime() - 7 * DIA_MS).toISOString())
      .order('started_at', { ascending: false }).order('id').limit(LIMITES_EXPORT.incidentes),
    // ai_summary y last_scan_at de la última auditoría correcta; las mediciones de Rendimiento (kind lighthouse) no cuentan.
    admin.from('scan_runs').select('finished_at, summary').eq('org_id', orgId).eq('status', 'succeeded')
      .neq('kind', 'lighthouse').order('finished_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    admin.from('connections').select('provider, kind, label, status, scopes, meta').eq('org_id', orgId)
      .in('status', ['active', 'error', 'expired']).order('provider').order('kind').order('label').limit(LIMITES_EXPORT.conexiones),
    admin.from('perf_runs').select('url, strategy, scores, metrics, created_at').eq('org_id', orgId)
      .order('created_at', { ascending: false }).limit(LIMITES_EXPORT.perf),
    calcularCobertura(c.env, orgId, ahora),
  ]);
  const err = org.error ?? fs.error ?? abiertos.error ?? inc.error ?? ultima.error ?? conns.error ?? perf.error;
  if (err) {
    log('error', 'export.lectura_error', { rid: c.get('rid'), code: err.code ?? null });
    throw new ApiError('internal', 'No pudimos armar el export');
  }
  const o = org.data as { name: string; slug: string; is_demo: boolean } | null;
  if (!o) throw new ApiError('not_found', 'Organización no encontrada');

  const paraPuntaje = (abiertos.data ?? []) as { module: Module; severity: Severity; confirmed: boolean }[];
  const counts = Object.fromEntries(Severity.options.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of paraPuntaje) if (Object.hasOwn(counts, f.severity)) counts[f.severity] += 1;
  const puntaje = cov.seen === 0 ? null : score(paraPuntaje);
  const scan = ultima.data as { finished_at: string | null; summary: unknown } | null;
  const filas = (fs.data ?? []) as unknown as FilaHallazgoExport[];
  const incidentes = (inc.data ?? []) as unknown as FilaIncidenteExport[];

  const exp = await armarExport({
    generated_at: ahora.toISOString(), version: CORE_VERSION, ips: p.ips,
    org: { name: o.name, slug: o.slug, is_demo: o.is_demo },
    overview: { score: puntaje?.score ?? null, band: puntaje?.band ?? null, coverage: cov, counts,
      last_scan_at: scan?.finished_at ? iso(scan.finished_at) : null },
    connections: ((conns.data ?? []) as FilaConexion[]).map(conexion),
    findings: filas, total_findings: fs.count ?? filas.length,
    incidents: incidentes, total_incidents: inc.count ?? incidentes.length,
    perf_runs: ((perf.data ?? []) as FilaPerf[]).map((r) => ({ url: r.url, strategy: r.strategy, scores: r.scores ?? {},
      metrics: r.metrics ?? {}, created_at: iso(r.created_at) })),
    ai_summary: scan?.summary ?? null,
  });
  const v = VanguardExport.safeParse(exp);
  if (!v.success) {
    // Solo las rutas de los campos (nunca valores): una fila fuera del contrato no sale a medias.
    log('error', 'export.fuera_de_contrato', { rid: c.get('rid'), campos: v.error.issues.slice(0, 5).map((i) => i.path.join('.')) });
    throw new ApiError('internal', 'No pudimos armar el export');
  }
  const cuerpo = p.format === 'json' ? stableStringify(v.data, 2) : renderMarkdown(v.data);
  log('info', 'export.descarga', { rid: c.get('rid'), format: p.format, hallazgos: v.data.findings.length,
    omitidos: v.data.truncated.findings });
  return c.body(cuerpo, 200, {
    'Content-Type': TIPO[p.format],
    'Content-Disposition': `attachment; filename="${nombreArchivoExport(o.slug, p.format, ahora)}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-VG-Export-Sha256': v.data.integrity.findings_sha256,
  });
});
