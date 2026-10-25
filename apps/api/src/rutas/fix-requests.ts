import { Hono } from 'hono';
import { FIX_REQUEST_ABIERTA, FixRequest, FixRequestCreate, Id } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';

// «Enviar a mi IA» (cola fix_requests, 0023_fix_requests.sql):
// E58 · POST   /api/orgs/:org/findings/:id/fix-requests · admin → crea la petición «enviado» (idempotente: si ya hay una
//               abierta, 200 con esa; nueva, 201). Solo para un hallazgo abierto (otro estado → 409).
// E58 · DELETE /api/orgs/:org/findings/:id/fix-requests · admin → cancela la abierta (204 aunque no hubiera ninguna).
// E58b · GET   /api/orgs/:org/fix-requests · miembro → las abiertas y las cerradas de los últimos 7 días, una por
//               hallazgo (la web pinta el distintivo de la fila y del detalle).
// Viewer y anónimo (la demo) → 403 en las escrituras (requireAdmin). «arreglando» lo pone el MCP al pedir la corrección
// (mcp/vanguard.ts) y «corregido» la base cuando el hallazgo deja de estar abierto (trigger vg_fix_request_cierre).
export const fixRequests = new Hono<AppEnv>();

export const COLUMNAS_FIX_REQUEST = 'id, finding_id, status, client, created_at, started_at, closed_at';
const VENTANA_CERRADAS_MS = 7 * 86_400_000;
const ABIERTA = [...FIX_REQUEST_ABIERTA];

const t = (x: unknown) => (typeof x === 'string' ? iso(x) : null);
export const aFixRequest = (f: Record<string, unknown>) => FixRequest.parse({ ...f, created_at: iso(String(f.created_at)),
  started_at: t(f.started_at), closed_at: t(f.closed_at) });

const idDe = (raw: string | undefined) => {
  const r = Id.safeParse(raw);
  if (!r.success) throw new ApiError('not_found', 'Hallazgo no encontrado');
  return r.data;
};

fixRequests.get('/orgs/:org/fix-requests', async (c) => {
  const admin = db(c.env);
  const orgId = c.get('orgId');
  // Las abiertas no caducan (un «enviado» de hace un mes sigue en la cola); las cerradas, solo las de los últimos 7 días.
  const [abiertas, cerradas] = await Promise.all([
    admin.from('fix_requests').select(COLUMNAS_FIX_REQUEST).eq('org_id', orgId).in('status', ABIERTA)
      .order('created_at', { ascending: false }).limit(200),
    admin.from('fix_requests').select(COLUMNAS_FIX_REQUEST).eq('org_id', orgId).in('status', ['corregido', 'cancelado'])
      .gte('closed_at', new Date(Date.now() - VENTANA_CERRADAS_MS).toISOString()).order('closed_at', { ascending: false }).limit(200),
  ]);
  const error = abiertas.error ?? cerradas.error;
  if (error) {
    log('error', 'fix_requests.lista_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos leer la cola de tu IA');
  }
  // Una por hallazgo: la abierta y, si no hay, la cerrada más reciente.
  const vistas = new Set<string>();
  const filas = [...(abiertas.data ?? []), ...(cerradas.data ?? [])] as Record<string, unknown>[];
  return c.json(filas.filter((f) => !vistas.has(String(f.finding_id)) && !!vistas.add(String(f.finding_id))).map(aFixRequest));
});

fixRequests.post('/orgs/:org/findings/:id/fix-requests', requireAdmin, async (c) => {
  const id = idDe(c.req.param('id'));
  let client: FixRequest['client'] = null;
  const texto = await c.req.text();
  if (texto.trim()) {
    let raw: unknown;
    try { raw = JSON.parse(texto); } catch { throw new ApiError('invalid_body', 'El cuerpo de la petición no es JSON válido'); }
    const b = FixRequestCreate.safeParse(raw);
    if (!b.success) throw new ApiError('invalid_body', 'Revisa los campos marcados', { field_errors: { client: ['Cliente no válido'] } });
    client = b.data.client ?? null;
  }
  const admin = db(c.env);
  const orgId = c.get('orgId');
  const { data: f, error: ef } = await admin.from('findings').select('id, status').eq('id', id).eq('org_id', orgId).maybeSingle();
  if (ef) throw new ApiError('internal', 'No pudimos leer el hallazgo');
  if (!f) throw new ApiError('not_found', 'Hallazgo no encontrado');
  if (f.status !== 'open') throw new ApiError('conflict', 'Este hallazgo ya no está abierto: no hay nada que mandar a tu IA', { reason: 'no_abierto' });

  const abierta = async () => {
    const { data, error } = await admin.from('fix_requests').select(COLUMNAS_FIX_REQUEST).eq('org_id', orgId).eq('finding_id', id)
      .in('status', ABIERTA).maybeSingle();
    if (error) throw new ApiError('internal', 'No pudimos leer la cola de tu IA');
    return data as Record<string, unknown> | null;
  };
  const ya = await abierta();
  if (ya) return c.json(aFixRequest(ya), 200);
  const { data, error } = await admin.from('fix_requests')
    .insert({ org_id: orgId, finding_id: id, requested_by: c.get('userId'), client }).select(COLUMNAS_FIX_REQUEST).single();
  if (error?.code === '23505') {                                          // doble clic en paralelo: gana la otra
    const otra = await abierta();
    if (otra) return c.json(aFixRequest(otra), 200);
  }
  if (error || !data) {
    log('error', 'fix_requests.alta_error', { rid: c.get('rid'), code: error?.code ?? null });
    throw new ApiError('internal', 'No pudimos mandar el hallazgo a tu IA');
  }
  log('info', 'fix_request.enviado', { rid: c.get('rid'), user: c.get('userId'), client });
  return c.json(aFixRequest(data as Record<string, unknown>), 201);
});

fixRequests.delete('/orgs/:org/findings/:id/fix-requests', requireAdmin, async (c) => {
  const id = idDe(c.req.param('id'));
  const { error } = await db(c.env).from('fix_requests').update({ status: 'cancelado', closed_at: new Date().toISOString() })
    .eq('org_id', c.get('orgId')).eq('finding_id', id).in('status', ABIERTA);
  if (error) {
    log('error', 'fix_requests.cancelar_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos cancelar el envío');
  }
  log('info', 'fix_request.cancelado', { rid: c.get('rid'), user: c.get('userId') });
  return c.body(null, 204);
});
