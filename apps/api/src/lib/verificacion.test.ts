import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VerificacionContacto } from '@vanguard/contracts';

// getKeys de mentira: una FPK distinta por kid (bytes conocidos), para comprobar la fórmula con node:crypto y que el
// kid es el fijo. activeKid diría 'v2': si alguien la usara, el código cambiaría y las pruebas lo verían.
const llaves = vi.hoisted(() => ({ kids: [] as string[] }));
const bytesDe = (kid: string) => new Uint8Array(32).fill(kid === 'v1' ? 0x11 : 0x22);
vi.mock('./keyring.ts', () => ({
  getKeys: async (_env: unknown, _admin: unknown, kid: string) => {
    llaves.kids.push(kid);
    const fpk = await crypto.subtle.importKey('raw', bytesDe(kid), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return { kid, kek: fpk, fpk };
  },
  activeKid: async () => 'v2',
}));

const { BAJA, casaCodigo, codigoConClaves, codigoVerificacion, enlaceVerificacion, MAX_TEXTO_ENLACE, numeroVisible,
  textoEnlace, VENTANA_MS, ventanaAbierta, VERIFICAR } = await import('./verificacion.ts');

const ORG = '0f6c0000-0000-4000-8000-000000000001';
const ORG2 = '0f6c0000-0000-4000-8000-000000000002';
const C1 = 'c0c00000-0000-4000-8000-000000000001';
const C2 = 'c0c00000-0000-4000-8000-000000000002';
const env = {} as CloudflareBindings;
// Cualquier consulta (p. ej. leer kek_active de app_config) lanza: el código no debe tocar la base salvo por getKeys.
const admin = { from: () => { throw new Error('no debe consultar tablas'); } } as unknown as SupabaseClient;

// Referencia independiente (node:crypto, no WebCrypto).
const esperado = (kid: string, org: string, id: string) =>
  createHmac('sha256', bytesDe(kid)).update(`contact|${org}|${id}`).digest('hex').slice(0, 6).toUpperCase();
const clave = async (kid: string) => ({
  fpk: await crypto.subtle.importKey('raw', bytesDe(kid), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) });

beforeEach(() => { llaves.kids.length = 0; });

describe('código de verificación', () => {
  it('6 primeros hex en mayúsculas de HMAC-SHA256(fpk, contact|org|id), estable entre llamadas', async () => {
    const k = await clave('v1');
    const a = await codigoConClaves(k, ORG, C1);
    expect(a).toMatch(/^[0-9A-F]{6}$/);
    expect(a).toBe(esperado('v1', ORG, C1));
    expect(await codigoConClaves(k, ORG, C1)).toBe(a);
  });

  it('el org_id va dentro: el mismo contacto-id en dos orgs da códigos distintos; otro contacto, otro código', async () => {
    const k = await clave('v1');
    expect(await codigoConClaves(k, ORG, C1)).not.toBe(await codigoConClaves(k, ORG2, C1));
    expect(await codigoConClaves(k, ORG, C1)).not.toBe(await codigoConClaves(k, ORG, C2));
  });

  it('codigoVerificacion usa el kid FIJO v1 aunque kek_active sea otro, sin leer app_config', async () => {
    const c = await codigoVerificacion(env, admin, ORG, C1);
    expect(llaves.kids).toEqual(['v1']);
    expect(c).toBe(esperado('v1', ORG, C1));
    expect(c).not.toBe(esperado('v2', ORG, C1));
  });

  it('casaCodigo: acepta el suyo en mayúsculas, minúsculas o con espacios; rechaza el de otra org, otro contacto o basura',
    async () => {
      const c = await codigoVerificacion(env, admin, ORG, C1);
      expect(await casaCodigo(env, admin, ORG, C1, c)).toBe(true);
      expect(await casaCodigo(env, admin, ORG, C1, c.toLowerCase())).toBe(true);
      expect(await casaCodigo(env, admin, ORG, C1, ` ${c} `)).toBe(true);
      expect(await casaCodigo(env, admin, ORG2, C1, c)).toBe(false);
      expect(await casaCodigo(env, admin, ORG, C2, c)).toBe(false);
      for (const malo of ['', '000000', c.slice(0, 5), `${c}0`, 'ZZZZZZ']) {
        expect(await casaCodigo(env, admin, ORG, C1, malo)).toBe(false);
      }
      expect(llaves.kids.every((k) => k === 'v1')).toBe(true);
    });
});

describe('texto y enlace wa.me', () => {
  it('textoEnlace devuelve el texto exacto de las decisiones y mide ≤ 140', () => {
    const t = textoEnlace('7C2A9F');
    expect(t).toBe('VERIFICAR 7C2A9F. Acepto recibir alertas de seguridad de VanGUARD en este WhatsApp. BAJA para salir');
    expect(t.length).toBeLessThanOrEqual(MAX_TEXTO_ENLACE);
  });

  it('textoEnlace no acepta un código sin forma (nada de texto inyectado en el enlace)', () => {
    for (const malo of ['7c2a9f', '7C2A9', '7C2A9F0', '7C2A9F&text=x', '']) expect(() => textoEnlace(malo)).toThrow(RangeError);
  });

  it('numeroVisible: solo 8–15 dígitos', () => {
    expect(numeroVisible({ KAPSO_DISPLAY_NUMBER: '15550100' })).toBe('15550100');
    expect(numeroVisible({ KAPSO_DISPLAY_NUMBER: '584121234567' })).toBe('584121234567');
    for (const malo of [undefined, '', '+15550100', '1555010', '1234567890123456', '1555 0100', 'abc15550100']) {
      expect(numeroVisible({ KAPSO_DISPLAY_NUMBER: malo })).toBeNull();
    }
  });

  it('enlaceVerificacion: wa.me con el texto codificado; casa el contrato y se decodifica al texto exacto', () => {
    const enlace = enlaceVerificacion('15550100', '7C2A9F');
    expect(enlace.startsWith('https://wa.me/15550100?text=VERIFICAR%207C2A9F.%20Acepto')).toBe(true);
    expect(VerificacionContacto.parse({ codigo: '7C2A9F', enlace }).enlace).toBe(enlace);
    expect(new URL(enlace).searchParams.get('text')).toBe(textoEnlace('7C2A9F'));
  });
});

describe('VERIFICAR y BAJA', () => {
  it('VERIFICAR <6 hex> al principio, sin importar mayúsculas ni espacios, y también el texto entero del enlace', () => {
    for (const [txt, cod] of [['VERIFICAR 7C2A9F', '7C2A9F'], ['  verificar 7c2a9f', '7c2a9f'], ['Verificar   7C2A9F gracias', '7C2A9F'],
      [textoEnlace('7C2A9F'), '7C2A9F']] as const) {
      expect(VERIFICAR.exec(txt)?.[1]).toBe(cod);
    }
    for (const txt of ['VERIFICAR 7C2A9', 'VERIFICAR 7C2A9F0', 'VERIFICAR 7G2A9F', 'hola VERIFICAR 7C2A9F', 'VERIFICAR7C2A9F', 'BAJA']) {
      expect(VERIFICAR.test(txt)).toBe(false);
    }
  });

  it('BAJA, STOP y SALIR al principio (no BAJAR, ni el «BAJA para salir» del final del enlace)', () => {
    for (const txt of ['BAJA', 'baja', ' Stop', 'SALIR ya', 'stop.']) expect(BAJA.test(txt)).toBe(true);
    for (const txt of ['BAJAR', 'quiero BAJA', 'STOPPED', textoEnlace('7C2A9F'), '']) expect(BAJA.test(txt)).toBe(false);
  });
});

describe('ventana de 24 h', () => {
  const ahora = Date.parse('2026-10-24T20:00:00.000Z');
  const hace = (ms: number) => new Date(ahora - ms).toISOString();

  it('abierta si nos escribió hace ≤ 23 h 50 min (también con el formato de Postgres)', () => {
    expect(ventanaAbierta({}, hace(3600_000), ahora)).toBe(true);
    expect(ventanaAbierta({}, hace(VENTANA_MS), ahora)).toBe(true);
    expect(ventanaAbierta({}, '2026-10-24T19:00:00.123456+00:00', ahora)).toBe(true);
  });

  it('cerrada sin entrada, con más de 23 h 50 min o con una fecha ilegible', () => {
    expect(ventanaAbierta({}, null, ahora)).toBe(false);
    expect(ventanaAbierta({}, undefined, ahora)).toBe(false);
    expect(ventanaAbierta({}, hace(VENTANA_MS + 60_000), ahora)).toBe(false);
    expect(ventanaAbierta({}, hace(24 * 3600_000), ahora)).toBe(false);
    expect(ventanaAbierta({}, 'ayer', ahora)).toBe(false);
  });

  it("KAPSO_SANDBOX='1' la da por abierta; otro valor no", () => {
    expect(ventanaAbierta({ KAPSO_SANDBOX: '1' }, null, ahora)).toBe(true);
    expect(ventanaAbierta({ KAPSO_SANDBOX: '0' }, null, ahora)).toBe(false);
    expect(ventanaAbierta({ KAPSO_SANDBOX: 'true' }, null, ahora)).toBe(false);
  });
});
