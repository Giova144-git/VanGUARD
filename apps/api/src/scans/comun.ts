import type { Module } from '@vanguard/contracts';
import { redact } from '@vanguard/core';
import { dedupeKey } from '@vanguard/core/crypto';
import type { MsgScan } from '../jobs.ts';
import { db } from '../lib/db.ts';
import { ProviderError } from '../lib/http.ts';
import { log } from '../lib/log.ts';

// Piezas comunes de los pasos de la auditoría (S15 15.8).
// dedupe_input: lo que identifica el hallazgo dentro de la regla (por defecto el resource; en SQL 2 es recurso#política y
// en advisors el cache_key del lint, según packages/core/src/rules/supabase.ts).
export type Borrador = { rule_id: string; severity: string; confirmed?: boolean; origin?: 'rule' | 'ai' | 'provider';
  title: string; resource: string; evidence?: Record<string, unknown>; suspected_injection?: boolean; dedupe_input?: string };
export type Conexion = { id: string; meta: Record<string, unknown>; capabilities: Record<string, unknown> };

// Conexión de lectura activa del proveedor: la del params del scan_run si la pidieron, o la más reciente.
export async function conexionActiva(env: CloudflareBindings, m: MsgScan, provider: string): Promise<Conexion | null> {
  const admin = db(env);
  const { data: scan } = await admin.from('scan_runs').select('params').eq('id', m.scan_run_id).eq('org_id', m.org_id).maybeSingle();
  const pedida = (scan?.params as { connection_id?: string } | undefined)?.connection_id;
  let q = admin.from('connections').select('id, meta, capabilities').eq('org_id', m.org_id).eq('provider', provider)
    .eq('kind', 'read').eq('status', 'active');
  if (pedida) q = q.eq('id', pedida);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new ProviderError('unavailable');
  return (data as Conexion | null) ?? null;
}

// Toda la evidencia pasa por redact() antes de salir del paso; dedupe_key = sha256hex(org|regla|recurso) (§05).
async function aFila(orgId: string, b: Borrador) {
  const limpio = redact({ title: b.title, resource: b.resource, evidence: b.evidence ?? {}, clave: b.dedupe_input ?? b.resource });
  return { rule_id: b.rule_id, severity: b.severity, confirmed: b.confirmed ?? false, origin: b.origin ?? 'rule',
    title: limpio.title.slice(0, 200), resource: limpio.resource.slice(0, 300), evidence: limpio.evidence,
    suspected_injection: b.suspected_injection ?? false, dedupe_key: await dedupeKey(orgId, b.rule_id, limpio.clave) };
}

// vg_upsert_findings con cable trampa (regla 9): si el check looks_like_secret rechaza el lote (23514), fila por fila;
// la que falla va con evidence {redacted:true} y, si aún falla (el secreto estaba en title/resource), se descarta.
export async function guardarHallazgos(env: CloudflareBindings, m: MsgScan, module: Module, connId: string | null,
  borradores: Borrador[], completo: boolean, regla?: string): Promise<{ n: number; descartadas: number }> {
  const admin = db(env);
  const filas = await Promise.all(borradores.map((b) => aFila(m.org_id, b)));
  const rpc = (rows: unknown[], complete: boolean) => admin.rpc('vg_upsert_findings', { p_org: m.org_id, p_scan: m.scan_run_id,
    p_module: module, p_conn: connId, p_rows: rows, p_complete: complete, ...(regla ? { p_rule: regla } : {}) });
  const { error } = await rpc(filas, completo);
  if (!error) return { n: filas.length, descartadas: 0 };
  if (error.code !== '23514') throw new ProviderError('unavailable');
  let descartadas = 0;
  for (const f of filas) {
    if (!(await rpc([f], false)).error) continue;
    log('warn', 'TRIPWIRE', { rule_id: f.rule_id });
    if ((await rpc([{ ...f, evidence: { redacted: true } }], false)).error) descartadas++;
  }
  if (completo) await rpc([], true);   // la auto-verificación solo corre si el paso vio todo
  return { n: filas.length - descartadas, descartadas };
}
