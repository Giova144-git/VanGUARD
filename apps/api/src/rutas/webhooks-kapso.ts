import { Hono, type Context } from 'hono';
import { redact } from '@vanguard/core';
import { canjearBotonAlerta, parsearBoton } from '../actions/approvals.ts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { fail } from '../lib/errors.ts';
import { sha256Hex, verificarHmacHex } from '../lib/hmac.ts';
import { log } from '../lib/log.ts';
import { enmascararTelefono } from '../notify/kapso.ts';

// E31 · POST /webhooks/kapso · firma de Kapso · P0 (S15 15.4 y 15.10). Orden: cuerpo crudo → HMAC en tiempo constante
// ANTES de parsear (firma mala o sin secreto → 401 sin efecto) → dedupe por X-Idempotency-Key en webhook_events →
// 200 inmediato (Kapso exige 200 en ≤ 10 s) y el proceso sigue en waitUntil.
export const webhooksKapso = new Hono<AppEnv>();

type Obj = Record<string, unknown>;
type Estado = 'sent' | 'delivered' | 'read' | 'failed';

const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const lista = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

const ESTADO_DE_EVENTO: Record<string, Estado> = {
  'whatsapp.message.sent': 'sent',
  'whatsapp.message.delivered': 'delivered',
  'whatsapp.message.read': 'read',
  'whatsapp.message.failed': 'failed',
};
// Estados desde los que se puede pasar a cada uno: un delivered que llega después del read no lo deshace.
const DESDE: Record<Estado, string[]> = {
  sent: ['queued'],
  delivered: ['queued', 'sent'],
  read: ['queued', 'sent', 'delivered'],
  failed: ['queued', 'sent', 'delivered'],
};
const CLAVE_VALIDA = /^[\x21-\x7e]{1,200}$/;   // cabe en webhook_events.external_id (≤ 200)
const MAX_ITEMS = 100;

// Con buffering (que va apagado) Kapso manda {data:[…]}; sin él, un evento por petición.
export function itemsDe(payload: unknown): Obj[] {
  const p = obj(payload);
  return (Array.isArray(p.data) ? p.data : [p]).slice(0, MAX_ITEMS).map(obj);
}

// id del botón: interactivo (message.interactive.button_reply.id) o botón de plantilla (message.button.payload).
export const idBoton = (m: Obj): string | null =>
  str(obj(obj(m.interactive).button_reply).id) ?? str(obj(m.button).payload);

// Código corto del error de entrega: message.kapso.statuses[].errors[].code (131047 = ventana de 24 h cerrada); de
// respaldo message.errors[].code. Solo [A-Za-z0-9_.-], nunca el mensaje del proveedor.
export function codigoError(m: Obj): string | null {
  const errores = [...lista(obj(m.kapso).statuses).flatMap((s) => lista(obj(s).errors)), ...lista(m.errors)];
  for (const e of errores.reverse()) {
    const code = obj(e).code;
    const s = typeof code === 'number' || typeof code === 'string' ? String(code) : '';
    if (/^[A-Za-z0-9_.-]{1,40}$/.test(s)) return s;
  }
  return null;
}

// Hora del estado según Kapso (epoch en segundos, como string) si es creíble; si no, la de recepción.
function instante(m: Obj, estado: Estado, ahora: number): string {
  const s = lista(obj(m.kapso).statuses).map(obj).find((x) => x.status === estado);
  const t = Number(s?.timestamp ?? NaN) * 1000;
  return Number.isFinite(t) && Math.abs(ahora - t) < 7 * 864e5 ? new Date(t).toISOString() : new Date(ahora).toISOString();
}

// Lo que se guarda en webhook_events.payload_redacted: una proyección mínima pasada por redact(), sin teléfonos, sin
// textos libres ni nonces (el payload crudo trae `conversation.phone_number`, que redact() no reconoce por clave).
export function resumenKapso(evento: string | null, payload: unknown) {
  return redact({
    event: evento,
    items: itemsDe(payload).slice(0, 20).map((it) => {
      const m = obj(it.message);
      const boton = idBoton(m);
      return { message_id: str(m.id), type: str(m.type), status: str(obj(m.kapso).status), error_code: codigoError(m),
        button: boton ? parsearBoton(boton)?.accion ?? 'desconocido' : null };
    }),
  });
}

async function actualizarEstado(env: CloudflareBindings, m: Obj, estado: Estado, rid: string) {
  const pid = str(m.id);
  if (!pid || pid.length > 120) return;
  const t = instante(m, estado, Date.now());
  const error = estado === 'failed' ? codigoError(m) ?? 'failed' : null;
  const cambio = estado === 'sent' ? { status: 'sent', sent_at: t }
    : estado === 'delivered' ? { status: 'delivered', delivered_at: t }
    : estado === 'read' ? { status: 'read', read_at: t }
    : { status: 'failed', error };
  // Sin org_id a propósito: el webhook no tiene org; el wamid de Kapso identifica la fila por sí solo.
  const { data, error: e } = await db(env).from('notifications').update(cambio)
    .eq('provider_id', pid).eq('channel', 'whatsapp').in('status', DESDE[estado]).select('id');
  if (e) {
    log('error', 'kapso.estado_error', { rid, estado, code: e.code });
    return;
  }
  log('info', 'kapso.estado', { rid, estado, filas: Array.isArray(data) ? data.length : 0, ...(error ? { error_code: error } : {}) });
}

async function registrarBoton(env: CloudflareBindings, m: Obj, conversacion: Obj, rid: string) {
  const id = idBoton(m);
  if (!id) {
    log('debug', 'kapso.texto_ignorado', { rid, type: str(m.type) });   // P1: «VERIFICAR <código>» (§06.9)
    return;
  }
  const b = parsearBoton(id);
  const remitente = (str(m.from) ?? str(conversacion.phone_number) ?? '').replace(/\D/g, '');
  const enmascarado = remitente.length >= 8 ? enmascararTelefono(remitente) : null;
  log('info', 'kapso.boton', { rid, accion: b?.accion ?? 'desconocido', codigo: b?.codigo ?? null, remitente: enmascarado });
  // ack/snz: canje del nonce y efecto sobre el incidente (§15.10). ok/no/blk solo se registran hasta el hito siguiente.
  // Un canje sin efecto (repetido, vencido, de otra org, remitente que no es contacto) queda solo en el log.
  if (b?.accion !== 'ack' && b?.accion !== 'snz') return;
  const resultado = await canjearBotonAlerta(env, b, remitente, rid);
  log(resultado === 'aplicado' ? 'info' : 'warn', 'kapso.boton_canje',
    { rid, accion: b.accion, codigo: b.codigo, resultado, remitente: enmascarado });
}

// Proceso de un webhook ya verificado y deduplicado. Nunca lanza: corre en waitUntil.
export async function procesarKapso(env: CloudflareBindings, evento: string | null, payload: unknown, rid: string) {
  for (const it of itemsDe(payload)) {
    try {
      const m = obj(it.message);
      if (evento === 'whatsapp.message.received') {
        await registrarBoton(env, m, obj(it.conversation), rid);
        continue;
      }
      const estado = evento ? ESTADO_DE_EVENTO[evento] : ESTADO_DE_EVENTO[`whatsapp.message.${String(obj(m.kapso).status)}`];
      if (estado) await actualizarEstado(env, m, estado, rid);
      else log('debug', 'kapso.evento_ignorado', { rid, evento });
    } catch (e) {
      log('error', 'kapso.proceso_error', { rid, name: e instanceof Error ? e.name : typeof e });
    }
  }
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

webhooksKapso.post('/kapso', async (c) => {
  const rid = c.get('rid');
  const crudo = await c.req.arrayBuffer();
  if (!(await verificarHmacHex(c.env.KAPSO_WEBHOOK_SECRET, crudo, c.req.header('x-webhook-signature')))) {
    log('warn', 'kapso.firma_rechazada', { rid, con_secreto: !!c.env.KAPSO_WEBHOOK_SECRET });
    return fail(c, 'unauthorized', 'Firma no válida');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(crudo));
  } catch {
    return fail(c, 'invalid_body', 'El cuerpo no es JSON válido');
  }
  const evento = (c.req.header('x-webhook-event') ?? '').trim().slice(0, 80) || null;
  const cabecera = (c.req.header('x-idempotency-key') ?? '').trim();
  const clave = CLAVE_VALIDA.test(cabecera) ? cabecera : `sha256:${await sha256Hex(crudo)}`;

  const { error } = await db(c.env).from('webhook_events')
    .insert({ provider: 'kapso', external_id: clave, payload_redacted: resumenKapso(evento, payload) });
  if (error?.code === '23505') {
    log('info', 'kapso.duplicado', { rid, evento });
    return c.json({ ok: true });
  }
  if (error) {
    // 500: Kapso reintenta a los 10 s y a los 40 s; sin la fila de dedupe no se procesa nada.
    log('error', 'kapso.dedupe_error', { rid, code: error.code });
    return fail(c, 'internal', 'No pudimos registrar el evento');
  }
  await enSegundoPlano(c, procesarKapso(c.env, evento, payload, rid));
  return c.json({ ok: true });
});
