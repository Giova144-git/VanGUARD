import { log } from './lib/log.ts';
import { pasoHumo } from './humo.ts';

// Cola vg-jobs (S15 15.8): un mensaje = un paso = una invocación (max_batch_size 1). Solo ids, nunca tokens.
export type Paso = 'supabase' | 'cloudflare' | 'repo' | 'zip' | 'psi' | 'puntaje' | 'resumen_ia';

export type JobMsg =
  | { v: 1; kind: 'scan'; scan_run_id: string; org_id: string; paso: Paso; cursor?: string }
  | { v: 1; kind: 'escalate'; org_id: string; incident_id: string; level: number }
  | { v: 1; kind: 'eval'; org_id: string }
  | { v: 1; kind: 'humo'; i: number; fetches: number }; // TEMPORAL: prueba de humo de A7.7

export async function runJob(_env: CloudflareBindings, m: Message<JobMsg>) {
  const b = m.body;
  if (b?.kind === 'humo') {
    await pasoHumo(b);
    m.ack();
    return;
  }
  // scan (hito 3), escalate (P1) y eval (plan B de la ingesta) aún no tienen manejador: no se reintentan.
  log('warn', 'job.sin_manejador', { kind: b?.kind ?? null });
  m.ack();
}

// Consumidor de vg-jobs-dlq. Con la auditoría (hito 3) marcará el paso failed con error_code 'dlq' y encolará
// el siguiente, para que ninguna auditoría quede colgada (S15 15.8 regla 4).
export async function cierreDlq(_env: CloudflareBindings, m: Message<JobMsg>) {
  log('warn', 'job.dlq', { kind: m.body?.kind ?? null, intentos: m.attempts });
  m.ack();
}
