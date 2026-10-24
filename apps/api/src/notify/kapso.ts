import type { ProviderErrorCode } from '@vanguard/contracts';
import { codigoHttp, pedir, ProviderError } from '../lib/http.ts';

// Cliente de envío de Kapso (S12 12.6, S15 15.10): proxy de la Cloud API de Meta con X-API-Key. En el sandbox no hay
// plantillas de Meta: solo texto e interactivos con botones. Los cuerpos se arman con funciones puras (probadas).
export const KAPSO_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';
export const PLAZO_KAPSO_MS = 8_000;

// Límites de Meta (R14 §1.3): máx. 3 botones, body ≤ 1024, title ≤ 20, reply.id ≤ 256; texto simple ≤ 4096.
const MAX_TEXTO = 4096;
const MAX_BODY = 1024;
const MAX_HEADER = 60;
const MAX_FOOTER = 60;
const MAX_TITULO = 20;
const MAX_ID_BOTON = 256;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const ID_NUMERO = /^[A-Za-z0-9_-]{1,64}$/;
const ID_MENSAJE = /^[A-Za-z0-9._:=+/-]{1,120}$/;   // wamid…; cabe en notifications.provider_id (≤ 120)

export type BotonKapso = { id: string; title: string };
export type MensajeTexto = { messaging_product: 'whatsapp'; to: string; type: 'text'; text: { body: string } };
export type MensajeInteractivo = {
  messaging_product: 'whatsapp'; to: string; type: 'interactive';
  interactive: {
    type: 'button';
    header?: { type: 'text'; text: string };
    body: { text: string };
    footer?: { text: string };
    action: { buttons: { type: 'reply'; reply: BotonKapso }[] };
  };
};
export type MensajeKapso = MensajeTexto | MensajeInteractivo;

// Un ProviderError que además lleva el código corto del proveedor (131047…) o uno nuestro ('sin_config'), nunca su
// mensaje: es lo que va a notifications.error y a details.provider_code de E27.
export class KapsoError extends ProviderError {
  readonly detalle: string | null;

  constructor(code: ProviderErrorCode, status?: number, detalle: string | null = null) {
    super(code, status);
    this.detalle = detalle;
  }
}

// `to` = E.164 sin '+' (como llega el `from` del webhook).
export function aDestino(e164: string): string {
  if (!E164.test(e164)) throw new RangeError('KAPSO_DESTINO');
  return e164.slice(1);
}

// +584141234567 → +58•••4567: casa el check de notifications.recipient_masked y es lo único que va a los logs.
export function enmascararTelefono(tel: string): string {
  const d = tel.replace(/\D/g, '');
  return '+' + d.slice(0, 2) + '•••' + d.slice(-4);
}

const recortar = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

export function cuerpoTexto(e164: string, texto: string): MensajeTexto {
  const body = recortar(texto.trim(), MAX_TEXTO);
  if (!body) throw new RangeError('KAPSO_TEXTO_VACIO');
  return { messaging_product: 'whatsapp', to: aDestino(e164), type: 'text', text: { body } };
}

export type OpcionesInteractivo = { header?: string; body: string; footer?: string; botones: BotonKapso[] };

// Interactivo con 1–3 botones de respuesta. Un id de botón no se recorta (rompería el canje): si no cabe, lanza.
export function cuerpoInteractivo(e164: string, o: OpcionesInteractivo): MensajeInteractivo {
  if (o.botones.length < 1 || o.botones.length > 3) throw new RangeError('KAPSO_BOTONES');
  if (new Set(o.botones.map((b) => b.id)).size !== o.botones.length) throw new RangeError('KAPSO_BOTON_REPETIDO');
  const body = recortar(o.body.trim(), MAX_BODY);
  if (!body) throw new RangeError('KAPSO_TEXTO_VACIO');
  const buttons = o.botones.map((b) => {
    if (!b.id || b.id.length > MAX_ID_BOTON) throw new RangeError('KAPSO_ID_BOTON');
    const title = b.title.trim();
    if (!title || title.length > MAX_TITULO) throw new RangeError('KAPSO_TITULO_BOTON');
    return { type: 'reply' as const, reply: { id: b.id, title } };
  });
  const header = o.header?.trim();
  const footer = o.footer?.trim();
  return {
    messaging_product: 'whatsapp', to: aDestino(e164), type: 'interactive',
    interactive: {
      type: 'button',
      ...(header ? { header: { type: 'text' as const, text: recortar(header, MAX_HEADER) } } : {}),
      body: { text: body },
      ...(footer ? { footer: { text: recortar(footer, MAX_FOOTER) } } : {}),
      action: { buttons },
    },
  };
}

// provider_id = messages[0].id de la respuesta (forma de Meta, R14 §1.3).
export function idMensaje(texto: string): string | null {
  try {
    const id = (JSON.parse(texto) as { messages?: { id?: unknown }[] })?.messages?.[0]?.id;
    return typeof id === 'string' && ID_MENSAJE.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Solo el código numérico de Meta (error.code, p. ej. 131047 o 131030); el mensaje nunca se lee.
export function codigoMeta(texto: string): string | null {
  try {
    const code = (JSON.parse(texto) as { error?: { code?: unknown } })?.error?.code;
    const s = typeof code === 'number' || typeof code === 'string' ? String(code) : '';
    return /^\d{1,9}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

export const kapsoConfigurado = (env: CloudflareBindings) =>
  !!env.KAPSO_API_KEY && !!env.KAPSO_PHONE_NUMBER_ID && ID_NUMERO.test(env.KAPSO_PHONE_NUMBER_ID);

const aKapso = (e: unknown) => (e instanceof KapsoError ? e
  : e instanceof ProviderError ? new KapsoError(e.code, e.status) : new KapsoError('unavailable'));

// POST /{KAPSO_PHONE_NUMBER_ID}/messages con plazo de 8 s. Un reintento solo si la petición no llegó a salir (error de
// red sin respuesta); un plazo vencido o un 5xx no se repiten: Kapso pudo haberlo entregado y el mensaje saldría doble.
export async function enviarKapso(env: CloudflareBindings, mensaje: MensajeKapso): Promise<{ provider_id: string }> {
  if (!kapsoConfigurado(env)) throw new KapsoError('invalid', undefined, 'sin_config');
  const url = `${KAPSO_BASE}/${encodeURIComponent(env.KAPSO_PHONE_NUMBER_ID!)}/messages`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'X-API-Key': env.KAPSO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(mensaje),
  };
  let r: Response;
  try {
    r = await pedir(url, init, PLAZO_KAPSO_MS);
  } catch (e) {
    if (!(e instanceof ProviderError) || e.code !== 'unavailable' || e.status !== undefined) throw aKapso(e);
    try { r = await pedir(url, init, PLAZO_KAPSO_MS); } catch (e2) { throw aKapso(e2); }
  }
  const texto = await r.text().catch(() => '');
  if (!r.ok) throw new KapsoError(codigoHttp(r.status), r.status, codigoMeta(texto));
  const id = idMensaje(texto);
  if (!id) throw new KapsoError('invalid', r.status, 'sin_id');
  return { provider_id: id };
}

export const enviarTexto = (env: CloudflareBindings, e164: string, texto: string) =>
  enviarKapso(env, cuerpoTexto(e164, texto));

export const enviarInteractivo = (env: CloudflareBindings, e164: string, o: OpcionesInteractivo) =>
  enviarKapso(env, cuerpoInteractivo(e164, o));
