import type { Coverage, Module, ScanStep } from '@vanguard/contracts';
import { db } from '../lib/db.ts';

// Cobertura (§15.9, total = 4): un módulo cuenta como «visto» si su última lectura fue correcta. Nunca verde sin mirar.
// Supabase: paso supabase correcto en la última auditoría que lo intentó (o salud sb_service_ok de db en 5 min, siempre
// que haya un paso supabase correcto en 7 días); Cloudflare: paso cloudflare correcto o cf_req_5m en 10 min;
// Codebase: paso repo/zip correcto; Rendimiento: un perf_runs de los últimos 7 días (la fila sembrada cuenta).
const MODULOS: Module[] = ['supabase', 'cloudflare', 'codebase', 'performance'];
const PASO: Record<Exclude<Module, 'performance'>, ScanStep['name'][]> = { supabase: ['supabase'], cloudflare: ['cloudflare'], codebase: ['repo', 'zip'] };
const DIA_MS = 86_400_000;

// Puro: con los steps de las auditorías recientes (más nuevas primero), el último intento de cada módulo.
export function ultimoIntento(scans: { steps: ScanStep[] }[], nombres: ScanStep['name'][]): 'done' | 'failed' | null {
  for (const s of scans) {
    const p = s.steps.find((x) => nombres.includes(x.name) && (x.status === 'done' || x.status === 'failed'));
    if (p) return p.status as 'done' | 'failed';
  }
  return null;
}

export async function calcularCobertura(env: CloudflareBindings, orgId: string, ahora = new Date()): Promise<Coverage> {
  const admin = db(env);
  const hace = (ms: number) => new Date(ahora.getTime() - ms).toISOString();
  const [{ data: scans }, { count: perf }, { count: sbOk }, { count: cfReq }] = await Promise.all([
    admin.from('scan_runs').select('steps').eq('org_id', orgId).gte('created_at', hace(7 * DIA_MS))
      .order('created_at', { ascending: false }).limit(20),
    admin.from('perf_runs').select('id', { count: 'exact', head: true }).eq('org_id', orgId).gte('created_at', hace(7 * DIA_MS)),
    admin.from('metric_samples').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('metric', 'sb_service_ok')
      .eq('value', 1).eq('labels->>service', 'db').gte('ts', hace(5 * 60_000)),
    admin.from('metric_samples').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('metric', 'cf_req_5m')
      .gte('ts', hace(10 * 60_000)),
  ]);
  const lista = ((scans ?? []) as { steps: ScanStep[] | null }[]).map((s) => ({ steps: Array.isArray(s.steps) ? s.steps : [] }));
  const supabaseOk7d = lista.some((s) => s.steps.some((x) => x.name === 'supabase' && x.status === 'done'));
  const visto: Record<Module, boolean> = {
    supabase: ultimoIntento(lista, PASO.supabase) === 'done' || ((sbOk ?? 0) > 0 && supabaseOk7d),
    cloudflare: ultimoIntento(lista, PASO.cloudflare) === 'done' || (cfReq ?? 0) > 0,
    codebase: ultimoIntento(lista, PASO.codebase) === 'done',
    performance: (perf ?? 0) > 0,
  };
  const missing = MODULOS.filter((m) => !visto[m]);
  return { seen: MODULOS.length - missing.length, total: MODULOS.length, missing };
}
