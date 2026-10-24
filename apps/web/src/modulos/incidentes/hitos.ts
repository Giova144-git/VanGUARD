// De dónde sale cada segundo que se dice en el pitch (S01). Manda IncidentDetail.timeline[] (E17: TimelineItem {t, ms,
// kind, label?}, ms desde attack_start); los campos del incidente son solo respaldo si falta un hito (S14 §14.16).
import type { IncidentDetail, TimelineItem } from '@vanguard/contracts';
import { duracion, SIN_DATO } from '@/lib/formato';

export type Hito = { clave: string; etiqueta: string; en: string | null; via?: string | null; mas: string };

export function t0De(i: IncidentDetail): string {
  return i.timeline.find((t) => t.kind === 'attack_start')?.t ?? i.started_at;
}

export function hitosDe(i: IncidentDetail): Hito[] {
  const primero = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort()[0] ?? null;
  const tl = (...ks: TimelineItem['kind'][]) => i.timeline.find((t) => ks.includes(t.kind)) ?? null;
  const t0 = t0De(i);
  const hitos = [
    { clave: 'detected', etiqueta: 'Ataque detectado', en: tl('detected')?.t ?? i.started_at },
    { clave: 'whatsapp', etiqueta: 'WhatsApp enviado', en: tl('whatsapp_sent')?.t ?? primero(i.notifications.filter((n) => n.channel === 'whatsapp').map((n) => n.sent_at ?? n.created_at)) },
    { clave: 'critical', etiqueta: 'Sube a crítica',   en: tl('severity_up')?.t ?? null },
    { clave: 'call',     etiqueta: 'Llamada',          en: tl('call_started')?.t ?? primero(i.notifications.filter((n) => n.channel === 'voice').map((n) => n.sent_at ?? n.created_at)) },
    { clave: 'ack',      etiqueta: 'Lo están viendo',  en: tl('ack')?.t ?? i.acked_at, via: i.acked_via },
    { clave: 'blocked',  etiqueta: 'IP bloqueada',     en: tl('action_executed', 'mitigated')?.t ?? i.mitigated_at },
  ];
  return hitos
    .filter((h) => h.en || !['critical', 'call'].includes(h.clave))   // «Sube a crítica» y «Llamada» (P1) solo si ocurrieron: nunca un «—» que parezca un fallo
    .map((h) => {                                                       // «+8,4 s» o «—» (también si el reloj da negativo)
      const d = h.en ? Date.parse(h.en) - Date.parse(t0) : -1;
      return { ...h, mas: d >= 0 ? `+${duracion(d)}` : SIN_DATO };
    });
}

// El resto de timeline[] (plegado bajo los hitos fijos), tal como llega.
const FIJOS = new Set<TimelineItem['kind']>(['attack_start', 'detected', 'whatsapp_sent', 'severity_up', 'call_started', 'ack', 'action_executed', 'mitigated']);
export const restoDe = (i: IncidentDetail) => i.timeline.filter((t) => !FIJOS.has(t.kind));

// Fin del cronómetro: bloqueo o mitigación; si no, resolución; si sigue abierto, null (corre con el reloj).
export function finDe(i: IncidentDetail): string | null {
  return i.timeline.find((t) => t.kind === 'action_executed' || t.kind === 'mitigated')?.t ?? i.mitigated_at ?? i.resolved_at ?? null;
}
