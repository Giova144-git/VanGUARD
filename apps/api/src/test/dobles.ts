import { vi } from 'vitest';
import type { JobMsg } from '../jobs.ts';

// Dobles de bindings para app.request(ruta, init, env) de Hono y para los manejadores del Worker (S15 15.13).
export function envDoble(extra: Partial<CloudflareBindings> = {}) {
  const pasa: RateLimit = { limit: async () => ({ success: true }) };
  const enviados: JobMsg[] = [];
  const cola = {
    send: vi.fn(async (body: JobMsg) => { enviados.push(body); }),
    sendBatch: vi.fn(async (msgs: Iterable<{ body: JobMsg }>) => { for (const m of msgs) enviados.push(m.body); }),
  };
  const env = { RL_API: pasa, RL_COSTLY: pasa, RL_INGEST: pasa, JOBS_Q: cola, ...extra } as unknown as CloudflareBindings;
  return { env, cola, enviados };
}

export function mensajeDoble(body: JobMsg) {
  const m = { id: 'm1', timestamp: new Date(), body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  return m as typeof m & Message<JobMsg>;
}
