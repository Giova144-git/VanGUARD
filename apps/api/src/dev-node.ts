import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { CRON_MINUTO, onCron } from './cron.ts';
import { colaEnSerie, type JobMsg } from './jobs.ts';
import { log } from './lib/log.ts';
import './scans/index.ts';   // registra los pasos de la cola vg-jobs

// El mismo app de Hono en Node 24 (:8787) con dobles de bindings (R17 §11.4): la cola es una FIFO local que corre los
// pasos en serie, uno tras otro y nunca anidados (S15.8 regla 10), con los reintentos de vg-jobs (attempts+1 tras su
// delaySeconds, max_retries 3 y luego la DLQ), y un setInterval de 60 s hace de cron por minuto. Los valores salen de
// .dev.vars vía --env-file.
const PUERTO = 8787;

const pasa: RateLimit = { limit: async () => ({ success: true }) };

const env = { ...process.env, VG_ENV: process.env.VG_ENV ?? 'local', RL_API: pasa, RL_COSTLY: pasa, RL_INGEST: pasa, RL_WA: pasa } as
  unknown as CloudflareBindings;
env.JOBS_Q = colaEnSerie(env, (e) => log('error', 'dev.job_error', { name: (e as Error)?.name })) as unknown as Queue<JobMsg>;

const ctx = {
  waitUntil(p: Promise<unknown>) { p.catch((e: unknown) => log('error', 'dev.waituntil', { name: (e as Error)?.name })); },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

serve({ fetch: (req) => app.fetch(req, env, ctx), port: PUERTO });
setInterval(() => void onCron(CRON_MINUTO, env), 60_000);
log('info', 'dev.escuchando', { url: `http://localhost:${PUERTO}` });
