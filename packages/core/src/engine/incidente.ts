// Decisión del incidente (S15 15.9 y 15.12, S12 12.3–12.4). La RPC vg_upsert_incident es quien agrupa, sube la
// severidad y reabre en una transacción; aquí, la lógica pura alrededor: parámetros de la RPC, qué motivo de aviso trae
// su respuesta, cooldown de reapertura, tormenta, ventana de alertas de la org de demo (§02.5.1) y cierre por inactividad.
import type { IncidentStatus, Module, Severity } from '@vanguard/contracts';
import { rank } from '../severity.ts';
import type { IncidenteEdgeConClave } from './edge.ts';

/** vg_upsert_incident reabre un incidente resuelto hace menos de esto (`reopened = true`). */
export const REAPERTURA_MS = 10 * 60_000;
/** housekeeping resuelve un incidente CF_ sin peticiones de su IP en edge_hits desde hace esto (S12 12.3). */
export const RESOLVER_SIN_EVENTOS_MS = 15 * 60_000;
/** Tormenta: MÁS de 5 incidentes de la org con started_at en los últimos 2 min (S15 15.9, S12 12.4). */
export const TORMENTA_UMBRAL = 5;
export const TORMENTA_VENTANA_MS = 2 * 60_000;

/** Fila que devuelve vg_upsert_incident (15.12): justo la entrada de planNotifications. */
export type RespuestaUpsert = {
  id: string; code: string; severity: Severity; prev_severity: Severity | null; is_new: boolean; reopened: boolean;
  status: IncidentStatus; muted_until: string | null;
};
/** Argumentos con nombre de `rpc('vg_upsert_incident', …)`. */
export type ParamsUpsertIncidente = {
  p_org: string; p_conn: string | null; p_dedupe: string; p_rules: string[]; p_severity: Severity; p_title: string;
  p_resource: string; p_details: Record<string, unknown>; p_ip: string | null; p_started: string | null;
};

/** p_started = vg_ip_first_seen(org, ip) (inicio del cronómetro); null → la RPC usa now(). */
export function paramsUpsertIncidente(inc: IncidenteEdgeConClave,
  o: { org_id: string; connection_id: string | null; started_at: string | null }): ParamsUpsertIncidente {
  return { p_org: o.org_id, p_conn: o.connection_id, p_dedupe: inc.dedupe_key, p_rules: [...inc.rule_ids],
    p_severity: inc.severity, p_title: inc.title, p_resource: inc.resource, p_details: { ...inc.details }, p_ip: inc.ip,
    p_started: o.started_at };
}

/** high → critical (y cualquier subida): se compara por rango, nunca por texto ('critical' < 'high' alfabéticamente). */
export const subioSeveridad = (prev: Severity | null, actual: Severity): boolean => prev !== null && rank(actual) > rank(prev);

export type MotivoAviso = 'nuevo' | 'subio';
/** Por qué la respuesta del upsert merece aviso externo (renotificación de §12.3), o null si no cambió nada que avisar.
 *  Reabrir sin subir de severidad no avisa (§12.3/§12.4, decisión del ORQUESTADOR): queda en la app y en la timeline. */
export function motivoAviso(i: Pick<RespuestaUpsert, 'severity' | 'prev_severity' | 'is_new' | 'reopened'>): MotivoAviso | null {
  if (i.is_new) return 'nuevo';
  return subioSeveridad(i.prev_severity, i.severity) ? 'subio' : null;
}

/** Espejo del cooldown de la RPC: ¿un incidente resuelto en `resolvedAt` se reabriría ahora en vez de abrir uno nuevo? */
export function dentroDeCooldown(resolvedAt: string | null, ahora = new Date()): boolean {
  const t = resolvedAt ? Date.parse(resolvedAt) : NaN;
  return Number.isFinite(t) && ahora.getTime() - t < REAPERTURA_MS;
}

export type Tormenta = 'none' | 'first' | 'suppressed';
/** `incidentes2min` = incidentes de la org con started_at en los últimos 2 min (contando el actual); `stormEnviado` =
 *  la org ya tiene un storm_v1 en esos 2 min. */
export function estadoTormenta(incidentes2min: number, stormEnviado: boolean): Tormenta {
  if (!(incidentes2min > TORMENTA_UMBRAL)) return 'none';
  return stormEnviado ? 'suppressed' : 'first';
}

/** M10 de §02.5.1: para la org is_demo la ventana `app_config.demo_alertas_hasta` (ISO) está cerrada si falta, no es
 *  una fecha o ya pasó. Las demás orgs nunca están fuera de ventana. */
export function fueraDeVentanaDemo(org: { is_demo: boolean }, hasta: string | null | undefined, ahora = new Date()): boolean {
  if (!org.is_demo) return false;
  const t = typeof hasta === 'string' ? Date.parse(hasta) : NaN;
  return !(Number.isFinite(t) && ahora.getTime() < t);
}

/** housekeeping (S12 12.3): un incidente no resuelto con reglas CF_ se cierra si su IP no tiene peticiones desde hace
 *  15 min (`ultimoHit` = max(ts) de edge_hits de esa IP, null si no queda ninguna). Las SB_ siguen su propia regla. */
export function cerrarPorInactividad(i: { status: IncidentStatus; rule_ids: readonly string[] }, ultimoHit: string | null,
  ahora = new Date()): boolean {
  if (i.status === 'resolved' || !i.rule_ids.some((r) => r.startsWith('CF_'))) return false;
  const t = ultimoHit ? Date.parse(ultimoHit) : NaN;
  return !Number.isFinite(t) || ahora.getTime() - t >= RESOLVER_SIN_EVENTOS_MS;
}

// ── Módulo y servicio por prefijo de regla (E17: `module` no es columna de incidents) ────────────────────────────
const PREFIJOS: ReadonlyArray<readonly [string, Module]> = [['CF_', 'cloudflare'], ['SB_', 'supabase'], ['CB_', 'codebase'], ['PF_', 'performance']];
export const moduloDeRegla = (ruleId: string | undefined): Module | null =>
  PREFIJOS.find(([p]) => (ruleId ?? '').startsWith(p))?.[1] ?? null;
/** {servicio} de §12.6: nombre visible del módulo (los de la navegación del FRONT). */
export const SERVICIO_MODULO: Readonly<Record<Module, string>> = {
  cloudflare: 'Cloudflare', supabase: 'Supabase', codebase: 'Codebase', performance: 'Rendimiento',
};
/** Servicio por el prefijo de rule_ids[0]; «VanGUARD» si no se reconoce. */
export const servicioDeReglas = (ruleIds: readonly string[]): string => {
  const m = moduloDeRegla(ruleIds[0]);
  return m ? SERVICIO_MODULO[m] : 'VanGUARD';
};

// Regla cuyo {resumen} encabeza el aviso: si es critical, la causa de la subida; si no, la del primer WhatsApp de la
// demo (CF_UA_TOOL/CF_PATH_SCAN, §12.2).
const PRINCIPAL_CRITICAL = ['CF_ADMIN_EXPOSED', 'CF_IP_FLOOD', 'SB_DB_DOWN', 'SB_CPU_HIGH', 'CF_UA_TOOL', 'CF_PATH_SCAN'];
const PRINCIPAL_OTRAS = ['CF_UA_TOOL', 'CF_PATH_SCAN', 'CF_IP_FLOOD', 'SB_CPU_HIGH', 'SB_DB_DOWN', 'CF_ADMIN_EXPOSED'];
export function reglaPrincipal(ruleIds: readonly string[], severity: Severity): string | null {
  const orden = severity === 'critical' ? PRINCIPAL_CRITICAL : PRINCIPAL_OTRAS;
  return orden.find((r) => ruleIds.includes(r)) ?? ruleIds[0] ?? null;
}
