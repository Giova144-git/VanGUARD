// Contexto de la llamada de Guardia en un ataque (asignaciones/llamada-ataque.md §B1): las 5 claves EXACTAS que acepta
// POST {VOZ_URL}/operator/api/outbound/call (otra clave → 422). El agente las lee dentro de un saludo fijo; aquí salen
// cortas y por textoSeguro: nada de rutas, repo, tokens ni texto de IA, y la IP siempre recortada (203.0.x.x, como el WhatsApp).
import type { Severity } from '@vanguard/contracts';
import { ipCanonica, ipCorta } from '../engine/edge.ts';
import { reglaPrincipal } from '../engine/incidente.ts';
import { textoSeguro } from './whatsapp.ts';

export type ContextoLlamada = { tipo: string; host: string; ip: string; eventos: string; severidad: string };
export type IncidenteLlamada = {
  rule_ids: readonly string[]; severity: Severity; resource: string; details?: Readonly<Record<string, unknown>> | null;
  event_count?: number | null;
};

/** Lo que dice Guardia según la regla principal del incidente. */
export const TIPO_LLAMADA: Readonly<Record<string, string>> = {
  CF_PATH_SCAN: 'un escaneo de rutas', CF_IP_FLOOD: 'una inundación de peticiones', CF_UA_TOOL: 'una herramienta de ataque',
};
const TIPO_OTRO = 'actividad sospechosa';
// Los recortes del servidor de voz (60/80/45/12/12): aquí no se pasa de ellos.
const MAX = { tipo: 60, host: 80, ip: 45, eventos: 12, severidad: 12 } as const;

export function contextoLlamada(i: IncidenteLlamada): ContextoLlamada {
  const regla = reglaPrincipal(i.rule_ids, i.severity) ?? '';
  const d = i.details ?? {};
  const host = typeof d.host === 'string' && d.host.trim() ? textoSeguro(d.host, MAX.host) : 'tu sitio';
  const crudo = i.resource.startsWith('ip:') ? i.resource.slice(3) : typeof d.ip === 'string' ? d.ip : '';
  const ip = ipCanonica(crudo);
  const n = typeof i.event_count === 'number' && Number.isFinite(i.event_count) && i.event_count > 0 ? Math.round(i.event_count) : 1;
  return {
    tipo: textoSeguro(TIPO_LLAMADA[regla] ?? TIPO_OTRO, MAX.tipo),
    host,
    ip: ip ? textoSeguro(ipCorta(ip), MAX.ip) : 'una IP desconocida',
    eventos: String(Math.min(n, 999_999_999)),
    severidad: i.severity === 'critical' ? 'crítica' : 'alta',
  };
}
