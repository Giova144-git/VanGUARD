// Casos de S15 15.13 (core/rules/notify-plan.test.ts) + topes de 06.9, contactos sin verificar (T13), ventana de la org
// de demo (M10 de §02.5.1), tope global de llamadas y escalamiento de voz (P1, S12 12.5).
import { describe, expect, it } from 'vitest';
import {
  type ContactoAviso, ESTADOS_QUE_CUENTAN, type IncidenteAviso, MAX_LLAMADAS_INCIDENTE, planAvisos, planEscalamiento,
  planNotifications, type Planned, TOPE_GLOBAL_LLAMADAS_HORA, TOPES_AVISOS, topesDeOrg,
} from './notify-plan.ts';

const AHORA = new Date('2026-10-24T19:02:00.000Z');
const V = '2026-10-24T12:00:00.000Z';                                          // verified_at
const C: ContactoAviso[] = [
  { id: 'c2', whatsapp: true, voice: false, priority: 2, verified_at: V },
  { id: 'c1', whatsapp: true, voice: true, priority: 1, verified_at: V },
  { id: 'c3', whatsapp: false, voice: true, priority: 3, verified_at: V },
];
const inc = (o: Partial<IncidenteAviso> = {}): IncidenteAviso =>
  ({ severity: 'critical', prev_severity: null, is_new: true, reopened: false, muted_until: null, ...o });
const NADA = { whatsapp: 0, voice: 0 };
const CAPS = TOPES_AVISOS.normal;
const corto = (xs: Planned[]) => xs.map((p) => `${p.channel}:${p.contact_id}:${p.template}:${p.status}${p.error ? ':' + p.error : ''}`);
const plan = (i: IncidenteAviso, o: { c?: ContactoAviso[]; used?: { whatsapp: number; voice: number }; storm?: 'none' | 'first' | 'suppressed' } = {}) =>
  corto(planNotifications(i, o.c ?? C, o.used ?? NADA, CAPS, o.storm ?? 'none', AHORA));

describe('planNotifications: casos de S15 15.13', () => {
  it('critical nuevo → incident_v1 a todos los de WhatsApp (por prioridad) + 1 call_v1', () => {
    expect(plan(inc())).toEqual(['whatsapp:c1:incident_v1:queued', 'whatsapp:c2:incident_v1:queued', 'voice:c1:call_v1:queued']);
  });
  it('mismo incidente sin subir → []', () => {
    expect(plan(inc({ is_new: false, prev_severity: 'critical' }))).toEqual([]);
    expect(planAvisos(inc({ is_new: false, prev_severity: 'critical' }), C, NADA, CAPS, 'none', AHORA).motivo).toBe('sin_cambio');
  });
  it('high → critical → incident_up_v1 + call_v1', () => {
    expect(plan(inc({ is_new: false, prev_severity: 'high' })))
      .toEqual(['whatsapp:c1:incident_up_v1:queued', 'whatsapp:c2:incident_up_v1:queued', 'voice:c1:call_v1:queued']);
  });
  it('muted_until en el futuro → []; vencido o inválido → avisa', () => {
    expect(plan(inc({ muted_until: '2026-10-24T20:00:00.000Z' }))).toEqual([]);
    expect(planAvisos(inc({ muted_until: '2026-10-24T20:00:00.000Z' }), C, NADA, CAPS, 'none', AHORA).motivo).toBe('muted');
    expect(plan(inc({ muted_until: '2026-10-24T19:01:59.000Z' }))).toHaveLength(3);
    expect(plan(inc({ muted_until: 'no-fecha' }))).toHaveLength(3);
  });
  it('tope superado → skipped_cap: true (y no llama al proveedor)', () => {
    const xs = planNotifications(inc(), C, { whatsapp: 10, voice: 2 }, CAPS, 'none', AHORA);
    expect(xs.every((p) => p.skipped_cap && p.status === 'skipped_cap' && p.error === 'cap')).toBe(true);
    expect(xs).toHaveLength(3);
  });
  it('tormenta first → un solo storm_v1 aunque el contacto 1 no tenga WhatsApp (va al primero que sí)', () => {
    const sinWa1: ContactoAviso[] = [{ id: 'v1', whatsapp: false, voice: true, priority: 1, verified_at: V },
      { id: 'w2', whatsapp: true, voice: false, priority: 2, verified_at: V }, { id: 'w3', whatsapp: true, voice: false, priority: 3, verified_at: V }];
    expect(plan(inc({ severity: 'high' }), { c: sinWa1, storm: 'first' })).toEqual(['whatsapp:w2:storm_v1:queued']);
    expect(plan(inc(), { c: sinWa1, storm: 'first' })).toEqual(['whatsapp:w2:storm_v1:queued', 'voice:v1:call_v1:queued']);
  });
  it('tormenta suppressed → []', () => {
    expect(plan(inc(), { storm: 'suppressed' })).toEqual([]);
    expect(planAvisos(inc(), C, NADA, CAPS, 'suppressed', AHORA).motivo).toBe('tormenta');
  });
  it('reabierto critical sin subir → reopened_v1 y SIN llamada', () => {
    expect(plan(inc({ is_new: false, reopened: true, prev_severity: 'critical' })))
      .toEqual(['whatsapp:c1:reopened_v1:queued', 'whatsapp:c2:reopened_v1:queued']);
  });
  it('medium (y low/info) → [] solo in-app', () => {
    for (const s of ['medium', 'low', 'info'] as const) {
      expect(plan(inc({ severity: s })), s).toEqual([]);
      expect(planAvisos(inc({ severity: s }), C, NADA, CAPS, 'none', AHORA).motivo).toBe('severidad_baja');
    }
  });
});

describe('planNotifications: resto de §12.3–12.5', () => {
  it('high nuevo → WhatsApp a todos, sin llamada (la llamada del high es escalamiento P1)', () => {
    expect(plan(inc({ severity: 'high' }))).toEqual(['whatsapp:c1:incident_v1:queued', 'whatsapp:c2:incident_v1:queued']);
  });
  it('reabierto que además sube → incident_up_v1 sin llamada (reabierto nunca llama, S12 12.3)', () => {
    expect(plan(inc({ is_new: false, reopened: true, prev_severity: 'high' })))
      .toEqual(['whatsapp:c1:incident_up_v1:queued', 'whatsapp:c2:incident_up_v1:queued']);
  });
  it('la historia de la demo: nace high (2 WhatsApp) y sube a critical (2 incident_up_v1 + llamada)', () => {
    const uno = plan(inc({ severity: 'high' }));
    const dos = plan(inc({ is_new: false, prev_severity: 'high' }), { used: { whatsapp: 2, voice: 0 } });
    expect([...uno, ...dos]).toEqual(['whatsapp:c1:incident_v1:queued', 'whatsapp:c2:incident_v1:queued',
      'whatsapp:c1:incident_up_v1:queued', 'whatsapp:c2:incident_up_v1:queued', 'voice:c1:call_v1:queued']);
  });
  it('voz marcada p1 (el despachador P0 no la envía); WhatsApp no', () => {
    const xs = planNotifications(inc(), C, NADA, CAPS, 'none', AHORA);
    expect(xs.map((p) => [p.channel, p.p1])).toEqual([['whatsapp', false], ['whatsapp', false], ['voice', true]]);
  });
  it('tope parcial: con 9 de 10 usados sale 1 WhatsApp y el resto skipped_cap; la voz tiene su propio tope', () => {
    const tres = [...C, { id: 'c4', whatsapp: true, voice: false, priority: 4, verified_at: V }];
    expect(plan(inc(), { c: tres, used: { whatsapp: 9, voice: 1 } })).toEqual(['whatsapp:c1:incident_v1:queued',
      'whatsapp:c2:incident_v1:skipped_cap:cap', 'whatsapp:c4:incident_v1:skipped_cap:cap', 'voice:c1:call_v1:queued']);
    expect(plan(inc(), { used: { whatsapp: 0, voice: 2 } })).toContain('voice:c1:call_v1:skipped_cap:cap');
  });
  it('org de demo: topes 30 y 6', () => {
    expect(topesDeOrg({ is_demo: true })).toEqual({ whatsapp: 30, voice: 6 });
    expect(topesDeOrg({ is_demo: false })).toEqual({ whatsapp: 10, voice: 2 });
    const xs = planNotifications(inc(), C, { whatsapp: 29, voice: 5 }, topesDeOrg({ is_demo: true }), 'none', AHORA);
    expect(corto(xs)).toEqual(['whatsapp:c1:incident_v1:queued', 'whatsapp:c2:incident_v1:skipped_cap:cap', 'voice:c1:call_v1:queued']);
    expect(ESTADOS_QUE_CUENTAN).toEqual(['queued', 'sent', 'delivered', 'read']);
  });
  it('contacto sin verificar → failed/unverified y no gasta tope; la llamada va al primero verificado', () => {
    const c: ContactoAviso[] = [{ id: 'x1', whatsapp: true, voice: true, priority: 1, verified_at: null },
      { id: 'x2', whatsapp: true, voice: true, priority: 2, verified_at: V }];
    expect(plan(inc(), { c, used: { whatsapp: 9, voice: 0 } }))
      .toEqual(['whatsapp:x1:incident_v1:failed:unverified', 'whatsapp:x2:incident_v1:queued', 'voice:x2:call_v1:queued']);
    const nadie: ContactoAviso[] = c.map((x) => ({ ...x, verified_at: null }));
    expect(plan(inc(), { c: nadie })).toEqual(['whatsapp:x1:incident_v1:failed:unverified',
      'whatsapp:x2:incident_v1:failed:unverified', 'voice:x1:call_v1:failed:unverified']);
    expect(plan(inc({ severity: 'high' }), { c: [nadie[0]!, c[1]!], storm: 'first' }))
      .toEqual(['whatsapp:x2:storm_v1:queued']);                                       // la tormenta busca uno verificado
  });
  it('fuera de la ventana de demo → todo skipped_cap con fuera_de_ventana_demo (también la voz), sin gastar tope', () => {
    const xs = planNotifications(inc(), C, NADA, topesDeOrg({ is_demo: true }), 'none', AHORA, { fueraDeVentanaDemo: true });
    expect(corto(xs)).toEqual(['whatsapp:c1:incident_v1:skipped_cap:fuera_de_ventana_demo',
      'whatsapp:c2:incident_v1:skipped_cap:fuera_de_ventana_demo', 'voice:c1:call_v1:skipped_cap:fuera_de_ventana_demo']);
    expect(xs.every((p) => p.skipped_cap)).toBe(true);
  });
  it('tope global de llamadas (06.9): 20/h entre todas las orgs', () => {
    expect(TOPE_GLOBAL_LLAMADAS_HORA).toBe(20);
    const o = (voice: number) => corto(planNotifications(inc(), C, NADA, CAPS, 'none', AHORA, { usoGlobal: { voice } }));
    expect(o(19)).toContain('voice:c1:call_v1:queued');
    expect(o(20)).toContain('voice:c1:call_v1:skipped_cap:cap_global');
    expect(corto(planNotifications(inc(), C, NADA, CAPS, 'none', AHORA, { usoGlobal: { voice: 3 }, topeGlobal: { voice: 3 } })))
      .toContain('voice:c1:call_v1:skipped_cap:cap_global');
  });
  it('sin contactos (o solo con voz en un high) → [] con motivo sin_contactos', () => {
    expect(planAvisos(inc(), [], NADA, CAPS, 'none', AHORA)).toEqual({ envios: [], motivo: 'sin_contactos' });
    const soloVoz: ContactoAviso[] = [{ id: 'v', whatsapp: false, voice: true, priority: 1, verified_at: V }];
    expect(planAvisos(inc({ severity: 'high' }), soloVoz, NADA, CAPS, 'none', AHORA).motivo).toBe('sin_contactos');
    expect(plan(inc(), { c: soloVoz })).toEqual(['voice:v:call_v1:queued']);
  });
  it('no muta la lista de contactos y el orden no depende del de entrada', () => {
    const copia = JSON.stringify(C);
    expect(plan(inc())).toEqual(plan(inc(), { c: [...C].reverse() }));
    expect(JSON.stringify(C)).toBe(copia);
  });
  it('planAvisos con envíos → motivo null', () => {
    expect(planAvisos(inc(), C, NADA, CAPS, 'none', AHORA).motivo).toBeNull();
  });
});

describe('planEscalamiento (P1): critical a los 45 s, high a los 15 min de 07:00 a 22:00 de Caracas', () => {
  const voz: ContactoAviso[] = [
    { id: 'a', whatsapp: true, voice: true, priority: 1, verified_at: V },
    { id: 'b', whatsapp: false, voice: true, priority: 2, verified_at: null },
    { id: 'c', whatsapp: false, voice: true, priority: 3, verified_at: V },
    { id: 'd', whatsapp: false, voice: true, priority: 4, verified_at: V },
  ];
  const crit = { severity: 'critical' as const, status: 'open' as const, acked_at: null, muted_until: null,
    ultimo_aviso: '2026-10-24T19:01:15.000Z' };
  it('critical sin ack: a los 45 s llama al siguiente contacto con voz verificado', () => {
    expect(planEscalamiento(crit, voz, 1, AHORA)).toEqual({ llamar: true, contact_id: 'c' });
    expect(planEscalamiento(crit, voz, 2, AHORA)).toEqual({ llamar: true, contact_id: 'd' });
    expect(planEscalamiento({ ...crit, ultimo_aviso: '2026-10-24T19:01:15.001Z' }, voz, 1, AHORA))
      .toEqual({ llamar: false, motivo: 'temprano' });
    expect(planEscalamiento({ ...crit, ultimo_aviso: null }, voz, 1, AHORA)).toEqual({ llamar: false, motivo: 'temprano' });
  });
  it('se detiene con ack, silencio, mitigado/resuelto, tope por incidente o sin más contactos', () => {
    expect(planEscalamiento({ ...crit, acked_at: '2026-10-24T19:01:30.000Z' }, voz, 1, AHORA)).toMatchObject({ motivo: 'ack' });
    expect(planEscalamiento({ ...crit, muted_until: '2026-10-24T20:00:00.000Z' }, voz, 1, AHORA)).toMatchObject({ motivo: 'muted' });
    expect(planEscalamiento({ ...crit, status: 'mitigated' }, voz, 1, AHORA)).toMatchObject({ motivo: 'resuelto' });
    expect(planEscalamiento({ ...crit, status: 'resolved' }, voz, 1, AHORA)).toMatchObject({ motivo: 'resuelto' });
    expect(planEscalamiento(crit, voz, MAX_LLAMADAS_INCIDENTE, AHORA)).toMatchObject({ motivo: 'tope_incidente' });
    expect(planEscalamiento(crit, voz.slice(0, 2), 1, AHORA)).toMatchObject({ motivo: 'sin_contacto' });
    expect(planEscalamiento({ ...crit, severity: 'medium' }, voz, 0, AHORA)).toMatchObject({ motivo: 'severidad_baja' });
  });
  it('high: una sola llamada, a los 15 min y solo en horario de Caracas', () => {
    const high = (ahora: string) => planEscalamiento({ ...crit, severity: 'high', ultimo_aviso: '2026-10-24T00:00:00.000Z' }, voz, 0,
      new Date(ahora));
    expect(high('2026-10-24T14:00:00.000Z')).toEqual({ llamar: true, contact_id: 'a' });          // 10:00 en Caracas
    expect(high('2026-10-24T11:00:00.000Z')).toEqual({ llamar: true, contact_id: 'a' });          // 07:00
    expect(high('2026-10-24T10:59:00.000Z')).toMatchObject({ motivo: 'fuera_de_horario' });       // 06:59
    expect(high('2026-10-25T01:59:00.000Z')).toEqual({ llamar: true, contact_id: 'a' });          // 21:59
    expect(high('2026-10-25T02:00:00.000Z')).toMatchObject({ motivo: 'fuera_de_horario' });       // 22:00
    expect(planEscalamiento({ ...crit, severity: 'high', ultimo_aviso: '2026-10-24T13:50:00.000Z' }, voz, 0,
      new Date('2026-10-24T14:04:59.000Z'))).toMatchObject({ motivo: 'temprano' });               // 14:59 min
    expect(planEscalamiento({ ...crit, severity: 'high' }, voz, 1, new Date('2026-10-24T14:00:00.000Z')))
      .toMatchObject({ motivo: 'tope_incidente' });
  });
});
