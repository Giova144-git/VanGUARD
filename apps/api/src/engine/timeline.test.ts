import { describe, expect, it } from 'vitest';
import { TimelineItem } from '@vanguard/contracts';
import { armarTimeline, type AccionTimeline, type IncidenteTimeline, type NotificacionTimeline } from './timeline.ts';

const T0 = Date.parse('2026-10-24T19:01:00.000Z');
const pg = (ms: number) => new Date(T0 + ms).toISOString().replace('Z', '+00:00');   // como llega de Postgres
const C1 = '+58•••0001';
const C2 = '+58•••0002';

const base: IncidenteTimeline = {
  rule_ids: ['CF_UA_TOOL', 'CF_PATH_SCAN', 'CF_ADMIN_EXPOSED'], severity: 'critical', started_at: pg(0),
  details: { ip: '186.92.14.7', detected_at: pg(6_100), severity_up_at: pg(26_100) },
  acked_at: null, acked_via: null, muted_until: null, mitigated_at: null, resolved_at: null,
};
const wa = (o: Partial<NotificacionTimeline>): NotificacionTimeline => ({ channel: 'whatsapp', recipient_masked: C1, status: 'sent',
  created_at: pg(7_900), sent_at: null, delivered_at: null, read_at: null, ...o });

describe('armarTimeline (E17 detalle)', () => {
  it('el guion de la demo: hitos en orden, ms desde attack_start, fechas en …Z y válido contra TimelineItem', () => {
    const notifs = [
      // Llegan en cualquier orden: cuenta el primer sent/delivered/read de las WhatsApp.
      wa({ recipient_masked: C2, sent_at: pg(8_700), delivered_at: pg(10_200), status: 'delivered' }),
      wa({ sent_at: pg(8_400), delivered_at: pg(9_600), read_at: pg(14_000), status: 'read' }),
      wa({ created_at: pg(26_300), sent_at: pg(26_700) }),                 // incident_up_v1: no mueve whatsapp_sent
      { channel: 'voice', recipient_masked: C1, status: 'sent', created_at: pg(26_400), sent_at: pg(27_500), delivered_at: null, read_at: null },
    ];
    const acciones: AccionTimeline[] = [{ kind: 'block_ip', status: 'executed', created_at: pg(64_000), undone_at: null }];
    const t = armarTimeline({ ...base, acked_at: pg(40_000), acked_via: 'whatsapp', mitigated_at: pg(64_100) }, notifs, acciones, pg(50_000));
    expect(t.map((x) => TimelineItem.parse(x))).toEqual(t);
    expect(t.map((x) => [x.kind, x.ms])).toEqual([
      ['attack_start', 0], ['detected', 6_100], ['whatsapp_sent', 8_400], ['whatsapp_delivered', 9_600], ['whatsapp_read', 14_000],
      ['severity_up', 26_100], ['call_started', 27_500], ['ack', 40_000], ['action_proposed', 50_000], ['action_executed', 64_000],
      ['mitigated', 64_100]]);
    expect(t[0]).toEqual({ t: '2026-10-24T19:01:00.000Z', ms: 0, kind: 'attack_start', label: 'Primera petición del atacante' });
    const label = (k: string) => t.find((x) => x.kind === k)?.label;
    // La regla de la subida va en severity_up; detected nombra las de antes.
    expect(label('detected')).toBe('Reglas CF_UA_TOOL y CF_PATH_SCAN');
    expect(label('severity_up')).toBe('Sube a crítica: CF_ADMIN_EXPOSED');
    expect(label('whatsapp_sent')).toBe(`WhatsApp a ${C1}`);
    expect(label('whatsapp_read')).toBe('WhatsApp visto (no es confirmación)');
    expect(label('call_started')).toBe(`Llamada a ${C1}`);
    expect(label('ack')).toBe('Confirmado por WhatsApp');
    expect(label('action_executed')).toBe('IP bloqueada 1 h');
  });

  it('un hito sin dato no se emite: recién detectado solo trae attack_start y detected', () => {
    const t = armarTimeline({ ...base, rule_ids: ['CF_UA_TOOL'], severity: 'high', details: { detected_at: pg(5_000) } }, [], []);
    expect(t).toEqual([
      { t: '2026-10-24T19:01:00.000Z', ms: 0, kind: 'attack_start', label: 'Primera petición del atacante' },
      { t: '2026-10-24T19:01:05.000Z', ms: 5_000, kind: 'detected', label: 'Regla CF_UA_TOOL' },
    ]);
    // Filas queued o failed sin sent_at no cuentan como whatsapp_sent.
    expect(armarTimeline(base, [wa({ status: 'failed' }), wa({ status: 'queued' })], []).some((x) => x.kind.startsWith('whatsapp')))
      .toBe(false);
  });

  it('voz fallida, silencio, bloqueo deshecho y cierre por housekeeping', () => {
    const t = armarTimeline({ ...base, details: { ...base.details, muted_at: pg(30_000) }, muted_until: pg(30_000 + 3_600_000),
      acked_at: pg(20_000), acked_via: 'in_app', resolved_at: pg(1_000_000) },
    [{ channel: 'voice', recipient_masked: C1, status: 'failed', created_at: pg(27_000), sent_at: null, delivered_at: null, read_at: null }],
    [{ kind: 'block_ip', status: 'undone', created_at: pg(64_000), undone_at: pg(90_000) },
      { kind: 'block_ip', status: 'failed', created_at: pg(63_000), undone_at: null }]);
    const kinds = t.map((x) => x.kind);
    expect(kinds).toEqual(['attack_start', 'detected', 'ack', 'severity_up', 'call_failed', 'muted', 'action_executed', 'action_undone',
      'resolved']);
    expect(kinds).not.toContain('call_started');
    const label = (k: string) => t.find((x) => x.kind === k)?.label;
    expect(label('ack')).toBe('Confirmado desde la app');
    expect(label('muted')).toMatch(/^Silenciado hasta las \d{2}:\d{2}$/);
    expect(label('call_failed')).toBe(`La llamada a ${C1} no salió`);
    expect(label('action_undone')).toBe('Bloqueo retirado');
    expect(label('resolved')).toBe('Resuelto: 15 min sin peticiones de esa IP');
  });

  it('started_at ilegible → []; marcas ilegibles se saltan; nunca ms negativos; empates por el orden del flujo', () => {
    expect(armarTimeline({ ...base, started_at: 'no-es-fecha' }, [], [])).toEqual([]);
    const t = armarTimeline({ ...base, details: { detected_at: 'x', severity_up_at: 12 }, acked_at: pg(-5_000), acked_via: 'voice',
      mitigated_at: pg(0) }, [], []);
    expect(t.map((x) => [x.kind, x.ms])).toEqual([['ack', 0], ['attack_start', 0], ['mitigated', 0]]);
    expect(t.find((x) => x.kind === 'ack')?.label).toBe('Confirmado por teléfono');
    // SB_: sin «atacante».
    expect(armarTimeline({ ...base, rule_ids: ['SB_DB_DOWN'], details: {} }, [], [])[0]?.label).toBe('Inicio del incidente');
  });
});
