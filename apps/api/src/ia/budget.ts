// Envoltorios del libro de gasto de IA (S11 11.8 y 11.12): vg_ai_status, vg_ai_reserve (S05) y vg_ai_settle.
// Nunca lanzan: un error de la RPC (o la base sin configurar) se trata como «sin libro», y sin libro no se gasta.
import { db } from '../lib/db.ts';                                         // cliente admin de la sección 15
import { log } from '../lib/log.ts';

export type EstadoIA = { enabled: boolean; today_usd: number; cap_usd: number; calls_1m: number;
  level: 'normal' | 'reduced' | 'minimal' | 'off' };
export type Reserva = { ok: boolean; code?: 'disabled' | 'budget'; scope?: string; usage_id?: string; global_pct?: number };
export type Liquidacion = { input?: number | null; cache_read?: number | null; cache_write?: number | null;
  output?: number | null; cost: number | null; stop: string; refusal?: string | null; request_id?: string | null };

export async function estadoIA(env: CloudflareBindings, org: string): Promise<EstadoIA | null> {
  try {
    const r = await db(env).rpc('vg_ai_status', { p_org: org });
    return r.error || !r.data ? null : (r.data as EstadoIA);
  } catch {
    return null;
  }
}

export async function reservarIA(env: CloudflareBindings, org: string, ruta: string, model: string,
  peor: number): Promise<Reserva | null> {
  try {
    const r = await db(env).rpc('vg_ai_reserve', { p_org: org, p_route: ruta, p_model: model, p_worst_usd: peor });  // S05
    return r.error || !r.data ? null : (r.data as Reserva);
  } catch {
    return null;
  }
}

// null en tokens = 0 y cost null = conservar el peor caso reservado (lo decide vg_ai_settle).
export async function liquidarIA(env: CloudflareBindings, id: string, l: Liquidacion): Promise<void> {
  try {
    const r = await db(env).rpc('vg_ai_settle', { p_id: id, p_input: l.input ?? null, p_cache_read: l.cache_read ?? null,
      p_cache_write: l.cache_write ?? null, p_output: l.output ?? null, p_cost: l.cost, p_stop: l.stop,
      p_refusal: l.refusal ?? null, p_request_id: l.request_id ?? null });
    if (r.error) log('warn', 'ia.liquidar_fallo', { usage_id: id, code: r.error.code ?? null });
  } catch {
    log('warn', 'ia.liquidar_fallo', { usage_id: id, code: 'excepcion' });   // la fila queda en reserved: cuenta su peor caso
  }
}
