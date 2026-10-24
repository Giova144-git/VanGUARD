import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { CRON_MINUTO, onCron } from './cron.ts';
import { runJob, type JobMsg } from './jobs.ts';
import { log } from './lib/log.ts';

// El mismo app de Hono en Node 24 (:8787) con dobles de bindings (R17 §11.4): la cola corre en línea y en serie,
// sin reintentos, y un setInterval de 60 s hace de cron por minuto. Los valores salen de .dev.vars vía --env-file.
const PUERTO = 8787;

const pasa: RateLimit = { limit: async () => ({ success: true }) };

function mensaje(body: JobMsg): Message<JobMsg> {
  return { id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1, ack() {}, retry() {} } as Message<JobMsg>;
}

const env = { ...process.env, VG_ENV: process.env.VG_ENV ?? 'local', RL_API: pasa, RL_COSTLY: pasa, RL_INGEST: pasa } as
  unknown as CloudflareBindings;
env.JOBS_Q = {
  async send(body: JobMsg) { await runJob(env, mensaje(body)); },
  async sendBatch(msgs: Iterable<{ body: JobMsg }>) { for (const m of msgs) await runJob(env, mensaje(m.body)); },
} as unknown as Queue<JobMsg>;

const ctx = {
  waitUntil(p: Promise<unknown>) { p.catch((e: unknown) => log('error', 'dev.waituntil', { name: (e as Error)?.name })); },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

serve({ fetch: (req) => app.fetch(req, env, ctx), port: PUERTO });
setInterval(() => void onCron(CRON_MINUTO, env), 60_000);
log('info', 'dev.escuchando', { url: `http://localhost:${PUERTO}` });
