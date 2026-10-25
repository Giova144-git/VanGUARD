// La sesión del invitado de /demo va a sessionStorage (volátil); la de correo, a localStorage. Un solo cliente de
// supabase-js: el almacén se elige al escribir, mirando user.is_anonymous de la propia sesión.
import { describe, expect, it } from 'vitest';
import { almacenAuth, CLAVE_AUTH, esSesionInvitada, idSesionGuardada } from './almacen-auth';

const memoria = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
};
const sesion = (id: string, is_anonymous: boolean) => JSON.stringify({ access_token: 'x', user: { id, is_anonymous } });

describe('almacenAuth', () => {
  it('el invitado va a sessionStorage y nunca queda en localStorage', () => {
    const pestana = memoria(), local = memoria();
    almacenAuth(pestana, local).setItem(CLAVE_AUTH, sesion('anon', true));
    expect(pestana.m.has(CLAVE_AUTH)).toBe(true);
    expect(local.m.has(CLAVE_AUTH)).toBe(false);
  });

  it('la sesión de correo va a localStorage, y entrar con correo desde la pestaña del invitado la mueve allí', () => {
    const pestana = memoria(), local = memoria();
    const a = almacenAuth(pestana, local);
    a.setItem(CLAVE_AUTH, sesion('anon', true));
    a.setItem(CLAVE_AUTH, sesion('ana', false));
    expect(local.m.get(CLAVE_AUTH)).toContain('"ana"');
    expect(pestana.m.has(CLAVE_AUTH)).toBe(false);
    expect(idSesionGuardada(a)).toBe('ana');
  });

  it('una sesión anónima vieja de localStorage pasa a sessionStorage al reescribirse (refresco)', () => {
    const pestana = memoria(), local = memoria();
    local.setItem(CLAVE_AUTH, sesion('anon', true));
    const a = almacenAuth(pestana, local);
    expect(idSesionGuardada(a)).toBe('anon');
    a.setItem(CLAVE_AUTH, sesion('anon', true));
    expect(local.m.has(CLAVE_AUTH)).toBe(false);
    expect(pestana.m.has(CLAVE_AUTH)).toBe(true);
  });

  it('lee primero la de la pestaña: el invitado sigue siéndolo aunque otra pestaña tenga sesión de correo', () => {
    const pestana = memoria(), local = memoria();
    local.setItem(CLAVE_AUTH, sesion('ana', false));
    pestana.setItem(CLAVE_AUTH, sesion('anon', true));
    expect(idSesionGuardada(almacenAuth(pestana, local))).toBe('anon');
  });

  it('salir del invitado borra solo su sesión, no la de correo compartida', () => {
    const pestana = memoria(), local = memoria();
    local.setItem(CLAVE_AUTH, sesion('ana', false));
    pestana.setItem(CLAVE_AUTH, sesion('anon', true));
    const a = almacenAuth(pestana, local);
    a.removeItem(CLAVE_AUTH);
    expect(local.m.has(CLAVE_AUTH)).toBe(true);
    a.removeItem(CLAVE_AUTH);
    expect(local.m.has(CLAVE_AUTH)).toBe(false);
  });

  it('lo que no es una sesión (code verifier de PKCE) va a localStorage; sin almacenamiento no lanza', () => {
    const pestana = memoria(), local = memoria();
    almacenAuth(pestana, local).setItem(`${CLAVE_AUTH}-code-verifier`, 'abc');
    expect(local.m.get(`${CLAVE_AUTH}-code-verifier`)).toBe('abc');
    for (const v of ['abc', '', 'null', '{"user":{"is_anonymous":"true"}}']) expect(esSesionInvitada(v), v).toBe(false);
    const roto = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    const a = almacenAuth(roto, null);
    expect(() => a.setItem(CLAVE_AUTH, sesion('anon', true))).not.toThrow();
    expect(a.getItem(CLAVE_AUTH)).toBeNull();
  });
});
