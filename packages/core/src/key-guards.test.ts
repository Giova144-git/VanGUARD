// Casos de S15 15.13 para key-guards. Las cadenas con forma de secreto se construyen en tiempo de ejecución (S06 06.4).
import { describe, it, expect } from 'vitest';
import { guardKey, jwtRole } from './key-guards.ts';

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload: unknown) => b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url(payload) + '.' + 'firma'.repeat(8);
const hex = (n: number) => 'a1b2c3d4e5f6'.repeat(8).slice(0, n);

describe('guardKey', () => {
  it('sb_secret_… → sb_secret (también pegada en el campo de otro proveedor)', () => {
    const s = 'sb_' + 'secret_' + 'x'.repeat(40);
    expect(guardKey('supabase', s)).toBe('sb_secret');
    expect(guardKey('cloudflare', s)).toBe('sb_secret');
    expect(guardKey('github', '  ' + s + '\n')).toBe('sb_secret');
  });
  it('JWT con role:service_role → service_role', () => {
    const s = jwt({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'service_role' });
    expect(guardKey('supabase', s)).toBe('service_role');
    expect(guardKey('cloudflare', s)).toBe('service_role');
  });
  it('ghp_… → classic_github_pat', () => {
    expect(guardKey('github', 'gh' + 'p_' + 'A1b2C3'.repeat(6))).toBe('classic_github_pat');
    expect(guardKey('github', 'gh' + 'o_' + 'A1b2C3'.repeat(6))).toBe('classic_github_pat');
  });
  it('37 hex, 45 hex y cfk_… → global_api_key', () => {
    expect(guardKey('cloudflare', hex(37))).toBe('global_api_key');
    expect(guardKey('cloudflare', hex(45))).toBe('global_api_key');
    expect(guardKey('cloudflare', 'cf' + 'k_' + 'Z9y8X7'.repeat(7))).toBe('global_api_key');
  });
  it('carácter invisible → invalid_chars', () => {
    expect(guardKey('supabase', 'sbp_fc' + 'a'.repeat(20) + '​' + 'b'.repeat(10))).toBe('invalid_chars');
    expect(guardKey('cloudflare', 'tok en')).toBe('invalid_chars');
  });
  it('PAT sbp_fc… válido → null', () => {
    expect(guardKey('supabase', 'sbp_fc' + 'q1w2e3'.repeat(7))).toBeNull();
  });
  it('más de 400 caracteres → too_long; PAT sin sbp_fc en Supabase → legacy_pat', () => {
    expect(guardKey('supabase', 'sbp_fc' + 'a'.repeat(400))).toBe('too_long');
    expect(guardKey('supabase', 'sbp_' + hex(40))).toBe('legacy_pat');
  });
  it('tokens aceptables de otros proveedores → null', () => {
    expect(guardKey('github', 'github_' + 'pat_' + 'A1b2C3'.repeat(10))).toBeNull();
    expect(guardKey('cloudflare', 'Q'.repeat(40))).toBeNull();
    expect(guardKey('cloudflare', hex(46))).toBeNull();
  });
});

describe('jwtRole', () => {
  it('lee el role sin verificar firma y devuelve null si no es JWT', () => {
    expect(jwtRole(jwt({ role: 'anon' }))).toBe('anon');
    expect(jwtRole(b64url({ alg: 'none' }) + '.' + b64url({ role: 'service_role' }))).toBe('service_role');
    expect(jwtRole('no.es.un-jwt')).toBeNull();
    expect(jwtRole('sbp_fc123')).toBeNull();
    expect(jwtRole(b64url({ a: 1 }) + '.' + b64url({ sub: 'x' }) + '.x')).toBeNull();
  });
});
