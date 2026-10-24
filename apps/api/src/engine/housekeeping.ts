import { ORDEN_REGLAS_EDGE, RESOLVER_SIN_EVENTOS_MS } from '@vanguard/core';
import { deshacerBloqueos, PERMANENTES } from '../actions/block-ip.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

// housekeeping del cron por minuto (S12 12.3, S15 15.7). P0: cierre automático de los incidentes CF_ sin peticiones de
// su IP en edge_hits desde hace 15 min, en UNA consulta acotada (RPC vg_resolve_idle_incidents, 0009). Mientras la 0009
// no esté aplicada (PGRST202), respaldo en un solo UPDATE por last_event_at: la última evaluación que vio la IP disparar
// una regla, que va hasta 60 s por detrás de su última petición; cierra igual a los ~15 min de un ataque que paró.
// Devuelve un resumen y onCron lo deja en su línea monitor.minuto.
// Caducidad de «Bloquear IP» (§08.8, S15 15.10): Cloudflare no caduca las access rules; aquí se deshacen las actions
// executed con expires_at < now(), como mucho LIMITE_CADUCIDAD por minuto (las más viejas primero), con deshacerBloqueos
// (un sobre por conexión, DELETE por regla, 404 = ya no estaba, previous.existed → no se toca Cloudflare). Un fallo
// permanente (permiso, token, credencial, otro 4xx) deja la fila failed con previous.deshacer_error (visible, y E22 puede
// reintentarla). Uno pasajero (red, 5xx, 429) la deja executed con previous.intentos y previous.reintento_en (espera de
// 1, 2, 4… min): mientras espera se salta, así unas filas atascadas no tapan las de otras orgs; al MAX_REINTENTOS pasa a
// failed. Solo con VG_ENV=production (cron sin petición, S15 15.3): en local y previews no se toca Cloudflare.
// SB_DB_DOWN se cierra en su monitor (2 lecturas sanas seguidas), no aquí.

export const LIMITE_CIERRE = 200;
export const LIMITE_CADUCIDAD = 5;           // ≤ 5 reglas por minuto (§08.8): ≤ 23 subpeticiones en el peor caso
export const CANDIDATOS_CADUCIDAD = 50;      // se leen más para saltar las que esperan su reintento
export const MAX_REINTENTOS = 6;             // ~1 h de esperas (1+2+4+8+16+32 min) antes de rendirse
const SIN_RPC = new Set(['PGRST202', '42883']);
const esperaMs = (intentos: number) => Math.min(2 ** (intentos - 1), 60) * 60_000;
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});

export type ResultadoHousekeeping = {
  resueltos: number;
  subpeticiones: number;
  modo: 'rpc' | 'respaldo' | null;
  error: string | null;       // código corto (de Postgres/PostgREST o nuestro), nunca un mensaje
  deshechos: number;          // bloqueos caducados retirados de Cloudflare
  fallidos: number;           // bloqueos que no se pudieron retirar y quedan failed
};

export async function housekeeping(env: CloudflareBindings, now = new Date()): Promise<ResultadoHousekeeping> {
  const r: ResultadoHousekeeping = { resueltos: 0, subpeticiones: 0, modo: null, error: null, deshechos: 0, fallidos: 0 };
  const cierre = await cerrarIncidentes(env, now, r);
  await caducarBloqueos(env, now, cierre);
  return cierre;
}

async function cerrarIncidentes(env: CloudflareBindings, now: Date, r: ResultadoHousekeeping): Promise<ResultadoHousekeeping> {
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

async function caducarBloqueos(env: CloudflareBindings, now: Date, r: ResultadoHousekeeping) {
  if (env.VG_ENV !== 'production') return;
  try {
    const admin = db(env);
    const t = now.getTime();
    const { data, error } = await admin.from('actions').select('id, org_id, provider_ref, previous')
      .eq('status', 'executed').eq('kind', 'block_ip').lt('expires_at', now.toISOString())
      .order('expires_at').limit(CANDIDATOS_CADUCIDAD);
    r.subpeticiones++;
    if (error) {
      r.error ??= error.code ?? 'actions';
      return;
    }
    type Fila = { id: string; org_id: string; provider_ref: string | null; previous: unknown };
    const filas = ((Array.isArray(data) ? data : []) as Fila[])
      .filter((f) => !(Date.parse(String(obj(f.previous).reintento_en ?? '')) > t)).slice(0, LIMITE_CADUCIDAD);
    if (!filas.length) return;
    const { resultados, subpeticiones } = await deshacerBloqueos(env, filas, { rid: 'cron', ahora: t });
    r.subpeticiones += subpeticiones;
    r.deshechos = filas.filter((f) => resultados.get(f.id) === 'deshecho').length;
    // Una escritura por fila no retirada (≤ 5): cada una guarda su previous con el intento o el motivo.
    const pendientes = filas.filter((f) => resultados.get(f.id) !== 'deshecho');
    const escritas = await Promise.all(pendientes.map(async (f) => {
      const motivo = resultados.get(f.id) ?? 'caido';
      const prev = obj(f.previous);
      const intentos = (typeof prev.intentos === 'number' ? prev.intentos : 0) + 1;
      const rendida = PERMANENTES.has(motivo) || intentos >= MAX_REINTENTOS;
      const cambio = rendida ? { status: 'failed', previous: { ...prev, intentos, deshacer_error: motivo } }
        : { previous: { ...prev, intentos, reintento_en: new Date(t + esperaMs(intentos)).toISOString() } };
      const u = await admin.from('actions').update(cambio).eq('id', f.id).eq('org_id', f.org_id).eq('status', 'executed');
      if (u.error) r.error ??= u.error.code ?? 'update';
      // La regla puede seguir en Cloudflare: queda en el log de errores (sin la IP) y como failed en la app.
      else if (rendida) log('error', 'bloqueo.caducidad_fallida', { action_id: f.id, motivo, intentos });
      return !u.error && rendida;
    }));
    r.subpeticiones += pendientes.length;
    r.fallidos = escritas.filter(Boolean).length;
    log(r.fallidos ? 'warn' : 'info', 'bloqueos.caducados', { deshechos: r.deshechos, fallidos: r.fallidos,
      reintentos: pendientes.length - r.fallidos });
  } catch (e) {
    r.error ??= e instanceof ApiError ? e.code : e instanceof Error ? e.name : 'desconocido';
  }
}
