// «Info» de un problema con sus fechas (historial de fallas, 0025): qué dice Vigía según el estado, con el formato de
// lib/formato.ts (hora de Caracas), y que una fecha del servidor que no es fecha no se cita nunca (ni su HTML).
import { describe, expect, it } from 'vitest';
import { elDia } from '@/lib/formato';
import { fechasDeHallazgo, infoDeHallazgo, marcaHallazgo, hallazgoVisto, type DatosHallazgo } from './info-hallazgos';

const AHORA = new Date('2026-10-26T15:00:00.000Z');          // lunes 26-10, 11:00 en Caracas
const ID = 'c3d40000-0000-4000-8000-0000000000f1';
const base: DatosHallazgo = { id: ID, module: 'supabase', rule_id: 'SB_RLS_DISABLED', severity: 'critical', resource: 'public.pedidos',
  first_seen_at: '2026-10-24T18:04:00.000Z' };

describe('elDia', () => {
  it('«el 24-10 a las 14:04» en hora de Caracas; hoy, «hoy a las …»', () => {
    expect(elDia('2026-10-24T18:04:00.000Z', AHORA)).toBe('el 24-10 a las 14:04');
    expect(elDia('2026-10-26T13:30:00.000Z', AHORA)).toBe('hoy a las 09:30');
    expect(elDia('2026-10-25T03:30:00.000Z', AHORA)).toBe('el 24-10 a las 23:30');   // de madrugada en UTC, aún 24 en Caracas
  });
  it('sin fecha válida, null (nada que citar)', () => {
    for (const x of [null, undefined, '', 'mañana', '<img src=x onerror=alert(1)>', '2026-13-45']) expect(elDia(x, AHORA), String(x)).toBeNull();
  });
});

describe('fechasDeHallazgo', () => {
  it('verificado tras marcarlo corregido: la frase del ejemplo', () => {
    expect(fechasDeHallazgo({ ...base, status: 'verified', fixed_at: '2026-10-25T13:12:00.000Z', verified_at: '2026-10-25T19:01:00.000Z' }, AHORA))
      .toBe('Se detectó el 24-10 a las 14:04 y se corrigió el 25-10 a las 09:12; una auditoría lo verificó el 25-10 a las 15:01.');
  });
  it('verificado sin marca a mano', () => {
    expect(fechasDeHallazgo({ ...base, status: 'verified', verified_at: '2026-10-25T19:01:00.000Z' }, AHORA))
      .toBe('Se detectó el 24-10 a las 14:04; una auditoría lo verificó el 25-10 a las 15:01.');
  });
  it('corregido a mano, pendiente de comprobar', () => {
    expect(fechasDeHallazgo({ ...base, status: 'fixed', fixed_at: '2026-10-26T12:15:00.000Z' }, AHORA))
      .toBe('Se detectó el 24-10 a las 14:04 y se marcó corregido hoy a las 08:15; falta que una auditoría lo compruebe.');
  });
  it('abierto: desde cuándo; si reapareció, cuándo', () => {
    expect(fechasDeHallazgo({ ...base, status: 'open' }, AHORA)).toBe('Se detectó el 24-10 a las 14:04 y sigue abierto.');
    expect(fechasDeHallazgo({ ...base, status: 'open', reopened_at: '2026-10-25T18:02:05.000Z' }, AHORA))
      .toBe('Se detectó el 24-10 a las 14:04 y sigue abierto: reapareció el 25-10 a las 14:02, después de corregirse.');
  });
  it('ignorado', () => {
    expect(fechasDeHallazgo({ ...base, status: 'ignored', ignored_at: '2026-10-25T01:10:00.000Z' }, AHORA))
      .toBe('Se detectó el 24-10 a las 14:04 y se ignoró el 24-10 a las 21:10: ya no cuenta en tu puntaje.');
  });
  it('sin fechas: nada para un abierto; para uno cerrado, el estado sin inventar fechas', () => {
    expect(fechasDeHallazgo({ id: ID, status: 'open' }, AHORA)).toBeNull();
    expect(fechasDeHallazgo({ id: ID, status: 'verified' }, AHORA)).toBe('Una auditoría verificó que ya no está.');
    expect(fechasDeHallazgo({ id: ID }, AHORA)).toBeNull();
  });
  it('XSS: una «fecha» con HTML no se cita, ni sale ningún < o >', () => {
    const malo = '<img src=x onerror=alert(1)>';
    const t = fechasDeHallazgo({ ...base, status: 'verified', first_seen_at: malo, fixed_at: malo, verified_at: '2026-10-25T19:01:00.000Z' }, AHORA);
    expect(t).toBe('Una auditoría lo verificó el 25-10 a las 15:01.');
    const info = infoDeHallazgo({ ...base, resource: '<script>alert(1)</script>', status: 'open', first_seen_at: malo, reopened_at: malo }, AHORA);
    expect(info.texto).not.toMatch(/onerror|<img/);
    expect(info.texto).toContain('«<script>alert(1)</script>»');   // el recurso va como texto (React lo escapa), nunca como HTML
  });
});

describe('infoDeHallazgo con fechas', () => {
  it('cerrado: qué era, dónde y sus fechas, sin meter prisa', () => {
    const t = infoDeHallazgo({ ...base, status: 'verified', verified_at: '2026-10-25T19:01:00.000Z' }, AHORA).texto;
    expect(t).toContain('«public.pedidos»');
    expect(t).toContain('una auditoría lo verificó el 25-10 a las 15:01.');
    expect(t).not.toContain('arréglalo hoy');
  });
  it('abierto: también la prisa', () => {
    expect(infoDeHallazgo({ ...base, status: 'open' }, AHORA).texto).toMatch(/sigue abierto\. Gravedad crítica: arréglalo hoy\.$/);
  });
  it('marcaHallazgo guarda las fechas de la fila (y solo los campos conocidos)', () => {
    marcaHallazgo({ ...base, status: 'fixed', fixed_at: '2026-10-25T13:12:00.000Z', title: 'x', evidence: { a: 1 } } as DatosHallazgo);
    const v = hallazgoVisto(ID)!;
    expect(v).toMatchObject({ fixed_at: '2026-10-25T13:12:00.000Z', first_seen_at: base.first_seen_at, status: 'fixed' });
    expect(v).not.toHaveProperty('title');
    expect(v).not.toHaveProperty('evidence');
  });
});
