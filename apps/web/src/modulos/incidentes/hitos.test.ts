import { describe, expect, it } from 'vitest';
import { fixtures as fx, type IncidentDetail } from '@vanguard/contracts';
import { finDe, hitosDe } from './hitos';

const detalle = fx.incidentDetail as unknown as IncidentDetail;

describe('hitosDe con la historia de los fixtures (A9)', () => {
  it('WhatsApp a +8,4 s, crítica a +26,1 s y llamada a +27,5 s', () => {
    const h = Object.fromEntries(hitosDe(detalle).map((x) => [x.clave, x.mas]));
    expect(h.detected).toBe('+6,1 s');
    expect(h.whatsapp).toBe('+8,4 s');
    expect(h.critical).toBe('+26,1 s');
    expect(h.call).toBe('+27,5 s');
    expect(h.ack).toBe('—');
    expect(h.blocked).toBe('—');
  });
  it('sin severity_up ni llamada, esos hitos no aparecen (nunca un «—» que parezca fallo)', () => {
    const sin = { ...detalle, timeline: detalle.timeline.filter((t) => t.kind !== 'severity_up' && t.kind !== 'call_started'),
      notifications: detalle.notifications.filter((n) => n.channel !== 'voice') };
    const claves = hitosDe(sin).map((x) => x.clave);
    expect(claves).not.toContain('critical');
    expect(claves).not.toContain('call');
    expect(claves).toContain('whatsapp');
  });
  it('el cronómetro corre mientras no hay bloqueo', () => {
    expect(finDe(detalle)).toBeNull();
  });
});
