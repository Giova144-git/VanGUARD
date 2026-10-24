import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

// Doble fiel a supabase-js 2.118 donde importa (verificado en RealtimeClient/RealtimeChannel y phoenix):
// - channel(nombre) devuelve el MISMO canal mientras no se haya quitado (dedupe por topic);
// - subscribe() sobre un canal ya suscrito no registra el callback nuevo;
// - removeChannel() dispara CLOSED de forma síncrona y saca el canal de la lista.
type Canal = { topic: string; cb?: (e: string) => void; on: () => Canal; subscribe: (cb: (e: string) => void) => Canal };
const vivos: Canal[] = [];
const creados: Canal[] = [];
const quitados: Canal[] = [];
const falla = { channel: false };
vi.mock('./supabase', () => ({
  supabase: {
    realtime: { setAuth: vi.fn(async () => {}) },
    getChannels: () => [...vivos],
    channel: (nombre: string) => {
      if (falla.channel) throw new Error('boom');
      const topic = `realtime:${nombre}`;
      const ya = vivos.find((c) => c.topic === topic);
      if (ya) return ya;
      const c: Canal = { topic, on: () => c, subscribe: (cb) => { if (!c.cb) c.cb = cb; return c; } };
      vivos.push(c); creados.push(c);
      return c;
    },
    removeChannel: vi.fn(async (c: Canal) => {
      const i = vivos.indexOf(c);
      if (i >= 0) vivos.splice(i, 1);
      quitados.push(c);
      c.cb?.('CLOSED');
      return 'ok';
    }),
  },
}));

const { suscribirOrg, BACKOFF_MS, ESTABLE_MS, TODO } = await import('./realtime');
const qc = () => ({ invalidateQueries: vi.fn() }) as unknown as QueryClient & { invalidateQueries: ReturnType<typeof vi.fn> };
const microtareas = () => vi.advanceTimersByTimeAsync(0);

describe('suscribirOrg', () => {
  beforeEach(() => { vi.useFakeTimers(); vivos.length = 0; creados.length = 0; quitados.length = 0; falla.channel = false; });
  afterEach(() => vi.useRealTimers());

  it('se suscribe al canal privado org:<id> y al entrar invalida todo una vez', async () => {
    const cambios: boolean[] = [];
    const q = qc();
    const cerrar = suscribirOrg('org1', q, (v) => cambios.push(v));
    await microtareas();
    expect(creados.map((c) => c.topic)).toEqual(['realtime:org:org1']);
    creados[0]!.cb!('SUBSCRIBED');
    expect(cambios).toEqual([true]);
    expect(q.invalidateQueries).toHaveBeenCalledTimes(TODO.length);
    cerrar();
  });

  it('CHANNEL_ERROR pasa al respaldo y deja el reintento a phoenix: mismo canal, sin quitarlo ni crear otro', async () => {
    const cambios: boolean[] = [];
    const cerrar = suscribirOrg('org1', qc(), (v) => cambios.push(v));
    await microtareas();
    creados[0]!.cb!('CHANNEL_ERROR');
    expect(cambios).toEqual([false]);
    creados[0]!.cb!('SUBSCRIBED');                           // phoenix lo volvió a unir
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[BACKOFF_MS.length - 1]! * 2);
    expect(cambios).toEqual([false, true]);
    expect(quitados).toHaveLength(0);
    expect(creados).toHaveLength(1);
    cerrar();
  });

  it('SUBSCRIBED → TIMED_OUT → SUBSCRIBED vuelve a invalidar todo al reentrar', async () => {
    const q = qc();
    const cerrar = suscribirOrg('org1', q, () => {});
    await microtareas();
    creados[0]!.cb!('SUBSCRIBED');
    creados[0]!.cb!('TIMED_OUT');
    creados[0]!.cb!('SUBSCRIBED');
    expect(q.invalidateQueries).toHaveBeenCalledTimes(TODO.length * 2);
    cerrar();
  });

  it('un CLOSED espontáneo crea un canal nuevo con backoff creciente', async () => {
    const cambios: boolean[] = [];
    const cerrar = suscribirOrg('org1', qc(), (v) => cambios.push(v));
    await microtareas();
    creados[0]!.cb!('SUBSCRIBED');
    creados[0]!.cb!('CLOSED');
    expect(cambios).toEqual([true, false]);
    expect(quitados).toEqual([creados[0]]);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]!);
    expect(creados).toHaveLength(2);
    creados[1]!.cb!('CLOSED');                               // vuelve a cerrarse antes de entrar: espera más
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]!);
    expect(creados).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[1]! - BACKOFF_MS[0]!);
    expect(creados).toHaveLength(3);
    creados[2]!.cb!('SUBSCRIBED');
    expect(cambios.at(-1)).toBe(true);
    cerrar();
  });

  it('StrictMode (montar, limpiar, montar sin esperar): la segunda montura tiene su canal y entra', async () => {
    const a: boolean[] = [], b: boolean[] = [];
    const cerrarA = suscribirOrg('org1', qc(), (v) => a.push(v));
    cerrarA();                                               // limpieza síncrona, antes de que resuelva setAuth
    const cerrarB = suscribirOrg('org1', qc(), (v) => b.push(v));
    await microtareas();
    expect(creados).toHaveLength(1);                         // A no llegó a crear canal
    creados[0]!.cb!('SUBSCRIBED');
    expect(b).toEqual([true]);
    expect(a).toEqual([]);
    cerrarB();
  });

  it('dos suscripciones vivas a la misma org no se quitan el canal la una a la otra', async () => {
    const cerrarA = suscribirOrg('org1', qc(), () => {});
    const cerrarB = suscribirOrg('org1', qc(), () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quitados).toHaveLength(0);
    expect(creados).toHaveLength(1);
    cerrarA(); cerrarB();
  });

  it('un SUBSCRIBED fugaz no reinicia el backoff; 30 s estables sí', async () => {
    const cerrar = suscribirOrg('org1', qc(), () => {});
    await microtareas();
    creados[0]!.cb!('CLOSED');
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]!);
    expect(creados).toHaveLength(2);
    creados[1]!.cb!('SUBSCRIBED');
    creados[1]!.cb!('CLOSED');                               // acepta y cierra enseguida
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]!);
    expect(creados).toHaveLength(2);                         // sigue subiendo: espera BACKOFF_MS[1]
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[1]! - BACKOFF_MS[0]!);
    expect(creados).toHaveLength(3);
    creados[2]!.cb!('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(ESTABLE_MS);           // aguanta 30 s
    creados[2]!.cb!('CLOSED');
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]!);
    expect(creados).toHaveLength(4);                         // vuelve a empezar por BACKOFF_MS[0]
    cerrar();
  });

  it('al desmontar con un reintento pendiente no crea más canales ni avisa', async () => {
    const cambios: boolean[] = [];
    const cerrar = suscribirOrg('org1', qc(), (v) => cambios.push(v));
    await microtareas();
    creados[0]!.cb!('CLOSED');
    cerrar();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(creados).toHaveLength(1);
    expect(cambios).toEqual([false]);
  });

  it('si crear el canal lanza, avisa del respaldo y reintenta', async () => {
    falla.channel = true;
    const cambios: boolean[] = [];
    const cerrar = suscribirOrg('org1', qc(), (v) => cambios.push(v));
    await microtareas();
    expect(cambios).toEqual([false]);
    falla.channel = false;
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]!);
    expect(creados).toHaveLength(1);
    cerrar();
  });

  it('canal mudo: a los 10 s avisa que va por el respaldo', async () => {
    const cambios: boolean[] = [];
    const cerrar = suscribirOrg('org1', qc(), (v) => cambios.push(v));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cambios).toEqual([false]);
    cerrar();
  });
});
