import type { ContextoLlamada } from '@vanguard/core';
import { pedir } from '../lib/http.ts';
import { log } from '../lib/log.ts';

// Cliente del servidor de voz (apps/voz, asignaciones/llamada-ataque.md). Meta no deja a esta cuenta iniciar llamadas
// (call_permissions → 400, 138013): la llamada la inicia el usuario con el botón «Llamar a Guardia» del WhatsApp. Antes
// de mandarlo, POST {VOZ_URL}/operator/api/attack/expect (Bearer VOZ_OPERATOR_TOKEN) avisa al servidor de que ese teléfono
// puede llamar en los próximos minutos, con el contexto del ataque y el ticket «vg:<código>» que vuelve en la llamada.
// UNA petición, sin reintento; lo que vuelve es un código corto: nunca el cuerpo del servidor ni el teléfono.

export const PLAZO_VOZ_MS = 20_000;
export type ResultadoEspera = { tipo: 'ok'; minutos: number } | { tipo: 'fallida'; status: number | null };

/** Sin VOZ_URL o sin VOZ_OPERATOR_TOKEN, nada de voz (ni fila). */
export const vozConfigurada = (env: CloudflareBindings): boolean => Boolean(env.VOZ_URL?.trim() && env.VOZ_OPERATOR_TOKEN?.trim());

// Keepalive (el servidor de voz gratuito se duerme sin tráfico y despertarlo tarda más que PLAZO_VOZ_MS): el cron por
// minuto, cada 10 min, hace GET {VOZ_URL}/healthz con 5 s, sin reintento y sin mirar el resultado más que para el log.
// Sin VOZ_URL no hace nada. Nunca lanza.
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

/** `recipient`: E.164 sin el +; `ticket`: «vg:<código del incidente>». ok solo con 200 y expected:true. Nunca lanza. */
export async function esperarLlamada(env: CloudflareBindings, recipient: string, context: ContextoLlamada, ticket: string)
  : Promise<ResultadoEspera> {
  if (!vozConfigurada(env)) return { tipo: 'fallida', status: null };
  try {
    const r = await pedir(new URL('/operator/api/attack/expect', env.VOZ_URL).href, { method: 'POST',
      headers: { Authorization: `Bearer ${env.VOZ_OPERATOR_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient, context, ticket }) }, PLAZO_VOZ_MS);
    let cuerpo: Record<string, unknown> = {};
    try {
      const j: unknown = await r.json();
      if (j && typeof j === 'object' && !Array.isArray(j)) cuerpo = j as Record<string, unknown>;
    } catch { /* ilegible: no cuenta como esperada */ }
    if (r.status !== 200 || cuerpo.expected !== true) return { tipo: 'fallida', status: r.status };
    const m = typeof cuerpo.minutes === 'number' && Number.isFinite(cuerpo.minutes) ? Math.round(cuerpo.minutes) : 30;
    return { tipo: 'ok', minutos: m };
  } catch {
    // Red, plazo, egress bloqueado (host fuera de *.app.github.dev, *.hf.space y *.onrender.com) o VOZ_URL ilegible.
    return { tipo: 'fallida', status: null };
  }
}
