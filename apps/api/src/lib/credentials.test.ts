// Secreto del webhook de GitHub con el sellado y la caché DE VERDAD (asignaciones/revision-codigo.md E46/E47): al rotar,
// la firma con el secreto viejo deja de verificar y la del nuevo verifica, aunque la clave vieja siguiera en la caché del
// isolate (va por config + iv). Las llaves salen de deriveKeys con bytes fijos; nada de red ni de base.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { b64, deriveKeys, fingerprint, newWebhookSecret, open, type Box, type Keys } from '@vanguard/core/crypto';

const llaves = vi.hoisted(() => ({ keys: null as unknown, llamadas: 0 }));
vi.mock('./keyring.ts', () => ({
  getKeys: async () => { llaves.llamadas++; return llaves.keys; },
  activeKid: async () => 'v1',
}));
const { claveWebhook, olvidarClaveWebhook, rotarSecretoConexion, sellarSecretoWebhook } = await import('./credentials.ts');

const ORG = '0f6c0000-0000-4000-8000-000000000001';
const CFG = 'c4000000-0000-4000-8000-000000000001';
const env = {} as CloudflareBindings;
const admin = {} as Parameters<typeof claveWebhook>[1];
const cuerpo = new TextEncoder().encode('{"zen":"Keep it logically awesome.","hook_id":1}');
const firma = async (secreto: string) => {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, cuerpo));
};

beforeAll(async () => {
  const bytes = (n: number) => b64(new Uint8Array(32).fill(n));
  llaves.keys = await deriveKeys({ kid: 'v1', vaultKekB64: bytes(1), kekPepperB64: bytes(2), vaultFpB64: bytes(3),
    fpPepperB64: bytes(4) }) satisfies Keys;
});

describe('secreto del webhook: sellar, verificar y rotar', () => {
  it('rotar en la misma config: el secreto viejo deja de verificar al momento y el nuevo verifica', async () => {
    const viejo = newWebhookSecret(), nuevo = newWebhookSecret();
    const s1 = await sellarSecretoWebhook(env, admin, ORG, CFG, viejo);
    expect(s1.kid).toBe('v1');
    expect(JSON.stringify(s1.sealed)).not.toContain(viejo);
    const k1 = await claveWebhook(env, admin, { id: CFG, org_id: ORG, secret_sealed: s1.sealed });
    expect(await crypto.subtle.verify('HMAC', k1, await firma(viejo), cuerpo)).toBe(true);

    const s2 = await sellarSecretoWebhook(env, admin, ORG, CFG, nuevo);   // E46 rotate_secret: misma config, otro iv
    expect(s2.sealed.iv).not.toBe(s1.sealed.iv);
    const k2 = await claveWebhook(env, admin, { id: CFG, org_id: ORG, secret_sealed: s2.sealed });
    expect(await crypto.subtle.verify('HMAC', k2, await firma(viejo), cuerpo)).toBe(false);   // E47 → 401
    expect(await crypto.subtle.verify('HMAC', k2, await firma(nuevo), cuerpo)).toBe(true);    // E47 → 200
  });

  it('el sellado va atado a org + config: abrirlo con otra config u otra org falla (no hay clave)', async () => {
    const s = await sellarSecretoWebhook(env, admin, ORG, CFG, newWebhookSecret());
    await expect(claveWebhook(env, admin, { id: 'c4000000-0000-4000-8000-0000000000ff', org_id: ORG, secret_sealed: s.sealed }))
      .rejects.toThrow();
    await expect(claveWebhook(env, admin, { id: CFG, org_id: '0f6c0000-0000-4000-8000-000000000002', secret_sealed: s.sealed }))
      .rejects.toThrow();
  });

  it('caché por config + iv durante 60 s; olvidarClaveWebhook la suelta y la siguiente vuelve a abrir el sellado', async () => {
    const s = await sellarSecretoWebhook(env, admin, ORG, CFG, newWebhookSecret());
    const cfg = { id: CFG, org_id: ORG, secret_sealed: s.sealed };
    await claveWebhook(env, admin, cfg);
    const antes = llaves.llamadas;
    await claveWebhook(env, admin, cfg);
    expect(llaves.llamadas).toBe(antes);                // de la caché: sin getKeys
    olvidarClaveWebhook(CFG);
    await claveWebhook(env, admin, cfg);
    expect(llaves.llamadas).toBe(antes + 1);            // olvidada: vuelve a abrir el sellado
  });
});

// Bloqueo de merge (asignaciones/bloqueo-merge-criticos.md §2.8 y prueba B4 de §10.5): el token de acciones de GitHub se
// cambia en la MISMA conexión. Una sola función para E53 y el «Reconectar» de varias-codebases.md §2.1.
describe('rotarSecretoConexion', () => {
  const CONN = 'c0000000-0000-4000-8000-000000000006';
  const ctx = { orgId: ORG, connectionId: CONN, provider: 'github' as const, kind: 'action' as const };
  const token = ['github', 'pat', 'r'.repeat(40)].join('_');
  const conRpc = (r: { error: { code: string } | null }) => {
    const llamadas: { name: string; args: Record<string, unknown> }[] = [];
    const a = { rpc: async (name: string, args: Record<string, unknown>) => { llamadas.push({ name, args }); return r; } };
    return { a: a as unknown as Parameters<typeof rotarSecretoConexion>[1], llamadas };
  };

  it('sella con el AAD de la misma conexión (se abre con ese ctx y no con otro) y manda huella, last4 y capacidades', async () => {
    const { a, llamadas } = conRpc({ error: null });
    await rotarSecretoConexion(env, a, ctx, token, { scopes: ['statuses:write'], capabilities: { statuses: true },
      expiresAt: '2026-11-23T20:00:00.000Z' });
    const [{ name, args }] = llamadas as [{ name: string; args: Record<string, unknown> }];
    expect(name).toBe('vg_rotate_secret');
    expect(args).toMatchObject({ p_org: ORG, p_conn: CONN, p_last4: token.slice(-4), p_scopes: ['statuses:write'],
      p_capabilities: { statuses: true }, p_expires_at: '2026-11-23T20:00:00.000Z' });
    const secreto = args.p_secret as { sealed: Box; kid: string; fingerprint: string };
    expect(secreto.fingerprint).toBe(await fingerprint(llaves.keys as Keys, ORG, token));
    expect(JSON.stringify(args)).not.toContain(token);
    expect(await open(llaves.keys as Keys, secreto.sealed, ctx)).toBe(token);
    await expect(open(llaves.keys as Keys, secreto.sealed, { ...ctx, kind: 'read' })).rejects.toThrow();
    await expect(open(llaves.keys as Keys, secreto.sealed, { ...ctx, connectionId: CFG })).rejects.toThrow();
  });

  it('23505 (esa huella ya está en la org) → conflict; P0002 → not_found; otro → internal, sin error.message', async () => {
    for (const [code, esperado] of [['23505', 'conflict'], ['P0002', 'not_found'], ['08006', 'internal']] as const) {
      const { a } = conRpc({ error: { code } });
      await expect(rotarSecretoConexion(env, a, ctx, token, { scopes: [], capabilities: {}, expiresAt: null }))
        .rejects.toMatchObject({ name: 'ApiError', code: esperado });
    }
  });
});
