import { Hono } from 'hono';
import { IngestBatch, SimulateAttackIn, SimulateAttackOut } from '@vanguard/contracts';
import { eventosSimulados, ipSimulada } from '@vanguard/core';
import { evaluarAhora } from '../engine/evaluar.ts';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';
import { aFila } from './ingest.ts';

// E57 · POST /api/orgs/:org/incidents/simulate · admin · solo la org de demo (asignaciones/llamada-ataque.md §B2).
// «Simular ataque» por el MOTOR REAL: eventos de borde sintéticos con la forma de EdgeEvent (eventosSimulados de core,
// desde una IP de TEST-NET-3 contra la víctima de la demo), validados con IngestBatch en lotes de ≤ 100 como /ingest y
// normalizados con su aFila, a edge_hits por la conexión ingest del simulador (connections.meta.simulador, sin secreto:
// /ingest nunca la autentica) y la misma evaluación que E30 (evaluarAhora: vg_try_eval → vg_edge_window → evaluateEdge →
// vg_upsert_incident → avisarIncidente). Las reglas deciden rule_ids, severidad y título; details.simulated se añade
// después (Ctx.marcas). Sin incidente de esa IP → 422 «la regla no se disparó». Uno cada 2 min por org (429).

export const ORG_DEMO = '00000000-0000-4000-a000-00000000de00';
export const ESPERA_SIMULACION_MS = 2 * 60_000;
const MAX_LOTE = 100;   // IngestBatch

const azar = (min: number, max: number) => min + (crypto.getRandomValues(new Uint32Array(1))[0]! % (max - min + 1));

export const simular = new Hono<AppEnv>();

simular.post('/orgs/:org/incidents/simulate', requireAdmin, async (c) => {
  const orgId = c.get('orgId');
  const rid = c.get('rid');
  if (orgId !== ORG_DEMO) throw new ApiError('forbidden', 'Solo se puede simular un ataque en la organización de demo');
  const { kind } = await cuerpo(c, SimulateAttackIn);
  const admin = db(c.env);

  const desde = new Date(Date.now() - ESPERA_SIMULACION_MS).toISOString();
  const [previos, conexion] = await Promise.all([
    admin.from('incidents').select('id', { count: 'exact', head: true }).eq('org_id', orgId)
      .eq('details->>simulated', 'true').gte('started_at', desde),
    admin.from('connections').select('id, org_id').eq('org_id', orgId).eq('provider', 'ingest')
      .eq('meta->>simulador', 'true').order('created_at').limit(1).maybeSingle(),
  ]);
  if (previos.error || conexion.error) {
    log('error', 'simular.lectura_error', { rid, code: previos.error?.code ?? conexion.error?.code ?? null });
    throw new ApiError('internal', 'No pudimos simular el ataque');
  }
  if ((previos.count ?? 0) > 0) throw new ApiError('rate_limited', 'Espera 2 minutos entre simulaciones');
  const cx = conexion.data as { id: string; org_id: string } | null;
  if (!cx) throw new ApiError('conflict', 'Falta la conexión del simulador de ataques en esta organización');

  // Los eventos, por el mismo filtro que /ingest: IngestBatch (lotes de ≤ 100) y aFila.
  const ip = ipSimulada(azar(1, 254));
  const ahora = Date.now();
  const eventos = eventosSimulados(kind, ip, ahora);
  const filas = [];
  for (let i = 0; i < eventos.length; i += MAX_LOTE) {
    const lote = IngestBatch.parse({ events: eventos.slice(i, i + MAX_LOTE) });
    for (const e of lote.events) {
      const f = aFila(e, cx, ahora);
      if (f) filas.push(f);
    }
  }
  if (filas.length) {
    const { error } = await admin.from('edge_hits').insert(filas);
    if (error) {
      log('error', 'simular.insert_error', { rid, code: error.code ?? null, n: filas.length });
      throw new ApiError('internal', 'No pudimos simular el ataque');
    }
  }

  const ev = await evaluarAhora(c.env, { orgId, connectionId: cx.id, rid, marcas: { simulated: true } });
  if (!ev) throw new ApiError('conflict', 'El motor está evaluando otro lote: inténtalo en unos segundos');
  const inc = ev.registrados.find((x) => x.ip === ip);
  if (!inc) {
    log('warn', 'simular.sin_regla', { rid, kind, filas: filas.length });
    throw new ApiError('invalid_body', 'La regla no se disparó: el ataque simulado no superó el umbral');
  }
  const aviso = inc.aviso ?? { whatsapp: 'skipped' as const, voice: 'skipped' as const };
  log('info', 'simular.ataque', { rid, user: c.get('userId'), incidente: inc.code, kind, reglas: inc.rule_ids.join(','),
    severidad: inc.severity, eventos: filas.length, whatsapp: aviso.whatsapp, voice: aviso.voice });
  return c.json(SimulateAttackOut.parse({ incident_id: inc.id, code: inc.code, whatsapp: aviso.whatsapp, voice: aviso.voice }));
});
