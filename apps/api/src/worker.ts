import { app } from './app.ts';
import { onCron } from './cron.ts';
import { cierreDlq, runJob, type JobMsg } from './jobs.ts';

// Entrada del Worker `vanguard` (S15 15.2). Sin tail(): en Free no hay Tail Workers (A7.6).
const COLA_DLQ = 'vg-jobs-dlq';

export default {
  fetch: app.fetch,

  scheduled(controller, env, ctx) {
    ctx.waitUntil(onCron(controller.cron, env, new Date(controller.scheduledTime)));
  },

  // max_batch_size 1: cada paso tiene su propia invocación con sus 10 ms de CPU y sus 50 subpeticiones.
  async queue(batch, env) {
    for (const m of batch.messages) {
      if (batch.queue === COLA_DLQ) await cierreDlq(env, m);
      else await runJob(env, m);
    }
  },
} satisfies ExportedHandler<CloudflareBindings, JobMsg>;
