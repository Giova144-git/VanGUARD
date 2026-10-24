import type { Severity, TimelineItem } from '@vanguard/contracts';
import { horaCaracas, moduloDeRegla, reglaPrincipal } from '@vanguard/core';

// IncidentDetail.timeline (E17 detalle, S15 15.4): se calcula al leer, sin tabla nueva; un hito sin dato no se emite.
// attack_start = started_at (vg_ip_first_seen al abrir) · detected = details.detected_at (lo pone vg_upsert_incident) ·
// severity_up = details.severity_up_at · whatsapp_* = primer sent/delivered/read de las WhatsApp · call_started = sent_at
// de la primera voz · call_failed = created_at de una voz failed · ack = acked_at · muted = details.muted_at ·
// action_proposed = aprobación in_app · action_executed / action_undone = actions · mitigated / resolved = columnas.
// `ms` desde attack_start (el cronómetro de la demo); orden por `t`.

export type IncidenteTimeline = {
  rule_ids: readonly string[]; severity: Severity; started_at: string; details: Readonly<Record<string, unknown>> | null;
  acked_at: string | null; acked_via: string | null; muted_until: string | null; mitigated_at: string | null;
  resolved_at: string | null;
};
export type NotificacionTimeline = {
  channel: string; recipient_masked: string; status: string; created_at: string; sent_at: string | null;
  delivered_at: string | null; read_at: string | null;
};
export type AccionTimeline = { kind: string; status: string; created_at: string; undone_at: string | null };

type Kind = TimelineItem['kind'];
// Desempate de hitos con la misma marca: el orden del flujo (§12.10).
const ORDEN: readonly Kind[] = ['attack_start', 'detected', 'severity_up', 'whatsapp_sent', 'whatsapp_delivered', 'whatsapp_read',
  'call_started', 'call_failed', 'ack', 'muted', 'action_proposed', 'action_executed', 'action_undone', 'edge_confirmed',
  'mitigated', 'resolved'];

const ms = (t: unknown): number | null => {
  const x = typeof t === 'string' ? Date.parse(t) : NaN;
  return Number.isFinite(x) ? x : null;
};
const lista = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs.at(-1)}`);

const ACK_VIA: Readonly<Record<string, string>> = {
  whatsapp: 'Confirmado por WhatsApp', in_app: 'Confirmado desde la app', voice: 'Confirmado por teléfono',
};
const ACCION: Readonly<Record<string, string>> = {
  block_ip: 'IP bloqueada 1 h', unblock_ip: 'IP desbloqueada', under_attack_on: 'Modo «Under Attack» activado',
  under_attack_off: 'Modo «Under Attack» desactivado', rate_limit: 'Límite de peticiones aplicado',
};

/** Primer elemento por marca de tiempo de `campo` (las notificaciones llegan en cualquier orden). */
function primero<T>(xs: readonly T[], campo: (x: T) => string | null): { x: T; t: number } | null {
  let mejor: { x: T; t: number } | null = null;
  for (const x of xs) {
    const t = ms(campo(x));
    if (t !== null && (!mejor || t < mejor.t)) mejor = { x, t };
  }
  return mejor;
}

export function armarTimeline(i: IncidenteTimeline, notificaciones: readonly NotificacionTimeline[],
  acciones: readonly AccionTimeline[], propuestaEn: string | null = null): TimelineItem[] {
  const inicio = ms(i.started_at);
  if (inicio === null) return [];
  const d = i.details ?? {};
  const hitos: { t: number; kind: Kind; label: string }[] = [];
  const poner = (t: number | null, kind: Kind, label: string) => { if (t !== null) hitos.push({ t, kind, label }); };

  const cf = moduloDeRegla(i.rule_ids[0]) === 'cloudflare';
  poner(inicio, 'attack_start', cf ? 'Primera petición del atacante' : 'Inicio del incidente');
  // La regla de la subida va en severity_up; detected nombra las demás (rule_ids acumula todas las de la IP).
  const subida = ms(d.severity_up_at);
  const causa = subida !== null ? reglaPrincipal(i.rule_ids, i.severity) : null;
  const deteccion = causa && i.rule_ids.length > 1 ? i.rule_ids.filter((r) => r !== causa) : [...i.rule_ids];
  poner(ms(d.detected_at), 'detected', `${deteccion.length > 1 ? 'Reglas' : 'Regla'} ${lista(deteccion)}`);
  poner(subida, 'severity_up', `Sube a ${i.severity === 'critical' ? 'crítica' : 'alta'}${causa ? `: ${causa}` : ''}`);

  const wa = notificaciones.filter((n) => n.channel === 'whatsapp');
  const enviado = primero(wa, (n) => n.sent_at);
  poner(enviado?.t ?? null, 'whatsapp_sent', `WhatsApp a ${enviado?.x.recipient_masked ?? ''}`);
  poner(primero(wa, (n) => n.delivered_at)?.t ?? null, 'whatsapp_delivered', 'WhatsApp entregado');
  poner(primero(wa, (n) => n.read_at)?.t ?? null, 'whatsapp_read', 'WhatsApp visto (no es confirmación)');

  const voz = notificaciones.filter((n) => n.channel === 'voice');
  const llamada = primero(voz, (n) => n.sent_at);
  poner(llamada?.t ?? null, 'call_started', `Llamada a ${llamada?.x.recipient_masked ?? ''}`);
  const fallida = primero(voz.filter((n) => n.status === 'failed'), (n) => n.created_at);
  poner(fallida?.t ?? null, 'call_failed', `La llamada a ${fallida?.x.recipient_masked ?? ''} no salió`);

  poner(ms(i.acked_at), 'ack', ACK_VIA[i.acked_via ?? ''] ?? 'Confirmado');
  poner(ms(d.muted_at), 'muted', ms(i.muted_until) !== null ? `Silenciado hasta las ${horaCaracas(i.muted_until!)}` : 'Silenciado');
  poner(ms(propuestaEn), 'action_proposed', 'Bloqueo propuesto');
  for (const a of acciones) {
    // Una acción deshecha también se ejecutó; las failed y proposed no cuentan.
    if (a.status === 'executed' || a.status === 'undone') poner(ms(a.created_at), 'action_executed', ACCION[a.kind] ?? 'Acción ejecutada');
    poner(ms(a.undone_at), 'action_undone', a.kind === 'block_ip' ? 'Bloqueo retirado' : 'Acción deshecha');
  }
  poner(ms(i.mitigated_at), 'mitigated', 'Mitigado');
  poner(ms(i.resolved_at), 'resolved', cf ? 'Resuelto: 15 min sin peticiones de esa IP' : 'Resuelto');

  return hitos
    .sort((a, b) => a.t - b.t || ORDEN.indexOf(a.kind) - ORDEN.indexOf(b.kind))
    .map((h) => ({ t: new Date(h.t).toISOString(), ms: Math.max(0, Math.round(h.t - inicio)), kind: h.kind, label: h.label }));
}
