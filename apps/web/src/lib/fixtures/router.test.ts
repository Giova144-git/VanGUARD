import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures as fx, type ConnectionCreated, type EstadoModulo, type ScanRun, type WikiRun } from '@vanguard/contracts';
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
    ['POST', 'connections'], ['POST', 'scans'], ['GET', 'ruta-que-no-existe'],
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
