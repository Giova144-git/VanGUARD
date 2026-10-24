import { ORDEN_REGLAS_EDGE, RESOLVER_SIN_EVENTOS_MS } from '@vanguard/core';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';

// housekeeping del cron por minuto (S12 12.3, S15 15.7). P0: cierre automático de los incidentes CF_ sin peticiones de
// su IP en edge_hits desde hace 15 min, en UNA consulta acotada (RPC vg_resolve_idle_incidents, 0009). Mientras la 0009
// no esté aplicada (PGRST202), respaldo en un solo UPDATE por last_event_at: la última evaluación que vio la IP disparar
// una regla, que va hasta 60 s por detrás de su última petición; cierra igual a los ~15 min de un ataque que paró.
// No registra nada: devuelve un resumen y onCron lo deja en su línea monitor.minuto.
// Pendiente (E20–E22, con actions/block-ip.ts): deshacer los bloqueos vencidos (actions executed con expires_at ≤ now()):
// DELETE de la regla con previous.connection_id → undone, undone_at; 404 = ya no estaba; previous.existed → no se toca.
// SB_DB_DOWN se cierra en su monitor (2 lecturas sanas seguidas), no aquí.

export const LIMITE_CIERRE = 200;
const SIN_RPC = new Set(['PGRST202', '42883']);

export type ResultadoHousekeeping = {
  resueltos: number;
  subpeticiones: number;
  modo: 'rpc' | 'respaldo' | null;
  error: string | null;       // código corto (de Postgres/PostgREST o nuestro), nunca un mensaje
};

export async function housekeeping(env: CloudflareBindings, now = new Date()): Promise<ResultadoHousekeeping> {
  const r: ResultadoHousekeeping = { resueltos: 0, subpeticiones: 0, modo: null, error: null };
  try {
    const admin = db(env);
    const { data, error } = await admin.rpc('vg_resolve_idle_incidents',
      { p_idle_seconds: RESOLVER_SIN_EVENTOS_MS / 1000, p_limit: LIMITE_CIERRE });
    r.subpeticiones++;
    if (!error) return { ...r, modo: 'rpc', resueltos: Array.isArray(data) ? data.length : 0 };
    if (!SIN_RPC.has(error.code ?? '')) return { ...r, modo: 'rpc', error: error.code ?? 'rpc' };

    const corte = new Date(now.getTime() - RESOLVER_SIN_EVENTOS_MS).toISOString();
    const res = await admin.from('incidents').update({ status: 'resolved', resolved_at: now.toISOString() })
      .in('status', ['open', 'ack', 'mitigated']).lt('last_event_at', corte).overlaps('rule_ids', [...ORDEN_REGLAS_EDGE])
      .select('id');
    r.subpeticiones++;
    if (res.error) return { ...r, modo: 'respaldo', error: res.error.code ?? 'update' };
    return { ...r, modo: 'respaldo', resueltos: Array.isArray(res.data) ? res.data.length : 0 };
  } catch (e) {
    return { ...r, error: e instanceof ApiError ? e.code : e instanceof Error ? e.name : 'desconocido' };
  }
}
