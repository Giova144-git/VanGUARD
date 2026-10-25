import { Coverage, type Severity } from '@vanguard/contracts';
import { banda, plantillaResumen, score } from '@vanguard/core';
import { pedirResumen, type HallazgoResumen } from '../ia/claude.ts';
import { registrarPaso, type FnPaso } from '../jobs.ts';
import { db } from '../lib/db.ts';
import { ProviderError } from '../lib/http.ts';
import { pasoCloudflare } from './cloudflare.ts';
import { calcularCobertura } from './cobertura.ts';
import { pasoPsi } from './psi.ts';
import { pasoRepo } from './repo-paso.ts';
import { pasoSupabase } from './supabase.ts';
import { pasoZip } from './zip-paso.ts';

// Registro de los pasos de la cola vg-jobs (S15 15.8). worker.ts y dev-node.ts importan este archivo por su efecto.

// puntaje: score y coverage ANTES de la IA (la demo ve el rojo aunque IA-2 siga escribiendo). Fusiona coverage para no
// borrar coverage.detail.codebase. Con seen = 0, score null (nunca un número sin haber mirado nada).
export const pasoPuntaje: FnPaso = async (env, m) => {
  const admin = db(env);
  const [{ data: fs, error }, cov, { data: prev }] = await Promise.all([
    admin.from('findings').select('module, severity, confirmed').eq('org_id', m.org_id).eq('status', 'open').limit(2000),
    calcularCobertura(env, m.org_id),
    admin.from('scan_runs').select('coverage').eq('id', m.scan_run_id).eq('org_id', m.org_id).maybeSingle(),
  ]);
  if (error) throw new ProviderError('unavailable');
  const p = cov.seen === 0 ? null : score((fs ?? []) as Parameters<typeof score>[0]);
  const coverage = { ...((prev?.coverage as Record<string, unknown> | null) ?? {}), ...cov };
  const { error: eu } = await admin.from('scan_runs').update({ score: p?.score ?? null, coverage })
    .eq('id', m.scan_run_id).eq('org_id', m.org_id);
  if (eu) throw new ProviderError('unavailable');
  return { status: 'done' };
};

// resumen_ia (IA-2): solo llama al modelo si scan_runs.summary es nulo (idempotente, sin doble gasto). Si la IA está
// apagada, sin presupuesto o su salida no pasa el filtro, va la plantilla determinista (recorte #4 de §15.14).
export const pasoResumen: FnPaso = async (env, m) => {
  const admin = db(env);
  const { data: scan, error } = await admin.from('scan_runs').select('summary, score, coverage')
    .eq('id', m.scan_run_id).eq('org_id', m.org_id).maybeSingle();
  if (error || !scan) throw new ProviderError('unavailable');
  if (scan.summary) return { status: 'done' };
  const { data: fs, error: ef } = await admin.from('findings').select('id, module, rule_id, severity, confirmed, title, resource')
    .eq('org_id', m.org_id).eq('status', 'open').order('severity_rank', { ascending: false }).order('confirmed', { ascending: false })
    .order('last_seen_at', { ascending: false }).limit(30);
  if (ef) throw new ProviderError('unavailable');
  const hallazgos = (fs ?? []) as HallazgoResumen[];
  if (!hallazgos.length) return { status: 'skipped', error_code: 'sin_hallazgos' };
  const score = typeof scan.score === 'number' ? scan.score : null;
  const cov = Coverage.safeParse(scan.coverage);
  const coverage = cov.success ? cov.data : null;
  const band = score === null ? null : banda(score);
  const r = await pedirResumen(env, { org_id: m.org_id, scan_run_id: m.scan_run_id, score, band, coverage, hallazgos });
  const summary = r.ok ? r.summary : plantillaResumen({ score, band, coverage, motivos: r.reasons,
    hallazgos: hallazgos.map((f) => ({ finding_id: f.id, module: f.module, rule_id: f.rule_id, severity: f.severity as Severity,
      confirmed: f.confirmed, title: f.title, resource: f.resource })) });
  const { error: eu } = await admin.from('scan_runs').update({ summary }).eq('id', m.scan_run_id).eq('org_id', m.org_id);
  if (eu) throw new ProviderError('unavailable');
  return { status: 'done', ...(r.ok ? {} : { error_code: `ia_${r.code}` }) };
};

registrarPaso('supabase', pasoSupabase);
registrarPaso('resumen_ia', pasoResumen);
registrarPaso('cloudflare', pasoCloudflare);
registrarPaso('repo', pasoRepo);
registrarPaso('zip', pasoZip);
registrarPaso('psi', pasoPsi);
registrarPaso('puntaje', pasoPuntaje);
