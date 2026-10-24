// Casos de S15 15.13 / S06 06.7 para otp.ts.
import { describe, it, expect } from 'vitest';
import { sixDigitCode, otpHash, otpHashParam } from './otp.ts';
import { deriveKeys, sha256hex, b64 } from './crypto.ts';

const rnd = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const mk = () => deriveKeys({ kid: 'v1', vaultKekB64: rnd(), kekPepperB64: rnd(), vaultFpB64: rnd(), fpPepperB64: rnd() });

describe('sixDigitCode', () => {
  it('10^5 códigos de 6 dígitos; cada primer dígito entre el 9 % y el 11 %', () => {
    const N = 100_000, cuenta = new Array<number>(10).fill(0);
    for (let i = 0; i < N; i++) {
      const c = sixDigitCode();
      expect(c).toMatch(/^\d{6}$/);
      const d = Number(c[0]);
      cuenta[d] = (cuenta[d] ?? 0) + 1;
    }
    for (const n of cuenta) {
      expect(n / N).toBeGreaterThanOrEqual(0.09);
      expect(n / N).toBeLessThanOrEqual(0.11);
    }
  });
});

describe('otpHash', () => {
  it('estable con las mismas Keys, distinto si cambia id o code, y no es sha256 a secas', async () => {
    const k = await mk(), id = '00000000-0000-4000-a000-00000000a001';
    const h = await otpHash(k, id, '482915');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await otpHash(k, id, '482915')).toBe(h);
    expect(await otpHash(k, '00000000-0000-4000-a000-00000000a002', '482915')).not.toBe(h);
    expect(await otpHash(k, id, '482916')).not.toBe(h);
    expect(h).not.toBe(await sha256hex(id + ':' + '482915'));
    expect(h).not.toBe(await sha256hex(`otp|${id}|482915`));
    expect(await otpHash(await mk(), id, '482915')).not.toBe(h);   // otra FPK, otra huella
  });
  it('otpHashParam va en formato bytea hex de Postgres', async () => {
    const k = await mk();
    expect(await otpHashParam(k, 'a', '000001')).toBe('\\x' + await otpHash(k, 'a', '000001'));
  });
});
