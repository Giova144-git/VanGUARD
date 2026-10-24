import { describe, expect, it, vi } from 'vitest';

// El registro de la cola usa el paso cloudflare de cloudflare.ts (el que escribe coverage.detail.cloudflare.miradas y
// lleva el cable trampa; sus casos están en cloudflare.test.ts), no una copia local sin miradas.
const registrados = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../jobs.ts', () => ({ registrarPaso: (p: string, fn: unknown) => registrados.set(p, fn) }));
vi.mock('../ia/claude.ts', () => ({ pedirResumen: vi.fn() }));
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
