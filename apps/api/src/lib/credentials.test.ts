// Secreto del webhook de GitHub con el sellado y la caché DE VERDAD (asignaciones/revision-codigo.md E46/E47): al rotar,
// la firma con el secreto viejo deja de verificar y la del nuevo verifica, aunque la clave vieja siguiera en la caché del
// isolate (va por config + iv). Las llaves salen de deriveKeys con bytes fijos; nada de red ni de base.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { b64, deriveKeys, newWebhookSecret, type Keys } from '@vanguard/core/crypto';
import { ApiError } from './errors.ts';

const llaves = vi.hoisted(() => ({ keys: null as unknown, llamadas: 0 }));
vi.mock('./keyring.ts', () => ({
  getKeys: async () => { llaves.llamadas++; return llaves.keys; },
  activeKid: async () => 'v1',
}));
const { claveWebhook, olvidarClaveWebhook, rotarSecretoConexion, sellarSecretoWebhook, withSecret } =
  await import('./credentials.ts');

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

// «Reconectar» (asignaciones/varias-codebases.md §2.1): rotarSecretoConexion sella con el id EXISTENTE y llama a
// vg_rotate_secret. El token sellado se abre con withSecret de ESA conexión (mismo AAD); con otro id, no.
describe('rotarSecretoConexion', () => {
  const CONN = 'c0aa0000-0000-4000-8000-000000000001';
  const ctx = { orgId: ORG, connectionId: CONN, provider: 'github' as const, kind: 'read' as const };
  const TOKEN = ['github', 'pat', 'r'.repeat(40)].join('_');   // armado en tiempo de ejecución: ningún literal así
  const sondeo = { scopes: ['metadata:read', 'contents:read'], capabilities: { metadata: true, contents: true },
    expiresAt: null };
  // Doble mínimo: la RPC (con el error que diga la prueba) y la lectura de connection_secrets que hace withSecret.
  const doble = (rpcError: { code: string } | null) => {
    const llamadas: { name: string; args: Record<string, unknown> }[] = [];
    let guardado: unknown = null;
    const a = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        llamadas.push({ name, args });
        if (!rpcError) guardado = (args.p_secret as { sealed: unknown }).sealed;
        return { data: null, error: rpcError };
      },
      from: () => {
        const b = { select: () => b, eq: () => b,
          maybeSingle: async () => ({ data: guardado ? { sealed: guardado, kid: 'v1' } : null, error: null }) };
        return b;
      },
    };
    return { admin: a as unknown as Parameters<typeof rotarSecretoConexion>[1], llamadas };
  };

  it('vg_rotate_secret con el id existente, last4, huella y el sondeo; se abre con ESA conexión y no con otra', async () => {
    const d = doble(null);
    await rotarSecretoConexion(env, d.admin, ctx, TOKEN, sondeo);
    expect(d.llamadas).toHaveLength(1);
    const { name, args } = d.llamadas[0]!;
    expect(name).toBe('vg_rotate_secret');
    expect(args).toMatchObject({ p_org: ORG, p_conn: CONN, p_last4: TOKEN.slice(-4), p_scopes: sondeo.scopes,
      p_capabilities: sondeo.capabilities, p_expires_at: null });
    const secreto = args.p_secret as { kid: string; fingerprint: string };
    expect(secreto.kid).toBe('v1');
    expect(secreto.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain(TOKEN);
    expect(await withSecret(env, d.admin, ctx, async (t) => t)).toBe(TOKEN);
    await expect(withSecret(env, d.admin, { ...ctx, connectionId: 'c0aa0000-0000-4000-8000-000000000002' }, async (t) => t))
      .rejects.toThrow();
  });

  it('23505 (ese PAT ya está en otra conexión de la org) → 409; P0002 → 404; otro → 500 sin el mensaje de Postgres', async () => {
    const casos = [['23505', 409, 'Ese token ya está conectado en esta organización.'], ['P0002', 404, 'Conexión no encontrada'],
      ['08006', 500, 'No se pudo guardar la conexión.']] as const;
    for (const [code, status, texto] of casos) {
      const e = await rotarSecretoConexion(env, doble({ code }).admin, ctx, TOKEN, sondeo).catch((x: unknown) => x);
      expect(e, code).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(status);
      expect((e as ApiError).message).toBe(texto);
      expect((e as ApiError).details).toBeUndefined();   // el 409 del mismo token va sin reason, como en el alta
    }
  });
});
