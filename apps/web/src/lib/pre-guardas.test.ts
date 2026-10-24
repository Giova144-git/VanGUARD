import { describe, expect, it } from 'vitest';
import { extraerProjectRef, extraerRepo, preGuardar, zoneIdValido } from './pre-guardas';

const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.firmafalsafirmafalsa`;

describe('preGuardar', () => {
  it('rechaza la clave secreta de Supabase y el JWT service_role', () => {
    expect(preGuardar('sb_secret_abcdefghijklmnopqrstuvwxyz', 'supabase')?.titulo).toMatch(/clave secreta de Supabase/);
    expect(preGuardar(jwt({ role: 'service_role', iss: 'supabase' }), 'cloudflare')?.titulo).toMatch(/clave secreta de Supabase/);
  });
  it('rechaza tokens clásicos de GitHub', () => {
    expect(preGuardar('ghp_' + 'a'.repeat(36), 'github')?.titulo).toMatch(/clásico de GitHub/);
    expect(preGuardar('gho_' + 'a'.repeat(36), 'github')).not.toBeNull();
  });
  it('rechaza la Global API Key de Cloudflare en sus dos formatos', () => {
    expect(preGuardar('cfk_' + 'a'.repeat(40), 'cloudflare')?.titulo).toMatch(/Global API Key/);
    expect(preGuardar('0123456789abcdef0123456789abcdef01234', 'cloudflare')?.titulo).toMatch(/Global API Key/);
  });
  it('exige sbp_fc en Supabase y acepta tokens válidos', () => {
    expect(preGuardar('sbp_' + 'a'.repeat(40), 'supabase')?.titulo).toMatch(/todos tus proyectos/);
    expect(preGuardar('sbp_fc' + 'a'.repeat(40), 'supabase')).toBeNull();
    expect(preGuardar('github_pat_' + 'A'.repeat(60), 'github')).toBeNull();
    expect(preGuardar('A'.repeat(40), 'cloudflare')).toBeNull();
  });
  it('rechaza espacios y tokens cortos', () => {
    expect(preGuardar('sbp_fc abc def ghi jkl mno pqr', 'supabase')?.titulo).toMatch(/espacios/);
    expect(preGuardar('corto', 'github')?.titulo).toMatch(/incompleto/);
  });
});

describe('extraer', () => {
  it('project_ref desde URL, panel o ref', () => {
    expect(extraerProjectRef('https://accshmgmfrqrxubpuxcl.supabase.co')).toBe('accshmgmfrqrxubpuxcl');
    expect(extraerProjectRef('https://supabase.com/dashboard/project/accshmgmfrqrxubpuxcl/settings')).toBe('accshmgmfrqrxubpuxcl');
    expect(extraerProjectRef('accshmgmfrqrxubpuxcl')).toBe('accshmgmfrqrxubpuxcl');
    expect(extraerProjectRef('corto')).toBeNull();
  });
  it('repo desde owner/repo o URL, sin . ni ..', () => {
    expect(extraerRepo('https://github.com/acme/tienda.git')).toBe('acme/tienda');
    expect(extraerRepo('acme/tienda')).toBe('acme/tienda');
    expect(extraerRepo('acme/..')).toBeNull();
    expect(extraerRepo('acme/.')).toBeNull();
  });
  it('zone_id de 32 hex', () => {
    expect(zoneIdValido('023e105f4ecef8ad9ca31a8372d0c353')).toBe(true);
    expect(zoneIdValido('023E105F')).toBe(false);
  });
});
