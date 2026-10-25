// Línea de tiempo de una falla (historial.ts) y el historial de la demo (fixtures/historial.ts).
import { describe, expect, it } from 'vitest';
import { eventosDeFalla, fixtures as fx, FindingTimeline, MAX_EVENTOS, ultimoCambio, type FindingHistoryItem, type FixRequest } from './index.ts';
import * as ids from './fixtures/ids.ts';

const ID = 'f0000000-0000-4000-8000-0000000000ff';
const base: FindingHistoryItem = {
  id: ID, module: 'supabase', rule_id: 'SB_RLS_DISABLED', severity: 'critical', title: 'RLS', resource: 'public.x',
  status: 'open', status_reason: null, connection_id: null, first_seen_at: '2026-10-21T18:00:00.000Z',
  last_seen_at: '2026-10-24T18:00:00.000Z', fixed_at: null, verified_at: null, ignored_at: null, reopened_at: null,
  reopen_count: 0, changed_at: '2026-10-21T18:00:00.000Z',
};
const tipos = (f: FindingHistoryItem, envios: FixRequest[] = [], fotos?: { nuevo: string[]; corregido: string[] }) =>
  eventosDeFalla(f, envios, fotos).map((e) => e.kind);

describe('eventosDeFalla', () => {
  it('abierta sin nada más: detectada y vista', () => {
    expect(tipos(base)).toEqual(['detectado', 'visto']);
  });

  it('marcada corregida y verificada después, en orden de fecha', () => {
    const f = { ...base, status: 'verified' as const, last_seen_at: '2026-10-22T18:00:00.000Z',
      fixed_at: '2026-10-23T09:00:00.000Z', verified_at: '2026-10-23T18:00:00.000Z' };
    expect(tipos(f)).toEqual(['detectado', 'visto', 'corregido', 'verificado']);
  });

  it('la cola de su IA: enviada, arreglando y cancelada; las de otra falla no cuentan', () => {
    const envios: FixRequest[] = [
      { id: ids.FIX_REQ_ENVIADO, finding_id: ID, status: 'cancelado', client: 'vscode', created_at: '2026-10-22T10:00:00.000Z',
        started_at: '2026-10-22T10:01:00.000Z', closed_at: '2026-10-22T11:00:00.000Z' },
      { id: ids.FIX_REQ_ARREGLANDO, finding_id: ids.F_CB_ENV, status: 'enviado', client: null, created_at: '2026-10-22T10:00:00.000Z',
        started_at: null, closed_at: null },
    ];
    const ev = eventosDeFalla(base, envios);
    expect(ev.map((e) => e.kind)).toEqual(['detectado', 'enviado_ia', 'arreglando', 'envio_cancelado', 'visto']);
    expect(ev[1]!.client).toBe('vscode');
  });

  it('reapareció: la foto que la vio nueva tras otra que ya no la vio; reopened_at manda sobre la foto del mismo cambio', () => {
    const f = { ...base, last_seen_at: '2026-10-24T18:00:10.000Z', reopened_at: '2026-10-24T18:00:10.000Z', reopen_count: 1 };
    const ev = eventosDeFalla(f, [], { nuevo: ['2026-10-24T18:04:00.000Z'], corregido: ['2026-10-22T18:00:00.000Z'] });
    expect(ev.map((e) => e.kind)).toEqual(['detectado', 'salio', 'reaparecido', 'visto']);
    expect(ev.find((e) => e.kind === 'reaparecido')!.at).toBe('2026-10-24T18:00:10.000Z');
    expect(ev.find((e) => e.kind === 'salio')!.at).toBe('2026-10-22T18:00:00.000Z');
  });

  it('una foto nueva sin salida antes no es una reaparición; reopened_at sin foto (un push) se añade igual', () => {
    expect(tipos(base, [], { nuevo: ['2026-10-21T18:00:00.000Z'], corregido: [] })).toEqual(['detectado', 'visto']);
    const f = { ...base, fixed_at: '2026-10-22T09:00:00.000Z', reopened_at: '2026-10-23T12:00:00.000Z', reopen_count: 1 };
    expect(tipos(f)).toEqual(['detectado', 'corregido', 'reaparecido', 'visto']);
  });

  it('el ciclo con su fecha de corregido no repite la salida de la foto', () => {
    const f = { ...base, fixed_at: '2026-10-22T09:00:00.000Z', reopened_at: '2026-10-24T18:00:00.000Z', reopen_count: 1 };
    expect(tipos(f, [], { nuevo: ['2026-10-24T18:01:00.000Z'], corregido: ['2026-10-22T18:00:00.000Z'] }))
      .toEqual(['detectado', 'corregido', 'reaparecido', 'visto']);
  });

  it('fechas que no son fechas no entran (ni el HTML de un servidor roto)', () => {
    const f = { ...base, fixed_at: '<img src=x onerror=alert(1)>', verified_at: 'mañana' };
    expect(tipos(f)).toEqual(['detectado', 'visto']);
  });

  it('como mucho MAX_EVENTOS, los más recientes', () => {
    const envios = Array.from({ length: 60 }, (_, i): FixRequest => ({ id: ids.FIX_REQ_ENVIADO, finding_id: ID, status: 'cancelado',
      client: null, created_at: new Date(Date.parse('2026-10-22T00:00:00Z') + i * 60_000).toISOString(),
      started_at: null, closed_at: new Date(Date.parse('2026-10-22T00:00:30Z') + i * 60_000).toISOString() }));
    const ev = eventosDeFalla(base, envios);
    expect(ev).toHaveLength(MAX_EVENTOS);
    expect(ev.at(-1)!.kind).toBe('visto');
  });

  it('ultimoCambio: la fecha más reciente de la fila', () => {
    expect(ultimoCambio({ ...base, fixed_at: '2026-10-23T09:00:00.000Z', verified_at: '2026-10-22T09:00:00.000Z' }))
      .toBe('2026-10-23T09:00:00.000Z');
    expect(ultimoCambio(base)).toBe(base.first_seen_at);
  });
});

describe('historial de la demo', () => {
  const h = fx.historialFallas;
  it('trae fallas en los cuatro estados, ordenadas del último cambio al más viejo', () => {
    expect(new Set(h.map((f) => f.status))).toEqual(new Set(['open', 'fixed', 'verified', 'ignored']));
    for (let i = 1; i < h.length; i++) expect(Date.parse(h[i - 1]!.changed_at)).toBeGreaterThanOrEqual(Date.parse(h[i]!.changed_at));
    expect(new Set(h.map((f) => f.id)).size).toBe(h.length);
  });

  it('cada fecha cuadra con su estado y nunca va antes de detectarla', () => {
    for (const f of h) {
      const t0 = Date.parse(f.first_seen_at);
      for (const t of [f.fixed_at, f.verified_at, f.ignored_at, f.reopened_at]) if (t) expect(Date.parse(t), f.id).toBeGreaterThanOrEqual(t0);
      if (f.status === 'verified') expect(f.verified_at, f.id).not.toBeNull();
      if (f.status === 'fixed') expect(f.fixed_at, f.id).not.toBeNull();
      if (f.status === 'ignored') expect(f.ignored_at, f.id).not.toBeNull();
      expect(f.reopen_count > 0, f.id).toBe(f.reopened_at !== null);
    }
  });

  it('la línea de la regresión: detectada, salió el jueves, reapareció el sábado', () => {
    expect(FindingTimeline.safeParse(fx.lineaTiempoFalla).success).toBe(true);
    expect(fx.lineaTiempoFalla.events.map((e) => e.kind)).toEqual(['detectado', 'salio', 'reaparecido', 'visto']);
  });
});
