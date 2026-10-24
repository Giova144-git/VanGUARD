import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanKind, ScanStep } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op } from './test/db-doble.ts';
import { envDoble, mensajeDoble } from './test/dobles.ts';
import type { JobMsg } from './jobs.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('./lib/db.ts', () => ({ db: () => estado.client }));
// Pasos reales (hallazgo 13): el token se da sin descifrar nada; GitHub y Supabase responden con el fetch simulado.
vi.mock('./lib/credentials.ts', () => ({
  withSecret: async (_e: unknown, _a: unknown, _c: unknown, fn: (t: string) => Promise<unknown>) => fn('tok-de-prueba'),
}));
// Pasos 'wiki': aquí solo el enrutado y los reintentos de la cola; el consumidor se prueba en wiki/pasos.test.ts.
const wiki = vi.hoisted(() => ({ paso: vi.fn(), dlq: vi.fn() }));
vi.mock('./wiki/pasos.ts', () => ({ pasoWiki: wiki.paso, cierreWikiDlq: wiki.dlq }));
const { cierreDlq, colaEnSerie, conConexion, registrarPaso, runJob, siguientePaso, pasosDe, REINTENTOS } = await import('./jobs.ts');
const { ProviderError } = await import('./lib/http.ts');
const { pasoRepo } = await import('./scans/repo-paso.ts');
const { pasoSupabase } = await import('./scans/supabase.ts');
// puntaje real (hallazgos 2/9 y 15): calcularCobertura lee steps[] de esta auditoría y de las `previas`.
const { pasoPuntaje } = await import('./scans/index.ts');

const SCAN = '5a1c0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const CONN = 'c0000000-0000-4000-8000-000000000001';
const ERR = { code: '08006' };
let tipo: ScanKind;
let steps: ScanStep[];
let estadoScan: string;
let progreso: number;
// marcaDe: cuántas veces más falla vg_mark_step para ese paso.
let fallos: { lectura?: boolean; marca?: boolean; fin?: boolean; marcaDe?: Record<string, number> };
let conexion: { id: string; meta: Record<string, unknown>; capabilities: Record<string, unknown> } | null;
let eventos: string[];
// scan_runs.coverage y score de la fila; `previas`: steps de auditorías anteriores de la org (más nuevas primero).
let cobertura: { seen?: number; missing?: string[] } | null;
let puntuacion: number | null;
let previas: { steps: ScanStep[] }[];
// Pasos de fuente que vio abiertos cada cálculo del puntaje doble por defecto.
let puntajes: string[][];
let doble: ReturnType<typeof dbDoble>;
const activa = () => estadoScan === 'queued' || estadoScan === 'running';

// El doble imita las RPC de 0004 y 0008f sobre la fila actual: vg_claim_step (pending → running, o retomar un running)
// y vg_mark_step (solo el elemento del paso, progress = greatest, nada si la auditoría ya cerró). `conexion` es la
// conexión activa que devuelve connections a conexionActiva.
beforeEach(() => {
  tipo = 'full_audit';
  steps = pasosDe('full_audit').map((name) => ({ name, status: 'pending' as const }));
  estadoScan = 'running';
  progreso = 0;
  fallos = {};
  conexion = null;
  eventos = [];
  cobertura = null;
  puntuacion = null;
  previas = [];
  puntajes = [];
  doble = dbDoble({
    tabla: (op: Op) => {
      if (op.table === 'scan_runs' && op.action === 'select') {
        if (fallos.lectura) return { error: ERR };
        // calcularCobertura pide la lista de auditorías recientes; el resto, esta fila.
        if (op.single !== 'maybe') return { data: [{ steps }, ...previas] };
        return { data: { id: SCAN, org_id: ORG, kind: tipo, status: estadoScan, steps, coverage: cobertura, score: puntuacion, summary: null } };
      }
      if (op.table === 'connections' && op.action === 'select') return { data: conexion };
      if (op.table === 'scan_runs' && op.action === 'update') {
        if (fallos.fin) return { error: ERR };
        const p = op.payload as { status?: string; progress?: number; coverage?: typeof cobertura; score?: number | null };
        if (p.status && activa()) { estadoScan = p.status; progreso = p.progress ?? progreso; eventos.push(`fin:${p.status}`); }
        if ('coverage' in p && activa()) { cobertura = p.coverage ?? null; puntuacion = p.score ?? null; }
      }
      return undefined;
    },
    rpc: (name, a) => {
      if (name === 'vg_claim_step') {
        const s = steps.find((x) => x.name === a.p_paso);
        const gana = activa() && !!s && (s.status === 'pending' || (a.p_retomar === true && s.status === 'running'));
        if (gana) steps = steps.map((x) => (x.name === a.p_paso ? { ...x, status: 'running' } : x));
        return { data: gana };
      }
      if (name === 'vg_mark_step') {
        const quedan = fallos.marcaDe?.[String(a.p_paso)] ?? 0;
        if (quedan > 0) fallos.marcaDe![String(a.p_paso)] = quedan - 1;
        if (fallos.marca || quedan > 0) return { error: ERR };
        eventos.push(`marca:${String(a.p_paso)}`);
        if (!activa()) return { data: false };
        const patch = a.p_patch as Partial<ScanStep>;
        if (patch.status) steps = steps.map((x) => (x.name === a.p_paso ? { ...patch, name: x.name } as ScanStep : x));
        progreso = Math.max(progreso, Number(a.p_progress));
        return { data: true };
      }
      return undefined;
    },
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  registrarPaso('puntaje', puntajeDoble);
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const msg = (paso: string, extra: Record<string, unknown> = {}) =>
  mensajeDoble({ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: paso as 'supabase', ...extra });
const paso = (name: string) => steps.find((s) => s.name === name);
const actualizaciones = (tabla: string) => doble.ops.filter((o) => o.table === tabla && o.action === 'update');
const abiertas = () => steps.filter((s) => s.name !== 'resumen_ia' && (s.status === 'pending' || s.status === 'running')).map((s) => s.name);
// Puntaje doble: anota qué fuentes veía abiertas y escribe coverage como el real (seen marca que ya calculó).
const puntajeDoble = async () => {
  puntajes.push(abiertas());
  cobertura = { seen: 4, missing: [] };
  return { status: 'done' as const };
};
// steps[] y coverage se contradicen si una fuente terminó done y su módulo sale en missing, o terminó failed y su
// módulo cuenta como visto (el doble no tiene salud en vivo de metric_samples que lo justifique).
const MODULO: Record<string, string> = { supabase: 'supabase', cloudflare: 'cloudflare', repo: 'codebase' };
const contradicciones = () => steps.filter((s) => MODULO[s.name]).filter((s) => {
  const falta = (cobertura?.missing ?? []).includes(MODULO[s.name]!);
  return (s.status === 'done' && falta) || (s.status === 'failed' && !falta);
}).map((s) => s.name);
const pasosEnviados = (d: { enviados: JobMsg[] }) => d.enviados.map((e) => (e.kind === 'scan' ? e.paso : e.kind));

describe('cadena de pasos', () => {
  it('siguientePaso recorre fuentes → puntaje → resumen_ia y termina', () => {
    expect(siguientePaso('full_audit', 'supabase')).toBe('cloudflare');
    expect(siguientePaso('full_audit', 'repo')).toBe('puntaje');
    expect(siguientePaso('full_audit', 'puntaje')).toBe('resumen_ia');
    expect(siguientePaso('full_audit', 'resumen_ia')).toBeNull();
    expect(siguientePaso('repo', 'repo')).toBe('puntaje');
    expect(siguientePaso('zip', 'zip')).toBe('puntaje');
    expect(pasosDe('zip')).toEqual(['zip', 'resumen_ia']);
    expect(REINTENTOS.zip).toBe(1);   // como repo: el paso zip solo habla con la base y con OSV (F-18)
  });
});

describe('runJob', () => {
  it('el mismo mensaje dos veces → el paso corre una sola vez', async () => {
    const fn = vi.fn(async () => ({ status: 'done' as const, findings: 3 }));
    registrarPaso('supabase', fn);
    const d = envDoble();
    const m1 = msg('supabase'); const m2 = msg('supabase');
    await runJob(d.env, m1); await runJob(d.env, m2);
    expect(fn).toHaveBeenCalledOnce();
    expect(m1.ack).toHaveBeenCalled(); expect(m2.ack).toHaveBeenCalled();
    expect(d.enviados).toEqual([{ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: 'cloudflare' }]);
    expect(paso('supabase')).toEqual({ name: 'supabase', status: 'done', findings: 3 });
  });

  it('error transitorio → retry a 10 s y luego a 20 s; superado el límite → failed y sigue la cadena', async () => {
    registrarPaso('supabase', async () => { throw new ProviderError('unavailable', 503); });
    const d = envDoble();
    const a1 = msg('supabase');
    await runJob(d.env, a1);
    expect(a1.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    const a2 = Object.assign(msg('supabase'), { attempts: 2 });
    await runJob(d.env, a2);
    expect(a2.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    const a3 = Object.assign(msg('supabase'), { attempts: 3 });
    await runJob(d.env, a3);
    expect(a3.retry).not.toHaveBeenCalled();
    expect(paso('supabase')).toMatchObject({ status: 'failed', error_code: 'unavailable' });
    expect(d.enviados.at(-1)).toMatchObject({ paso: 'cloudflare' });
  });

  it('un 401 del proveedor no se reintenta: failed y se encola el siguiente', async () => {
    registrarPaso('cloudflare', async () => { throw new ProviderError('unauthorized', 401); });
    const d = envDoble();
    const m = msg('cloudflare');
    await runJob(d.env, m);
    expect(m.retry).not.toHaveBeenCalled();
    expect(paso('cloudflare')).toMatchObject({ status: 'failed', error_code: 'unauthorized' });
    expect(d.enviados).toEqual([expect.objectContaining({ paso: 'repo' })]);
  });

  it('continuar re-encola el mismo paso con cursor y deja el paso en running', async () => {
    registrarPaso('repo', async () => ({ continuar: { cursor: 'osv', deps: [['npm', 'lodash', '4.17.15', 0]] } }));
    const d = envDoble();
    await runJob(d.env, msg('repo'));
    expect(d.enviados).toEqual([{ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: 'repo', cursor: 'osv',
      deps: [['npm', 'lodash', '4.17.15', 0]] }]);
    expect(paso('repo')?.status).toBe('running');
  });

  it('resumen_ia cierra con fin: succeeded aunque falle una fuente; failed si fallan todas', async () => {
    registrarPaso('resumen_ia', async () => ({ status: 'done' as const }));
    steps = steps.map((s) => (s.name === 'resumen_ia' ? s : { ...s, status: s.name === 'repo' ? 'failed' : 'done' }));
    await runJob(envDoble().env, msg('resumen_ia'));
    const fin = actualizaciones('scan_runs').at(-1);
    expect(fin?.payload).toMatchObject({ status: 'succeeded', progress: 100 });

    estadoScan = 'running';
    steps = steps.map((s) => (s.name === 'resumen_ia' ? { ...s, status: 'pending' } : { ...s, status: 'failed' }));
    await runJob(envDoble().env, msg('resumen_ia'));
    const fin2 = actualizaciones('scan_runs').at(-1);
    expect(fin2?.payload).toMatchObject({ status: 'failed' });
  });
});

// Hallazgos 2 y 9: marcarPaso no reescribe steps[] entero desde la copia del principio de la invocación.
describe('marcar un paso (vg_mark_step)', () => {
  it('manda solo el resultado de su paso, nunca el array steps', async () => {
    registrarPaso('supabase', async () => ({ status: 'done' as const, findings: 3 }));
    await runJob(envDoble().env, msg('supabase'));
    expect(doble.rpcs.find((r) => r.name === 'vg_mark_step')?.args).toEqual({ p_scan: SCAN, p_paso: 'supabase',
      p_patch: { status: 'done', findings: 3 }, p_progress: 30 });
    expect(actualizaciones('scan_runs').some((o) => 'steps' in (o.payload as object))).toBe(false);
  });

  it('el paso siguiente termina antes de que el anterior escriba: ninguno pisa al otro y progress no baja', async () => {
    registrarPaso('supabase', async () => ({ status: 'done' as const, findings: 2 }));
    registrarPaso('cloudflare', async () => ({ status: 'done' as const, findings: 1 }));
    const d = envDoble();
    let anidar = true;
    // La entrega de cloudflare corre entera dentro del send de supabase (antes de su steps[i], regla 2).
    d.cola.send.mockImplementation(async (body: JobMsg) => {
      d.enviados.push(body);
      if (anidar) { anidar = false; await runJob(d.env, mensajeDoble(body)); }
    });
    await runJob(d.env, msg('supabase'));
    expect(eventos).toEqual(['marca:cloudflare', 'marca:supabase']);
    expect(paso('supabase')).toEqual({ name: 'supabase', status: 'done', findings: 2 });
    expect(paso('cloudflare')).toEqual({ name: 'cloudflare', status: 'done', findings: 1 });
    expect(progreso).toBe(45);
  });

  it('puntaje solo avanza progress, sin tocar steps', async () => {
    registrarPaso('puntaje', async () => ({ status: 'done' as const }));
    steps = steps.map((s) => (s.name === 'resumen_ia' ? s : { ...s, status: 'done' }));
    const antes = structuredClone(steps);
    await runJob(envDoble().env, msg('puntaje'));
    expect(doble.rpcs.find((r) => r.name === 'vg_mark_step')?.args).toEqual({ p_scan: SCAN, p_paso: 'puntaje', p_patch: {}, p_progress: 90 });
    expect(steps).toEqual(antes);
    expect(progreso).toBe(90);
  });

  it('puntaje espera un momento si la última fuente aún no escribió su steps[i]', async () => {
    vi.useFakeTimers();
    const visto: (string | undefined)[] = [];
    registrarPaso('puntaje', async () => { visto.push(paso('repo')?.status); return { status: 'done' as const }; });
    steps = steps.map((s) => (s.name === 'resumen_ia' ? s : { ...s, status: s.name === 'repo' ? 'running' : 'done' }));
    setTimeout(() => { steps = steps.map((s) => (s.name === 'repo' ? { ...s, status: 'done' } : s)); }, 200);
    const corrida = runJob(envDoble().env, msg('puntaje'));
    await vi.advanceTimersByTimeAsync(2000);
    await corrida;
    expect(visto).toEqual(['done']);
  });

  it('fin relee steps de la fila: decide con lo que escribieron los pasos tardíos', async () => {
    steps = steps.map((s) => (s.name === 'resumen_ia' ? s : { ...s, status: 'running' }));
    registrarPaso('resumen_ia', async () => {
      steps = steps.map((s) => (s.name === 'resumen_ia' ? s : { ...s, status: 'failed' }));   // llegan las marcas tardías
      return { status: 'done' as const };
    });
    await runJob(envDoble().env, msg('resumen_ia'));
    const fin = actualizaciones('scan_runs').at(-1)!;
    expect(fin.payload).toMatchObject({ status: 'failed', progress: 100 });
    expect(fin.filters).toContainEqual(['status', 'in', ['queued', 'running']]);
  });
});

// Hallazgo 15: si no se pudo escribir, no hay ack.
describe('escrituras que fallan', () => {
  it('falla marcar el paso → retry sin ack; la entrega siguiente retoma el paso y lo cierra', async () => {
    const fn = vi.fn(async () => ({ status: 'done' as const, findings: 1 }));
    registrarPaso('supabase', fn);
    fallos.marca = true;
    const m1 = msg('supabase');
    await runJob(envDoble().env, m1);
    expect(m1.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(m1.ack).not.toHaveBeenCalled();
    expect(paso('supabase')?.status).toBe('running');

    fallos.marca = false;
    const m2 = Object.assign(msg('supabase'), { attempts: 2 });
    await runJob(envDoble().env, m2);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(m2.ack).toHaveBeenCalled();
    expect(paso('supabase')).toEqual({ name: 'supabase', status: 'done', findings: 1 });
  });

  it('falla fin → retry sin ack; la reentrega ve resumen_ia escrito y cierra sin repetir la IA', async () => {
    const fn = vi.fn(async () => ({ status: 'done' as const }));
    registrarPaso('resumen_ia', fn);
    steps = steps.map((s) => (s.name === 'resumen_ia' ? s : { ...s, status: 'done' }));
    fallos.fin = true;
    const m1 = msg('resumen_ia');
    await runJob(envDoble().env, m1);
    expect(m1.retry).toHaveBeenCalled();
    expect(m1.ack).not.toHaveBeenCalled();
    expect(estadoScan).toBe('running');

    fallos.fin = false;
    const m2 = Object.assign(msg('resumen_ia'), { attempts: 2 });
    await runJob(envDoble().env, m2);
    expect(fn).toHaveBeenCalledOnce();
    expect(estadoScan).toBe('succeeded');
    expect(m2.ack).toHaveBeenCalled();
  });

  // Orden de entregas de la revisión: la marca de la única fuente falla con su siguiente ya encolado. Antes cerraba
  // succeeded con steps[supabase] running para siempre; ahora ni puntaje calcula ni fin cierra hasta que escribe.
  it('falla marcar una fuente intermedia → puntaje se reintenta sin calcular; con su steps[i] escrito, calcula y cierra failed', async () => {
    vi.useFakeTimers();
    tipo = 'supabase';
    steps = pasosDe('supabase').map((name) => ({ name, status: 'pending' as const }));
    registrarPaso('supabase', async () => ({ status: 'failed' as const, error_code: 'forbidden' }));
    registrarPaso('resumen_ia', async () => ({ status: 'skipped' as const, error_code: 'sin_hallazgos' }));
    const d = envDoble();
    fallos.marcaDe = { supabase: 1 };
    const m1 = msg('supabase');
    await runJob(d.env, m1);
    expect(m1.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(pasosEnviados(d)).toEqual(['puntaje']);
    const p1 = msg('puntaje');
    const corrida = runJob(d.env, p1);   // espera 1,5 s, relee y la fuente sigue running
    await vi.advanceTimersByTimeAsync(2000);
    await corrida;
    expect(p1.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(p1.ack).not.toHaveBeenCalled();
    expect(puntajes).toEqual([]);
    expect(pasosEnviados(d)).toEqual(['puntaje']);   // sin resumen_ia: la cadena espera a la fuente
    await runJob(d.env, Object.assign(msg('supabase'), { attempts: 2 }));
    const p2 = Object.assign(msg('puntaje'), { attempts: 2 });
    await runJob(d.env, p2);
    expect(puntajes).toEqual([[]]);
    expect(p2.ack).toHaveBeenCalled();
    const m5 = msg('resumen_ia');
    await runJob(d.env, m5);
    expect(m5.ack).toHaveBeenCalled();
    expect(estadoScan).toBe('failed');
    expect(puntajes).toEqual([[]]);   // fin no recalcula: puntaje ya calculó con todo cerrado
    expect(paso('supabase')).toEqual({ name: 'supabase', status: 'failed', error_code: 'forbidden' });
    expect(abiertas()).toEqual([]);
  });

  it('falla leer la auditoría → retry sin ack', async () => {
    fallos.lectura = true;
    const m = msg('supabase');
    await runJob(envDoble().env, m);
    expect(m.retry).toHaveBeenCalled();
    expect(m.ack).not.toHaveBeenCalled();
  });
});

// Hallazgos 2/9 y 15 (ventana de puntaje), con el pasoPuntaje real: si falla la marca de una fuente intermedia, la
// auditoría nunca cierra con steps[] y coverage contradictorios. Sin auditoría vieja, una fuente done en su reintento
// salía en missing; con una vieja que la vio, una fuente failed contaba como vista.
describe('puntaje y cierre con una fuente que escribe tarde', () => {
  const VIEJA: ScanStep[] = [{ name: 'supabase', status: 'done' }, { name: 'cloudflare', status: 'done' },
    { name: 'repo', status: 'done' }, { name: 'resumen_ia', status: 'done' }];
  const fuentes = (supabase: () => Promise<{ status: 'done' | 'failed'; error_code?: string }>) => {
    registrarPaso('puntaje', pasoPuntaje);
    registrarPaso('supabase', supabase);
    registrarPaso('cloudflare', async () => ({ status: 'done' as const }));
    registrarPaso('repo', async () => ({ status: 'done' as const }));
    registrarPaso('resumen_ia', async () => ({ status: 'skipped' as const, error_code: 'sin_hallazgos' }));
  };
  const resultado = (final: 'done' | 'failed') => async () =>
    (final === 'done' ? { status: 'done' as const } : { status: 'failed' as const, error_code: 'forbidden' });
  // Puntaje con timers falsos: corre su espera de 1,5 s.
  const correrPuntaje = async (env: CloudflareBindings, attempts: number) => {
    const m = Object.assign(msg('puntaje'), { attempts });
    const corrida = runJob(env, m);
    await vi.advanceTimersByTimeAsync(2000);
    await corrida;
    return m;
  };

  it.each([
    ['done', false, ['performance']],
    ['failed', true, ['supabase', 'performance']],
  ] as const)('full_audit, falla una vez la marca de supabase (%s; auditoría vieja: %s) → coverage según su estado final',
    async (final, vieja, missing) => {
      vi.useFakeTimers();
      if (vieja) previas = [{ steps: VIEJA }];
      fuentes(resultado(final));
      fallos.marcaDe = { supabase: 1 };
      const d = envDoble();
      const s1 = msg('supabase');
      await runJob(d.env, s1);
      expect(s1.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
      await runJob(d.env, msg('cloudflare'));
      await runJob(d.env, msg('repo'));
      const p1 = await correrPuntaje(d.env, 1);
      expect(p1.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
      expect(p1.ack).not.toHaveBeenCalled();
      expect(cobertura).toBeNull();   // no calculó con supabase running
      expect(pasosEnviados(d)).not.toContain('resumen_ia');
      await runJob(d.env, Object.assign(msg('supabase'), { attempts: 2 }));   // el reintento solo reenvía cloudflare
      const p2 = await correrPuntaje(d.env, 2);
      expect(p2.ack).toHaveBeenCalled();
      expect(pasosEnviados(d).at(-1)).toBe('resumen_ia');
      await runJob(d.env, msg('resumen_ia'));
      expect(estadoScan).toBe('succeeded');
      expect(paso('supabase')?.status).toBe(final);
      expect(cobertura).toMatchObject({ seen: 4 - missing.length, total: 4, missing });
      expect(typeof puntuacion).toBe('number');
      expect(contradicciones()).toEqual([]);
    });

  it('puntaje agota sus esperas → su DLQ encola resumen_ia; fin espera a la fuente y recalcula con su estado final', async () => {
    vi.useFakeTimers();
    fuentes(resultado('done'));
    fallos.marcaDe = { supabase: 1 };
    const d = envDoble();
    await runJob(d.env, msg('supabase'));
    await runJob(d.env, msg('cloudflare'));
    await runJob(d.env, msg('repo'));
    for (let i = 1; i <= 4; i++) expect((await correrPuntaje(d.env, i)).retry).toHaveBeenCalled();
    await cierreDlq(d.env, msg('puntaje'));
    expect(pasosEnviados(d).at(-1)).toBe('resumen_ia');
    expect(cobertura).toBeNull();
    const r1 = msg('resumen_ia');
    await runJob(d.env, r1);
    expect(r1.retry).toHaveBeenCalled();   // fin espera a supabase
    expect(estadoScan).toBe('running');
    await runJob(d.env, Object.assign(msg('supabase'), { attempts: 2 }));
    await runJob(d.env, Object.assign(msg('resumen_ia'), { attempts: 2 }));
    expect(estadoScan).toBe('succeeded');
    expect(paso('supabase')?.status).toBe('done');
    expect(cobertura).toMatchObject({ seen: 3, missing: ['performance'] });
    expect(contradicciones()).toEqual([]);
  });

  it('cierre forzado de la DLQ: la fuente que nunca escribió queda failed/dlq y coverage la cuenta así', async () => {
    fuentes(resultado('done'));
    previas = [{ steps: VIEJA }];
    steps = steps.map((s) => ({ ...s, status: s.name === 'supabase' ? 'running' : 'done' }));
    await cierreDlq(envDoble().env, msg('resumen_ia'));
    expect(paso('supabase')).toEqual({ name: 'supabase', status: 'failed', error_code: 'dlq' });
    expect(estadoScan).toBe('succeeded');
    expect(cobertura).toMatchObject({ missing: ['supabase', 'performance'] });
    expect(contradicciones()).toEqual([]);
  });

  it('si puntaje ya calculó con todo cerrado, fin no recalcula; si recalcular falla, fin reintenta y el forzado cierra igual', async () => {
    steps = steps.map((s) => ({ ...s, status: s.name === 'resumen_ia' ? 'pending' : 'done' }));
    cobertura = { seen: 4, missing: [] };
    registrarPaso('resumen_ia', async () => ({ status: 'done' as const }));
    await runJob(envDoble().env, msg('resumen_ia'));
    expect(puntajes).toEqual([]);
    expect(estadoScan).toBe('succeeded');

    estadoScan = 'running';
    cobertura = null;
    registrarPaso('puntaje', async () => { throw new ProviderError('unavailable'); });
    const r = Object.assign(msg('resumen_ia'), { attempts: 2 });
    await runJob(envDoble().env, r);
    expect(r.retry).toHaveBeenCalled();
    expect(estadoScan).toBe('running');
    const dlq = msg('resumen_ia');
    await cierreDlq(envDoble().env, dlq);
    expect(estadoScan).toBe('succeeded');
    expect(dlq.ack).toHaveBeenCalled();
  });
});

// Hallazgo 13 (parte de la cola): un 401 con la conexión del paso la deja revoked.
describe('401 con la conexión del paso', () => {
  it('lanzado con conConexion → connections revoked con last_error unauthorized y el paso failed sin el id', async () => {
    registrarPaso('cloudflare', async () => conConexion(CONN, async () => { throw new ProviderError('unauthorized', 401); }));
    const m = msg('cloudflare');
    await runJob(envDoble().env, m);
    const [up, ...resto] = actualizaciones('connections');
    expect(resto).toEqual([]);
    expect(up?.payload).toMatchObject({ status: 'revoked', last_error: 'unauthorized' });
    expect(eqDe(up!, 'id')).toBe(CONN);
    expect(eqDe(up!, 'org_id')).toBe(ORG);
    expect(paso('cloudflare')).toEqual({ name: 'cloudflare', status: 'failed', error_code: 'unauthorized' });
    expect(m.ack).toHaveBeenCalled();
  });

  it('devuelto en el resultado del paso → también revoca', async () => {
    registrarPaso('supabase', async () => ({ status: 'failed' as const, error_code: 'unauthorized', connection_id: CONN }));
    await runJob(envDoble().env, msg('supabase'));
    expect(actualizaciones('connections')[0]?.payload).toMatchObject({ status: 'revoked', last_error: 'unauthorized' });
    expect(paso('supabase')).toEqual({ name: 'supabase', status: 'failed', error_code: 'unauthorized' });
  });

  it('un 401 sin connection_id → revoca la conexión activa del proveedor del paso; puntaje no tiene conexión', async () => {
    conexion = { id: CONN, meta: {}, capabilities: {} };
    registrarPaso('puntaje', async () => { throw new ProviderError('unauthorized', 401); });
    await runJob(envDoble().env, msg('puntaje'));
    expect(doble.ops.filter((o) => o.table === 'connections')).toEqual([]);
    registrarPaso('cloudflare', async () => { throw new ProviderError('unauthorized', 401); });
    await runJob(envDoble().env, msg('cloudflare'));
    const sel = doble.ops.find((o) => o.table === 'connections' && o.action === 'select')!;
    expect(eqDe(sel, 'provider')).toBe('cloudflare');
    expect(eqDe(sel, 'org_id')).toBe(ORG);
    const [up, ...resto] = actualizaciones('connections');
    expect(resto).toEqual([]);
    expect(up?.payload).toMatchObject({ status: 'revoked', last_error: 'unauthorized' });
    expect(eqDe(up!, 'id')).toBe(CONN);
    expect(paso('cloudflare')).toEqual({ name: 'cloudflare', status: 'failed', error_code: 'unauthorized' });
  });

  it('si falla marcar el paso no revoca todavía: el reintento vuelve a ver la conexión, marca failed y revoca', async () => {
    conexion = { id: CONN, meta: {}, capabilities: {} };
    registrarPaso('cloudflare', async () => { throw new ProviderError('unauthorized', 401); });
    fallos.marca = true;
    const m1 = msg('cloudflare');
    await runJob(envDoble().env, m1);
    expect(m1.retry).toHaveBeenCalled();
    expect(actualizaciones('connections')).toEqual([]);
    fallos.marca = false;
    await runJob(envDoble().env, Object.assign(msg('cloudflare'), { attempts: 2 }));
    expect(paso('cloudflare')).toEqual({ name: 'cloudflare', status: 'failed', error_code: 'unauthorized' });
    expect(actualizaciones('connections')).toHaveLength(1);
  });

  it('otro error con conexión, o un 401 sin conexión activa → no toca connections', async () => {
    registrarPaso('supabase', async () => conConexion(CONN, async () => { throw new ProviderError('forbidden', 403); }));
    registrarPaso('cloudflare', async () => { throw new ProviderError('unauthorized', 401); });
    await runJob(envDoble().env, msg('supabase'));
    await runJob(envDoble().env, msg('cloudflare'));
    expect(actualizaciones('connections')).toEqual([]);
    expect(paso('supabase')).toMatchObject({ status: 'failed', error_code: 'forbidden' });
  });
});

// Hallazgo 13 con los pasos reales, que no usan conConexion: repo lanza el 401 dentro de withSecret y supabase después.
describe('401 de un paso real', () => {
  it.each([
    ['repo', 'github', { repo_full_name: 'o/r' }],
    ['supabase', 'supabase', { project_ref: 'abcdefghijklmnopqrst' }],
  ] as const)('%s: el proveedor responde 401 → paso failed unauthorized y su conexión revoked', async (nombre, proveedor, meta) => {
    conexion = { id: CONN, meta, capabilities: {} };
    const f = vi.fn(async () => new Response('no', { status: 401 }));
    vi.stubGlobal('fetch', f);
    registrarPaso(nombre, nombre === 'repo' ? pasoRepo : pasoSupabase);
    const m = msg(nombre);
    await runJob(envDoble().env, m);
    expect(f).toHaveBeenCalled();
    expect(paso(nombre)).toEqual({ name: nombre, status: 'failed', error_code: 'unauthorized' });
    const [up, ...resto] = actualizaciones('connections');
    expect(resto).toEqual([]);
    expect(up?.payload).toMatchObject({ status: 'revoked', last_error: 'unauthorized' });
    expect(eqDe(up!, 'id')).toBe(CONN);
    expect(eqDe(up!, 'org_id')).toBe(ORG);
    const sel = doble.ops.filter((o) => o.table === 'connections' && o.action === 'select');
    expect(sel.length).toBeGreaterThan(0);
    expect(sel.every((o) => eqDe(o, 'provider') === proveedor)).toBe(true);
    expect(m.ack).toHaveBeenCalled();
  });
});

describe('cierreDlq', () => {
  it('mensaje de vg-jobs-dlq → paso failed con dlq y la cadena sigue', async () => {
    const d = envDoble();
    const m = msg('repo');
    await cierreDlq(d.env, m);
    expect(paso('repo')).toMatchObject({ status: 'failed', error_code: 'dlq' });
    expect(d.enviados).toEqual([expect.objectContaining({ paso: 'puntaje' })]);
    expect(m.ack).toHaveBeenCalled();
  });

  it('si no puede leer o escribir → retry en vez de ack', async () => {
    fallos.lectura = true;
    const m1 = msg('repo');
    await cierreDlq(envDoble().env, m1);
    expect(m1.retry).toHaveBeenCalled(); expect(m1.ack).not.toHaveBeenCalled();
    fallos.lectura = false; fallos.marca = true;
    const m2 = msg('repo');
    await cierreDlq(envDoble().env, m2);
    expect(m2.retry).toHaveBeenCalled(); expect(m2.ack).not.toHaveBeenCalled();
  });

  it('resumen_ia ya escrito (solo falló fin) → no lo pisa con dlq y cierra', async () => {
    steps = steps.map((s) => ({ ...s, status: 'done' }));
    const d = envDoble();
    await cierreDlq(d.env, msg('resumen_ia'));
    expect(paso('resumen_ia')).toEqual({ name: 'resumen_ia', status: 'done' });
    expect(estadoScan).toBe('succeeded');
    expect(d.enviados).toEqual([]);
  });

  it('cierre forzado: lo que siga pending o running queda failed con dlq; failed si así fallaron todas las fuentes', async () => {
    steps = steps.map((s) => (s.name === 'cloudflare' ? { ...s, status: 'running' } : s.name === 'resumen_ia' ? s : { ...s, status: 'done' }));
    const m = msg('resumen_ia');
    await cierreDlq(envDoble().env, m);
    expect(paso('cloudflare')).toEqual({ name: 'cloudflare', status: 'failed', error_code: 'dlq' });
    expect(paso('resumen_ia')).toEqual({ name: 'resumen_ia', status: 'failed', error_code: 'dlq' });
    expect(estadoScan).toBe('succeeded');
    expect(m.ack).toHaveBeenCalled();

    estadoScan = 'running';
    steps = steps.map((s) => ({ ...s, status: s.name === 'supabase' ? 'pending' : s.name === 'resumen_ia' ? 'done' : 'running' }));
    await cierreDlq(envDoble().env, msg('resumen_ia'));
    expect(steps.filter((s) => s.name !== 'resumen_ia')).toEqual(['supabase', 'cloudflare', 'repo']
      .map((name) => ({ name, status: 'failed', error_code: 'dlq' })));
    expect(estadoScan).toBe('failed');
  });
});

const RUN_WIKI = '3a110000-0000-4000-8000-000000000001';
describe('kind wiki (DeepWiki)', () => {
  const wmsg = (paso: 'arbol' | 'triage' = 'arbol') =>
    mensajeDoble({ v: 1, kind: 'wiki', org_id: ORG, wiki_run_id: RUN_WIKI, paso });
  beforeEach(() => { wiki.paso.mockReset(); wiki.dlq.mockReset(); });

  it('runJob pasa el mensaje y attempts a pasoWiki; ack → ack, sin tocar scan_runs', async () => {
    wiki.paso.mockResolvedValue('ack');
    const d = envDoble();
    const m = Object.assign(wmsg('triage'), { attempts: 3 });
    await runJob(d.env, m);
    expect(wiki.paso).toHaveBeenCalledWith(d.env, m.body, 3);
    expect(m.ack).toHaveBeenCalled(); expect(m.retry).not.toHaveBeenCalled();
    expect(doble.ops).toEqual([]);
    expect(doble.rpcs).toEqual([]);
  });

  it('{ retry } → m.retry con ese delaySeconds y sin ack; si pasoWiki lanza → retry a 10 s', async () => {
    wiki.paso.mockResolvedValueOnce({ retry: 120 });
    const m1 = wmsg();
    await runJob(envDoble().env, m1);
    expect(m1.retry).toHaveBeenCalledWith({ delaySeconds: 120 }); expect(m1.ack).not.toHaveBeenCalled();
    wiki.paso.mockRejectedValueOnce(new TypeError('boom'));
    const m2 = wmsg();
    await runJob(envDoble().env, m2);
    expect(m2.retry).toHaveBeenCalledWith({ delaySeconds: 10 }); expect(m2.ack).not.toHaveBeenCalled();
  });

  it('cierreDlq de un mensaje wiki → cierreWikiDlq (ack o retry), nunca el cierre de auditorías', async () => {
    wiki.dlq.mockResolvedValueOnce('ack').mockResolvedValueOnce({ retry: 30 });
    const m1 = wmsg();
    await cierreDlq(envDoble().env, m1);
    expect(wiki.dlq).toHaveBeenCalledWith(expect.anything(), m1.body);
    expect(m1.ack).toHaveBeenCalled();
    const m2 = wmsg();
    await cierreDlq(envDoble().env, m2);
    expect(m2.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(wiki.paso).not.toHaveBeenCalled();
    expect(doble.ops).toEqual([]);
  });
});

// Hallazgo 3: el doble de dev-node corre la cadena en serie, cada paso entero antes del siguiente. Además imita los
// reintentos de Workers Queues: attempts+1 tras delaySeconds, max_retries 3 y luego la DLQ.
describe('colaEnSerie (dev-node)', () => {
  const montar = () => {
    const { env } = envDoble();
    const fallas: unknown[] = [];
    const cola = colaEnSerie(env, (e) => { fallas.push(e); });
    env.JOBS_Q = cola as unknown as Queue<JobMsg>;
    const enviar = (p: string) => cola.send({ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: p as 'supabase' });
    // Con timers falsos: avanza el reloj hasta que la cola se vacía (las esperas son de 10 s o más).
    const drenar = async (ms: number) => { const fin = cola.vacia(); await vi.advanceTimersByTimeAsync(ms); await fin; };
    return { cola, enviar, drenar, fallas };
  };

  it('un full_audit: cada paso escribe steps[i] antes de que empiece el siguiente y fin ve todo escrito', async () => {
    for (const p of ['supabase', 'cloudflare', 'repo', 'resumen_ia'] as const) {
      registrarPaso(p, async () => { eventos.push(`inicio:${p}`); return { status: 'done' as const }; });
    }
    registrarPaso('puntaje', async () => { eventos.push('inicio:puntaje'); return puntajeDoble(); });
    const { cola, enviar } = montar();
    await enviar('supabase');
    await cola.vacia();
    expect(eventos).toEqual([
      'inicio:supabase', 'marca:supabase', 'inicio:cloudflare', 'marca:cloudflare', 'inicio:repo', 'marca:repo',
      'inicio:puntaje', 'marca:puntaje', 'inicio:resumen_ia', 'marca:resumen_ia', 'fin:succeeded',
    ]);
    expect(steps.every((s) => s.status === 'done')).toBe(true);
    expect(estadoScan).toBe('succeeded');
    expect(progreso).toBe(100);
  });

  it('un paso que reintenta 2 veces termina done a la 3.ª: retry() reencola con attempts+1 tras su delaySeconds', async () => {
    vi.useFakeTimers();
    tipo = 'supabase';
    steps = pasosDe('supabase').map((name) => ({ name, status: 'pending' as const }));
    const vistos: { intento: number | undefined; t: number }[] = [];
    const t0 = Date.now();
    registrarPaso('supabase', async (_e, _m, intento) => {
      vistos.push({ intento, t: Date.now() - t0 });
      if ((intento ?? 1) < 3) throw new ProviderError('unavailable', 503);
      return { status: 'done' as const, findings: 2 };
    });
    registrarPaso('resumen_ia', async () => ({ status: 'done' as const }));
    const { enviar, drenar, fallas } = montar();
    await enviar('supabase');
    await drenar(60_000);
    expect(vistos).toEqual([{ intento: 1, t: 0 }, { intento: 2, t: 10_000 }, { intento: 3, t: 30_000 }]);   // 10 s y 20 s
    expect(paso('supabase')).toEqual({ name: 'supabase', status: 'done', findings: 2 });
    expect(estadoScan).toBe('succeeded');
    expect(puntajes).toEqual([[]]);
    expect(fallas).toEqual([]);
  });

  // Regresión de f2-repo: con attempts siempre 1, un paso que prefiere rendirse a fallar (repo con OSV caído) nunca
  // llegaba a su rama de rendirse y acababa failed/dlq en local.
  it('repo con OSV caído: el 2.º intento se rinde con done + osv_unavailable, como en Cloudflare', async () => {
    vi.useFakeTimers();
    tipo = 'repo';
    steps = pasosDe('repo').map((name) => ({ name, status: 'pending' as const }));
    registrarPaso('repo', async (_e, _m, intento = 1) => {
      if (intento <= REINTENTOS.repo) throw new ProviderError('unavailable', 503);   // quedaReintento
      return { status: 'done' as const, findings: 1, error_code: 'osv_unavailable' };
    });
    registrarPaso('resumen_ia', async () => ({ status: 'done' as const }));
    const { enviar, drenar } = montar();
    await enviar('repo');
    await drenar(30_000);
    expect(paso('repo')).toEqual({ name: 'repo', status: 'done', findings: 1, error_code: 'osv_unavailable' });
    expect(estadoScan).toBe('succeeded');
  });

  it('agotados los reintentos de su paso (transitorio) → failed con su código y la cadena sigue, sin DLQ', async () => {
    vi.useFakeTimers();
    registrarPaso('repo', async () => { throw new ProviderError('unavailable', 503); });
    registrarPaso('resumen_ia', async () => ({ status: 'done' as const }));
    steps = steps.map((s) => (s.name === 'supabase' || s.name === 'cloudflare' ? { ...s, status: 'done' } : s));
    const { enviar, drenar } = montar();
    await enviar('repo');
    await drenar(30_000);
    expect(paso('repo')).toEqual({ name: 'repo', status: 'failed', error_code: 'unavailable' });
    expect(estadoScan).toBe('succeeded');
  });

  it('pasado max_retries (4 entregas) → cierre de la DLQ: failed/dlq y la cadena sigue', async () => {
    vi.useFakeTimers();
    const intentos: (number | undefined)[] = [];
    registrarPaso('repo', async (_e, _m, intento) => { intentos.push(intento); return { status: 'done' as const }; });
    registrarPaso('resumen_ia', async () => ({ status: 'done' as const }));
    steps = steps.map((s) => (s.name === 'supabase' || s.name === 'cloudflare' ? { ...s, status: 'done' } : s));
    fallos.marcaDe = { repo: 4 };   // falla la marca en las 4 entregas; la de la DLQ ya entra
    const { enviar, drenar, fallas } = montar();
    await enviar('repo');
    await drenar(200_000);
    expect(intentos).toEqual([1, 2, 3, 4]);
    expect(paso('repo')).toEqual({ name: 'repo', status: 'failed', error_code: 'dlq' });
    expect(estadoScan).toBe('succeeded');
    expect(puntajes.length).toBeGreaterThan(0);
    expect(puntajes.every((a) => a.length === 0)).toBe(true);   // puntaje nunca calculó con repo abierto
    expect(fallas).toEqual([]);
  });

  it('una entrega que revienta sin ack ni retry se reintenta, como en la cola real', async () => {
    vi.useFakeTimers();
    tipo = 'cloudflare';
    steps = pasosDe('cloudflare').map((name) => ({ name, status: 'pending' as const }));
    registrarPaso('cloudflare', async () => ({ status: 'done' as const }));
    registrarPaso('resumen_ia', async () => ({ status: 'done' as const }));
    // La primera RPC (el reclamo, fuera de los try de guarded) revienta: runJob lanza sin ack ni retry.
    const real = doble.client;
    let reventar = true;
    estado.client = { ...real, rpc: async (name: string, args: Record<string, unknown>) => {
      if (reventar) { reventar = false; throw new TypeError('boom'); }
      return real.rpc(name, args);
    } };
    const { enviar, drenar, fallas } = montar();
    await enviar('cloudflare');
    await drenar(30_000);
    expect(fallas).toEqual([expect.any(TypeError)]);
    expect(paso('cloudflare')).toMatchObject({ status: 'done' });
    expect(estadoScan).toBe('succeeded');
  });

  it('un paso wiki que pide retry vuelve con attempts+1 tras su delay; agotado max_retries, al cierre wiki de la DLQ', async () => {
    vi.useFakeTimers();
    const vistos: { intento: number; t: number }[] = [];
    const t0 = Date.now();
    wiki.paso.mockReset().mockImplementation(async (_e: unknown, _b: unknown, intento: number) => {
      vistos.push({ intento, t: Date.now() - t0 });
      return { retry: 120 };
    });
    wiki.dlq.mockReset().mockResolvedValue('ack');
    const { cola, drenar, fallas } = montar();
    await cola.send({ v: 1, kind: 'wiki', org_id: ORG, wiki_run_id: RUN_WIKI, paso: 'area', area: 'src' });
    await drenar(600_000);
    expect(vistos).toEqual([{ intento: 1, t: 0 }, { intento: 2, t: 120_000 }, { intento: 3, t: 240_000 }, { intento: 4, t: 360_000 }]);
    expect(wiki.dlq).toHaveBeenCalledOnce();
    expect(wiki.dlq.mock.calls[0]?.[1]).toMatchObject({ kind: 'wiki', paso: 'area', area: 'src' });
    expect(fallas).toEqual([]);
  });

  it('una fuente que no logra escribir steps[i] ni en su paso ni en la DLQ → el cierre forzado la deja failed y recalcula', async () => {
    vi.useFakeTimers();
    tipo = 'supabase';
    steps = pasosDe('supabase').map((name) => ({ name, status: 'pending' as const }));
    registrarPaso('supabase', async () => ({ status: 'failed' as const, error_code: 'forbidden' }));
    registrarPaso('resumen_ia', async () => ({ status: 'skipped' as const, error_code: 'sin_hallazgos' }));
    fallos.marcaDe = { supabase: 8 };   // 4 entregas del paso y 4 de su DLQ; la escritura del cierre forzado ya entra
    const { enviar, drenar, fallas } = montar();
    await enviar('supabase');
    await drenar(600_000);
    expect(estadoScan).toBe('failed');
    expect(paso('supabase')).toEqual({ name: 'supabase', status: 'failed', error_code: 'dlq' });
    expect(paso('resumen_ia')).toMatchObject({ status: 'skipped' });
    expect(eventos.filter((e) => e.startsWith('fin:'))).toEqual(['fin:failed']);
    expect(puntajes).toEqual([[]]);   // un solo cálculo: el del cierre, ya con supabase cerrada
    expect(fallas).toEqual([expect.objectContaining({ name: 'dlq_agotada' })]);
  });
});
