import type { ScanKind, ScanStep } from '@vanguard/contracts';
import { db } from './lib/db.ts';
import { ProviderError } from './lib/http.ts';
import { log } from './lib/log.ts';
import { cierreRevisionDlq, pasoRevision } from './revision/pasos.ts';
import { conexionActiva } from './scans/comun.ts';
import { cierreWikiDlq, pasoWiki, type RespuestaCola } from './wiki/pasos.ts';

// Cola vg-jobs (S15 15.8): un mensaje = un paso = una invocación (max_batch_size 1). Solo ids, nunca tokens.
export type Paso = 'supabase' | 'cloudflare' | 'repo' | 'zip' | 'psi' | 'puntaje' | 'resumen_ia';
// Dependencias compactas que el paso repo pasa a su continuación de OSV: [ecosistema, paquete, versión, dev 0/1].
export type DepCompacta = [string, string, string, 0 | 1];
// DeepWiki (wiki/pasos.ts): un paso por mensaje; `area` solo con paso 'area' (nombre del área, no es un secreto).
export type PasoWiki = 'arbol' | 'triage' | 'area' | 'sintesis';
// Revisión de código en cada push (revision/pasos.ts, asignaciones/revision-codigo.md §2.1): diff → aviso. P1: 'osv'.
// 'estado' (revision/estado.ts, bloqueo-merge-criticos.md §2.4): publica el estado de commit «VanGUARD» y, con el anexo,
// cierra el PR con críticos. Solo se encola con el bloqueo encendido.
export type PasoRevision = 'diff' | 'aviso' | 'estado';

export type JobMsg =
  | { v: 1; kind: 'scan'; scan_run_id: string; org_id: string; paso: Paso; cursor?: string; deps?: DepCompacta[] }
  | { v: 1; kind: 'escalate'; org_id: string; incident_id: string; level: number }
  | { v: 1; kind: 'eval'; org_id: string }
  | { v: 1; kind: 'wiki'; org_id: string; wiki_run_id: string; paso: PasoWiki; area?: string }
  | { v: 1; kind: 'review'; org_id: string; review_id: string; paso: PasoRevision };

export type MsgScan = Extract<JobMsg, { kind: 'scan' }>;
export type MsgWiki = Extract<JobMsg, { kind: 'wiki' }>;
export type MsgRevision = Extract<JobMsg, { kind: 'review' }>;

// Lo que devuelve cada paso. `continuar` re-encola el mismo paso con cursor, en una invocación nueva (regla 3).
// connection_id: la conexión cuyo token usó el paso; con error_code 'unauthorized', guarded la marca revoked (§07.5). Si
// no viene, guarded busca la del paso como lo hace el propio paso (conexionActiva de su proveedor).
export type ResultadoPaso =
  | { status: 'done' | 'skipped' | 'failed'; findings?: number; error_code?: string; connection_id?: string }
  | { continuar: { cursor: string; deps?: DepCompacta[] } };
// intento = m.attempts (1 en la primera entrega): un paso que prefiere rendirse a fallar cuando guarded ya no lo va a
// reintentar (repo con OSV caído) lo compara con REINTENTOS.
export type FnPaso = (env: CloudflareBindings, m: MsgScan, intento?: number) => Promise<ResultadoPaso>;

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
// zip: 1 como repo (el ZIP ya no se abre en el servidor, F-18: el paso solo habla con la base y con OSV).
export const REINTENTOS: Record<Paso, number> = { supabase: 2, cloudflare: 2, repo: 1, zip: 1, psi: 1, puntaje: 1, resumen_ia: 1 };
const TRANSITORIO = new Set(['unavailable', 'timeout', 'rate_limited']);
// Proveedor de la conexión que usa cada paso de fuente (el mismo que pasa a conexionActiva): ante un 401 sin
// connection_id (p. ej. pasoSupabase lo lanza después de withSecret), guarded revoca esa conexión.
const PROVEEDOR: Partial<Record<Paso, string>> = { supabase: 'supabase', cloudflare: 'cloudflare', repo: 'github' };
const enSteps = (p: Paso): p is NombrePaso & Paso => p !== 'puntaje';
// puntaje calcula la cobertura con steps[]: un paso de fuente aún abierto es que su steps[i] no se ha escrito (regla 2:
// send antes que steps[i]), así que se le da este margen y se relee; si sigue abierto, puntaje se reintenta sin calcular.
// Esperar no gasta CPU.
const ESPERA_PUNTAJE_MS = 1500;
const esperar = (ms: number) => new Promise<void>((ok) => { setTimeout(ok, ms); });

// Los pasos se registran desde scans/index.ts (así jobs.ts no importa los escáneres y se prueba con dobles).
const registro = new Map<Paso, FnPaso>();
export function registrarPaso(p: Paso, fn: FnPaso) { registro.set(p, fn); }

const idConexion = (e: unknown): string | undefined => {
  const v = (e as { connection_id?: unknown } | null | undefined)?.connection_id;
  return typeof v === 'string' ? v : undefined;
};

// Un paso que llama al proveedor con el token de una conexión lo envuelve así: el ProviderError que salga lleva el
// connection_id y guarded revoca esa conexión ante un 401. También vale devolver { status:'failed', connection_id, … }.
export async function conConexion<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProviderError && idConexion(e) === undefined) Object.assign(e, { connection_id: connectionId });
    throw e;
  }
}

type FilaScan = { id: string; org_id: string; kind: ScanKind; status: string; steps: ScanStep[]; coverage?: unknown };
const cerrada = (scan: FilaScan) => scan.status === 'succeeded' || scan.status === 'failed';
const pasoTerminado = (scan: FilaScan, paso: Paso) => {
  const s = scan.steps.find((x) => x.name === paso)?.status;
  return s === 'done' || s === 'skipped' || s === 'failed';
};
const abierto = (s: ScanStep) => s.status === 'pending' || s.status === 'running';
const fuenteAbierta = (s: ScanStep) => s.name !== 'resumen_ia' && abierto(s);
// coverage.seen solo lo escribe puntaje, y puntaje solo calcula con todas las fuentes cerradas (guarded): con seen, la
// cobertura y el score ya salen del estado final de steps[].
const cubierta = (c: unknown) => typeof (c as { seen?: unknown } | null | undefined)?.seen === 'number';

async function leerScan(env: CloudflareBindings, m: MsgScan, conCobertura = false): Promise<FilaScan | null> {
  const { data, error } = await db(env).from('scan_runs').select(`id, org_id, kind, status, steps${conCobertura ? ', coverage' : ''}`)
    .eq('id', m.scan_run_id).eq('org_id', m.org_id).maybeSingle();
  if (error) throw new ProviderError('unavailable');
  const fila = data as FilaScan | null;
  return fila ? { ...fila, steps: Array.isArray(fila.steps) ? fila.steps : [] } : null;
}

// Escribe el resultado de un paso con vg_mark_step (0008f): solo su elemento de steps[] y sobre la fila actual (por la
// regla 2 el paso siguiente ya pudo empezar), y progress nunca retrocede. Sin `r` solo avanza progress (puntaje).
// Si no se pudo escribir, lanza: sin escritura no hay ack.
export async function marcarPaso(env: CloudflareBindings, scanId: string, paso: Paso, r?: { status: ScanStep['status']; findings?: number; error_code?: string }) {
  const p_patch = r ? { status: r.status, ...(r.findings !== undefined ? { findings: r.findings } : {}),
    ...(r.error_code ? { error_code: r.error_code } : {}) } : {};
  const { error } = await db(env).rpc('vg_mark_step', { p_scan: scanId, p_paso: paso, p_patch, p_progress: PROGRESO[paso] });
  if (error) {
    log('error', 'paso.marcar_error', { paso, code: error.code });
    throw new ProviderError('unavailable');
  }
}

// fin (al final de resumen_ia): succeeded salvo que hayan fallado TODOS los pasos de fuente. Relee steps de la fila (la
// copia del principio de la invocación es vieja) y solo cierra una auditoría en curso. Con un paso aún pending o running
// (su steps[i] llega con un reintento) no cierra: lanza y la cola repite el cierre. Con `forzar` (DLQ) esos pasos quedan
// failed con 'dlq' y cierra igual: nunca queda un paso running en una auditoría terminada. Si no puede escribir, lanza.
// Antes de cerrar, coverage y score salen del estado final de steps[]: si puntaje no llegó a calcular (agotó sus esperas
// a una fuente y fue a la DLQ) o el cierre forzado acaba de cerrar una fuente, se recalculan aquí con el mismo paso
// (~7 subpeticiones, solo en ese caso). En el forzado es de mejor esfuerzo: la auditoría se cierra igual.
async function finalizar(env: CloudflareBindings, b: MsgScan, forzar = false) {
  const scan = await leerScan(env, b, true);
  if (!scan || cerrada(scan)) return;
  const abiertos = scan.steps.filter(abierto);
  if (abiertos.length && !forzar) {
    log('info', 'scan.fin_espera', { pasos: abiertos.map((s) => s.name) });
    throw new ProviderError('unavailable');
  }
  for (const s of abiertos) await marcarPaso(env, scan.id, s.name, { status: 'failed', error_code: 'dlq' });
  const puntaje = registro.get('puntaje');
  if (puntaje && siguientePaso(scan.kind, 'puntaje') && (!cubierta(scan.coverage) || abiertos.some(fuenteAbierta))) {
    try {
      await puntaje(env, b);
      log('info', 'scan.puntaje_al_cerrar', { forzar });
    } catch (e) {
      log('error', 'scan.puntaje_error', { code: e instanceof ProviderError ? e.code : 'error', forzar });
      if (!forzar) throw e;
    }
  }
  const fuentes = scan.steps.filter((s) => s.name !== 'resumen_ia');
  const todosFallaron = fuentes.length > 0 && fuentes.every((s) => s.status === 'failed' || abierto(s));
  const { error } = await db(env).from('scan_runs').update({ status: todosFallaron ? 'failed' : 'succeeded', progress: 100,
    step: null, finished_at: new Date().toISOString(), ...(todosFallaron ? { error: 'Todos los pasos de la auditoría fallaron' } : {}) })
    .eq('id', scan.id).eq('org_id', scan.org_id).in('status', ['queued', 'running']);
  if (error) {
    log('error', 'scan.fin_error', { code: error.code });
    throw new ProviderError('unavailable');
  }
}

// §07.5 y §09.4: un 401 con el token de una conexión la deja revoked (Conexiones, E6 y E11 lo ven). Sin connection_id,
// la del paso según su proveedor (la misma que eligió el paso). Mejor esfuerzo: si falla, se registra y la cadena sigue.
async function revocarConexion(env: CloudflareBindings, b: MsgScan, connectionId: string | undefined) {
  try {
    const proveedor = PROVEEDOR[b.paso];
    const id = connectionId ?? (proveedor ? (await conexionActiva(env, b, proveedor))?.id : undefined);
    if (!id) return;
    const { error } = await db(env).from('connections').update({ status: 'revoked', last_error: 'unauthorized',
      last_checked_at: new Date().toISOString() }).eq('id', id).eq('org_id', b.org_id);
    if (error) log('error', 'conexion.revocar_error', { code: error.code });
  } catch (e) {
    log('error', 'conexion.revocar_error', { code: e instanceof ProviderError ? e.code : 'error' });
  }
}

async function encolar(env: CloudflareBindings, m: MsgScan, paso: Paso, extra: Partial<MsgScan> = {}) {
  await env.JOBS_Q.send({ v: 1, kind: 'scan', scan_run_id: m.scan_run_id, org_id: m.org_id, paso, ...extra });
}

// Reclama, ejecuta y encadena (regla 2: resultados → send(siguiente) → steps[i] → ack). Sin escritura no hay ack: si
// falla leer, encolar, marcar o cerrar, m.retry y la entrega siguiente retoma el paso que sigue running (p_retomar).
// El cierre también se repite mientras otro paso no haya escrito su steps[i] (finalizar).
export async function guarded(env: CloudflareBindings, m: Message<JobMsg>, b: MsgScan) {
  const t0 = Date.now();
  const reintentar = (donde: string, e: unknown) => {
    log('warn', 'paso.escritura_reintento', { paso: b.paso, donde, code: e instanceof ProviderError ? e.code : 'error',
      intento: m.attempts });
    m.retry({ delaySeconds: 10 });
  };
  let scan: FilaScan | null;
  try { scan = await leerScan(env, b); } catch (e) { reintentar('leer', e); return; }
  if (!scan || cerrada(scan)) { m.ack(); return; }
  const paso = b.paso;
  const sig = siguientePaso(scan.kind, paso);
  const cierra = paso === 'resumen_ia' || (!sig && paso !== 'puntaje');
  if (enSteps(paso)) {
    const { data: gana, error } = await db(env).rpc('vg_claim_step', { p_scan: scan.id, p_paso: paso,
      p_retomar: m.attempts > 1 || b.cursor !== undefined });
    if (error) { m.retry({ delaySeconds: 10 }); return; }
    if (gana !== true) {
      // Ya lo hizo otra entrega. Si es el paso que cierra y su steps[i] quedó escrito pero fin falló o esperaba a otro
      // paso, se cierra ahora.
      if (cierra && pasoTerminado(scan, paso)) {
        try { await finalizar(env, b); } catch (e) { reintentar('fin', e); return; }
      }
      m.ack();
      return;
    }
  }
  // puntaje nunca calcula con una fuente abierta (hallazgos 2/9 y 15): tras el margen relee y, si sigue abierta (su
  // marca falló y llega con un reintento a 10 s), se reintenta sin calcular ni encolar resumen_ia. La reentrega de la
  // fuente sale antes que la suya; si se agotan, su DLQ encola resumen_ia y fin recalcula al cerrar.
  if (paso === 'puntaje' && scan.steps.some(fuenteAbierta)) {
    await esperar(ESPERA_PUNTAJE_MS);
    try { scan = await leerScan(env, b); } catch (e) { reintentar('leer', e); return; }
    if (!scan || cerrada(scan)) { m.ack(); return; }
    const abiertas = scan.steps.filter(fuenteAbierta);
    if (abiertas.length) {
      log('info', 'puntaje.espera', { pasos: abiertas.map((s) => s.name), intento: m.attempts });
      m.retry({ delaySeconds: 10 });
      return;
    }
  }
  const fn = registro.get(paso);
  let r: ResultadoPaso;
  try {
    r = fn ? await fn(env, b, m.attempts) : { status: 'skipped', error_code: 'no_implementado' };
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : 'error';
    if (TRANSITORIO.has(code) && m.attempts <= REINTENTOS[paso]) {
      log('warn', 'paso.reintento', { paso, code, intento: m.attempts });
      m.retry({ delaySeconds: 10 * 2 ** (m.attempts - 1) });
      return;
    }
    log('warn', 'paso.fallo', { paso, code, name: (e as Error)?.name });
    const conn = idConexion(e);
    r = { status: 'failed', error_code: code, ...(conn ? { connection_id: conn } : {}) };
  }
  if ('continuar' in r) {
    try {
      await encolar(env, b, paso, { cursor: r.continuar.cursor, ...(r.continuar.deps ? { deps: r.continuar.deps } : {}) });
    } catch (e) { reintentar('encolar', e); return; }
    m.ack();
    return;
  }
  try {
    if (sig) await encolar(env, b, sig);
    await marcarPaso(env, scan.id, paso, enSteps(paso) ? r : undefined);
  } catch (e) { reintentar('marcar', e); return; }
  // Después de escribir steps[i]: si se revocara antes y la marca fallara, el reintento vería el paso sin conexión.
  if (r.status === 'failed' && r.error_code === 'unauthorized') await revocarConexion(env, b, r.connection_id);
  if (cierra) {
    try { await finalizar(env, b); } catch (e) { reintentar('fin', e); return; }
  }
  log('info', 'paso.fin', { paso, status: r.status, findings: r.findings ?? null, ms: Date.now() - t0 });
  m.ack();
}

// DeepWiki: wiki/pasos.ts decide ack o retry (sus transitorios se reintentan hasta MAX_REINTENTOS_COLA y en la última
// entrega la corrida falla con su código; lo que revienta sin decidir va a la DLQ, que la deja failed con 'dlq').
// Si algo lanza fuera de lo previsto, retry: sin escritura no hay ack.
async function correrWiki(env: CloudflareBindings, m: Message<JobMsg>, b: MsgWiki, dlq: boolean) {
  let r: RespuestaCola;
  try {
    r = dlq ? await cierreWikiDlq(env, b) : await pasoWiki(env, b, m.attempts);
  } catch (e) {
    log('error', 'wiki.excepcion', { name: (e as Error)?.name, dlq });
    r = { retry: 10 };
  }
  if (r === 'ack') m.ack();
  else m.retry({ delaySeconds: r.retry });
}

// Revisión de código: revision/pasos.ts decide ack o retry igual que la wiki (sus transitorios se reintentan 2 veces y
// después la revisión queda failed con su código; lo que revienta sin decidir llega a la DLQ, que la deja failed/dlq, o
// not_sent/dlq si era el aviso). Si algo lanza fuera de lo previsto, retry: sin escritura no hay ack.
async function correrRevision(env: CloudflareBindings, m: Message<JobMsg>, b: MsgRevision, dlq: boolean) {
  let r: RespuestaCola;
  try {
    r = dlq ? await cierreRevisionDlq(env, b) : await pasoRevision(env, b, m.attempts);
  } catch (e) {
    log('error', 'revision.excepcion', { name: (e as Error)?.name, paso: b.paso, dlq });
    r = { retry: 10 };
  }
  if (r === 'ack') m.ack();
  else m.retry({ delaySeconds: r.retry });
}

export async function runJob(env: CloudflareBindings, m: Message<JobMsg>) {
  const b = m.body;
  if (b?.kind === 'scan') { await guarded(env, m, b); return; }
  if (b?.kind === 'wiki') { await correrWiki(env, m, b, false); return; }
  if (b?.kind === 'review') { await correrRevision(env, m, b, false); return; }
  // escalate (P1) y eval (plan B de la ingesta) aún no tienen manejador: no se reintentan.
  log('warn', 'job.sin_manejador', { kind: b?.kind ?? null });
  m.ack();
}

// Consumidor de vg-jobs-dlq (regla 4): el paso queda failed con error_code 'dlq' y la cadena sigue hasta fin. Un paso
// que ya quedó escrito (p. ej. falló solo fin) no se pisa. El cierre es forzado: lo que siga pending o running queda
// failed con 'dlq'. Si no se puede leer o escribir, m.retry en vez de ack.
export async function cierreDlq(env: CloudflareBindings, m: Message<JobMsg>) {
  const b = m.body;
  log('warn', 'job.dlq', { kind: b?.kind ?? null, intentos: m.attempts });
  if (b?.kind === 'wiki') { await correrWiki(env, m, b, true); return; }
  if (b?.kind === 'review') { await correrRevision(env, m, b, true); return; }
  if (b?.kind === 'scan') {
    try {
      const scan = await leerScan(env, b);
      if (scan && !cerrada(scan)) {
        const sig = siguientePaso(scan.kind, b.paso);
        if (!(enSteps(b.paso) && pasoTerminado(scan, b.paso))) {
          if (sig) await encolar(env, b, sig);
          if (enSteps(b.paso)) await marcarPaso(env, scan.id, b.paso, { status: 'failed', error_code: 'dlq' });
        }
        if (b.paso === 'resumen_ia' || !sig) await finalizar(env, b, true);
      }
    } catch (e) {
      log('error', 'job.dlq_error', { name: (e as Error)?.name });
      m.retry({ delaySeconds: 10 });
      return;
    }
  }
  m.ack();
}

// max_retries de vg-jobs en wrangler.jsonc: la entrega 1 + 3 reintentos; la que falla la 4.ª va a vg-jobs-dlq.
export const MAX_REINTENTOS_COLA = 3;

// Doble de vg-jobs para dev-node (S15.8 regla 10, R17 §11.4) que imita a Workers Queues: send solo encola y un único
// bucle drena en orden, así cada paso escribe steps[i] y hace ack antes de que empiece el siguiente (nunca anidados).
// retry() vuelve a encolar con attempts+1 cuando pasa su delaySeconds (un temporizador que solo encola, no ejecuta);
// pasado max_retries va al cierre de la DLQ, que se reintenta igual y después se descarta (vg-jobs-dlq no tiene DLQ).
// Lanzar sin ack ni retry cuenta como retry, como en la cola real. vacia() espera a que no quede nada, tampoco en espera.
export function colaEnSerie(env: CloudflareBindings, alFallar: (e: unknown) => void = () => {}, maxReintentos = MAX_REINTENTOS_COLA) {
  type Entrega = { body: JobMsg; dlq: boolean; intento: number };
  const pendientes: Entrega[] = [];
  const avisar: (() => void)[] = [];
  let activa = false;
  let enEspera = 0;
  const quieta = () => !activa && enEspera === 0 && pendientes.length === 0;
  function poner(e: Entrega, segundos = 0) {
    if (segundos > 0) {
      enEspera++;
      setTimeout(() => { enEspera--; poner(e); }, segundos * 1000);
      return;
    }
    pendientes.push(e);
    if (!activa) void drenar();
  }
  function reintentar(e: Entrega, segundos = 0) {
    if (e.intento <= maxReintentos) poner({ ...e, intento: e.intento + 1 }, segundos);
    else if (!e.dlq) poner({ body: e.body, dlq: true, intento: 1 });
    else alFallar(Object.assign(new Error('mensaje descartado tras agotar la DLQ'), { name: 'dlq_agotada' }));
  }
  async function entregar(e: Entrega) {
    let decidido = false;
    const m = { id: crypto.randomUUID(), timestamp: new Date(), body: e.body, attempts: e.intento,
      ack() { decidido = true; },
      retry(o?: QueueRetryOptions) { if (!decidido) { decidido = true; reintentar(e, o?.delaySeconds); } },
    } as unknown as Message<JobMsg>;
    try {
      await (e.dlq ? cierreDlq(env, m) : runJob(env, m));
    } catch (err) {
      alFallar(err);
      if (!decidido) { decidido = true; reintentar(e); }
    }
  }
  async function drenar() {
    activa = true;
    try {
      for (let e = pendientes.shift(); e; e = pendientes.shift()) await entregar(e);
    } finally {
      activa = false;
      if (quieta()) for (const ok of avisar.splice(0)) ok();
    }
  }
  const nuevo = (body: JobMsg): Entrega => ({ body, dlq: false, intento: 1 });
  return {
    async send(body: JobMsg, o?: QueueSendOptions) { poner(nuevo(body), o?.delaySeconds); },
    async sendBatch(msgs: Iterable<MessageSendRequest<JobMsg>>) { for (const x of msgs) poner(nuevo(x.body), x.delaySeconds); },
    vacia: () => (quieta() ? Promise.resolve() : new Promise<void>((ok) => { avisar.push(ok); })),
  };
}
