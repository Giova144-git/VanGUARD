import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { IngestAccepted, IngestBatch, type EdgeEvent } from '@vanguard/contracts';
import { parseIp, textoIp } from '@vanguard/core';
import { evaluarEnVivo } from '../engine/evaluar.ts';
import type { AppEnv } from '../env.ts';
import { ingestKey } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ApiError, fail } from '../lib/errors.ts';
import { hexABytes } from '../lib/hmac.ts';
import { log } from '../lib/log.ts';

// E30 · POST /ingest/v1/events · hmac · P0 (S15 15.4, PLAN_MAESTRO 02.5.2). Orden: cuerpo ≤ 64 KB (bodyLimit de app.ts
// y aquí sobre el crudo) → |ahora − x-vg-ts| ≤ 300 s → conexión 'ingest' activa leída por id → ingestKey() → HMAC en
// tiempo constante sobre `${ts}.${cuerpo}` → JSON + IngestBatch (422 solo tras autenticar). Todo fallo de autenticación
// → 401 sin detalle ni causa. Sin sesión, originGuard ni RL_API (la víctima manda ~20 rps); RL_INGEST por conexión (P1).
export const ingest = new Hono<AppEnv>();

export const MAX_CUERPO = 64 * 1024;
const VENTANA_S = 300;
const RETENCION_MS = 24 * 3600_000;                      // edge_hits vive 24 h (0008)
const INT4_MAX = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const enc = new TextEncoder();

type Conexion = { id: string; org_id: string };
type Motivo = 'cabeceras' | 'ventana' | 'conexion' | 'clave' | 'firma';

export const demasiadoGrande = (c: Context<AppEnv>) =>
  fail(c, 'invalid_body', 'El lote pasa de 64 KB: envía menos eventos por petición', undefined, 413);

// Devuelve la conexión si la firma es buena, o el motivo del rechazo (solo para el log: la respuesta no lo distingue).
async function autenticar(c: Context<AppEnv>, crudo: Uint8Array<ArrayBuffer>): Promise<Conexion | Motivo> {
  const ts = (c.req.header('x-vg-ts') ?? '').trim();
  const conn = (c.req.header('x-vg-conn') ?? '').trim().toLowerCase();
  const firma = hexABytes((c.req.header('x-vg-sig') ?? '').trim(), 32);
  if (!/^\d{1,12}$/.test(ts) || !UUID.test(conn) || !firma) return 'cabeceras';
  if (Math.abs(Date.now() / 1000 - Number(ts)) > VENTANA_S) return 'ventana';

  const admin = db(c.env);
  const { data, error } = await admin.from('connections').select('id, org_id')
    .eq('id', conn).eq('provider', 'ingest').eq('status', 'active').maybeSingle();
  if (error) {
    log('error', 'ingest.conexion_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos comprobar la conexión');
  }
  const fila = data as Conexion | null;
  if (!fila) return 'conexion';
  let key: CryptoKey;
  try {
    // org e id salen de la fila (entran en el AAD del secreto), nunca de la cabecera ni del cuerpo.
    key = await ingestKey(c.env, admin, { orgId: fila.org_id, connectionId: fila.id, provider: 'ingest', kind: 'read' });
  } catch (e) {
    log('warn', 'ingest.clave_error', { rid: c.get('rid'), name: e instanceof Error ? e.name : typeof e });
    return 'clave';
  }
  // Bytes exactos de `${ts}.` + cuerpo crudo: lo mismo que encode(ts + '.' + cuerpo) sin pasar por una decodificación.
  const prefijo = enc.encode(`${ts}.`);
  const firmado = new Uint8Array(prefijo.length + crudo.length);
  firmado.set(prefijo);
  firmado.set(crudo, prefijo.length);
  return (await crypto.subtle.verify('HMAC', key, firma, firmado)) ? fila : 'firma';
}

// EdgeEvent → columnas reales de edge_hits (0006). Es UNA inserción: lo que Postgres rechace (ip no inet, «?» en path,
// int4 desbordado, \u0000 o un surrogate suelto en text —22P02, p. ej. un UA recortado con slice a mitad de un emoji—)
// tumbaría el lote entero, así que se normaliza aquí. Se descarta el evento con IP ilegible y el de fecha fuera de
// [ahora − 24 h, ahora + 300 s]: uno futuro contaría para siempre en la ventana de 60 s.
const sinNulos = (s: string) =>
  s.replace(/\u0000/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
export function aFila(e: EdgeEvent, cx: Conexion, ahora = Date.now()) {
  const ip = parseIp(e.ip.trim());
  const t = Date.parse(e.ts);
  if (!ip || !(t >= ahora - RETENCION_MS && t <= ahora + VENTANA_S * 1000)) return null;
  return { org_id: cx.org_id, connection_id: cx.id, ts: new Date(t).toISOString(), ip: textoIp(ip), method: sinNulos(e.method),
    path: sinNulos(e.path.split('?')[0] ?? ''), status: e.status, ua: sinNulos(e.ua), latency_ms: Math.min(e.latency_ms, INT4_MAX),
    auth: e.auth };
}

// waitUntil del Worker (y del doble de dev-node.ts); sin ExecutionContext, c.executionCtx lanza y se espera aquí.
function enSegundoPlano(c: Context<AppEnv>, p: Promise<unknown>): Promise<unknown> | undefined {
  try {
    c.executionCtx.waitUntil(p);
    return undefined;
  } catch {
    return p;
  }
}

ingest.post('/v1/events', async (c) => {
  const rid = c.get('rid');
  const crudo = new Uint8Array(await c.req.arrayBuffer());
  if (crudo.length > MAX_CUERPO) return demasiadoGrande(c);
  const cx = await autenticar(c, crudo);
  if (typeof cx === 'string') {
    log('warn', 'ingest.rechazado', { rid, motivo: cx });
    return fail(c, 'unauthorized', 'No autorizado');
  }

  // RL_INGEST (S15 15.3, P1): 300 por 10 s y conexión, solo tras autenticar (sin firma nadie gasta el cupo ajeno).
  const { success } = await c.env.RL_INGEST.limit({ key: `c:${cx.id}` });
  if (!success) {
    c.header('Retry-After', '10');
    return fail(c, 'rate_limited', 'Demasiados lotes seguidos. Espera unos segundos.');
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(crudo));
  } catch {
    return fail(c, 'invalid_body', 'El cuerpo no es JSON válido');
  }
  const lote = IngestBatch.safeParse(json);
  if (!lote.success) {
    return fail(c, 'invalid_body', 'Revisa los campos marcados', { field_errors: z.flattenError(lote.error).fieldErrors });
  }

  const ahora = Date.now();
  const filas = lote.data.events.map((e) => aFila(e, cx, ahora)).filter((f) => f !== null);
  if (filas.length > 0) {
    const { error } = await db(c.env).from('edge_hits').insert(filas);
    if (error) {
      log('error', 'ingest.insert_error', { rid, code: error.code, n: filas.length });
      return fail(c, 'internal', 'No pudimos guardar el lote');
    }
    const evaluacion = evaluarEnVivo(c.env, { orgId: cx.org_id, connectionId: cx.id, rid }).catch((e: unknown) => {
      log('error', 'ingest.evaluacion_error', { rid, name: e instanceof Error ? e.name : typeof e });
    });
    await enSegundoPlano(c, evaluacion);
  }
  log('info', 'ingest.lote', { rid, n: filas.length, descartados: lote.data.events.length - filas.length });
  return c.json(IngestAccepted.parse({ accepted: filas.length }), 202);
});
