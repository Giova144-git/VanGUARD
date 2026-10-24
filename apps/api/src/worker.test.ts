import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './worker.ts';
import { CRON_DIA, CRON_HORA, CRON_MINUTO } from './cron.ts';
import { HUMO_FETCHES } from './humo.ts';
import type { JobMsg } from './jobs.ts';
import { envDoble, mensajeDoble } from './test/dobles.ts';

function lote(queue: string, body: JobMsg) {
  const m = mensajeDoble(body);
  return { m, batch: { queue, messages: [m], metadata: {}, retryAll() {}, ackAll() {} } as unknown as MessageBatch<JobMsg> };
}

const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('queue()', () => {
  it('humo: un mensaje hace 40 fetch a OSV dentro de su invocación y se confirma', async () => {
    const f = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { m, batch } = lote('vg-jobs', { v: 1, kind: 'humo', i: 1, fetches: HUMO_FETCHES });
    await worker.queue(batch, envDoble().env);
    expect(f).toHaveBeenCalledTimes(40);
    expect(f.mock.calls.every((c) => String(c[0]) === 'https://api.osv.dev/v1/query')).toBe(true);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('un fallo de OSV no tumba el paso: se cuenta y se confirma igual', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('red'); }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { m, batch } = lote('vg-jobs', { v: 1, kind: 'humo', i: 2, fetches: HUMO_FETCHES });
    await worker.queue(batch, envDoble().env);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it('la DLQ se distingue por batch.queue y confirma sin ejecutar el paso', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { m, batch } = lote('vg-jobs-dlq', { v: 1, kind: 'humo', i: 3, fetches: HUMO_FETCHES });
    await worker.queue(batch, envDoble().env);
    expect(f).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalledOnce();
  });
});

describe('scheduled()', () => {
  it('los 3 crons de 15.7 corren dentro de waitUntil sin lanzar', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const cron of [CRON_MINUTO, CRON_HORA, CRON_DIA]) {
      const c = ctx();
      worker.scheduled({ cron, scheduledTime: Date.UTC(2026, 9, 24, 14, 0), noRetry() {} } as ScheduledController,
        envDoble().env, c);
      await (c.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    }
    const eventos = logs.mock.calls.map((a) => JSON.parse(String(a[0])).event);
    expect(eventos).toEqual(['monitor.minuto', 'mantenimiento.hora', 'reauditoria.dia']);
  });
});
