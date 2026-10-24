// Plan de avisos (S15 15.9, S12 12.3–12.5, S06 06.9, M10 de §02.5.1): decide canal, contacto y plantilla de cada aviso
// externo; no envía nada. El despachador (apps/api engine/dispatch.ts) inserta una fila de notifications por envío con
// el status y el error que trae (el unique de §05 hace idempotente el despacho) y solo llama a Kapso con los `queued`.
// La voz es P1: el plan la marca (`p1: true`) y el despachador P0 la ignora sin escribir fila.
import type { IncidentStatus, Severity } from '@vanguard/contracts';
import { rank } from '../severity.ts';
import { partesCaracas } from '../templates/whatsapp.ts';
import { subioSeveridad, type Tormenta } from './incidente.ts';

// Un template distinto por motivo: notifications es único por (incident_id, channel, recipient_masked, template).
// code_review_v1: el texto fijo de la revisión de código (templates/revision.ts), único por (code_review_id, channel,
// recipient_masked).
export type PlantillaAviso = 'incident_v1' | 'incident_up_v1' | 'reopened_v1' | 'storm_v1' | 'call_v1' | 'code_review_v1';
export type CanalAviso = 'whatsapp' | 'voice';
export type IncidenteAviso = {
  severity: Severity; prev_severity: Severity | null; is_new: boolean; reopened: boolean; muted_until: string | null;
};
/** Fila de contacts. `verified_at` es obligatorio a propósito: sin verificar no sale nada real (T13 de §06, 06.9). */
export type ContactoAviso = { id: string; whatsapp: boolean; voice: boolean; priority: number; verified_at: string | null };
export type UsoAvisos = { whatsapp: number; voice: number };
export type TopesAvisos = { whatsapp: number; voice: number };
/** notifications.error de un envío que no sale: tope de la org, tope global de llamadas, ventana de demo cerrada o
 *  contacto sin verificar. */
export type ErrorAviso = 'cap' | 'cap_global' | 'fuera_de_ventana_demo' | 'unverified';
export type Planned = {
  channel: CanalAviso; contact_id: string; template: PlantillaAviso;
  status: 'queued' | 'skipped_cap' | 'failed';   // status de la fila de notifications
  error: ErrorAviso | null;
  skipped_cap: boolean;                           // = status === 'skipped_cap' (forma de S15 15.9)
  p1: boolean;                                    // voz: el despachador P0 no la envía ni escribe fila
};
export type MotivoSinAvisos = 'sin_cambio' | 'reabierto' | 'muted' | 'severidad_baja' | 'tormenta' | 'sin_contactos';
export type PlanAvisos = { envios: Planned[]; motivo: MotivoSinAvisos | null };
export type OpcionesPlan = {
  fueraDeVentanaDemo?: boolean;                   // fueraDeVentanaDemo(org, app_config.demo_alertas_hasta)
  usoGlobal?: { voice: number };                  // llamadas de TODAS las orgs en la última hora (06.9, P1)
  topeGlobal?: { voice: number };                 // defecto TOPE_GLOBAL_LLAMADAS_HORA
};

/** Topes por org y hora (canónicas §9.3, S06 06.9): 10 WhatsApp y 2 llamadas; org de demo 30 y 6. */
export const TOPES_AVISOS: Readonly<{ normal: TopesAvisos; demo: TopesAvisos }> = Object.freeze({
  normal: Object.freeze({ whatsapp: 10, voice: 2 }), demo: Object.freeze({ whatsapp: 30, voice: 6 }),
});
/** Tope global de llamadas por hora [propuesta de 06.9: app_config.topes.global_calls_hour]. */
export const TOPE_GLOBAL_LLAMADAS_HORA = 20;
export const topesDeOrg = (org: { is_demo: boolean }): TopesAvisos => ({ ...(org.is_demo ? TOPES_AVISOS.demo : TOPES_AVISOS.normal) });
/** Estados que gastan tope (`used1h` de 15.9): ni failed ni skipped_cap. */
export const ESTADOS_QUE_CUENTAN = ['queued', 'sent', 'delivered', 'read'] as const;

const verificado = (c: ContactoAviso) => typeof c.verified_at === 'string' && c.verified_at !== '';
/** El primero verificado de la lista (ya en orden de prioridad); si no hay, el primero (su fila sale unverified). */
const preferirVerificado = (xs: readonly ContactoAviso[]) => xs.find(verificado) ?? xs[0];

/** S15 15.9 con el detalle de cada fila. Orden de corte: sin cambio que avisar → silenciado → severidad < high →
 *  tormenta suprimida → sin contactos. Por envío: ventana de demo → sin verificar → tope de la org → tope global. Un
 *  envío que no sale no gasta tope (ni en el plan ni en `used1h`). */
export function planAvisos(i: IncidenteAviso, contacts: readonly ContactoAviso[], used1h: UsoAvisos, caps: TopesAvisos,
  storm: Tormenta, now = new Date(), o: OpcionesPlan = {}): PlanAvisos {
  const subio = subioSeveridad(i.prev_severity, i.severity);
  const no = (motivo: MotivoSinAvisos): PlanAvisos => ({ envios: [], motivo });
  // Reabierto sin subir: sin avisos externos (§12.3/§12.4); si al reabrir sube, va incident_up_v1 (sin llamada, abajo).
  if (!(i.is_new || subio)) return no(i.reopened ? 'reabierto' : 'sin_cambio');
  const silencio = i.muted_until ? Date.parse(i.muted_until) : NaN;
  if (Number.isFinite(silencio) && silencio > now.getTime()) return no('muted');
  if (rank(i.severity) < rank('high')) return no('severidad_baja');       // medium/low/info: solo in-app
  if (storm === 'suppressed') return no('tormenta');

  const byPrio = [...contacts].sort((a, b) => a.priority - b.priority);
  const conWa = byPrio.filter((c) => c.whatsapp);                         // filtrar ANTES de recortar
  const conVoz = byPrio.filter((c) => c.voice);
  const tpl: PlantillaAviso = storm === 'first' ? 'storm_v1' : i.is_new ? 'incident_v1' : 'incident_up_v1';
  const uso = { whatsapp: used1h.whatsapp, voice: used1h.voice };
  let global = o.usoGlobal?.voice ?? null;
  const topeGlobal = o.topeGlobal?.voice ?? TOPE_GLOBAL_LLAMADAS_HORA;
  const envios: Planned[] = [];
  const planear = (channel: CanalAviso, c: ContactoAviso, template: PlantillaAviso) => {
    const p = (status: Planned['status'], error: ErrorAviso | null): Planned =>
      ({ channel, contact_id: c.id, template, status, error, skipped_cap: status === 'skipped_cap', p1: channel === 'voice' });
    if (o.fueraDeVentanaDemo) return envios.push(p('skipped_cap', 'fuera_de_ventana_demo'));
    if (!verificado(c)) return envios.push(p('failed', 'unverified'));
    if (uso[channel] >= caps[channel]) return envios.push(p('skipped_cap', 'cap'));
    if (channel === 'voice' && global !== null && global >= topeGlobal) return envios.push(p('skipped_cap', 'cap_global'));
    uso[channel]++;
    if (channel === 'voice' && global !== null) global++;
    return envios.push(p('queued', null));
  };

  if (storm === 'first') { const c = preferirVerificado(conWa); if (c) planear('whatsapp', c, tpl); }
  else for (const c of conWa) planear('whatsapp', c, tpl);
  // Llamada: critical nuevo o que acaba de subir. Reabierto nunca llama, aunque suba (S12 12.3; S15 15.9 lo dice para
  // el que no sube). En tormenta `first`, una sola llamada.
  const callee = preferirVerificado(conVoz);
  if (i.severity === 'critical' && (i.is_new || subio) && !i.reopened && callee) planear('voice', callee, 'call_v1');
  return envios.length ? { envios, motivo: null } : no('sin_contactos');
}

/** Firma de S15 15.9 (devuelve solo la lista); `o` añade la ventana de demo y el tope global. */
export function planNotifications(i: IncidenteAviso, contacts: readonly ContactoAviso[], used1h: UsoAvisos, caps: TopesAvisos,
  storm: Tormenta, now = new Date(), o: OpcionesPlan = {}): Planned[] {
  return planAvisos(i, contacts, used1h, caps, storm, now, o).envios;
}

// ── Revisión de código (asignaciones/revision-codigo.md §5, §5.1): umbral por canal de la org, cupo propio y texto fijo.
// No pasa por planAvisos: aquel fija el umbral en high y no lee preferencias, y su tormenta (incidentes high/critical de
// los últimos 2 min) podría degradar a storm_v1 el aviso de un ataque si alguien empuja durante la demo. ──────────────
/** Severidad mínima de un hallazgo NUEVO para avisar por un canal; 'off' = nunca por ese canal. */
export type UmbralAviso = Severity | 'off';
export const superaUmbral = (s: Severity | null, u: UmbralAviso): boolean => s !== null && u !== 'off' && rank(s) >= rank(u);
/** Umbral efectivo de WhatsApp: sin llamadas, el más permisivo de los dos ('off' solo si los dos lo son). Quien eligió
 *  «llámame en crítico» y «WhatsApp: nunca» se entera por WhatsApp mientras no haya llamadas. */
export function umbralWhatsapp(p: { whatsapp: UmbralAviso; voice: UmbralAviso }, vozDisponible: boolean): UmbralAviso {
  if (vozDisponible || p.voice === 'off') return p.whatsapp;
  if (p.whatsapp === 'off') return p.voice;
  return rank(p.voice) < rank(p.whatsapp) ? p.voice : p.whatsapp;
}
/** Cupo propio de la revisión: revisiones avisadas por org y hora, aparte de TOPES_AVISOS. */
export const TOPES_REVISION: Readonly<{ normal: number; demo: number }> = Object.freeze({ normal: 3, demo: 10 });
const MAX_CONTACTOS_REVISION = 5;                 // como E26
export type MotivoSinAvisoRevision = 'sin_hallazgos' | 'bajo_umbral' | 'sin_contactos';
export type PlanAvisoRevision = { envios: Planned[]; voz_pendiente: boolean; motivo: MotivoSinAvisoRevision | null };
const filaRevision = (c: ContactoAviso, status: Planned['status'], error: ErrorAviso | null): Planned => ({
  channel: 'whatsapp', contact_id: c.id, template: 'code_review_v1', status, error,
  skipped_cap: status === 'skipped_cap', p1: false,
});

/** Revisión de código: plantilla code_review_v1 por WhatsApp a cada contacto con whatsapp (por prioridad, ≤ 5). Hay
 *  envío si la peor severidad nueva pasa el umbral efectivo o si la revisión es parcial y ese umbral no es 'off' (un push
 *  grande no pasa en silencio). Por envío, el mismo orden que planAvisos: ventana de demo → sin verificar → cupo. El cupo
 *  cuenta revisiones, no filas: `avisadas1h` = revisiones avisadas en la última hora. La voz no genera envíos, solo
 *  voz_pendiente (pasa el umbral de voz y hay algún contacto con voz verificado). Motivo sin envíos: sin_hallazgos (sin
 *  nuevos y completa), bajo_umbral (nuevos o parcial que no pasan el umbral) o sin_contactos. */
export function planAvisoRevision(r: { max: Severity | null; parcial: boolean },
  prefs: { whatsapp: UmbralAviso; voice: UmbralAviso }, contacts: readonly ContactoAviso[], avisadas1h: number, cupo: number,
  o: { fueraDeVentanaDemo?: boolean; vozDisponible?: boolean } = {}): PlanAvisoRevision {
  const umbral = umbralWhatsapp(prefs, o.vozDisponible ?? false);
  const voz_pendiente = superaUmbral(r.max, prefs.voice) && contacts.some((c) => c.voice && verificado(c));
  const no = (motivo: MotivoSinAvisoRevision): PlanAvisoRevision => ({ envios: [], voz_pendiente, motivo });
  if (r.max === null && !r.parcial) return no('sin_hallazgos');
  if (!superaUmbral(r.max, umbral) && !(r.parcial && umbral !== 'off')) return no('bajo_umbral');
  const conWa = [...contacts].sort((a, b) => a.priority - b.priority).filter((c) => c.whatsapp)   // filtrar ANTES de recortar
    .slice(0, MAX_CONTACTOS_REVISION);
  if (!conWa.length) return no('sin_contactos');
  const sinCupo = avisadas1h >= cupo;
  const envios = conWa.map((c) => o.fueraDeVentanaDemo ? filaRevision(c, 'skipped_cap', 'fuera_de_ventana_demo')
    : !verificado(c) ? filaRevision(c, 'failed', 'unverified')
    : sinCupo ? filaRevision(c, 'skipped_cap', 'cap') : filaRevision(c, 'queued', null));
  return { envios, voz_pendiente, motivo: null };
}

// ── Escalamiento de voz (P1, S12 12.5): critical sin ack → siguiente contacto con voz a los 45 s; high sin ack → a los
// 15 min, solo de 07:00 a 22:00 de Caracas, una vez. Tope de 3 llamadas por incidente además del tope por hora. ──────
export const ESCALAR_CRITICAL_MS = 45_000;
export const ESCALAR_HIGH_MS = 15 * 60_000;
export const MAX_LLAMADAS_INCIDENTE = 3;
export const HORARIO_LLAMADA_HIGH = Object.freeze({ desde: 7, hasta: 22 });   // [07:00, 22:00) en America/Caracas
export type EstadoEscalamiento = {
  severity: Severity; status: IncidentStatus; acked_at: string | null; muted_until: string | null;
  ultimo_aviso: string | null;     // sent_at de la última llamada o, si no hubo, incidents.notified_at
};
export type DecisionEscalamiento =
  | { llamar: true; contact_id: string }
  | { llamar: false; motivo: 'ack' | 'muted' | 'resuelto' | 'severidad_baja' | 'tope_incidente' | 'temprano' | 'fuera_de_horario' | 'sin_contacto' };

/** `llamadasHechas` = llamadas de este incidente ya registradas (la de t0 incluida): elige el índice en la lista de
 *  contactos con voz verificados por prioridad. El tope por hora lo sigue aplicando el despachador. */
export function planEscalamiento(i: EstadoEscalamiento, contacts: readonly ContactoAviso[], llamadasHechas: number,
  now = new Date()): DecisionEscalamiento {
  const no = (motivo: Extract<DecisionEscalamiento, { llamar: false }>['motivo']): DecisionEscalamiento => ({ llamar: false, motivo });
  if (i.status === 'resolved' || i.status === 'mitigated') return no('resuelto');
  if (i.acked_at) return no('ack');
  const silencio = i.muted_until ? Date.parse(i.muted_until) : NaN;
  if (Number.isFinite(silencio) && silencio > now.getTime()) return no('muted');
  if (i.severity !== 'critical' && i.severity !== 'high') return no('severidad_baja');
  const maximo = i.severity === 'critical' ? MAX_LLAMADAS_INCIDENTE : 1;
  if (llamadasHechas >= maximo) return no('tope_incidente');
  const desde = i.ultimo_aviso ? Date.parse(i.ultimo_aviso) : NaN;
  const espera = i.severity === 'critical' ? ESCALAR_CRITICAL_MS : ESCALAR_HIGH_MS;
  if (!Number.isFinite(desde) || now.getTime() - desde < espera) return no('temprano');
  if (i.severity === 'high') {
    const h = partesCaracas(now)?.h ?? -1;
    if (h < HORARIO_LLAMADA_HIGH.desde || h >= HORARIO_LLAMADA_HIGH.hasta) return no('fuera_de_horario');
  }
  const voz = [...contacts].sort((a, b) => a.priority - b.priority).filter((c) => c.voice && verificado(c));
  const c = voz[Math.max(0, Math.floor(llamadasHechas))];
  return c ? { llamar: true, contact_id: c.id } : no('sin_contacto');
}
