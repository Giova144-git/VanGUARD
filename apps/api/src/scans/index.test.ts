import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbDoble, eqDe, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// El registro de la cola usa el paso cloudflare de cloudflare.ts (el que escribe coverage.detail.cloudflare.miradas y
// lleva el cable trampa; sus casos están en cloudflare.test.ts), no una copia local sin miradas.
const registrados = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../jobs.ts', () => ({ registrarPaso: (p: string, fn: unknown) => registrados.set(p, fn) }));
vi.mock('../ia/claude.ts', () => ({ pedirResumen: vi.fn() }));
// puntaje con el doble de supabase-js y la cobertura fija (calcularCobertura se prueba en cobertura.test.ts).
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
vi.mock('./cobertura.ts', async (orig) => ({ ...(await orig<typeof import('./cobertura.ts')>()),
  calcularCobertura: async () => ({ seen: 3, total: 4, missing: ['performance'] }) }));
const cloudflare = await import('./cloudflare.ts');
const supabase = await import('./supabase.ts');
const repo = await import('./repo-paso.ts');
const zip = await import('./zip-paso.ts');
const indice = await import('./index.ts');

describe('registro de pasos de vg-jobs', () => {
  it('cada paso registrado es el de su módulo', () => {
    expect(registrados.get('cloudflare')).toBe(cloudflare.pasoCloudflare);
    expect(registrados.get('supabase')).toBe(supabase.pasoSupabase);
    expect(registrados.get('repo')).toBe(repo.pasoRepo);
    expect(registrados.get('zip')).toBe(zip.pasoZip);
    expect(registrados.get('puntaje')).toBe(indice.pasoPuntaje);
    expect(registrados.get('resumen_ia')).toBe(indice.pasoResumen);
    expect('pasoCloudflare' in indice).toBe(false);
  });
});

// Foto de la auditoría para la evolución (asignaciones/evolucion-entre-revisiones.md §2.1 y pruebas B2 de §9.2).
describe('puntaje · foto de la evolución (vg_snapshot_audit, 0015)', () => {
  const SCAN = '5a1c0000-0000-4000-8000-000000000001';
  const ORG = '0f6c0000-0000-4000-8000-000000000001';
  const m = { v: 1 as const, kind: 'scan' as const, scan_run_id: SCAN, org_id: ORG, paso: 'puntaje' as const };
  let orden: string[];
  let errorScore: Resp['error'];
  let foto: () => Resp;
  let doble: ReturnType<typeof dbDoble>;

  beforeEach(() => {
    orden = [];
    errorScore = null;
    foto = () => ({ data: { applied: true, first: false, open: 12, new: 7, kept: 5, fixed: 2, ignored: 1, moved: 0, gone: 0 } });
    doble = dbDoble({
      tabla: (op) => {
        if (op.table === 'findings') return { data: [{ module: 'codebase', severity: 'critical', confirmed: true }] };
        if (op.table === 'scan_runs' && op.action === 'select') return { data: { coverage: { detail: { codebase: {} } } } };
        if (op.table === 'scan_runs' && op.action === 'update') {
          orden.push('score');
          return { error: errorScore };
        }
        return undefined;
      },
      rpc: (name) => {
        orden.push(name);
        return name === 'vg_snapshot_audit' ? foto() : undefined;
      },
    });
    estado.client = doble.client;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const correr = () => indice.pasoPuntaje(envDoble().env, m);
  const lineas = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
  const evento = (e: string) => lineas().map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === e);

  it('llama a vg_snapshot_audit con {p_org, p_scan} DESPUÉS de escribir score, y una sola vez', async () => {
    expect(await correr()).toEqual({ status: 'done' });
    expect(orden).toEqual(['score', 'vg_snapshot_audit']);
    expect(doble.rpcs).toEqual([{ name: 'vg_snapshot_audit', args: { p_org: ORG, p_scan: SCAN } }]);
    const u = doble.ops.find((o) => o.table === 'scan_runs' && o.action === 'update')!;
    expect([eqDe(u, 'id'), eqDe(u, 'org_id')]).toEqual([SCAN, ORG]);
    expect(typeof (u.payload as { score: unknown }).score).toBe('number');
    expect(evento('evolucion.foto')).toMatchObject({ scan: SCAN, applied: true, first: false, repetida: false, open: 12,
      nuevos: 7, se_mantienen: 5, corregidos: 2, ignorados: 1, movidos: 0, ya_no_existen: 0, reason: null });
  });

  it('repetida (reintento o finalizar) y sin módulos: done igual, y el log lo dice', async () => {
    foto = () => ({ data: { applied: true, repeated: true, first: true, open: 4, new: 0, kept: 0, fixed: 0 } });
    expect(await correr()).toEqual({ status: 'done' });
    expect(evento('evolucion.foto')).toMatchObject({ applied: true, repetida: true, first: true, open: 4 });
    vi.mocked(console.log).mockClear();
    foto = () => ({ data: { applied: false, reason: 'sin_modulos' } });
    expect(await correr()).toEqual({ status: 'done' });
    expect(evento('evolucion.foto')).toMatchObject({ applied: false, reason: 'sin_modulos', open: null });
  });

  it('la RPC da error o lanza → puntaje devuelve done y registra evolucion.foto_error (solo el código)', async () => {
    foto = () => ({ error: { code: 'PGRST202', message: 'Could not find the function public.vg_snapshot_audit' } });
    expect(await correr()).toEqual({ status: 'done' });
    expect(evento('evolucion.foto_error')).toEqual({ level: 'warn', event: 'evolucion.foto_error', scan: SCAN,
      code: 'PGRST202' });
    expect(evento('evolucion.foto')).toBeUndefined();
    foto = () => { throw new Error('red caída'); };
    expect(await correr()).toEqual({ status: 'done' });
    expect(lineas().join('\n')).toContain('"code":"red"');
  });

  it('si falla escribir score, lanza antes y no pide la foto', async () => {
    errorScore = { code: '08006' };
    await expect(correr()).rejects.toMatchObject({ code: 'unavailable' });
    expect(doble.rpcs).toEqual([]);
  });
});
