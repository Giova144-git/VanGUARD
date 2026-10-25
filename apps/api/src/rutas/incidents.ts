import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ActionPublic, Id, Incident, IncidentDetail, IncidentStatus, MuteBody, NotificationPublic, RespuestaEscritura,
} from '@vanguard/contracts';
import { moduloDeRegla } from '@vanguard/core';
import { armarTimeline } from '../engine/timeline.ts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';

// E17 · GET incidents (?status=open → open y ack; sin status → últimas 24 h) y GET incidents/:id (IncidentDetail con
// avisos, acciones y línea de tiempo) · user · P0. E19 · POST incidents/:id/ack y /mute · admin · P0 (S15 15.4).
// Anti-IDOR: toda consulta lleva org_id de la ruta; un id de otra org → 404. ack/mute responden el Incident más
// {ok, resultado, en} de RespuestaEscritura, que es lo que valida la mutación del FRONT (useAccionIncidente).
export const incidents = new Hono<AppEnv>();

export const COLUMNAS_INCIDENTE = 'id, code, rule_ids, severity, title, resource, status, event_count, details, started_at, '
  + 'last_event_at, notified_at, acked_at, acked_via, muted_until, mitigated_at, resolved_at, suspected_injection';
const COLUMNAS_NOTIFICACION = 'id, channel, recipient_masked, template, status, error, preview, created_at, sent_at, delivered_at, read_at';
const COLUMNAS_ACCION = 'id, kind, target, status, created_at, undone_at, expires_at, approval_id';
const VENTANA_LISTA_MS = 24 * 3600_000;
const MAX_LISTA = 100;
const ABIERTOS = ['open', 'ack'];                         // lo mismo que cuenta E12 (open_incidents) y el FRONT
const NO_RESUELTOS = ['open', 'ack', 'mitigated'];
// Marcas nuestras dentro de details (to_jsonb(now()) llega con +00:00): al contrato van en …Z.
const MARCAS_DETAILS = ['detected_at', 'severity_up_at', 'muted_at'];

type Fila = Record<string, unknown>;
const t = (x: unknown) => (typeof x === 'string' && x ? iso(x) : null);

export function aIncident(fila: unknown): Incident {
  const f = fila as Fila;
  const reglas = Array.isArray(f.rule_ids) ? f.rule_ids.map(String) : [];
  const details: Fila = { ...((f.details && typeof f.details === 'object' ? f.details : {}) as Fila) };
  for (const k of MARCAS_DETAILS) if (typeof details[k] === 'string') details[k] = t(details[k]) ?? details[k];
  return Incident.parse({ ...f, module: moduloDeRegla(reglas[0]) ?? 'cloudflare', rule_ids: reglas, details,
    started_at: iso(String(f.started_at)), last_event_at: iso(String(f.last_event_at)), notified_at: t(f.notified_at),
    acked_at: t(f.acked_at), muted_until: t(f.muted_until), mitigated_at: t(f.mitigated_at), resolved_at: t(f.resolved_at),
    suspected_injection: f.suspected_injection === true });
}

const idDe = (raw: string | undefined) => {
  const r = Id.safeParse(raw);
  if (!r.success) throw new ApiError('not_found', 'Incidente no encontrado');
  return r.data;
};

async function leer(c: Context<AppEnv>, id: string): Promise<Fila> {
  const { data, error } = await db(c.env).from('incidents').select(COLUMNAS_INCIDENTE)
    .eq('id', id).eq('org_id', c.get('orgId')).maybeSingle();
  if (error) {
    log('error', 'incidente.lectura_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer el incidente');
  }
  if (!data) throw new ApiError('not_found', 'Incidente no encontrado');
  return data as unknown as Fila;
}

// UPDATE de la fila propia (id + org) solo si sigue en uno de `estados`; null si ya no lo estaba (carrera).
async function actualizar(c: Context<AppEnv>, id: string, cambio: Fila, estados: string[]): Promise<Fila | null> {
  const { data, error } = await db(c.env).from('incidents').update(cambio)
    .eq('id', id).eq('org_id', c.get('orgId')).in('status', estados).select(COLUMNAS_INCIDENTE).maybeSingle();
  if (error) {
    log('error', 'incidente.update_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos actualizar el incidente');
  }
  return (data as unknown as Fila | null) ?? null;
}

const resuelto = () => new ApiError('conflict', 'El incidente ya está resuelto', { reason: 'resolved' });
const respuesta = (fila: Fila, resultado: string, en: string) =>
  ({ ...aIncident(fila), ...RespuestaEscritura.parse({ ok: true, resultado, en }) });

incidents.get('/orgs/:org/incidents', async (c) => {
  const status = c.req.query('status');
  let consulta = db(c.env).from('incidents').select(COLUMNAS_INCIDENTE).eq('org_id', c.get('orgId'));
  if (status === undefined || status === '') {
    consulta = consulta.gte('last_event_at', new Date(Date.now() - VENTANA_LISTA_MS).toISOString());
  } else if (status === 'open') {
    consulta = consulta.in('status', ABIERTOS);
  } else {
    const s = IncidentStatus.safeParse(status);
    if (!s.success) throw new ApiError('invalid_body', 'Filtro no válido', { field_errors: { status: ['Valor no válido'] } });
    consulta = consulta.eq('status', s.data);
  }
  const { data, error } = await consulta.order('started_at', { ascending: false }).limit(MAX_LISTA);
  if (error) {
    log('error', 'incidentes.lista_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer los incidentes');
  }
  return c.json((data ?? []).map((f) => aIncident(f)));
});

incidents.get('/orgs/:org/incidents/:id', async (c) => {
  const id = idDe(c.req.param('id'));
  const orgId = c.get('orgId');
  const admin = db(c.env);
  // Cuatro lecturas en paralelo, todas por incident_id Y org_id: sin la del incidente, las otras salen vacías.
  const [inc, n, a, p] = await Promise.all([
    admin.from('incidents').select(COLUMNAS_INCIDENTE).eq('id', id).eq('org_id', orgId).maybeSingle(),
    admin.from('notifications').select(COLUMNAS_NOTIFICACION).eq('incident_id', id).eq('org_id', orgId)
      .in('channel', ['in_app', 'whatsapp', 'voice']).order('created_at').limit(50),
    admin.from('actions').select(COLUMNAS_ACCION).eq('incident_id', id).eq('org_id', orgId).order('created_at').limit(20),
    admin.from('approvals').select('created_at').eq('incident_id', id).eq('org_id', orgId).eq('channel', 'in_app')
      .order('created_at').limit(1),
  ]);
  const error = inc.error ?? n.error ?? a.error ?? p.error;
  if (error) {
    log('error', 'incidente.detalle_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer el incidente');
  }
  if (!inc.data) throw new ApiError('not_found', 'Incidente no encontrado');
  const incidente = aIncident(inc.data);
  const notifications = ((n.data ?? []) as Fila[]).map((x) => NotificationPublic.parse({ ...x, created_at: iso(String(x.created_at)),
    sent_at: t(x.sent_at), delivered_at: t(x.delivered_at), read_at: t(x.read_at) }));
  const actions = ((a.data ?? []) as Fila[]).map((x) => ActionPublic.parse({ ...x, created_at: iso(String(x.created_at)),
    undone_at: t(x.undone_at), expires_at: t(x.expires_at) }));
  const propuesta = t(((p.data ?? []) as Fila[])[0]?.created_at);
  return c.json(IncidentDetail.parse({ ...incidente, notifications, actions,
    timeline: armarTimeline(incidente, notifications, actions, propuesta) }));
});

// «Lo estoy viendo» desde la app. open → ack. ack: idempotente. mitigated sin ack previo: se anota acked_at sin
// retroceder el estado (el cronómetro de §12.10 lo usa). resolved → 409. Sin cuerpo (el FRONT manda {}).
incidents.post('/orgs/:org/incidents/:id/ack', requireAdmin, async (c) => {
  const id = idDe(c.req.param('id'));
  let fila = await leer(c, id);
  if (fila.status === 'resolved') throw resuelto();
  const en = new Date().toISOString();
  const cambio = fila.status === 'open' ? { status: 'ack', acked_at: en, acked_via: 'in_app' }
    : !fila.acked_at ? { acked_at: en, acked_via: 'in_app' } : null;
  if (cambio) {
    const nueva = await actualizar(c, id, cambio, [String(fila.status)]);
    fila = nueva ?? await leer(c, id);
    if (fila.status === 'resolved') throw resuelto();
  }
  log('info', 'incidente.ack', { rid: c.get('rid'), user: c.get('userId'), incidente: fila.code, cambio: cambio !== null });
  return c.json(respuesta(fila, 'Lo estás viendo', en));
});

// Silencia los avisos externos {minutes} 15–1440 (60 si no llega cuerpo) sin cambiar el estado; details.muted_at es el
// hito «muted» de la línea de tiempo (vg_upsert_incident lo conserva). resolved → 409.
incidents.post('/orgs/:org/incidents/:id/mute', requireAdmin, async (c) => {
  const id = idDe(c.req.param('id'));
  const texto = await c.req.text();
  let raw: unknown = {};
  if (texto.trim()) {
    try { raw = JSON.parse(texto); } catch { throw new ApiError('invalid_body', 'El cuerpo de la petición no es JSON válido'); }
  }
  const b = MuteBody.safeParse(raw);
  if (!b.success) throw new ApiError('invalid_body', 'Revisa los campos marcados', { field_errors: z.flattenError(b.error).fieldErrors });
  const actual = await leer(c, id);
  if (actual.status === 'resolved') throw resuelto();
  const ahora = Date.now();
  const en = new Date(ahora).toISOString();
  const details = { ...((actual.details && typeof actual.details === 'object' ? actual.details : {}) as Fila), muted_at: en };
  const fila = await actualizar(c, id, { muted_until: new Date(ahora + b.data.minutes * 60_000).toISOString(), details }, NO_RESUELTOS);
  if (!fila) throw resuelto();            // se resolvió entre la lectura y el update
  log('info', 'incidente.mute', { rid: c.get('rid'), user: c.get('userId'), incidente: fila.code, minutos: b.data.minutes });
  return c.json(respuesta(fila, `Silenciado ${b.data.minutes >= 60 && b.data.minutes % 60 === 0 ? `${b.data.minutes / 60} h` : `${b.data.minutes} min`}`, en));
});
