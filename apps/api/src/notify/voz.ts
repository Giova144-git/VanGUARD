import type { ContextoLlamada } from '@vanguard/core';
import { pedir, ProviderError } from '../lib/http.ts';
import { log } from '../lib/log.ts';

// Cliente del servidor de voz (apps/voz en Render, asignaciones/llamada-ataque.md): POST {VOZ_URL}/operator/api/outbound/call
// con Bearer VOZ_OPERATOR_TOKEN. UNA petición y nunca un reintento: con un 502 o un plazo el teléfono puede estar sonando
// ya, y cada llamada la cobra Meta. Lo que vuelve es un código corto: nunca el cuerpo del servidor ni el teléfono.

export const PLAZO_VOZ_MS = 20_000;
export type ResultadoLlamada =
  | { tipo: 'ok'; ref: string; state: string }
  | { tipo: 'fallida'; error: 'sin_permiso' | 'ocupado' | 'sin_config' | 'rechazada' }
  | { tipo: 'desconocida' };   // 502, 5xx, plazo, red o una respuesta ilegible: no se sabe si sonó

/** Sin VOZ_URL o sin VOZ_OPERATOR_TOKEN, ninguna llamada (ni fila). */
export const vozConfigurada = (env: CloudflareBindings): boolean => Boolean(env.VOZ_URL?.trim() && env.VOZ_OPERATOR_TOKEN?.trim());

// Keepalive (el plan gratis de Render duerme el servicio tras 15 min sin tráfico y despertarlo tarda ~1 min, más que
// PLAZO_VOZ_MS): el cron por minuto, cada 10 min, hace GET {VOZ_URL}/healthz con 5 s, sin reintento y sin mirar el
// resultado más que para el log. Sin la voz configurada no hace nada. Nunca lanza.
export const PLAZO_PING_MS = 5_000;
export const CADA_PING_MIN = 10;
export async function pingVoz(env: CloudflareBindings): Promise<'ok' | 'fallido' | null> {
  if (!env.VOZ_URL?.trim()) return null;
  let r: 'ok' | 'fallido' = 'fallido';
  let status: number | null = null;
  try {
    const res = await pedir(new URL('/healthz', env.VOZ_URL).href, { method: 'GET' }, PLAZO_PING_MS);
    status = res.status;
    await res.body?.cancel();
    r = res.ok ? 'ok' : 'fallido';
  } catch { /* red, plazo, egress o VOZ_URL ilegible: fallido */ }
  log(r === 'ok' ? 'info' : 'warn', r === 'ok' ? 'voz.ping_ok' : 'voz.ping_fallido', { status });
  return r;
}

const REF = /^[A-Za-z0-9._:-]{1,80}$/;
const STATE = /^[a-z_]{1,20}$/;

/** `recipient`: E.164 sin el +. Nunca lanza. */
export async function llamarVoz(env: CloudflareBindings, recipient: string, context: ContextoLlamada): Promise<ResultadoLlamada> {
  if (!vozConfigurada(env)) return { tipo: 'fallida', error: 'sin_config' };
  let url: string;
  try {
    url = new URL('/operator/api/outbound/call', env.VOZ_URL).href;
  } catch {
    return { tipo: 'fallida', error: 'sin_config' };
  }
  let r: Response;
  try {
    r = await pedir(url, { method: 'POST', headers: { Authorization: `Bearer ${env.VOZ_OPERATOR_TOKEN}`,
      'Content-Type': 'application/json' }, body: JSON.stringify({ recipient, context }) }, PLAZO_VOZ_MS);
  } catch (e) {
    // Egress bloqueado (host fuera de *.onrender.com): la petición no salió, así que no sonó nada.
    if (e instanceof ProviderError && e.code === 'invalid' && e.status === undefined) return { tipo: 'fallida', error: 'sin_config' };
    return { tipo: 'desconocida' };
  }
  let cuerpo: Record<string, unknown> = {};
  try {
    const j: unknown = await r.json();
    if (j && typeof j === 'object' && !Array.isArray(j)) cuerpo = j as Record<string, unknown>;
  } catch { /* cuerpo ilegible: decide el status */ }
  if (r.status === 200) {
    const ref = typeof cuerpo.ref === 'string' && REF.test(cuerpo.ref) ? cuerpo.ref : null;
    const state = typeof cuerpo.state === 'string' && STATE.test(cuerpo.state) ? cuerpo.state : 'ringing';
    return ref ? { tipo: 'ok', ref, state } : { tipo: 'desconocida' };
  }
  if (r.status === 409) {
    // El servidor distingue ocupado (1 llamada a la vez) de sin permiso de llamada de WhatsApp por su texto.
    const t = JSON.stringify(cuerpo).toLowerCase();
    return { tipo: 'fallida', error: /ocupad|busy|in_progress|en curso/.test(t) ? 'ocupado' : 'sin_permiso' };
  }
  if (r.status === 503) return { tipo: 'fallida', error: 'sin_config' };
  if (r.status >= 400 && r.status < 500) return { tipo: 'fallida', error: 'rechazada' };   // 401, 422…: no salió
  return { tipo: 'desconocida' };
}
