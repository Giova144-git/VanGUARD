import { Hono } from 'hono';
import {
  eventosDeFalla, FindingHistoryItem, FindingStatus, FindingTimeline, FixRequest, Id, Module, Severity, type FotosFalla,
} from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { aFixRequest, COLUMNAS_FIX_REQUEST } from './fix-requests.ts';

// Historial de fallas (0025_historial_hallazgos.sql). Lectura para cualquier miembro (también el anónimo de la demo):
// lo mismo que ya ve en Hallazgos, sin evidencia ni prompt.
// E13h · GET /api/orgs/:org/findings/history?status=&module=&severity=&days=&order=&limit= → FindingHistoryItem[]:
//        todas las fallas (abiertas o no) del último cambio de estado al más viejo (order=asc, al revés). days 1–365
//        filtra por ese último cambio; limit 1–500 (200 por defecto).
// E13t · GET /api/orgs/:org/findings/:id/timeline → FindingTimeline: la fila, su cola «Enviar a mi IA» entera (no solo
//        los 7 días de E58b) y las fotos de audit_snapshots que la nombran (reapariciones y ciclos anteriores).
// Se monta ANTES de findings: si no, /findings/history caería en E13b (/findings/:id) y daría 404.
export const historial = new Hono<AppEnv>();

export const COLUMNAS_HISTORIAL = 'id, module, rule_id, severity, title, resource, status, status_reason, connection_id, '
  + 'first_seen_at, last_seen_at, fixed_at, verified_at, ignored_at, reopened_at, reopen_count, status_changed_at';
const MAX_FOTOS = 60;

/** Fila → FindingHistoryItem: horas con Z y status_changed_at como changed_at. */
export function aHistorial(fila: unknown): FindingHistoryItem {
  const f = fila as Record<string, unknown>;
  const t = (x: unknown) => (typeof x === 'string' ? iso(x) : null);
  const { status_changed_at: cambio, ...resto } = f;
  return FindingHistoryItem.parse({ ...resto, first_seen_at: iso(String(f.first_seen_at)), last_seen_at: iso(String(f.last_seen_at)),
    fixed_at: t(f.fixed_at), verified_at: t(f.verified_at), ignored_at: t(f.ignored_at), reopened_at: t(f.reopened_at),
    reopen_count: Number(f.reopen_count ?? 0), changed_at: iso(String(cambio ?? f.first_seen_at)) });
}

const entero = (v: string | undefined, campo: string, min: number, max: number) => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!/^\d{1,4}$/.test(v) || n < min || n > max) {
    throw new ApiError('invalid_body', 'Filtro no válido', { field_errors: { [campo]: [`Entre ${min} y ${max}`] } });
  }
  return n;
};
const filtro = <T>(s: { safeParse: (x: unknown) => { success: boolean; data?: T } }, v: string | undefined, campo: string) => {
  if (v === undefined || v === '') return undefined;
  const r = s.safeParse(v);
  if (!r.success) throw new ApiError('invalid_body', 'Filtro no válido', { field_errors: { [campo]: ['Valor no válido'] } });
  return r.data as T;
};

historial.get('/orgs/:org/findings/history', async (c) => {
  const q = c.req.query();
  const status = filtro(FindingStatus, q.status, 'status');
  const module = filtro(Module, q.module, 'module');
  const severity = filtro(Severity, q.severity, 'severity');
  const days = entero(q.days, 'days', 1, 365);
  const limit = entero(q.limit, 'limit', 1, 500) ?? 200;
  if (q.order !== undefined && q.order !== '' && q.order !== 'asc' && q.order !== 'desc') {
    throw new ApiError('invalid_body', 'Filtro no válido', { field_errors: { order: ['asc o desc'] } });
  }
  const asc = q.order === 'asc';
  let consulta = db(c.env).from('findings').select(COLUMNAS_HISTORIAL).eq('org_id', c.get('orgId'));
  if (status) consulta = consulta.eq('status', status);
  if (module) consulta = consulta.eq('module', module);
  if (severity) consulta = consulta.eq('severity', severity);
  if (days) consulta = consulta.gte('status_changed_at', new Date(Date.now() - days * 86_400_000).toISOString());
  const { data, error } = await consulta.order('status_changed_at', { ascending: asc }).order('id', { ascending: true }).limit(limit);
  if (error) {
    log('error', 'historial.lista_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer el historial de fallas');
  }
  return c.json((data ?? []).map(aHistorial));
});

historial.get('/orgs/:org/findings/:id/timeline', async (c) => {
  const id = Id.safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError('not_found', 'Hallazgo no encontrado');
  const admin = db(c.env);
  const orgId = c.get('orgId');
  const { data: f, error } = await admin.from('findings').select(COLUMNAS_HISTORIAL).eq('id', id.data).eq('org_id', orgId).maybeSingle();
  if (error) {
    log('error', 'historial.falla_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer el historial de esta falla');
  }
  if (!f) throw new ApiError('not_found', 'Hallazgo no encontrado');
  // La cola y las fotos completan la línea; si fallan, sale la línea con lo de la fila (y queda en el log).
  const [envios, nuevas, salidas] = await Promise.all([
    admin.from('fix_requests').select(COLUMNAS_FIX_REQUEST).eq('org_id', orgId).eq('finding_id', id.data)
      .order('created_at', { ascending: true }).limit(20),
    admin.from('audit_snapshots').select('taken_at').eq('org_id', orgId).contains('new_ids', [id.data])
      .order('taken_at', { ascending: true }).limit(MAX_FOTOS),
    admin.from('audit_snapshots').select('taken_at').eq('org_id', orgId).contains('fixed_ids', [id.data])
      .order('taken_at', { ascending: true }).limit(MAX_FOTOS),
  ]);
  for (const [k, r] of [['envios', envios], ['fotos_nuevo', nuevas], ['fotos_corregido', salidas]] as const) {
    if (r.error) log('warn', 'historial.parcial', { rid: c.get('rid'), parte: k, code: r.error.code ?? null });
  }
  const horas = (r: { data: unknown }) => ((r.data ?? []) as { taken_at?: unknown }[])
    .flatMap((x) => (typeof x.taken_at === 'string' ? [iso(x.taken_at)] : []));
  const item = aHistorial(f);
  const cola: FixRequest[] = envios.error ? [] : ((envios.data ?? []) as Record<string, unknown>[]).map(aFixRequest);
  const fotos: FotosFalla = { nuevo: nuevas.error ? [] : horas(nuevas), corregido: salidas.error ? [] : horas(salidas) };
  return c.json(FindingTimeline.parse({ item, events: eventosDeFalla(item, cola, fotos) }));
});
