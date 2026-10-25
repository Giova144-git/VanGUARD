import { Hono } from 'hono';
import { SimulateAttackIn, SimulateAttackOut, type SimulateAttackKind } from '@vanguard/contracts';
import { tituloIncidenteEdge, type EdgeRuleId } from '@vanguard/core';
import { aRespuestaUpsert } from '../engine/evaluar.ts';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';
import { avisarIncidente } from '../notify/despachador.ts';

// E57 · POST /api/orgs/:org/incidents/simulate · admin · solo la org de demo (asignaciones/llamada-ataque.md §B2).
// «Simular ataque»: un incidente critical REAL por el mismo camino que el motor (vg_upsert_incident) con una IP de
// TEST-NET-3 (203.0.113.N, nunca una IP real ni bloqueable), details como los del borde + simulated y el host de la
// víctima, y su aviso por el mismo despachador (mismos topes, ventana de la demo y llamada de Guardia). Uno cada 2 min
// por org (429). Subpeticiones: ~4 propias + las del despachador.

export const ORG_DEMO = '00000000-0000-4000-a000-00000000de00';
export const HOST_SIMULADO = 'vanguard-demo-victima.pages.dev';
export const ESPERA_SIMULACION_MS = 2 * 60_000;
const REGLA: Record<SimulateAttackKind, EdgeRuleId> = { path_scan: 'CF_PATH_SCAN', ip_flood: 'CF_IP_FLOOD', attack_tool: 'CF_UA_TOOL' };
const UA_SIMULADO = 'sqlmap/1.8';

const azar = (min: number, max: number) => min + (crypto.getRandomValues(new Uint32Array(1))[0]! % (max - min + 1));
async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** details como los de agruparEdge (DetallesEdge) para cada tipo, con simulated y el host de la víctima. */
export function detallesSimulados(kind: SimulateAttackKind, ip: string, n: number): Record<string, unknown> {
  const total = kind === 'ip_flood' ? Math.round(n * 1.1) : n * 3;
  return { ip, host: HOST_SIMULADO, source: 'ingest', ua_top: kind === 'attack_tool' ? UA_SIMULADO : null, n_60s: n,
    total_60s: total, share_pct: Math.min(100, Math.round((100 * n) / total)), paths_4xx: kind === 'path_scan' ? Math.round(n * 0.8) : 0,
    probe_hits: kind === 'path_scan' ? 6 : 0, admin_ok: 0, n5xx: 0, p95_ms: 140, simulated: true };
}

export const simular = new Hono<AppEnv>();

simular.post('/orgs/:org/incidents/simulate', requireAdmin, async (c) => {
  const orgId = c.get('orgId');
  const rid = c.get('rid');
  if (orgId !== ORG_DEMO) throw new ApiError('forbidden', 'Solo se puede simular un ataque en la organización de demo');
  const { kind } = await cuerpo(c, SimulateAttackIn);
  const admin = db(c.env);

  const desde = new Date(Date.now() - ESPERA_SIMULACION_MS).toISOString();
  const previos = await admin.from('incidents').select('id', { count: 'exact', head: true }).eq('org_id', orgId)
    .eq('details->>simulated', 'true').gte('started_at', desde);
  if (previos.error) {
    log('error', 'simular.lectura_error', { rid, code: previos.error.code ?? null });
    throw new ApiError('internal', 'No pudimos simular el ataque');
  }
  if ((previos.count ?? 0) > 0) throw new ApiError('rate_limited', 'Espera 2 minutos entre simulaciones');

  const ip = `203.0.113.${azar(1, 254)}`;
  const regla = REGLA[kind];
  const eventos = azar(40, 120);
  // dedupe_key nuevo en cada simulación: nunca se suma a un incidente abierto de otra simulación ni a uno real.
  const dedupe = await sha256(`${orgId}|simulado|${ip}|${crypto.randomUUID()}`);
  const { data, error } = await admin.rpc('vg_upsert_incident', { p_org: orgId, p_conn: null, p_dedupe: dedupe,
    p_rules: [regla], p_severity: 'critical', p_title: tituloIncidenteEdge([regla], kind === 'attack_tool' ? UA_SIMULADO : null, ip),
    p_resource: `ip:${ip}`, p_details: detallesSimulados(kind, ip, eventos), p_ip: null, p_started: null });
  const resp = error ? null : aRespuestaUpsert(data);
  if (!resp) {
    log('error', 'simular.upsert_error', { rid, code: error?.code ?? null });
    throw new ApiError('internal', 'No pudimos simular el ataque');
  }
  // Sin p_ip la RPC deja event_count = 1 (no hay edge_hits de una IP de documentación): se pone el creíble.
  const { error: ee } = await admin.from('incidents').update({ event_count: eventos }).eq('id', resp.id).eq('org_id', orgId);
  if (ee) log('warn', 'simular.eventos_error', { rid, code: ee.code ?? null });

  const r = await avisarIncidente(c.env, orgId, resp.id, { is_new: resp.is_new, prev_severity: resp.prev_severity,
    reopened: resp.reopened }, rid);
  log('info', 'simular.ataque', { rid, user: c.get('userId'), incidente: resp.code, kind, whatsapp: r.whatsapp, voice: r.voice });
  return c.json(SimulateAttackOut.parse({ incident_id: resp.id, code: resp.code, whatsapp: r.whatsapp, voice: r.voice }));
});
