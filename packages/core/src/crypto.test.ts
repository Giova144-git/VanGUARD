// Las 8 pruebas de cripto de S05 05.12 (las 3 primeras literales). El material se genera en cada corrida: ningún secreto en el repo.
import { describe, it, expect } from 'vitest';
import { deriveKeys, seal, open, rewrap, fingerprint, b64, type SecretCtx } from './crypto.ts';
const rnd = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const mk = (kid = 'v1') => deriveKeys({ kid, vaultKekB64: rnd(), kekPepperB64: rnd(), vaultFpB64: rnd(), fpPepperB64: rnd() });
const A: SecretCtx = { orgId: 'org-a', connectionId: 'c1', provider: 'cloudflare', kind: 'read' };
const flip = (s: string) => { const u = Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); u[0] = (u[0] ?? 0) ^ 1; return b64(u); };
describe('crypto', () => {
  it('ida y vuelta (recorta espacios)', async () => { const k = await mk(); expect(await open(k, await seal(k, ' t_1 ', A), A)).toBe('t_1'); });
  it('1 byte de ct o de wdek lanza', async () => { const k = await mk(), b = await seal(k, 't', A);
    await expect(open(k, { ...b, ct: flip(b.ct) }, A)).rejects.toThrow();
    await expect(open(k, { ...b, wdek: flip(b.wdek) }, A)).rejects.toThrow(); });
  it('otra org u otra conexión lanza', async () => { const k = await mk(), b = await seal(k, 't', A);
    await expect(open(k, b, { ...A, orgId: 'org-b' })).rejects.toThrow();
    await expect(open(k, b, { ...A, connectionId: 'c2' })).rejects.toThrow(); });

  it('otra KEK con el mismo kid lanza', async () => {
    const k1 = await mk('v1'), k2 = await mk('v1'), b = await seal(k1, 't', A);
    await expect(open(k2, b, A)).rejects.toThrow();
  });
  it('kid distinto → BOX_KID_MISMATCH', async () => {
    const k1 = await mk('v1'), k2 = await mk('v2'), b = await seal(k1, 't', A);
    await expect(open(k2, b, A)).rejects.toThrow('BOX_KID_MISMATCH');
  });
  it('huella estable, ignora espacios y distinta entre orgs', async () => {
    const k = await mk();
    const f1 = await fingerprint(k, 'org-a', 'tok_123');
    expect(f1).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint(k, 'org-a', 'tok_123')).toBe(f1);
    expect(await fingerprint(k, 'org-a', '  tok_123 \n')).toBe(f1);
    expect(await fingerprint(k, 'org-b', 'tok_123')).not.toBe(f1);
  });
  it('rewrap abre con las llaves nuevas y no con las viejas, con ct idéntico', async () => {
    const viejas = await mk('v1'), nuevas = await mk('v2'), b = await seal(viejas, 'tok_rot', A);
    const r = await rewrap(viejas, nuevas, b, A);
    expect(r.ct).toBe(b.ct);
    expect(r.iv).toBe(b.iv);
    expect(r.kid).toBe('v2');
    expect(await open(nuevas, r, A)).toBe('tok_rot');
    await expect(open(viejas, r, A)).rejects.toThrow();
    await expect(open(viejas, { ...r, kid: 'v1' }, A)).rejects.toThrow();   // aunque se falsee el kid, la DEK ya no abre
  });
  it('material de 31 bytes → CRYPTO_MATERIAL_BAD_LENGTH', async () => {
    const corto = b64(crypto.getRandomValues(new Uint8Array(31)));
    await expect(deriveKeys({ kid: 'v1', vaultKekB64: corto, kekPepperB64: rnd(), vaultFpB64: rnd(), fpPepperB64: rnd() }))
      .rejects.toThrow('CRYPTO_MATERIAL_BAD_LENGTH');
    await expect(deriveKeys({ kid: 'v1', vaultKekB64: rnd(), kekPepperB64: rnd(), vaultFpB64: rnd(), fpPepperB64: corto }))
      .rejects.toThrow('CRYPTO_MATERIAL_BAD_LENGTH');
  });
});
