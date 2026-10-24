// Incidentes en vivo (E17), detalle con avisos y línea de tiempo (E17 :id), tráfico (E18) y simulación de
// «Bloquear IP» (E20). Historia del guion (canónicas §11 y S12 §12.11: `scripts/ataque.mjs … --rps 20 --admin-desde 25`):
// una IP de documentación ataca la víctima; los primeros 25 s solo van sondas y rutas 404, así que el incidente nace high
// (WhatsApp a +8 s); /admin empieza en el segundo 25, la siguiente evaluación lo ve y sube a critical (llamada a ≈ +27 s).
// Aún sin bloquear. (La simulación «Simular ataque» de S14 §14.19 dice «llamada a +20 s»: no reproduce --admin-desde 25.)
import type { Incident, IncidentDetail, NotificationPublic, ProposeResponse, TimelineItem, Traffic } from '../api.ts';
import {
  APPROVAL_BLOQUEO, HOST_VICTIMA, INC_ATAQUE, INC_ENSAYO, IP_ATACANTE, IP_ENSAYO, NOTIF_VOZ, NOTIF_WA_1, NOTIF_WA_2,
  NOTIF_WA_UP_1, NOTIF_WA_UP_2, T_ATAQUE, T_PROPUESTA, T_ULTIMO_EVENTO, ZONA,
} from './ids.ts';

// ── Tráfico de los últimos 300 s (cubetas de 10 s) ────────────────────────────
const INICIO_VENTANA = Date.parse('2026-10-24T18:57:00.000Z');
const NORMAL = [21, 18, 24, 19, 23, 20];                    // tráfico legítimo de la víctima por cubeta
const ATAQUE = [190, 195, 200, 198, 196, 167];             // cubetas 24–29 (19:01:00–19:01:50): 1146 peticiones
const ATAQUE_4XX = [190, 195, 100, 0, 0, 0];              // 0–25 s solo sondas y rutas 404; desde el 25, /admin y volumen 2xx
const UA_ATAQUE = 'sqlmap/1.8';                            // UA fijo del simulacro (canónicas §11)

export const EVENTOS_ATAQUE = ATAQUE.reduce((a, b) => a + b, 0); // 1146

export const traffic = {
  buckets: Array.from({ length: 30 }, (_, i) => {
    const a = i >= 24 ? (ATAQUE[i - 24] ?? 0) : 0;
    const a4 = i >= 24 ? (ATAQUE_4XX[i - 24] ?? 0) : 0;
    return { t: new Date(INICIO_VENTANA + i * 10_000).toISOString(), n: (NORMAL[i % NORMAL.length] ?? 20) + a,
      n4xx: (i % 7 === 3 ? 1 : 0) + a4, n5xx: 0 };
  }),
  top_ips: [
    { ip: IP_ATACANTE, n: EVENTOS_ATAQUE, ua_top: UA_ATAQUE },
    { ip: '198.51.100.40', n: 48, ua_top: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    { ip: '192.0.2.15', n: 31, ua_top: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
    { ip: '198.51.100.77', n: 22, ua_top: null },
  ],
} satisfies Traffic;

export const PETICIONES_5M = traffic.buckets.reduce((a, b) => a + b.n, 0);
export const PETICIONES_4XX_5M = traffic.buckets.reduce((a, b) => a + b.n4xx, 0);

// ── Incidente de la demo (abierto, critical) ──────────────────────────────────
const ms = (n: number) => new Date(Date.parse(T_ATAQUE) + n).toISOString();

export const incidenteAtaque = {
  id: INC_ATAQUE, code: 'A1F3C9', module: 'cloudflare',
  rule_ids: ['CF_UA_TOOL', 'CF_PATH_SCAN', 'CF_ADMIN_EXPOSED', 'CF_IP_FLOOD'], severity: 'critical',
  title: 'Escaneo con herramienta y /admin abierto desde 203.0.x.x', resource: `ip:${IP_ATACANTE}`, status: 'open',
  event_count: EVENTOS_ATAQUE,
  details: { ip: IP_ATACANTE, host: HOST_VICTIMA, ua_top: UA_ATAQUE, n_60s: 1080, paths_4xx: 37, probe_hits: 3, admin_ok: 3,
    n5xx: 0, p95_ms: 240, source: 'ingest', detected_at: ms(6_100), severity_up_at: ms(26_100) },
  started_at: T_ATAQUE, last_event_at: T_ULTIMO_EVENTO, notified_at: ms(8_400), acked_at: null, acked_via: null,
  muted_until: null, mitigated_at: null, resolved_at: null, suspected_injection: false,
} satisfies Incident;

// Ensayo de las 18:20Z: confirmado por WhatsApp y resuelto por housekeeping tras 15 min sin eventos. Sin bloqueo: la API
// real rechaza bloquear el rango de documentación (422 documentation_range, E20), así que el fixture no cuenta uno; por eso
// tampoco hay ningún block_ip vigente a las 19:02 (moduleState.cloudflare.bloqueos_vanguard = 0).
const incidenteEnsayo = {
  id: INC_ENSAYO, code: 'B7E204', module: 'cloudflare', rule_ids: ['CF_UA_TOOL', 'CF_PATH_SCAN'], severity: 'high',
  title: 'Escaneo de rutas con herramienta desde 198.51.x.x', resource: `ip:${IP_ENSAYO}`, status: 'resolved', event_count: 640,
  details: { ip: IP_ENSAYO, host: HOST_VICTIMA, ua_top: UA_ATAQUE, n_60s: 610, paths_4xx: 41, probe_hits: 3, admin_ok: 0, n5xx: 0,
    p95_ms: 180, source: 'ingest', detected_at: '2026-10-24T18:20:06.300Z', ensayo: true },
  started_at: '2026-10-24T18:20:00.000Z', last_event_at: '2026-10-24T18:21:30.000Z', notified_at: '2026-10-24T18:20:08.900Z',
  acked_at: '2026-10-24T18:20:40.000Z', acked_via: 'whatsapp', muted_until: null, mitigated_at: null,
  resolved_at: '2026-10-24T18:37:00.000Z', suspected_injection: false,
} satisfies Incident;

export const incidents = [incidenteAtaque, incidenteEnsayo] satisfies Incident[];

// ── Detalle: avisos y línea de tiempo ─────────────────────────────────────────
// Teléfonos de ajustes.ts enmascarados como en notifications.recipient_masked (+58 ficticio, no es un rango reservado).
const C1 = '+58•••••0001';
const C2 = '+58•••••0002';
const notifications = [
  { id: NOTIF_WA_1, channel: 'whatsapp', recipient_masked: C1, template: 'incident_v1', status: 'read', error: null,
    created_at: ms(7_900), sent_at: ms(8_400), delivered_at: ms(9_600), read_at: ms(14_000) },
  { id: NOTIF_WA_2, channel: 'whatsapp', recipient_masked: C2, template: 'incident_v1', status: 'delivered', error: null,
    created_at: ms(7_950), sent_at: ms(8_700), delivered_at: ms(10_200), read_at: null },
  { id: NOTIF_WA_UP_1, channel: 'whatsapp', recipient_masked: C1, template: 'incident_up_v1', status: 'delivered', error: null,
    created_at: ms(26_300), sent_at: ms(26_700), delivered_at: ms(28_000), read_at: null },
  { id: NOTIF_WA_UP_2, channel: 'whatsapp', recipient_masked: C2, template: 'incident_up_v1', status: 'sent', error: null,
    created_at: ms(26_350), sent_at: ms(26_900), delivered_at: null, read_at: null },
  { id: NOTIF_VOZ, channel: 'voice', recipient_masked: C1, template: 'call_v1', status: 'sent', error: null,
    created_at: ms(26_400), sent_at: ms(27_500), delivered_at: null, read_at: null },
] satisfies NotificationPublic[];

const timeline = [
  { t: T_ATAQUE, ms: 0, kind: 'attack_start', label: 'Primera petición del atacante' },
  { t: ms(6_100), ms: 6_100, kind: 'detected', label: 'Reglas CF_UA_TOOL y CF_PATH_SCAN' },
  { t: ms(8_400), ms: 8_400, kind: 'whatsapp_sent', label: `WhatsApp a ${C1}` },
  { t: ms(9_600), ms: 9_600, kind: 'whatsapp_delivered', label: 'WhatsApp entregado' },
  { t: ms(14_000), ms: 14_000, kind: 'whatsapp_read', label: 'WhatsApp visto (no es confirmación)' },
  { t: ms(26_100), ms: 26_100, kind: 'severity_up', label: 'Sube a crítica: CF_ADMIN_EXPOSED' },
  { t: ms(27_500), ms: 27_500, kind: 'call_started', label: `Llamada a ${C1}` },
] satisfies TimelineItem[];

export const incidentDetail = { ...incidenteAtaque, notifications, actions: [], timeline } satisfies IncidentDetail;

// ── Simulación de «Bloquear IP» (E20): código por WhatsApp, nunca en la respuesta ─────────────────
// OJO: expires_at es una fecha FIJA (T_PROPUESTA + 10 min) para que el fixture sea determinista y quede en la ventana del
// sábado. La máquina de estados de S14 §14.16 cuenta hasta expires_at: el enrutador falso (lib/fixtures/router.ts) debe
// devolver `{ ...fx.actionProposal, expires_at: new Date(Date.now() + 600_000).toISOString() }`, o el código «vence» al
// instante. No cambies aquí la fecha por Date.now().
export const actionProposal = {
  approval_id: APPROVAL_BLOQUEO,
  efecto: `Bloquear ${IP_ATACANTE} (/32) en la zona ${ZONA} durante 1 h: recibirá 403`,
  avisos: ['Solo afecta a esta IP', `Bloquea la IP en toda la zona ${ZONA}, también en tu web principal`],
  expires_at: new Date(Date.parse(T_PROPUESTA) + 10 * 60_000).toISOString(), delivery: 'whatsapp', code: null,
} satisfies ProposeResponse;
