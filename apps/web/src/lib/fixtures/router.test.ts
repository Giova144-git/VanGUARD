import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures as fx, AlertPrefs, AuditDelta, CodeReviewSaved, CodeReviewState, Evolution, Finding, MergeGateSaved, ScanRun, type ConnectionCreated, type ConnectionPublic, type EstadoModulo, type IncidentDetail, type WikiRun } from '@vanguard/contracts';
import type { ApiError } from '../errores';
import { fixtureFetch, simularAtaque } from './router';

// El enrutador falso imita al BACK en lo que importa al IDOR (§15.3): orgMember, ids de otra org y la ruta inexistente.
// Corre en Node: sin location ni sessionStorage, escenario() da 'lleno' (el bloque ?escenario=vacio los simula). La sesión
// falsa se controla con este doble.
const sesion = vi.hoisted(() => ({ tipo: 'correo' as 'correo' | 'anonima' | null }));
vi.mock('../supabase-doble', () => ({ tipoSesionFalsa: () => sesion.tipo }));

const DEMO = fx.me.orgs[0]!.id;
const AJENA = '0f0f0f0f-0000-4000-8000-000000000001';
const NADA = '0f0f0f0f-0000-4000-8000-0000000000ff';

// Cada llamada espera 250 ms: el reloj falso los adelanta. El catch vacío evita el aviso de rechazo sin manejar
// mientras corre el reloj; quien llama sigue viendo el error.
async function pedir<T = unknown>(ruta: string, method = 'GET', body?: unknown): Promise<T> {
  const p = fixtureFetch<T>(ruta, { method, body });
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(300);
  return p;
}
const fallo = (ruta: string, method?: string, body?: unknown) =>
  pedir(ruta, method, body).then(() => { throw new Error(`${ruta} no falló`); }, (e: unknown) => e as ApiError);

let nueva: string;
beforeAll(async () => {
  vi.useFakeTimers({ now: Date.parse('2026-10-24T19:00:00.000Z') });
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  nueva = (await pedir<{ id: string }>('/api/orgs', 'POST', { name: 'Mi tienda' })).id;
});
afterAll(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
beforeEach(() => { sesion.tipo = 'correo'; });

describe('orgMember', () => {
  it.each([
    ['GET', 'overview'], ['GET', 'findings'], ['GET', `findings/${fx.findings[0]!.id}`], ['GET', 'modules/supabase/state'],
    ['GET', 'traffic'], ['GET', `scans/${fx.scanDone.id}`], ['GET', `wiki/runs/${fx.wikiRunDone.id}/doc`], ['GET', 'export'],
    ['POST', 'connections'], ['POST', 'scans'], ['POST', `scans/${NADA}/zip-result`], ['GET', 'ruta-que-no-existe'],
    ['GET', 'code-review'], ['PUT', 'code-review/gate'], ['POST', `code-review/reviews/${fx.codeReviewStateBloqueo.recent[0]!.id}/gate`],
  ])('una org ajena responde 404 a %s %s', async (method, resto) => {
    const e = await fallo(`/api/orgs/${AJENA}/${resto}`, method, {});
    expect(e).toMatchObject({ status: 404, code: 'not_found', message: 'Organización no encontrada' });
  });

  it('deja pasar lo que no va bajo /api/orgs/<org> y las orgs propias', async () => {
    expect(await pedir('/api/me')).toMatchObject({ orgs: expect.arrayContaining([expect.objectContaining({ id: nueva, role: 'owner' })]) });
    expect(await pedir('/api/demo/join', 'POST', {})).toEqual({ org_id: expect.any(String), sandbox: true });   // su copia (E4), no la demo compartida
    expect(await pedir(`/api/orgs/${DEMO}/overview`)).toEqual(fx.overview);
    expect(await pedir(`/api/orgs/${nueva}/overview`)).toEqual(fx.overviewVacio);
  });

  it('el anónimo de «Ver demo» no es miembro de una org creada con /start', async () => {
    sesion.tipo = 'anonima';
    expect(await fallo(`/api/orgs/${nueva}/overview`)).toMatchObject({ status: 404, message: 'Organización no encontrada' });
    expect(await pedir(`/api/orgs/${DEMO}/overview`)).toEqual(fx.overview);
  });
});

describe('ids de otra org', () => {
  it('una auditoría de otra org responde 404', async () => {
    const { scan_run_id: deDemo } = await pedir<{ scan_run_id: string }>(`/api/orgs/${DEMO}/scans`, 'POST', { kind: 'full_audit' });
    const { scan_run_id: deNueva } = await pedir<{ scan_run_id: string }>(`/api/orgs/${nueva}/scans`, 'POST', { kind: 'full_audit' });
    expect(await fallo(`/api/orgs/${nueva}/scans/${deDemo}`)).toMatchObject({ status: 404, message: 'Esa auditoría no existe' });
    expect(await fallo(`/api/orgs/${DEMO}/scans/${deNueva}`)).toMatchObject({ status: 404, message: 'Esa auditoría no existe' });
    expect(await fallo(`/api/orgs/${nueva}/scans/${fx.scanDone.id}`)).toMatchObject({ status: 404 });
    expect(await pedir(`/api/orgs/${DEMO}/scans/${fx.scanDone.id}`)).toEqual(fx.scanDone);
    expect(await pedir<ScanRun>(`/api/orgs/${DEMO}/scans/${deDemo}`)).toMatchObject({ id: deDemo, status: 'running' });
  });

  it('la auditoría de una org nueva no trae hallazgos, puntaje ni resumen de la demo', async () => {
    const { scan_run_id: id } = await pedir<{ scan_run_id: string }>(`/api/orgs/${nueva}/scans`, 'POST', { kind: 'full_audit' });
    await vi.advanceTimersByTimeAsync(12_000);
    const run = await pedir<ScanRun>(`/api/orgs/${nueva}/scans/${id}`);
    expect(run).toMatchObject({ status: 'succeeded', score: null, coverage: null, summary: null });
    // Sin conexiones: los pasos de proveedor no corren; el resumen sí.
    expect(run.steps.map((s) => s.status)).toEqual(['skipped', 'skipped', 'skipped', 'done']);
  });

  it('una wiki de otra org o inexistente responde 404, también su documento', async () => {
    expect(await fallo(`/api/orgs/${DEMO}/wiki/runs/${NADA}/doc`)).toMatchObject({ status: 404, message: 'Esa wiki no existe' });
    expect(await fallo(`/api/orgs/${nueva}/wiki/runs/${fx.wikiRunDone.id}`)).toMatchObject({ status: 404 });
    expect(await fallo(`/api/orgs/${nueva}/wiki/runs/${fx.wikiRunDone.id}/doc`)).toMatchObject({ status: 404 });
    expect(await pedir(`/api/orgs/${DEMO}/wiki/runs/${fx.wikiRunDone.id}/doc`)).toEqual(fx.wikiDoc);
    expect(await pedir(`/api/orgs/${nueva}/wiki/runs`)).toEqual([]);

    const { wiki_run_id: id } = await pedir<{ wiki_run_id: string }>(`/api/orgs/${nueva}/wiki/runs`, 'POST', { repo_full_name: 'mi-equipo/web' });
    expect(id).not.toBe(fx.wikiRunDone.id);
    expect((await pedir<WikiRun[]>(`/api/orgs/${nueva}/wiki/runs`)).map((r) => r.id)).toEqual([id]);
    expect(await pedir<WikiRun>(`/api/orgs/${nueva}/wiki/runs/${id}`)).toMatchObject({ id, status: 'running' });
    expect(await fallo(`/api/orgs/${DEMO}/wiki/runs/${id}`)).toMatchObject({ status: 404 });
    expect(await fallo(`/api/orgs/${DEMO}/wiki/runs/${id}/doc`)).toMatchObject({ status: 404 });
  });
});

describe('una org sin los datos de la demo', () => {
  it('lee sus tablas vacías', async () => {
    expect(await pedir(`/api/orgs/${nueva}/traffic?seconds=300`)).toEqual({ buckets: [], top_ips: [] });
    expect(await pedir(`/api/orgs/${nueva}/perf/runs?limit=30`)).toEqual([]);
    expect(await pedir(`/api/orgs/${nueva}/mcp-tokens`)).toEqual([]);
    expect(await pedir(`/api/orgs/${nueva}/ai/usage`)).toMatchObject({ today_usd: 0 });
    for (const m of ['supabase', 'cloudflare', 'codebase', 'performance'] as const) {
      const e = await pedir<EstadoModulo>(`/api/orgs/${nueva}/modules/${m}/state`);
      expect(e.ahora).toEqual([]);
      expect(e.cifras.every((c) => c.n === null)).toBe(true);
      expect(e.checks.every((c) => c.n === null && !c.comprobado)).toBe(true);
    }
    const md = await (await pedir<Response>(`/api/orgs/${nueva}/export?format=md`)).text();
    expect(md).toContain('Mi tienda');
    expect(md).not.toContain(fx.me.orgs[0]!.name);
    expect(await (await pedir<Response>(`/api/orgs/${nueva}/export?format=json`)).json()).toMatchObject({ findings: 0 });
  });

  it('ve el tráfico de su propio ataque simulado', async () => {
    const otra = (await pedir<{ id: string }>('/api/orgs', 'POST', { name: 'Otra tienda' })).id;
    expect(await pedir(`/api/orgs/${otra}/traffic`)).toEqual({ buckets: [], top_ips: [] });
    simularAtaque(otra);
    expect(await pedir(`/api/orgs/${otra}/traffic`)).toEqual(fx.traffic);
  });

  // Como estado/modulo.ts del BACK: sin conexión read activa del proveedor, ok:false con 'sin_conexion' (PantallaModulo lo
  // pinta como «aún no conectado», sin chapa roja). Rendimiento no tiene conexión: sin mediciones, ok:true y todo n:null.
  it('un módulo sin conexión responde como el BACK: ok:false y sin_conexion; Rendimiento sin mediciones, ok:true', async () => {
    for (const m of ['supabase', 'cloudflare', 'codebase'] as const) {
      expect(await pedir<EstadoModulo>(`/api/orgs/${nueva}/modules/${m}/state`))
        .toMatchObject({ ok: false, error: 'sin_conexion', contador: { rojo: 0, aviso: 0, cola: 0 }, ahora: [] });
    }
    const perf = await pedir<EstadoModulo>(`/api/orgs/${nueva}/modules/performance/state`);
    expect(perf).toMatchObject({ ok: true, contador: { rojo: 0, aviso: 0, cola: 0 }, ahora: [] });
    expect(perf.error).toBeUndefined();
    expect(perf.cifras.every((c) => c.n === null && c.rol === undefined)).toBe(true);
  });

  it('con la conexión read activa pasa a ok:true; la de ingesta no cuenta para Cloudflare; al quitarla vuelve a sin_conexion', async () => {
    const org = (await pedir<{ id: string }>('/api/orgs', 'POST', { name: 'Tienda conectada' })).id;
    const estado = (m: string) => pedir<EstadoModulo>(`/api/orgs/${org}/modules/${m}/state`);
    const conectar = async (body: Record<string, string>) =>
      (await pedir<ConnectionCreated>(`/api/orgs/${org}/connections`, 'POST', body)).connection.id;

    const sb = await conectar({ provider: 'supabase', pat: 'sbp_prueba', project_ref: 'abcdefghijklmnopqrst' });
    const s = await estado('supabase');
    expect(s).toMatchObject({ ok: true, ahora: [] });
    expect(s.error).toBeUndefined();
    expect(s.cifras.every((c) => c.n === null)).toBe(true);
    expect(s.checks.every((c) => c.n === null && !c.comprobado)).toBe(true);
    expect(await estado('cloudflare')).toMatchObject({ ok: false, error: 'sin_conexion' });

    await conectar({ provider: 'ingest', label: 'mi.app' });
    expect(await estado('cloudflare')).toMatchObject({ ok: false, error: 'sin_conexion' });
    await conectar({ provider: 'github', pat: 'github_pat_prueba', repo_full_name: 'mi-equipo/web' });
    expect((await estado('codebase')).ok).toBe(true);

    await pedir(`/api/orgs/${org}/connections/${sb}`, 'DELETE');
    expect(await estado('supabase')).toMatchObject({ ok: false, error: 'sin_conexion' });
  });

  it('la demo conserva sus datos', async () => {
    for (const m of ['supabase', 'cloudflare', 'codebase', 'performance'] as const)
      expect(await pedir(`/api/orgs/${DEMO}/modules/${m}/state`)).toEqual(fx.moduleState[m]);
    expect(await pedir(`/api/orgs/${DEMO}/traffic`)).toEqual(fx.traffic);
    expect(await pedir(`/api/orgs/${DEMO}/mcp-tokens`)).toEqual(fx.mcpTokens);
    expect(await (await pedir<Response>(`/api/orgs/${DEMO}/export?format=md`)).text()).toBe(fx.exportMd);
  });
});

// ?escenario=vacio: la demo sin sus datos. Módulo nuevo (resetModules) para no heredar las conexiones en memoria.
describe('?escenario=vacio', () => {
  const almacen = new Map<string, string>();
  afterAll(() => { vi.unstubAllGlobals(); });

  it('la demo sin datos responde como el BACK: sin_conexion en los tres proveedores y Rendimiento sin medir', async () => {
    vi.stubGlobal('location', { search: '?escenario=vacio' });
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v); } });
    vi.resetModules();
    const { fixtureFetch: vacio } = await import('./router');
    const pedirVacio = async <T>(ruta: string) => { const p = vacio<T>(ruta, { method: 'GET' }); p.catch(() => {}); await vi.advanceTimersByTimeAsync(300); return p; };

    expect(await pedirVacio(`/api/orgs/${DEMO}/connections`)).toEqual([]);
    for (const m of ['supabase', 'cloudflare', 'codebase'] as const)
      expect(await pedirVacio<EstadoModulo>(`/api/orgs/${DEMO}/modules/${m}/state`)).toMatchObject({ ok: false, error: 'sin_conexion', ahora: [] });
    const perf = await pedirVacio<EstadoModulo>(`/api/orgs/${DEMO}/modules/performance/state`);
    expect(perf).toMatchObject({ ok: true, ahora: [] });
    expect(perf.cifras.every((c) => c.n === null)).toBe(true);
    expect(almacen.get('vg-fx-escenario')).toBe('vacio');
  });
});

describe('ruta inexistente', () => {
  it.each(['/api/nada', `/api/orgs/${DEMO}/nada`, `/api/orgs/${DEMO}/modules/constructor/state`])(
    '%s responde 404 sin la ruta en el mensaje', async (ruta) => {
      const e = await fallo(ruta);
      expect(e).toMatchObject({ status: 404, code: 'not_found' });
      expect(e.message).not.toContain('nada');
      expect(e.message).not.toContain('constructor');
    });

  it('el mensaje es el de app.notFound', async () => {
    expect((await fallo(`/api/orgs/${DEMO}/nada`)).message).toBe('Ruta inexistente');
    expect((await fallo(`/api/orgs/${DEMO}/overview`, 'DELETE')).message).toBe('Ruta inexistente');
  });
});

// F-18: el ZIP se abre en el navegador y E23 solo recibe el ZipResult. Igual que rutas/scans.ts del BACK en E11 y que el
// plan en E23 (S09 09.3): 404 si no es de la org, 409 si no espera resultado, 413 > 1 MB, 422 fuera de contrato, 5 al día.
describe('ZIP analizado en el navegador (E11 zip y E23)', () => {
  const ZIP = { kind: 'zip', filename: 'mi-app.zip', size_bytes: 4096 };
  const HALLAZGO = { rule_id: 'CB_SECRET_OPENAI', severity: 'critical', title: 'Clave de OpenAI en el código', resource: 'src/ia.ts:3',
    evidence: { path: 'src/ia.ts', line: 3, preview: 'abcd…wxyz' } };
  const resultado = (findings: unknown[] = [HALLAZGO]) =>
    ({ files_seen: 12, deps: [{ ecosystem: 'npm', name: 'lodash', version: '4.17.20' }], findings, analyzer: 'core@0.1.0' });
  const crear = async (org: string) => (await pedir<{ scan_run_id: string }>(`/api/orgs/${org}/scans`, 'POST', ZIP)).scan_run_id;
  const destino = (org: string, id: string) => `/api/orgs/${org}/scans/${id}/zip-result`;
  const ver = (org: string, id: string) => pedir<ScanRun>(`/api/orgs/${org}/scans/${id}`);

  it('E11 zip crea un scan en waiting_result; otro E11 del mismo usuario reemplaza al que esperaba', async () => {
    const id = await crear(nueva);
    const run = ScanRun.parse(await ver(nueva, id));
    expect(run).toMatchObject({ id, kind: 'zip', status: 'queued', step: 'waiting_result', progress: 0, started_at: null, error: null });
    expect(run.steps).toEqual([{ name: 'zip', status: 'pending' }, { name: 'resumen_ia', status: 'pending' }]);

    const otro = await crear(nueva);
    expect(otro).not.toBe(id);
    expect(ScanRun.parse(await ver(nueva, id))).toMatchObject({ status: 'failed', error: 'ZIP_RESULT_MISSING' });
    expect(await fallo(destino(nueva, id), 'POST', resultado())).toMatchObject({ status: 409, code: 'conflict' });
  });

  it.each([
    ['un filename fuera de la regex', { filename: 'código.zip' }, 'filename'],
    ['un filename sin .zip', { filename: 'mi-app.tar' }, 'filename'],
    ['menos de 22 B', { size_bytes: 21 }, 'size_bytes'],
    ['más de 25 MB', { size_bytes: 25 * 1024 * 1024 + 1 }, 'size_bytes'],
  ])('E11 zip con %s → 422 invalid_body con field_errors', async (_caso, malo, campo) => {
    const e = await fallo(`/api/orgs/${nueva}/scans`, 'POST', { ...ZIP, ...malo });
    expect(e).toMatchObject({ status: 422, code: 'invalid_body' });
    expect(e.details?.field_errors).toHaveProperty(campo);
  });

  it('la sesión anónima no puede escribir: 403 en E11 zip y en E23', async () => {
    sesion.tipo = 'anonima';
    expect(await fallo(`/api/orgs/${DEMO}/scans`, 'POST', ZIP)).toMatchObject({ status: 403, code: 'forbidden' });
    expect(await fallo(destino(DEMO, NADA), 'POST', resultado())).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('E23 sin E11 → 404', async () => {
    expect(await fallo(destino(nueva, NADA), 'POST', resultado())).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('E23 con el scan de otra org → 404 y el scan sigue esperando', async () => {
    const id = await crear(nueva);
    expect(await fallo(destino(DEMO, id), 'POST', resultado())).toMatchObject({ status: 404, message: 'Esa auditoría no existe' });
    expect(await ver(nueva, id)).toMatchObject({ status: 'queued', step: 'waiting_result' });
  });

  it('E23 con evidence de más → 422 y el scan sigue esperando', async () => {
    const id = await crear(nueva);
    const conDeMas = resultado([{ ...HALLAZGO, evidence: { ...HALLAZGO.evidence, snippet: 'la línea entera' } }]);
    const e = await fallo(destino(nueva, id), 'POST', conDeMas);
    expect(e).toMatchObject({ status: 422, code: 'invalid_body' });
    expect(e.details?.field_errors).toHaveProperty('findings');
    expect(await ver(nueva, id)).toMatchObject({ status: 'queued', step: 'waiting_result' });
  });

  it('E23 de más de 1 MB → 413', async () => {
    const id = await crear(nueva);
    const e = await fallo(destino(nueva, id), 'POST', { ...resultado(), relleno: 'x'.repeat(1024 * 1024) });
    expect(e).toMatchObject({ status: 413, code: 'invalid_body' });
  });

  it('E23 feliz → 202 con el scan_run_id; el scan pasa por zip, puntaje y resumen_ia y sus hallazgos llegan con el prefijo', async () => {
    const id = await crear(DEMO);
    expect(await pedir(destino(DEMO, id), 'POST', resultado())).toEqual({ scan_run_id: id });
    const corriendo = ScanRun.parse(await ver(DEMO, id));
    expect(corriendo).toMatchObject({ kind: 'zip', status: 'running', step: 'zip' });
    expect(corriendo.steps).toEqual([{ name: 'zip', status: 'running' }, { name: 'resumen_ia', status: 'pending' }]);
    const deEste = async () => (await pedir<Finding[]>(`/api/orgs/${DEMO}/findings?module=codebase`)).filter((f) => f.scan_run_id === id);
    expect(await deEste()).toEqual([]);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(await ver(DEMO, id)).toMatchObject({ status: 'running', step: 'puntaje' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await ver(DEMO, id)).toMatchObject({ status: 'running', step: 'resumen_ia' });
    await vi.advanceTimersByTimeAsync(2_000);
    const fin = ScanRun.parse(await ver(DEMO, id));
    expect(fin).toMatchObject({ status: 'succeeded', progress: 100, step: null });
    expect(fin.steps).toEqual([{ name: 'zip', status: 'done', findings: 1 }, { name: 'resumen_ia', status: 'done' }]);

    const nuevos = await deEste();
    expect(nuevos).toEqual([expect.objectContaining({ module: 'codebase', rule_id: 'CB_SECRET_OPENAI', severity: 'critical',
      title: HALLAZGO.title, resource: 'zip:mi-app.zip/src/ia.ts:3', status: 'open' })]);
    Finding.parse(nuevos[0]);
    // La demo conserva los suyos: el del ZIP lleva un id nuevo.
    expect(fx.findings.map((f) => f.id)).not.toContain(nuevos[0]!.id);
    expect(await pedir<Finding[]>(`/api/orgs/${DEMO}/findings?module=codebase`))
      .toHaveLength(fx.findings.filter((f) => f.module === 'codebase').length + 1);
  });

  it('E23 dos veces → 409; también en una auditoría que no es de ZIP, y E11 zip con otro corriendo', async () => {
    const id = await crear(nueva);
    await pedir(destino(nueva, id), 'POST', resultado());
    expect(await fallo(destino(nueva, id), 'POST', resultado())).toMatchObject({ status: 409, code: 'conflict' });
    expect(await fallo(`/api/orgs/${nueva}/scans`, 'POST', ZIP)).toMatchObject({ status: 409, details: { scan_run_id: id } });
    const { scan_run_id: completa } = await pedir<{ scan_run_id: string }>(`/api/orgs/${DEMO}/scans`, 'POST', { kind: 'full_audit' });
    expect(await fallo(destino(DEMO, completa), 'POST', resultado())).toMatchObject({ status: 409 });
    expect(await fallo(destino(DEMO, fx.scanDone.id), 'POST', resultado())).toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(8_000);
  });

  it('E23 pasados 15 min desde E11 → 409', async () => {
    const id = await crear(nueva);
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
    expect(await fallo(destino(nueva, id), 'POST', resultado())).toMatchObject({ status: 409, code: 'conflict' });
  });

  // Módulo nuevo (resetModules): el contador del día empieza en cero y no depende de los tests de arriba.
  it('el sexto resultado del día en la misma org → 429 budget_exceeded, sin gastar el scan', async () => {
    vi.resetModules();
    const { fixtureFetch: limpio } = await import('./router');
    const pedirLimpio = async <T>(ruta: string, method = 'GET', body?: unknown) => {
      const p = limpio<T>(ruta, { method, body }); p.catch(() => {}); await vi.advanceTimersByTimeAsync(300); return p;
    };
    const crearLimpio = async () => (await pedirLimpio<{ scan_run_id: string }>(`/api/orgs/${DEMO}/scans`, 'POST', ZIP)).scan_run_id;
    for (let i = 0; i < 5; i++) {
      await pedirLimpio(destino(DEMO, await crearLimpio()), 'POST', resultado());
      await vi.advanceTimersByTimeAsync(8_000);
    }
    const sexto = await crearLimpio();
    const e = await pedirLimpio(destino(DEMO, sexto), 'POST', resultado()).then(() => null, (x: unknown) => x as ApiError);
    expect(e).toMatchObject({ status: 429, code: 'budget_exceeded' });
    expect(await pedirLimpio<ScanRun>(`/api/orgs/${DEMO}/scans/${sexto}`)).toMatchObject({ status: 'queued', step: 'waiting_result' });
  });
});

describe('revisión de código (E45, E46, E48, E49; asignaciones/revision-codigo.md §6.3)', () => {
  it('la demo arranca conectada con sus revisiones (el PR #7 del bloqueo encima) y el hallazgo del push se abre con ?finding=', async () => {
    const s = CodeReviewState.parse(await pedir(`/api/orgs/${DEMO}/code-review`));
    expect(s).toMatchObject({ available: true, config: { state: 'connected' } });
    expect(s.recent.map((r) => r.id)).toEqual(fx.codeReviewStateBloqueo.recent.map((r) => r.id));
    expect(await pedir<Finding>(`/api/orgs/${DEMO}/findings/${fx.hallazgoRevision.id}`)).toMatchObject({ rule_id: 'CB_SECRET_STRIPE_LIVE' });
  });

  it('E45 trae la foto de Codebase (delta) en los dos pushes del sábado, sobre codeReviewStateBloqueo; el PR #7, null', async () => {
    for (const tipo of ['correo', 'anonima'] as const) {
      sesion.tipo = tipo;
      const s = CodeReviewState.parse(await pedir(`/api/orgs/${DEMO}/code-review`));
      const [pr, secreto, limpia] = s.recent;
      expect(pr).toMatchObject({ id: fx.codeReviewStateBloqueo.recent[0]!.id, event: 'pull_request', delta: null });
      expect(secreto).toMatchObject({ id: fx.codeReviewState.recent[0]!.id, delta: fx.deltasRevision[secreto!.id] });
      expect(limpia).toMatchObject({ id: fx.codeReviewState.recent[1]!.id, delta: fx.deltasRevision[limpia!.id] });
      expect(secreto!.delta).toMatchObject({ first: false, kept: 7, fixed: 0 });
    }
  });

  it('el alta da el secreto vgw_ UNA vez; E45 nunca lo trae; la 3.ª consulta simula el ping; rotar da otro y espera el ping', async () => {
    const org = nueva;   // el tope de 3 orgs por dueño ya lo gastan los otros casos
    expect(await pedir(`/api/orgs/${org}/code-review`)).toMatchObject({ available: false, reason: 'sin_conexion', config: null });
    const gh = (await pedir<ConnectionCreated>(`/api/orgs/${org}/connections`, 'POST', { provider: 'github', pat: 'github_pat_prueba', repo_full_name: 'mi-equipo/web' })).connection.id;
    expect(await pedir(`/api/orgs/${org}/code-review`)).toMatchObject({ available: true, reason: null, config: null });

    // Sin config, rotate_secret es un alta normal, como en el BACK (2460162).
    const alta = CodeReviewSaved.parse(await pedir(`/api/orgs/${org}/code-review`, 'PUT', { connection_id: gh, enabled: true, rotate_secret: true }));
    expect(alta.webhook_secret).toMatch(/^vgw_[A-Za-z0-9_-]{43}$/);
    expect(alta.config).toMatchObject({ state: 'waiting_ping', secret_last4: alta.webhook_secret!.slice(-4) });
    const leer = () => pedir<CodeReviewState>(`/api/orgs/${org}/code-review`);
    expect(JSON.stringify(await leer())).not.toContain(alta.webhook_secret);
    await leer();
    expect((await leer()).config).toMatchObject({ state: 'connected', hook_events: ['pull_request', 'push'] });

    expect(await pedir(`/api/orgs/${org}/code-review`, 'PUT', { connection_id: gh, enabled: false })).toMatchObject({ webhook_secret: null, config: { state: 'off' } });
    const otro = CodeReviewSaved.parse(await pedir(`/api/orgs/${org}/code-review`, 'PUT', { connection_id: gh, enabled: true, rotate_secret: true }));
    expect(otro.webhook_secret).toMatch(/^vgw_[A-Za-z0-9_-]{43}$/);
    expect(otro.webhook_secret).not.toBe(alta.webhook_secret);
    expect(otro.config).toMatchObject({ id: alta.config.id, state: 'waiting_ping', last_ping_at: null, last_event_at: null, hook_events: [],
      secret_last4: otro.webhook_secret!.slice(-4), webhook_url: alta.config.webhook_url });
    expect(JSON.stringify(await leer())).not.toContain(otro.webhook_secret);
    expect(await fallo(`/api/orgs/${org}/code-review`, 'PUT', { connection_id: NADA, enabled: true })).toMatchObject({ status: 404 });
  });

  it('el anónimo de la demo ve el estado sin la URL del webhook y no puede activarla ni cambiar los avisos', async () => {
    sesion.tipo = 'anonima';
    const s = await pedir<CodeReviewState>(`/api/orgs/${DEMO}/code-review`);
    expect(s.config?.webhook_url).toBeNull();
    expect(await fallo(`/api/orgs/${DEMO}/code-review`, 'PUT', { connection_id: s.config!.connection_id, enabled: false })).toMatchObject({ status: 403 });
    expect(await fallo(`/api/orgs/${DEMO}/alert-prefs`, 'PUT', { review_whatsapp_min: 'off', review_voice_min: 'off' })).toMatchObject({ status: 403 });
  });

  it('avisos: «Alta o más» y «Solo crítica» por defecto, sin llamadas; guardar devuelve lo guardado con su hora', async () => {
    const antes = AlertPrefs.parse(await pedir(`/api/orgs/${DEMO}/alert-prefs`));
    expect(antes).toMatchObject({ review_whatsapp_min: 'high', review_voice_min: 'critical', voice_available: false, updated_at: null });
    const despues = AlertPrefs.parse(await pedir(`/api/orgs/${DEMO}/alert-prefs`, 'PUT', { review_whatsapp_min: 'medium', review_voice_min: 'off' }));
    expect(despues).toMatchObject({ review_whatsapp_min: 'medium', review_voice_min: 'off' });
    expect(despues.updated_at).not.toBeNull();
    expect(await fallo(`/api/orgs/${DEMO}/alert-prefs`, 'PUT', { review_whatsapp_min: 'altisima', review_voice_min: 'off' })).toMatchObject({ status: 422 });
  });
});

describe('modo bajo ataque (E55, E56, E21 y E22; asignaciones/modo-bajo-ataque.md §9)', () => {
  const INC = fx.incidentDetail.id;
  const E55 = (org = DEMO, id = INC) => `/api/orgs/${org}/incidents/${id}/under-attack`;
  type Oferta = { ofrece: boolean; motivo: string | null; activo: { action_id: string; expires_at: string; created_at: string } | null };

  it('una org ajena o un incidente de otra org responden 404 a E55 y E56', async () => {
    expect(await fallo(E55(AJENA))).toMatchObject({ status: 404, message: 'Organización no encontrada' });
    expect(await fallo(`${E55(AJENA)}/propose`, 'POST', {})).toMatchObject({ status: 404, message: 'Organización no encontrada' });
    expect(await fallo(E55(nueva))).toMatchObject({ status: 404, message: 'Este incidente no existe' });
    expect(await fallo(`${E55(nueva)}/propose`, 'POST', {})).toMatchObject({ status: 404 });
  });

  it('la demo ofrece el modo en la inundación; el ensayo (sin CF_IP_FLOOD) no aplica; el anónimo no puede proponer', async () => {
    expect(await pedir(E55())).toEqual(fx.underAttackOffer);
    expect(await pedir(E55(DEMO, fx.incidents[1]!.id))).toMatchObject({ ofrece: false, motivo: 'no_aplica', ips: 0, scopes: [] });
    expect(await fallo(`${E55(DEMO, fx.incidents[1]!.id)}/propose`, 'POST', {})).toMatchObject({ status: 422, details: { reason: 'no_aplica' } });
    sesion.tipo = 'anonima';
    expect(await pedir(E55())).toEqual(fx.underAttackOffer);                 // E55 es de lectura: el viewer también la ve
    expect(await fallo(`${E55()}/propose`, 'POST', {})).toMatchObject({ status: 403 });
  });

  it('propose → confirm (activo 30 min, id ACTION_BAJO_ATAQUE) → E55 con activo → 409 al proponer otra vez → undo', async () => {
    const p = await pedir<{ approval_id: string; expires_at: string }>(`${E55()}/propose`, 'POST', { scope: 'host' });
    const { expires_at: _fija, ...resto } = fx.underAttackProposal;
    expect(p).toMatchObject(resto);
    expect(Date.parse(p.expires_at) - Date.now()).toBeGreaterThan(599_000);   // reescrita con el reloj, no la fija del fixture
    expect(p.approval_id).toBe(fx.underAttackProposal.approval_id);
    expect(await fallo(`/api/orgs/${nueva}/actions/${p.approval_id}/confirm`, 'POST', { code: '123456' })).toMatchObject({ status: 404 });
    const r = await pedir<{ ok: boolean; action_id: string }>(`/api/orgs/${DEMO}/actions/${p.approval_id}/confirm`, 'POST', { code: '123456' });
    expect(r).toMatchObject({ ok: true, action_id: 'ac000000-0000-4000-8000-000000000001' });
    const o = await pedir<Oferta>(E55());
    expect(o.activo).toMatchObject({ action_id: r.action_id, scope: 'host', target: 'demo.officialvanguard.com', retirada_fallida: false });
    expect(Date.parse(o.activo!.expires_at) - Date.parse(o.activo!.created_at)).toBe(30 * 60_000);
    const i = await pedir<IncidentDetail>(`/api/orgs/${DEMO}/incidents/${INC}`);
    expect(i.status).toBe('mitigated');
    expect(i.actions).toContainEqual(expect.objectContaining({ id: r.action_id, kind: 'under_attack_on', status: 'executed' }));
    expect(await fallo(`${E55()}/propose`, 'POST', {})).toMatchObject({ status: 409, details: { reason: 'already_active', action_id: r.action_id } });
    expect(await pedir(`/api/orgs/${DEMO}/actions/${r.action_id}/undo`, 'POST', {})).toMatchObject({ ok: true, resultado: 'Modo bajo ataque desactivado' });
    expect((await pedir<Oferta>(E55())).activo).toBeNull();
    expect((await pedir<IncidentDetail>(`/api/orgs/${DEMO}/incidents/${INC}`)).status).toBe('open');
    expect(await fallo(`/api/orgs/${DEMO}/actions/${r.action_id}/undo`, 'POST', {})).toMatchObject({ status: 409 });
  });

  // Los tres casos de la vista previa con la forma de leerOfertaBajoAtaque: la regla sigue ofreciéndolo (ofrece: true) y
  // lo que falta es el token o su permiso, con los pasos para hacerlo a mano en `copiar`; con permiso, la oferta de siempre.
  const blindaje = async () => (await pedir<ConnectionPublic[]>(`/api/orgs/${DEMO}/connections`)).find((c) => c.provider === 'cloudflare' && c.kind === 'action');
  const conectar = (action_token: string) => pedir<ConnectionCreated>(`/api/orgs/${DEMO}/connections`, 'POST',
    { provider: 'cloudflare', zone_id: '14d12778b0249e6d6854a67876c37e72', read_token: 'cf_lectura_prueba', action_token });
  const PASOS_SIN_ZONA = fx.underAttackOfferSinPermiso.copiar.replace(/^.*\n/, 'Para activarlo a mano en Cloudflare:\n');

  it('el token de Modo blindaje de la demo trae Config Rules · Edit: permiso ok, y «Probar conexión» lo dice', async () => {
    const accion = (await blindaje())!;
    expect(accion.capabilities).toMatchObject({ firewall_read: true, config_rules_edit: true });
    expect(await pedir(E55())).toMatchObject({ motivo: null, permiso: 'ok', scopes: ['host'], copiar: null, connection_id: accion.id });
    expect((await pedir<{ checks: unknown[] }>(`/api/orgs/${DEMO}/connections/${accion.id}/test`, 'POST', {})).checks)
      .toContainEqual({ permission: 'config_rules_edit', ok: true, required: false });
  });

  it('sin Modo blindaje: E55 dice sin_conexion (ofrece sigue true, sin zona ni permiso, con los pasos) y E56 da 409 no_action_connection', async () => {
    await pedir(`/api/orgs/${DEMO}/connections/${(await blindaje())!.id}`, 'DELETE');
    const o = await pedir<Record<string, unknown>>(E55());
    expect(o).toEqual({ ...fx.underAttackOffer, motivo: 'sin_conexion', scopes: [], zone_name: null, connection_id: null, permiso: null, copiar: PASOS_SIN_ZONA });
    expect(o.copiar).toMatch(/^Para activarlo a mano en Cloudflare:\n1\. Rules → Configuration Rules → Create rule\.\n2\. If incoming requests match: Hostname · equals · demo\.officialvanguard\.com\./);
    expect(await fallo(`${E55()}/propose`, 'POST', {})).toMatchObject({ status: 409, details: { reason: 'no_action_connection' } });
    expect(await pedir(E55(DEMO, fx.incidents[1]!.id))).toMatchObject({ motivo: 'no_aplica', copiar: null });   // sin inundación, nada que copiar
  });

  it('con un token de Modo blindaje sin Config Rules · Edit: sin_permiso con los pasos de fx.underAttackOfferSinPermiso y E56 da 409 sin_permiso', async () => {
    const creada = await conectar('cf_acciones_sin-config_prueba');
    const accion = creada.action_connection!;
    expect(accion.capabilities).toMatchObject({ config_rules_edit: false });
    expect(await pedir(E55())).toEqual({ ...fx.underAttackOfferSinPermiso, connection_id: accion.id });
    expect(await fallo(`${E55()}/propose`, 'POST', {})).toMatchObject({ status: 409,
      details: { reason: 'sin_permiso', copiar: fx.underAttackOfferSinPermiso.copiar } });
    expect((await pedir<{ ok: boolean; checks: unknown[] }>(`/api/orgs/${DEMO}/connections/${accion.id}/test`, 'POST', {})))
      .toMatchObject({ ok: true, checks: expect.arrayContaining([{ permission: 'config_rules_edit', ok: false, required: false, error_code: 'forbidden' }]) });
    sesion.tipo = 'anonima';
    expect(await pedir(E55())).toMatchObject({ motivo: 'sin_permiso' });              // el viewer también ve la vista previa
  });

  it('al volver a conectarlo con el permiso, la oferta de siempre (permiso ok, botón y E56 con su código)', async () => {
    await pedir(`/api/orgs/${DEMO}/connections/${(await blindaje())!.id}`, 'DELETE');
    const accion = (await conectar('cf_acciones_prueba')).action_connection!;
    expect(await pedir(E55())).toEqual({ ...fx.underAttackOffer, connection_id: accion.id });
    expect(await pedir(`${E55()}/propose`, 'POST', {})).toMatchObject({ approval_id: fx.underAttackProposal.approval_id, validado: true });
  });
});

// Al final a propósito: estos casos dejan un 2.º repo en la org de demo (el tope de 3 orgs por dueño ya está gastado).
describe('varias codebases (asignaciones/varias-codebases.md §6.5)', () => {
  const REPO = fx.wikiRunDone.repo_full_name;
  const REPO_2 = fx.conexionGithub2.meta.repo_full_name;
  const CONN_GITHUB = fx.connections.find((c) => c.provider === 'github')!.id;

  it('wiki: E43 filtra por ?repo= sin distinguir mayúsculas (422 si no es owner/repo) y E40/E41 exigen el repo de la conexión', async () => {
    expect((await pedir<WikiRun[]>(`/api/orgs/${DEMO}/wiki/runs?repo=${REPO.toUpperCase()}`)).map((r) => r.id)).toEqual(fx.wikiRuns.map((r) => r.id));
    expect(await pedir(`/api/orgs/${DEMO}/wiki/runs?repo=${REPO_2}`)).toEqual([]);
    expect(await fallo(`/api/orgs/${DEMO}/wiki/runs?repo=foo`)).toMatchObject({ status: 422 });
    const otroRepo = { repo_full_name: REPO_2, connection_id: CONN_GITHUB };
    expect(await fallo(`/api/orgs/${DEMO}/wiki/estimate`, 'POST', otroRepo)).toMatchObject({ status: 404, message: 'Conexión no encontrada' });
    expect(await fallo(`/api/orgs/${DEMO}/wiki/runs`, 'POST', otroRepo)).toMatchObject({ status: 404, message: 'Conexión no encontrada' });
    expect(await pedir(`/api/orgs/${DEMO}/wiki/estimate`, 'POST', { repo_full_name: REPO_2 })).toMatchObject({ repo_full_name: REPO_2 });
    // La wiki de otro repo de la demo es una corrida nueva, de ese repo, con su documento.
    const { wiki_run_id: id } = await pedir<{ wiki_run_id: string }>(`/api/orgs/${DEMO}/wiki/runs`, 'POST', { repo_full_name: REPO_2 });
    expect(id).not.toBe(fx.wikiRunDone.id);
    expect((await pedir<WikiRun[]>(`/api/orgs/${DEMO}/wiki/runs?repo=${REPO_2}`)).map((r) => r.id)).toEqual([id]);
    expect((await pedir<WikiRun[]>(`/api/orgs/${DEMO}/wiki/runs?repo=${REPO}`)).map((r) => r.id)).toEqual(fx.wikiRuns.map((r) => r.id));
    expect(await pedir(`/api/orgs/${DEMO}/wiki/runs/${id}/doc`)).toMatchObject({ run_id: id, repo_full_name: REPO_2 });
  });
});

// Sigue en la org de demo y después del bloque de la wiki: el 2.º repo se queda conectado para los casos siguientes.
describe('varias codebases · conexiones, revisión por repo y auditoría (§6.5)', () => {
  const CONN_GITHUB = fx.connections.find((c) => c.provider === 'github')!.id;
  const REPO = fx.connections.find((c) => c.provider === 'github')!.meta.repo_full_name;
  const REPO_2 = fx.conexionGithub2.meta.repo_full_name;
  const conectar = (repo: string, pat: string) => pedir<ConnectionCreated>(`/api/orgs/${DEMO}/connections`, 'POST', { provider: 'github', repo_full_name: repo, pat });
  const fallaConectar = (repo: string, pat: string) => fallo(`/api/orgs/${DEMO}/connections`, 'POST', { provider: 'github', repo_full_name: repo, pat });

  it('E8: el mismo repo activo (otras mayúsculas) da 409 repo_duplicado; REPO_2 devuelve conexionGithub2 con la marca', async () => {
    expect(await fallaConectar(REPO.toUpperCase(), 'github_pat_token_del_repo_uno_000')).toMatchObject({ status: 409, details: { reason: 'repo_duplicado' } });
    const r = await conectar(REPO_2, 'github_pat_token_del_repo_dos_0000');
    expect(r.connection).toEqual(fx.conexionGithub2);
    expect(r.connection.meta).toMatchObject({ hallazgos_por_repo: true });
    expect((await pedir<{ id: string }[]>(`/api/orgs/${DEMO}/connections`)).map((c) => c.id)).toContain(fx.conexionGithub2.id);
  });

  it('E8: el mismo token que otra conexión da 409 sin reason; con 5 repos distintos, 409 tope_repos', async () => {
    const e = await fallaConectar('equipo/otro', 'github_pat_token_del_repo_dos_0000');
    expect(e).toMatchObject({ status: 409, message: 'Ese token ya está conectado en esta organización.' });
    expect(e.details?.reason).toBeUndefined();
    for (const n of [3, 4, 5]) await conectar(`equipo/repo-${n}`, `github_pat_token_del_repo_${n}_00000`);
    expect(await fallaConectar('equipo/repo-6', 'github_pat_token_del_repo_6_00000')).toMatchObject({ status: 409, details: { reason: 'tope_repos' } });
    // Quitar uno libera su token y un hueco.
    const lista = await pedir<{ id: string; meta: { repo_full_name?: string } }[]>(`/api/orgs/${DEMO}/connections`);
    await pedir(`/api/orgs/${DEMO}/connections/${lista.find((c) => c.meta.repo_full_name === 'equipo/repo-5')!.id}`, 'DELETE');
    expect((await conectar('equipo/repo-6', 'github_pat_token_del_repo_5_00000')).connection.meta).toMatchObject({ repo_full_name: 'equipo/repo-6' });
  });

  it('E45 por conexión: ?connection_id= da el estado de ESE repo; sin él, el principal; malformado 422; ajeno sin_conexion', async () => {
    expect(await pedir(`/api/orgs/${DEMO}/code-review?connection_id=${fx.conexionGithub2.id}`)).toEqual(fx.codeReviewStateRepo2);
    const principal = CodeReviewState.parse(await pedir(`/api/orgs/${DEMO}/code-review`));
    expect(principal.config?.connection_id).toBe(CONN_GITHUB);
    expect((await pedir<CodeReviewState>(`/api/orgs/${DEMO}/code-review?connection_id=${CONN_GITHUB}`)).recent).toHaveLength(principal.recent.length);
    expect(await fallo(`/api/orgs/${DEMO}/code-review?connection_id=no-es-un-id`)).toMatchObject({ status: 422 });
    expect(await pedir(`/api/orgs/${DEMO}/code-review?connection_id=${NADA}`)).toMatchObject({ available: false, reason: 'sin_conexion', config: null, recent: [] });
    // Activar el 2.º repo crea SU config (con su repo) y no toca la del primero.
    const alta = CodeReviewSaved.parse(await pedir(`/api/orgs/${DEMO}/code-review`, 'PUT', { connection_id: fx.conexionGithub2.id, enabled: true }));
    expect(alta.config).toMatchObject({ connection_id: fx.conexionGithub2.id, repo_full_name: REPO_2, state: 'waiting_ping' });
    expect(alta.webhook_secret).toMatch(/^vgw_/);
    expect((await pedir<CodeReviewState>(`/api/orgs/${DEMO}/code-review?connection_id=${CONN_GITHUB}`)).config?.id).toBe(principal.config?.id);
  });

  it('E12 con dos o más repos trae una línea por repo; E5 lleva el connection_id de cada hallazgo de «Ahora»', async () => {
    const run = ScanRun.parse(await pedir(`/api/orgs/${DEMO}/scans/${fx.scanDone.id}`));
    expect(run.repos?.slice(0, 2)).toEqual(fx.scanDoneDosRepos.repos);
    const { scan_run_id: id } = await pedir<{ scan_run_id: string }>(`/api/orgs/${DEMO}/scans`, 'POST', { kind: 'full_audit' });
    expect((await pedir<ScanRun>(`/api/orgs/${DEMO}/scans/${id}`)).repos).toBeUndefined();   // el paso repo aún no terminó
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await pedir<ScanRun>(`/api/orgs/${DEMO}/scans/${id}`)).repos?.map((r) => r.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    const o = await pedir<{ ahora: { kind: string; connection_id?: string | null }[] }>(`/api/orgs/${DEMO}/overview`);
    const hallazgos = o.ahora.filter((a) => a.kind === 'finding');
    expect(hallazgos.length).toBeGreaterThan(0);
    expect(hallazgos.every((a) => a.connection_id !== undefined)).toBe(true);
    expect(o.ahora.filter((a) => a.kind === 'incident').every((a) => a.connection_id === undefined)).toBe(true);
  });
});

// Bloqueo de merge con críticos (bloqueo-merge-criticos.md §6.5 y anexo de cierre de PR). Al final: cambia el estado
// del bloqueo de la demo y da de alta su token de estados.
describe('bloqueo de merge (E45 con gate, E53, E54)', () => {
  const CONN_GITHUB = fx.connections.find((c) => c.provider === 'github')!.id;
  const PR = fx.codeReviewStateBloqueo.recent[0]!.id;
  const LIMPIA = fx.codeReviewState.recent[1]!.id;
  const leer = (q = '') => pedir<CodeReviewState>(`/api/orgs/${DEMO}/code-review${q}`);
  const bloqueo = (body: unknown) => pedir<MergeGateSaved>(`/api/orgs/${DEMO}/code-review/gate`, 'PUT', body);
  const accion = (id: string, body: unknown) => pedir(`/api/orgs/${DEMO}/code-review/reviews/${id}/gate`, 'POST', body);
  const BASE = { enabled: true, min_severity: 'critical' };

  it('la demo trae codeReviewStateBloqueo con el anexo (cerrar PR) y el PR #7 cerrado; el 2.º repo, sin gate', async () => {
    const s = CodeReviewState.parse(await leer());
    expect(s.config?.gate).toMatchObject({ ...fx.codeReviewStateBloqueo.config.gate, close_pr: true, can_close_pr: true });
    expect(s.recent[0]!.gate).toMatchObject({ state: 'failure', blocking: 1, pr_action: 'closed' });
    expect((await leer(`?connection_id=${fx.conexionGithub2.id}`)).config?.gate).toBeUndefined();
  });

  it('E53 y E54: el anónimo de la demo no puede escribir (403)', async () => {
    sesion.tipo = 'anonima';
    expect(await fallo(`/api/orgs/${DEMO}/code-review/gate`, 'PUT', BASE)).toMatchObject({ status: 403 });
    expect(await fallo(`/api/orgs/${DEMO}/code-review/reviews/${PR}/gate`, 'POST', { op: 'revert' })).toMatchObject({ status: 403 });
  });

  it('E53 con token: token clásico y permisos de más dan 422; uno bueno publica la prueba ✗ y aparece en Conexiones', async () => {
    expect(await fallo(`/api/orgs/${DEMO}/code-review/gate`, 'PUT', { ...BASE, statuses_pat: 'ghp_tokenclasicodegithub0000' })).toMatchObject({ status: 422, code: 'key_rejected' });
    expect(await fallo(`/api/orgs/${DEMO}/code-review/gate`, 'PUT', { ...BASE, statuses_pat: 'github_pat_con_contents_00000000' }))
      .toMatchObject({ status: 422, details: { reason: 'excess_scope', excess_permissions: ['contents', 'administration'] } });
    const r = MergeGateSaved.parse(await bloqueo({ ...BASE, statuses_pat: 'github_pat_estados_de_la_demo_k9Qz' }));
    expect(r).toMatchObject({ probe_sha: fx.mergeGateSaved.probe_sha, probe_state: 'failure', gate: { state: 'unchecked', can_close_pr: true } });
    expect(JSON.stringify(r)).not.toContain('github_pat_');
    const cx = await pedir<{ id: string; provider: string; kind: string; meta: Record<string, unknown> }[]>(`/api/orgs/${DEMO}/connections`);
    expect(cx.find((c) => c.provider === 'github' && c.kind === 'action')).toMatchObject({ id: fx.mergeGateSaved.gate.statuses_connection.id, meta: { branch: 'main' } });
    // Otro token rota el de la MISMA conexión.
    const otro = MergeGateSaved.parse(await bloqueo({ ...BASE, statuses_pat: 'github_pat_estados_nuevo_de_la_demo' }));
    expect(otro.gate.statuses_connection).toMatchObject({ id: r.gate.statuses_connection!.id, last4: 'demo' });
  });

  it('E54: dar por bueno y deshacer el PR #7, reabrirlo una vez; lo limpio o ajeno no se toca', async () => {
    expect(await accion(PR, { op: 'override', reason: 'Clave de prueba' })).toEqual({ ok: true, resultado: 'encolado' });
    expect((await leer()).recent[0]!.gate).toMatchObject({ state: 'success', override_at: expect.any(String) });
    expect(await fallo(`/api/orgs/${DEMO}/code-review/reviews/${PR}/gate`, 'POST', { op: 'override', reason: 'Otra vez' })).toMatchObject({ status: 409, details: { reason: 'nada_que_aprobar' } });
    await accion(PR, { op: 'revert' });
    expect((await leer()).recent[0]!.gate).toMatchObject({ state: 'failure', override_at: null });
    expect(await fallo(`/api/orgs/${DEMO}/code-review/reviews/${PR}/gate`, 'POST', { op: 'revert' })).toMatchObject({ status: 409, details: { reason: 'sin_override' } });
    await accion(PR, { op: 'reopen_pr' });
    expect((await leer()).recent[0]!.gate).toMatchObject({ pr_action: 'reopened', state: 'failure' });
    expect(await fallo(`/api/orgs/${DEMO}/code-review/reviews/${PR}/gate`, 'POST', { op: 'reopen_pr' })).toMatchObject({ status: 409 });
    expect(await fallo(`/api/orgs/${DEMO}/code-review/reviews/${LIMPIA}/gate`, 'POST', { op: 'override', reason: 'Limpia' })).toMatchObject({ status: 409 });
    // P1: «Publicar de nuevo» publica lo que ya se sabe de la más reciente del PR; una revisión de antes del bloqueo, 409.
    expect(await accion(PR, { op: 'republish' })).toEqual({ ok: true, resultado: 'encolado' });
    expect((await leer()).recent[0]!.gate).toMatchObject({ state: 'failure', error: null });
    expect(await fallo(`/api/orgs/${DEMO}/code-review/reviews/${fx.codeReviewState.recent[0]!.id}/gate`, 'POST', { op: 'republish' })).toMatchObject({ status: 409, details: { reason: 'sin_calculo' } });
    expect(await fallo(`/api/orgs/${DEMO}/code-review/reviews/${NADA}/gate`, 'POST', { op: 'revert' })).toMatchObject({ status: 404 });
    expect(await fallo(`/api/orgs/${DEMO}/code-review/reviews/${PR}/gate`, 'POST', { op: 'override', reason: 'x' })).toMatchObject({ status: 422 });
  });

  it('apagado: E45 dice off y E54 da 409; con la revisión apagada, off y E53 da 409 sin_revision', async () => {
    expect((await bloqueo({ ...BASE, enabled: false })).gate.state).toBe('off');
    expect(await fallo(`/api/orgs/${DEMO}/code-review/reviews/${PR}/gate`, 'POST', { op: 'revert' })).toMatchObject({ status: 409, details: { reason: 'apagado' } });
    // P1: encender sin token relee la protección («Comprobar de nuevo»): GitHub exige el check → active.
    expect((await bloqueo(BASE)).gate).toMatchObject({ state: 'active', protection: { required: 'yes', admins: 'bypass', pr_required: 'unknown' } });
    await pedir(`/api/orgs/${DEMO}/code-review`, 'PUT', { connection_id: CONN_GITHUB, enabled: false });
    expect((await leer()).config?.gate?.state).toBe('off');
    expect(await fallo(`/api/orgs/${DEMO}/code-review/gate`, 'PUT', BASE)).toMatchObject({ status: 409, details: { reason: 'sin_revision' } });
    await pedir(`/api/orgs/${DEMO}/code-review`, 'PUT', { connection_id: CONN_GITHUB, enabled: true });
    expect((await leer()).config?.gate?.state).toBe('active');
  });

  it('quitar el token de estados en Conexiones deja el bloqueo pidiendo otro (needs_token)', async () => {
    const cx = await pedir<{ id: string; provider: string; kind: string }[]>(`/api/orgs/${DEMO}/connections`);
    const est = cx.find((c) => c.provider === 'github' && c.kind === 'action')!;
    expect(await pedir<{ checks: { permission: string }[] }>(`/api/orgs/${DEMO}/connections/${est.id}/test`, 'POST', {})).toMatchObject({ checks: [{ permission: 'statuses:read' }] });
    await pedir(`/api/orgs/${DEMO}/connections/${est.id}`, 'DELETE');
    expect((await leer()).config?.gate).toMatchObject({ state: 'needs_token', statuses_connection: null });
  });

  it('una org nueva con su repo: gate apagado en E45; encender sin token → needs_token; con token, prueba «pendiente»', async () => {
    const s = await pedir<CodeReviewState>(`/api/orgs/${nueva}/code-review`);
    expect(s.config?.gate).toMatchObject({ enabled: false, state: 'off', statuses_connection: null });
    const sin = MergeGateSaved.parse(await pedir(`/api/orgs/${nueva}/code-review/gate`, 'PUT', BASE));
    expect(sin).toMatchObject({ gate: { state: 'needs_token' }, probe_sha: null, probe_state: null, checks: [] });
    const con = MergeGateSaved.parse(await pedir(`/api/orgs/${nueva}/code-review/gate`, 'PUT', { ...BASE, statuses_pat: 'github_pat_estados_org_nueva_000000' }));
    expect(con).toMatchObject({ gate: { state: 'unchecked', close_pr: true }, probe_state: 'pending' });
    expect(con.probe_sha).toMatch(/^[0-9a-f]{40}$/);
    // E54 desde otra org propia con el id de una revisión de la demo: 404, y la del PR #7 no cambia.
    const antes = (await leer()).recent[0]!.gate;
    expect(await fallo(`/api/orgs/${nueva}/code-review/reviews/${PR}/gate`, 'POST', { op: 'override', reason: 'Desde otra org' }))
      .toMatchObject({ status: 404 });
    expect((await leer()).recent[0]!.gate).toEqual(antes);
  });
});

// Evolución (E51 y E52, asignaciones/evolucion-entre-revisiones.md §6.5). Módulo nuevo (resetModules): la cadena de fotos
// no hereda los ZIP ni el hallazgo del push que dejaron los casos de arriba, y hay cupo para crear orgs.
describe('evolución (E51 y E52)', () => {
  let f: typeof fixtureFetch;
  const pide = async <T = unknown>(ruta: string, method = 'GET', body?: unknown) => {
    const p = f<T>(ruta, { method, body }); p.catch(() => {}); await vi.advanceTimersByTimeAsync(300); return p;
  };
  const falla = (ruta: string) => pide(ruta).then(() => { throw new Error(`${ruta} no falló`); }, (e: unknown) => e as ApiError);
  const delta = (org: string, id: string) => pide<AuditDelta>(`/api/orgs/${org}/scans/${id}/delta`);
  const auditar = async (org: string) => (await pide<{ scan_run_id: string }>(`/api/orgs/${org}/scans`, 'POST', { kind: 'full_audit' })).scan_run_id;
  const conFoto = (d: AuditDelta) => { if (!d.available) throw new Error('sin foto'); return d; };
  beforeAll(async () => { vi.resetModules(); f = (await import('./router')).fixtureFetch; });

  it('la auditoría de la demo devuelve fx.auditDelta y sus dos corregidos entran en la lista de la org', async () => {
    const [verificado, aMano] = fx.hallazgosCorregidos;
    expect(await pide<Finding>(`/api/orgs/${DEMO}/findings/${aMano!.id}`)).toMatchObject({ status: 'fixed' });   // ?finding= antes que E51
    expect(AuditDelta.parse(await delta(DEMO, fx.scanDone.id))).toEqual(fx.auditDelta);
    const lista = await pide<Finding[]>(`/api/orgs/${DEMO}/findings`);
    expect(lista.filter((x) => x.id === verificado!.id || x.id === aMano!.id).map((x) => x.status).sort()).toEqual(['fixed', 'verified']);
    expect(lista).toHaveLength(fx.findings.length + 2);
  });

  it('otra org, un id desconocido o que no es uuid → 404 uniforme', async () => {
    const otra = (await pide<{ id: string }>('/api/orgs', 'POST', { name: 'Tienda sin datos' })).id;
    const deDemo = await auditar(DEMO);
    for (const [org, id] of [[otra, fx.scanDone.id], [otra, deDemo], [DEMO, NADA], [DEMO, 'no-es-uuid']] as const)
      expect(await falla(`/api/orgs/${org}/scans/${id}/delta`)).toMatchObject({ status: 404, message: 'Auditoría no encontrada' });
    expect(await falla(`/api/orgs/${AJENA}/scans/${fx.scanDone.id}/delta`)).toMatchObject({ status: 404, message: 'Organización no encontrada' });
    await vi.advanceTimersByTimeAsync(12_000);   // deja terminada la de la demo: es la anterior del caso siguiente
  });

  it('una auditoría simulada: en_curso mientras corre; al terminar se compara con la anterior y la cadena sigue', async () => {
    const id = await auditar(DEMO);
    expect(await delta(DEMO, id)).toEqual({ available: false, scan_run_id: id, reason: 'en_curso' });
    await vi.advanceTimersByTimeAsync(12_000);
    // Frente a la del caso anterior (que a su vez se comparó con la de la demo): nada cambió, los 12 abiertos se mantienen.
    const d = conFoto(AuditDelta.parse(await delta(DEMO, id)));
    expect(d).toMatchObject({ first: false, score: fx.scanDone.score, modules_seen: ['supabase', 'cloudflare', 'codebase'],
      previous: { kind: 'full_audit', score: fx.scanDone.score }, fixed_checked: 0, moved: 0, gone: 0 });
    expect(d.previous!.scan_run_id).not.toBe(fx.scanDone.id);
    expect([d.new.total, d.kept.total, d.fixed.total, d.ignored.total]).toEqual([0, 12, 0, 0]);

    // Se marca uno a mano y se audita otra vez: «corregido» frente a la anterior, con su estado de ahora.
    const marcado = d.kept.items[0]!.finding_id;
    await pide(`/api/orgs/${DEMO}/findings/${marcado}`, 'PATCH', { status: 'fixed' });
    const otra = await auditar(DEMO);
    await vi.advanceTimersByTimeAsync(12_000);
    const d2 = conFoto(AuditDelta.parse(await delta(DEMO, otra)));
    expect(d2.previous?.scan_run_id).toBe(id);
    expect([d2.new.total, d2.kept.total, d2.fixed.total]).toEqual([0, 11, 1]);
    expect(d2.fixed.items).toEqual([expect.objectContaining({ finding_id: marcado, status: 'fixed' })]);
    expect(d2.fixed_checked).toBe(0);
    // La foto de antes no se rehace: sus conteos siguen, y su lista trae el estado de ahora.
    const otraVez = conFoto(await delta(DEMO, id));
    expect(otraVez.counts).toEqual(d.counts);
    expect(otraVez.kept.items.find((i) => i.finding_id === marcado)?.status).toBe('fixed');
  });

  it('una org sin datos: con una fuente conectada, la primera foto (first:true, todo en 0); sin ninguna, sin_foto', async () => {
    const org = (await pide<{ id: string }>('/api/orgs', 'POST', { name: 'Tienda nueva' })).id;
    const sinFuentes = await auditar(org);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await delta(org, sinFuentes)).toEqual({ available: false, scan_run_id: sinFuentes, reason: 'sin_foto' });

    await pide(`/api/orgs/${org}/connections`, 'POST', { provider: 'supabase', pat: 'sbp_prueba', project_ref: 'abcdefghijklmnopqrst' });
    const id = await auditar(org);
    await vi.advanceTimersByTimeAsync(12_000);
    const d = conFoto(AuditDelta.parse(await delta(org, id)));
    expect(d).toMatchObject({ first: true, previous: null, modules_seen: ['supabase'], fixed_checked: 0, moved: 0, gone: 0 });
    for (const k of ['open', 'new', 'kept', 'fixed', 'ignored'] as const)
      expect(Object.values(d.counts[k]).flatMap((s) => Object.values(s)).every((v) => v === 0)).toBe(true);
    expect([d.new, d.kept, d.fixed, d.ignored]).toEqual(Array(4).fill({ total: 0, items: [] }));

    expect(Evolution.parse(await pide(`/api/orgs/${org}/evolution?days=7`))).toMatchObject({ days: 7, points: [], reviews: [],
      incidents: [], truncated: false, totals: { versions: 0, snapshots: 0, score_first: null }, mttr: { verified: 0, hours_avg: null } });
  });

  it('E52 en la demo es fx.evolution con los días pedidos; el anónimo también la lee', async () => {
    expect(await pide(`/api/orgs/${DEMO}/evolution`)).toEqual(fx.evolution);
    expect(Evolution.parse(await pide(`/api/orgs/${DEMO}/evolution?days=90&limit=30`))).toEqual({ ...fx.evolution, days: 90 });
    sesion.tipo = 'anonima';
    expect(await pide(`/api/orgs/${DEMO}/evolution?days=30`)).toEqual(fx.evolution);
    expect(conFoto(await delta(DEMO, fx.scanDone.id)).scan_run_id).toBe(fx.scanDone.id);
  });
});

// E57 «Simular ataque» (llamada-ataque.md F1), al final: deja un incidente simulado en la demo.
describe('E57 · simular ataque', () => {
  it('fuera de la demo o con el anónimo de «Ver demo»: 403', async () => {
    expect(await fallo(`/api/orgs/${nueva}/incidents/simulate`, 'POST', { kind: 'path_scan' })).toMatchObject({ status: 403 });
    sesion.tipo = 'anonima';
    expect(await fallo(`/api/orgs/${DEMO}/incidents/simulate`, 'POST', { kind: 'path_scan' })).toMatchObject({ status: 403 });
  });

  it('en la demo crea un incidente marcado como simulado; el segundo dentro de 2 min da 429', async () => {
    const r = await pedir<{ incident_id: string; code: string; whatsapp: string; voice: string }>(`/api/orgs/${DEMO}/incidents/simulate`, 'POST', { kind: 'ip_flood' });
    expect(r).toMatchObject({ whatsapp: 'queued' });
    expect(['queued', 'skipped']).toContain(r.voice);
    const i = await pedir<IncidentDetail>(`/api/orgs/${DEMO}/incidents/${r.incident_id}`);
    expect(i).toMatchObject({ code: r.code, rule_ids: ['CF_IP_FLOOD'], resource: 'ip:203.0.113.7' });
    expect(i.details).toMatchObject({ simulated: true });
    expect(await fallo(`/api/orgs/${DEMO}/incidents/simulate`, 'POST', {})).toMatchObject({ status: 429 });
  });
});

describe('E8 · Cloudflare en modo sitio (cloudflare-por-url.md)', () => {
  it('sin token: activa, meta en modo url y sin config; con token de acciones: 400', async () => {
    const r = await pedir<{ connection: ConnectionPublic; checks: unknown[] }>(`/api/orgs/${nueva}/connections`, 'POST',
      { provider: 'cloudflare', mode: 'url', url: 'https://mi-app.pages.dev' });
    expect(r.connection).toMatchObject({ provider: 'cloudflare', label: 'Cloudflare · mi-app.pages.dev', last4: null,
      meta: { mode: 'url', site_url: 'https://mi-app.pages.dev', site_kind: 'pages', project: 'mi-app', config_read: false } });
    expect(await fallo(`/api/orgs/${nueva}/connections`, 'POST', { provider: 'cloudflare', mode: 'url', url: 'https://x.workers.dev', action_token: 'a'.repeat(40) }))
      .toMatchObject({ status: 400 });
  });
});

describe('E57 · tipo por defecto', () => {
  it('sin kind simula la inundación (la única crítica con el motor real); pasados 2 min se puede repetir', async () => {
    await vi.advanceTimersByTimeAsync(121_000);
    const r = await pedir<{ incident_id: string }>(`/api/orgs/${DEMO}/incidents/simulate`, 'POST', {});
    expect(await pedir<IncidentDetail>(`/api/orgs/${DEMO}/incidents/${r.incident_id}`)).toMatchObject({ rule_ids: ['CF_IP_FLOOD'] });
  });
});
