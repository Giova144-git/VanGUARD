// Clic derecho sobre una falla del historial (0025): «Ver historial» abre su línea de tiempo, «Info» cuenta sus fechas
// (sacadas del historial en caché: E13t o una lista de E13h) y «Enviar a mi IA» sigue solo para las abiertas.
import { describe, expect, it, vi } from 'vitest';
import { fixtures as fx, type FindingHistoryItem } from '@vanguard/contracts';
import type { Dicho } from './contexto';
import { ACCIONES, datosHallazgo, type Contexto } from './MenuContextual';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const ORG = 'b1000000-0000-4000-8000-000000000001';
const verificada = fx.historialFallas.find((f) => f.status === 'verified' && f.fixed_at) as FindingHistoryItem;
const elemento = { closest: () => null } as unknown as HTMLElement;
const accion = (id: string) => ACCIONES.find((a) => a.id === id)!;
const visibles = (c: Contexto) => ACCIONES.filter((a) => !a.disponible || a.disponible(c)).map((a) => a.id);
const qc = (falla?: unknown, listas: [readonly unknown[], unknown][] = []) => ({
  getQueryData: (k: readonly unknown[]) => (k[2] === 'history' && k[3] === 'falla' ? falla : undefined),
  getQueriesData: ({ queryKey }: { queryKey: readonly unknown[] }) => listas.filter(([k]) => queryKey.every((x, i) => k[i] === x)),
}) as never;

describe('datosHallazgo · fechas del historial', () => {
  it('de la línea de tiempo (E13t) en caché', () => {
    const d = datosHallazgo(qc({ item: verificada, events: [] }), ORG, verificada.id);
    expect(d).toMatchObject({ status: 'verified', first_seen_at: verificada.first_seen_at, fixed_at: verificada.fixed_at,
      verified_at: verificada.verified_at });
  });
  it('de una lista del historial (E13h); las listas de E13 no se confunden con ellas', () => {
    const d = datosHallazgo(qc(undefined, [[['org', ORG, 'history', 'lista', {}], fx.historialFallas]]), ORG, verificada.id);
    expect(d.fixed_at).toBe(verificada.fixed_at);
    expect(d.rule_id).toBe(verificada.rule_id);
  });
});

describe('ACCIONES · historial', () => {
  const ctx = (o: Partial<Contexto> = {}): Contexto => ({ elemento, id: null, guia: { decir: vi.fn<(d: Dicho) => void>() },
    hallazgo: { id: verificada.id, ...verificada }, verHistorial: vi.fn(), ...o });

  it('«Ver historial» sale en un problema con la acción del menú y abre su línea de tiempo', () => {
    const c = ctx();
    expect(visibles(c)).toEqual(['info', 'enviar-ia', 'ver-historial']);
    accion('ver-historial').hacer(c);
    expect(c.verHistorial).toHaveBeenCalledExactlyOnceWith(verificada.id);
    expect(visibles(ctx({ verHistorial: undefined }))).not.toContain('ver-historial');
    expect(visibles({ elemento, id: 'historial-fallas', guia: { decir: vi.fn() } })).toEqual(['info']);
  });

  it('«Info» de una verificada dice qué era y sus fechas; «Enviar a mi IA» sale apagada', () => {
    const c = ctx({ ia: { bloqueo: null, envioDe: () => null, repoDe: () => null, enviarYAbrir: vi.fn(), cancelar: vi.fn() } });
    accion('info').hacer(c);
    const dicho = vi.mocked(c.guia.decir).mock.calls[0]![0];
    expect(dicho.texto).toMatch(/Se detectó (?:hoy|ayer|el \d\d-[a-z]{3}(?:-\d{4})?) a las \d\d:\d\d y se corrigió (?:hoy|ayer|el \d\d-[a-z]{3}(?:-\d{4})?) a las \d\d:\d\d; una auditoría lo verificó (?:hoy|ayer|el \d\d-[a-z]{3}(?:-\d{4})?) a las \d\d:\d\d\./);
    expect(accion('enviar-ia').deshabilitada?.(c)).toBe('Ya no está abierto');
  });
});
