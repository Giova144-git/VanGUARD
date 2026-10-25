import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures as fx, AlertPrefs, CodeReviewSaved, CodeReviewState, Finding, ScanRun, type ConnectionCreated, type ConnectionPublic, type EstadoModulo, type IncidentDetail, type WikiRun } from '@vanguard/contracts';
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
  ])('una org ajena responde 404 a %s %s', async (method, resto) => {
    const e = await fallo(`/api/orgs/${AJENA}/${resto}`, method, {});
    expect(e).toMatchObject({ status: 404, code: 'not_found', message: 'Organización no encontrada' });
  });

  it('deja pasar lo que no va bajo /api/orgs/<org> y las orgs propias', async () => {
    expect(await pedir('/api/me')).toMatchObject({ orgs: expect.arrayContaining([expect.objectContaining({ id: nueva, role: 'owner' })]) });
    expect(await pedir('/api/demo/join', 'POST', {})).toEqual({ org_id: DEMO });
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
  it('la demo arranca conectada con sus dos revisiones y el hallazgo del push se abre con ?finding=', async () => {
    const s = CodeReviewState.parse(await pedir(`/api/orgs/${DEMO}/code-review`));
    expect(s).toMatchObject({ available: true, config: { state: 'connected' } });
    expect(s.recent).toHaveLength(2);
    expect(await pedir<Finding>(`/api/orgs/${DEMO}/findings/${fx.hallazgoRevision.id}`)).toMatchObject({ rule_id: 'CB_SECRET_STRIPE_LIVE' });
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

  it('sin Modo blindaje: E55 dice sin_conexion y E56 da 409 no_action_connection', async () => {
    const lista = await pedir<ConnectionPublic[]>(`/api/orgs/${DEMO}/connections`);
    const accion = lista.find((c) => c.provider === 'cloudflare' && c.kind === 'action')!;
    await pedir(`/api/orgs/${DEMO}/connections/${accion.id}`, 'DELETE');
    expect(await pedir(E55())).toMatchObject({ ofrece: false, motivo: 'sin_conexion', connection_id: null });
    expect(await fallo(`${E55()}/propose`, 'POST', {})).toMatchObject({ status: 409, details: { reason: 'no_action_connection' } });
  });
});
