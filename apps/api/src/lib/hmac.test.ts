import { describe, expect, it } from 'vitest';
import { hexABytes, sha256Hex, verificarHmacHex } from './hmac.ts';

const enc = new TextEncoder();
const SECRETO = ['secreto', 'de', 'prueba'].join('-');   // armado en tiempo de ejecución, sin forma de secreto real

async function firmar(secreto: string, cuerpo: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(cuerpo))),
    (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('verificarHmacHex', () => {
  const cuerpo = '{"message":{"id":"wamid.X"}}';

  it('acepta la firma hex del cuerpo crudo (string o ArrayBuffer, minúsculas, mayúsculas o con sha256=)', async () => {
    const f = await firmar(SECRETO, cuerpo);
    expect(await verificarHmacHex(SECRETO, cuerpo, f)).toBe(true);
    expect(await verificarHmacHex(SECRETO, enc.encode(cuerpo).buffer as ArrayBuffer, f)).toBe(true);
    expect(await verificarHmacHex(SECRETO, cuerpo, f.toUpperCase())).toBe(true);
    expect(await verificarHmacHex(SECRETO, cuerpo, `sha256=${f}`)).toBe(true);
  });

  it('rechaza otro cuerpo, otro secreto, firma truncada o no hex, y falla cerrada sin secreto o sin firma', async () => {
    const f = await firmar(SECRETO, cuerpo);
    expect(await verificarHmacHex(SECRETO, cuerpo + ' ', f)).toBe(false);
    expect(await verificarHmacHex('otro-secreto', cuerpo, f)).toBe(false);
    expect(await verificarHmacHex(SECRETO, cuerpo, f.slice(0, 62))).toBe(false);
    expect(await verificarHmacHex(SECRETO, cuerpo, 'z'.repeat(64))).toBe(false);
    expect(await verificarHmacHex(undefined, cuerpo, f)).toBe(false);
    expect(await verificarHmacHex('', cuerpo, f)).toBe(false);
    expect(await verificarHmacHex(SECRETO, cuerpo, null)).toBe(false);
  });
});

describe('hexABytes y sha256Hex', () => {
  it('convierte hex de la longitud pedida y devuelve null en lo demás', () => {
    expect(Array.from(hexABytes('00ff10', 3) ?? [])).toEqual([0, 255, 16]);
    expect(hexABytes('00ff1', 3)).toBeNull();
    expect(hexABytes('00fg10', 3)).toBeNull();
  });

  it('sha256Hex da el vector conocido de "abc"', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
