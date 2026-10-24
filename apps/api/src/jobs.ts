import type { ScanKind, ScanStep } from '@vanguard/contracts';
import { db } from './lib/db.ts';
import { ProviderError } from './lib/http.ts';
import { log } from './lib/log.ts';

// Cola vg-jobs (S15 15.8): un mensaje = un paso = una invocación (max_batch_size 1). Solo ids, nunca tokens.
export type Paso = 'supabase' | 'cloudflare' | 'repo' | 'zip' | 'psi' | 'puntaje' | 'resumen_ia';
// Dependencias compactas que el paso repo pasa a su continuación de OSV: [ecosistema, paquete, versión, dev 0/1].
export type DepCompacta = [string, string, string, 0 | 1];

export type JobMsg =
  | { v: 1; kind: 'scan'; scan_run_id: string; org_id: string; paso: Paso; cursor?: string; deps?: DepCompacta[] }
  | { v: 1; kind: 'escalate'; org_id: string; incident_id: string; level: number }
  | { v: 1; kind: 'eval'; org_id: string };

export type MsgScan = Extract<JobMsg, { kind: 'scan' }>;

// Lo que devuelve cada paso. `continuar` re-encola el mismo paso con cursor, en una invocación nueva (regla 3).
export type ResultadoPaso =
  | { status: 'done' | 'skipped' | 'failed'; findings?: number; error_code?: string }
  | { continuar: { cursor: string; deps?: DepCompacta[] } };
export type FnPaso = (env: CloudflareBindings, m: MsgScan) => Promise<ResultadoPaso>;

type NombrePaso = ScanStep['name'];

// Pasos visibles en ScanRun.steps por kind (E12). psi es P1 y no entra todavía en full_audit.
export function pasosDe(kind: ScanKind): NombrePaso[] {
  switch (kind) {
    case 'full_audit': return ['supabase', 'cloudflare', 'repo', 'resumen_ia'];
    case 'supabase': return ['supabase', 'resumen_ia'];
    case 'cloudflare': return ['cloudflare', 'resumen_ia'];
    case 'repo': return ['repo', 'resumen_ia'];
    case 'zip': return ['zip', 'resumen_ia'];
    case 'lighthouse': return ['psi'];
  }
}

// Cadena de mensajes: los pasos de fuente, luego puntaje (antes de la IA) y resumen_ia (que cierra con fin).
export function siguientePaso(kind: ScanKind, paso: Paso): Paso | null {
  if (kind === 'lighthouse') return null;
  const cadena: Paso[] = [...pasosDe(kind).filter((n) => n !== 'resumen_ia'), 'puntaje', 'resumen_ia'];
  const i = cadena.indexOf(paso);
  return i >= 0 ? (cadena[i + 1] ?? null) : null;
}
export const primerPaso = (kind: ScanKind): Paso => (pasosDe(kind)[0] ?? 'puntaje') as Paso;

const PROGRESO: Record<Paso, number> = { supabase: 30, cloudflare: 45, repo: 75, zip: 75, psi: 85, puntaje: 90, resumen_ia: 95 };
const REINTENTOS: Record<Paso, number> = { supabase: 2, cloudflare: 2, repo: 1, zip: 0, psi: 1, puntaje: 1, resumen_ia: 1 };
const TRANSITORIO = new Set(['unavailable', 'timeout', 'rate_limited']);
const enSteps = (p: Paso): p is NombrePaso & Paso => p !== 'puntaje';

// Los pasos se registran desde scans/index.ts (así jobs.ts no importa los escáneres y se prueba con dobles).
const registro = new Map<Paso, FnPaso>();
export function registrarPaso(p: Paso, fn: FnPaso) { registro.set(p, fn); }

type FilaScan = { id: string; org_id: string; kind: ScanKind; status: string; steps: ScanStep[] };

async function leerScan(env: CloudflareBindings, m: MsgScan): Promise<FilaScan | null> {
  const { data, error } = await db(env).from('scan_runs').select('id, org_id, kind, status, steps')
    .eq('id', m.scan_run_id).eq('org_id', m.org_id).maybeSingle();
  if (error) throw new ProviderError('unavailable');
  return (data as FilaScan | null) ?? null;
}

// Escribe el resultado de un paso en steps[] y el avance. Los pasos van en cadena, así que leer y escribir no compite.
export async function marcarPaso(env: CloudflareBindings, scan: FilaScan, paso: Paso, r: { status: ScanStep['status']; findings?: number; error_code?: string }) {
  const steps = scan.steps.map((s) => (s.name === paso
    ? { name: s.name, status: r.status, ...(r.findings !== undefined ? { findings: r.findings } : {}),
        ...(r.error_code ? { error_code: r.error_code } : {}) }
    : s));
  const { error } = await db(env).from('scan_runs').update({ steps, progress: PROGRESO[paso], step: paso })
    .eq('id', scan.id).eq('org_id', scan.org_id);
  if (error) log('error', 'paso.marcar_error', { paso, code: error.code });
  scan.steps = steps;
}

// fin (al final de resumen_ia): succeeded salvo que hayan fallado TODOS los pasos de fuente.
async function finalizar(env: CloudflareBindings, scan: FilaScan) {
  const fuentes = scan.steps.filter((s) => s.name !== 'resumen_ia');
  const todosFallaron = fuentes.length > 0 && fuentes.every((s) => s.status === 'failed');
  const { error } = await db(env).from('scan_runs').update({ status: todosFallaron ? 'failed' : 'succeeded', progress: 100,
    step: null, finished_at: new Date().toISOString(), ...(todosFallaron ? { error: 'Todos los pasos de la auditoría fallaron' } : {}) })
    .eq('id', scan.id).eq('org_id', scan.org_id);
  if (error) log('error', 'scan.fin_error', { code: error.code });
}

async function encolar(env: CloudflareBindings, m: MsgScan, paso: Paso, extra: Partial<MsgScan> = {}) {
  await env.JOBS_Q.send({ v: 1, kind: 'scan', scan_run_id: m.scan_run_id, org_id: m.org_id, paso, ...extra });
}

// Reclama, ejecuta y encadena (regla 2: resultados → send(siguiente) → steps[i] → ack).
export async function guarded(env: CloudflareBindings, m: Message<JobMsg>, b: MsgScan) {
  const t0 = Date.now();
  const scan = await leerScan(env, b);
  if (!scan || scan.status === 'succeeded' || scan.status === 'failed') { m.ack(); return; }
  const paso = b.paso;
  if (enSteps(paso)) {
    const { data: gana, error } = await db(env).rpc('vg_claim_step', { p_scan: scan.id, p_paso: paso,
      p_retomar: m.attempts > 1 || b.cursor !== undefined });
    if (error) { m.retry({ delaySeconds: 10 }); return; }
    if (gana !== true) { m.ack(); return; }   // ya lo hizo otra entrega
  }
  const fn = registro.get(paso);
  let r: ResultadoPaso;
  try {
    r = fn ? await fn(env, b) : { status: 'skipped', error_code: 'no_implementado' };
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : 'error';
    if (TRANSITORIO.has(code) && m.attempts <= REINTENTOS[paso]) {
      log('warn', 'paso.reintento', { paso, code, intento: m.attempts });
      m.retry({ delaySeconds: 10 * 2 ** (m.attempts - 1) });
      return;
    }
    log('warn', 'paso.fallo', { paso, code, name: (e as Error)?.name });
    r = { status: 'failed', error_code: code };
  }
  if ('continuar' in r) {
    await encolar(env, b, paso, { cursor: r.continuar.cursor, ...(r.continuar.deps ? { deps: r.continuar.deps } : {}) });
    m.ack();
    return;
  }
  const sig = siguientePaso(scan.kind, paso);
  if (sig) await encolar(env, b, sig);
  if (enSteps(paso)) await marcarPaso(env, scan, paso, r);
  else await db(env).from('scan_runs').update({ progress: PROGRESO[paso], step: paso }).eq('id', scan.id).eq('org_id', scan.org_id);
  if (paso === 'resumen_ia' || (!sig && paso !== 'puntaje')) await finalizar(env, scan);
  log('info', 'paso.fin', { paso, status: r.status, findings: r.findings ?? null, ms: Date.now() - t0 });
  m.ack();
}

export async function runJob(env: CloudflareBindings, m: Message<JobMsg>) {
  const b = m.body;
  if (b?.kind === 'scan') { await guarded(env, m, b); return; }
  // escalate (P1) y eval (plan B de la ingesta) aún no tienen manejador: no se reintentan.
  log('warn', 'job.sin_manejador', { kind: b?.kind ?? null });
  m.ack();
}

// Consumidor de vg-jobs-dlq (regla 4): el paso queda failed con error_code 'dlq' y la cadena sigue hasta fin.
export async function cierreDlq(env: CloudflareBindings, m: Message<JobMsg>) {
  const b = m.body;
  log('warn', 'job.dlq', { kind: b?.kind ?? null, intentos: m.attempts });
  if (b?.kind === 'scan') {
    try {
      const scan = await leerScan(env, b);
      if (scan && scan.status !== 'succeeded' && scan.status !== 'failed') {
        const sig = siguientePaso(scan.kind, b.paso);
        if (sig) await encolar(env, b, sig);
        if (enSteps(b.paso)) await marcarPaso(env, scan, b.paso, { status: 'failed', error_code: 'dlq' });
        if (b.paso === 'resumen_ia' || !sig) await finalizar(env, scan);
      }
    } catch (e) {
      log('error', 'job.dlq_error', { name: (e as Error)?.name });
    }
  }
  m.ack();
}
