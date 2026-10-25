import type { SupabaseClient } from '@supabase/supabase-js';
import { Severity } from '@vanguard/contracts';
import {
  evaluarVentanaEdge, motivoAviso, normalizarFilaVentana, paramsUpsertIncidente, rank, REGLAS_QUE_OFRECEN,
  type EdgeWindowRow, type IncidenteEdgeConClave, type RespuestaUpsert,
} from '@vanguard/core';
import { db } from '../lib/db.ts';
import { log } from '../lib/log.ts';
import { avisarIncidente, type ResumenAviso } from '../notify/despachador.ts';

// Motor en vivo (S15 15.9, S12 12.2–12.4). E30 lo llama una vez por lote con filas, en waitUntil: vg_try_eval (una
// evaluación por org cada ≥ 5 s) → vg_edge_window(org, 60) ‖ conexión → evaluateEdge del core, un incidente por IP →
// por incidente vg_ip_first_seen (inicio del cronómetro) y vg_upsert_incident → si es nuevo, subió o se reabrió,
// avisarIncidente. La línea de tiempo sale de incidents.started_at (= p_started) y de details.detected_at, que pone la
// RPC al insertar y conserva al actualizar. Nunca lanza: todo error va al log, sin IPs ni teléfonos.

/** Ventana de vg_edge_window (§12.2) y de vg_ip_first_seen (por defecto de 0006). */
export const VENTANA_S = 60;
export const PRIMERA_VISTA_S = 120;
// Subpeticiones (Workers Free: 50 por invocación; S15 pide ≤ 40 contando las de waitUntil). E30 gasta ≤ 4 antes de
// llegar aquí (conexión, secreto, material de cifrado, insert del lote), así que el motor se queda en 34.
export const PRESUPUESTO_MOTOR = 34;
const COSTE_BASE = 3;                 // vg_try_eval + vg_edge_window + connections
const RESERVA_INCIDENTE = 3;          // vg_ip_first_seen + vg_upsert_incident + un reintento por 23505
/** Reserva por aviso [estimación]: el despachador lee incidente, contactos, org, uso y tormenta, y por contacto escribe
 *  notifications y approvals, llama a Kapso y cierra la fila (~18 con 2 contactos). */
export const COSTE_AVISO = 18;
/** Reserva extra para el 2.º mensaje de bajo ataque del despachador (ofrecerBajoAtaque: oferta 3 + fila 1 + approvals 1
 *  + envío ≤ 2 + cierre 1), solo en los incidentes con CF_IP_FLOOD: los únicos a los que se les puede ofrecer. */
export const COSTE_OFERTA_BAJO_ATAQUE = 8;
const costeAviso = (inc: { rule_ids: readonly string[] }) =>
  COSTE_AVISO + (inc.rule_ids.some((r) => REGLAS_QUE_OFRECEN.includes(r)) ? COSTE_OFERTA_BAJO_ATAQUE : 0);

// marcas: claves que se añaden a details del incidente DESPUÉS de que las reglas decidan (E57: simulated). No entran en
// la ventana ni en evaluateEdge, así que no cambian ni reglas, ni severidad, ni título.
export type Ctx = { orgId: string; connectionId: string; rid: string; marcas?: Readonly<Record<string, unknown>> };
export type ResumenEvaluacion = {
  filas: number; incidentes: number; procesados: number; nuevos: number; avisos: number; pendientes: number; errores: number;
  subpeticiones: number;
};
/** Lo que decidió el motor por cada incidente que registró, y lo que hizo el despachador si avisó. */
export type IncidenteEvaluado = { id: string; code: string; rule_ids: string[]; severity: Severity; ip: string;
  aviso: ResumenAviso | null };
export type Evaluacion = ResumenEvaluacion & { registrados: IncidenteEvaluado[] };

export async function evaluarEnVivo(env: CloudflareBindings, ctx: Ctx): Promise<void> {
  await evaluarAhora(env, ctx);
}

/** El motor en vivo de una vez, con su resultado: null si no tocó evaluar (vg_try_eval: otra evaluación de la org hace
 *  < 5 s) o si algo lanzó. E30 lo deja en waitUntil (evaluarEnVivo); E57 lo espera para responder. Nunca lanza. */
export async function evaluarAhora(env: CloudflareBindings, ctx: Ctx): Promise<Evaluacion | null> {
  const t0 = Date.now();
  try {
    const r = await evaluar(env, ctx);
    if (r) {
      const { registrados, ...resumen } = r;
      log(r.errores || r.pendientes ? 'warn' : 'info', 'motor.evaluacion', { rid: ctx.rid, ...resumen, ms: Date.now() - t0 });
      void registrados;
    }
    return r;
  } catch (e) {
    log('error', 'motor.error', { rid: ctx.rid, name: e instanceof Error ? e.name : typeof e });
    return null;
  }
}

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {});
const err = (e: unknown) => (e instanceof Error ? e.name : typeof e);

// connections.label es el {host} de §12.6; meta.ingest_factor escala los umbrales de volumen (P1, defecto 1).
function contexto(fila: unknown): { host: string; f: number } {
  const o = obj(fila), meta = obj(o.meta);
  const host = typeof o.label === 'string' && o.label.trim() ? o.label
    : typeof meta.hostname === 'string' && meta.hostname.trim() ? meta.hostname : 'tu sitio';
  const f = typeof meta.ingest_factor === 'number' && meta.ingest_factor > 0 && meta.ingest_factor <= 100 ? meta.ingest_factor : 1;
  return { host, f };
}

// Fila de vg_upsert_incident (returns table → array de una fila) → RespuestaUpsert, o null si no tiene la forma esperada.
export function aRespuestaUpsert(data: unknown): RespuestaUpsert | null {
  const o = obj(Array.isArray(data) ? data[0] : data);
  const sev = Severity.safeParse(o.severity);
  const prev = Severity.safeParse(o.prev_severity);
  if (typeof o.id !== 'string' || typeof o.code !== 'string' || !sev.success || typeof o.is_new !== 'boolean') return null;
  const status = o.status === 'ack' || o.status === 'mitigated' || o.status === 'resolved' ? o.status : 'open';
  return { id: o.id, code: o.code, severity: sev.data, prev_severity: prev.success ? prev.data : null, is_new: o.is_new,
    reopened: o.reopened === true, status, muted_until: typeof o.muted_until === 'string' ? o.muted_until : null };
}

/** Orden de proceso: primero los que avisarán (sin abierto con esa clave, o con uno de menor severidad), critical antes;
 *  después los que solo actualizan. `abiertos` = dedupe_key → severidad del incidente no resuelto; null = no se pudo
 *  leer (todos cuentan como aviso: la reserva se queda del lado seguro). Puro, para probarlo sin base. */
export function planEvaluacion(incidentes: readonly IncidenteEdgeConClave[], abiertos: ReadonlyMap<string, Severity> | null) {
  const plan = incidentes.map((inc) => {
    const sev = abiertos?.get(inc.dedupe_key);
    return { inc, avisara: !abiertos || !sev || rank(inc.severity) > rank(sev) };
  });
  return [...plan.filter((p) => p.avisara), ...plan.filter((p) => !p.avisara)];   // filter conserva critical primero
}

async function evaluar(env: CloudflareBindings, ctx: Ctx): Promise<Evaluacion | null> {
  const { orgId, connectionId, rid } = ctx;
  const admin = db(env);
  const { data: toca, error: et } = await admin.rpc('vg_try_eval', { p_org: orgId });
  if (et) {
    log('warn', 'motor.try_eval_error', { rid, code: et.code ?? null });
    return null;
  }
  if (toca !== true) return null;          // null = otra evaluación de la org hace < 5 s

  const [ventana, conexion] = await Promise.all([
    admin.rpc('vg_edge_window', { p_org: orgId, p_seconds: VENTANA_S }),
    admin.from('connections').select('label, meta').eq('id', connectionId).eq('org_id', orgId).maybeSingle(),
  ]);
  const r: Evaluacion = { filas: 0, incidentes: 0, procesados: 0, nuevos: 0, avisos: 0, pendientes: 0, errores: 0,
    subpeticiones: COSTE_BASE, registrados: [] };
  if (ventana.error) {
    log('error', 'motor.ventana_error', { rid, code: ventana.error.code ?? null });
    return { ...r, errores: 1 };
  }
  if (conexion.error) log('warn', 'motor.conexion_error', { rid, code: conexion.error.code ?? null });
  const filas = (Array.isArray(ventana.data) ? ventana.data : []).map(normalizarFilaVentana)
    .filter((x): x is EdgeWindowRow => x !== null);
  r.filas = filas.length;
  const { host, f } = contexto(conexion.data);
  const incidentes = await evaluarVentanaEdge(filas, { org_id: orgId, host, f });   // critical primero, ≤ 20 (ventana)
  r.incidentes = incidentes.length;
  if (!incidentes.length) return r;

  // Una lectura para saber cuáles ya tienen incidente abierto: así los avisos van primero y la reserva solo se aparta
  // para ellos. Sin esto, con muchas IPs los abiertos (baratos) se comerían el presupuesto y una IP nueva no llegaría
  // nunca a abrir el suyo.
  const { data: ab, error: ea } = await admin.from('incidents').select('dedupe_key, severity').eq('org_id', orgId)
    .in('dedupe_key', incidentes.map((i) => i.dedupe_key)).in('status', ['open', 'ack', 'mitigated']);
  r.subpeticiones++;
  if (ea) log('warn', 'motor.abiertos_error', { rid, code: ea.code ?? null });
  const abiertos = ea ? null : new Map((Array.isArray(ab) ? ab : []).flatMap((x) => {
    const o = obj(x), s = Severity.safeParse(o.severity);
    return typeof o.dedupe_key === 'string' && s.success ? [[o.dedupe_key, s.data] as const] : [];
  }));

  const plan = planEvaluacion(incidentes, abiertos);
  for (const [i, { inc, avisara }] of plan.entries()) {
    const coste = costeAviso(inc);
    if (r.subpeticiones + RESERVA_INCIDENTE + (avisara ? coste : 0) > PRESUPUESTO_MOTOR) {
      // Si no cabe un aviso, aún pueden caber los que solo actualizan (van detrás): se salta este y se sigue.
      if (avisara) { r.pendientes++; continue; }
      r.pendientes += plan.length - i;
      break;
    }
    const resp = await registrar(admin, inc, ctx, r);
    if (!resp) {
      r.errores++;
      continue;
    }
    r.procesados++;
    if (resp.is_new) r.nuevos++;
    const registrado: IncidenteEvaluado = { id: resp.id, code: resp.code, rule_ids: [...inc.rule_ids], severity: resp.severity,
      ip: inc.ip, aviso: null };
    r.registrados.push(registrado);
    if (!motivoAviso(resp)) continue;
    // Un aviso no previsto (se resolvió entre la lectura y el upsert) sale solo si aún cabe; si no, queda en el log.
    if (!avisara && r.subpeticiones + coste > PRESUPUESTO_MOTOR) {
      log('warn', 'motor.aviso_sin_presupuesto', { rid, incidente: resp.code });
      continue;
    }
    r.avisos++;
    r.subpeticiones += coste;
    try {
      registrado.aviso = await avisarIncidente(env, orgId, resp.id, { is_new: resp.is_new, prev_severity: resp.prev_severity,
        reopened: resp.reopened }, rid);
    } catch (e) {
      log('error', 'motor.aviso_error', { rid, incidente: resp.code, name: err(e) });
    }
  }
  return r;
}

// vg_ip_first_seen + vg_upsert_incident. Un 23505 del índice parcial (carrera entre dos evaluaciones) se reintenta una vez.
async function registrar(admin: SupabaseClient, inc: IncidenteEdgeConClave, ctx: Ctx, r: ResumenEvaluacion): Promise<RespuestaUpsert | null> {
  const { orgId, connectionId, rid } = ctx;
  const { data: primera, error: ep } = await admin.rpc('vg_ip_first_seen', { p_org: orgId, p_ip: inc.ip, p_seconds: PRIMERA_VISTA_S });
  r.subpeticiones++;
  if (ep) log('warn', 'motor.primera_vista_error', { rid, code: ep.code ?? null });
  // Sin dato, p_started null: la RPC usa now() (started_at es not null).
  const started_at = !ep && typeof primera === 'string' && primera ? primera : null;
  const base = paramsUpsertIncidente(inc, { org_id: orgId, connection_id: connectionId, started_at });
  const params = ctx.marcas ? { ...base, p_details: { ...base.p_details, ...ctx.marcas } } : base;
  for (let intento = 1; intento <= 2; intento++) {
    const { data, error } = await admin.rpc('vg_upsert_incident', params);
    r.subpeticiones++;
    if (!error) {
      const resp = aRespuestaUpsert(data);
      if (!resp) log('error', 'motor.upsert_forma', { rid });
      return resp;
    }
    if (error.code === '23505' && intento === 1) continue;
    log('error', 'motor.upsert_error', { rid, code: error.code ?? null, reglas: inc.rule_ids.join(',') });
    return null;
  }
  return null;
}
