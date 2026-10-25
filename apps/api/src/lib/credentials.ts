import type { SupabaseClient } from '@supabase/supabase-js';
import { seal, open, fingerprint, last4, type Box, type SecretCtx } from '@vanguard/core/crypto';
import { getKeys, activeKid } from './keyring.ts';
import { ApiError } from './errors.ts';

// Literal de §05.7: ÚNICO módulo que toca connection_secrets.
export type NewConnection = SecretCtx & { label: string; meta: Record<string, unknown>; scopes: string[];
  capabilities: Record<string, boolean>; expiresAt: string | null; createdBy: string };

export async function createConnectionWithSecret(env: CloudflareBindings, admin: SupabaseClient, c: NewConnection, token: string) {
  const keys = await getKeys(env, admin, await activeKid(admin));
  const sealed = await seal(keys, token, c);
  const { error } = await admin.rpc('vg_create_connection', {
    p_conn: { id: c.connectionId, org_id: c.orgId, provider: c.provider, kind: c.kind, label: c.label, meta: c.meta,
              last4: last4(token), scopes: c.scopes, capabilities: c.capabilities, expires_at: c.expiresAt, created_by: c.createdBy },
    p_secret: { sealed, kid: keys.kid, fingerprint: await fingerprint(keys, c.orgId, token) } });
  if (error?.code === '23505') throw new ApiError('conflict', 'Ese token ya está conectado en esta organización.');
  if (error) throw new ApiError('internal', 'No se pudo guardar la conexión.');   // nunca error.message
}

/** Cambiar el token de una conexión SIN cambiar su id (vg_rotate_secret, 0003): sella el token nuevo con el AAD de la
 *  MISMA conexión (org, id existente, proveedor, kind), calcula su huella y deja la conexión active con sus scopes,
 *  capabilities y caducidad nuevos. Lo usa E53 para el token de acciones de GitHub (bloqueo-merge-criticos.md §2.8) y es
 *  la misma función que pide varias-codebases.md §2.1 para «Reconectar» en E8 (una sola para los dos). 23505 (esa huella
 *  ya está en la org) → conflict; P0002 (la conexión no tiene secreto) → not_found; nunca error.message. */
export async function rotarSecretoConexion(env: CloudflareBindings, admin: SupabaseClient, ctx: SecretCtx, token: string,
  c: { scopes: string[]; capabilities: Record<string, boolean>; expiresAt: string | null }) {
  const keys = await getKeys(env, admin, await activeKid(admin));
  const sealed = await seal(keys, token, ctx);
  const { error } = await admin.rpc('vg_rotate_secret', { p_org: ctx.orgId, p_conn: ctx.connectionId,
    p_secret: { sealed, kid: keys.kid, fingerprint: await fingerprint(keys, ctx.orgId, token) }, p_last4: last4(token),
    p_scopes: c.scopes, p_capabilities: c.capabilities, p_expires_at: c.expiresAt });
  if (error?.code === '23505') throw new ApiError('conflict', 'Ese token ya está conectado en esta organización.');
  if (error?.code === 'P0002') throw new ApiError('not_found', 'Conexión no encontrada');
  if (error) throw new ApiError('internal', 'No se pudo guardar la conexión.');   // nunca error.message
}

/** El token existe solo dentro de fn: prohibido devolverlo, registrarlo o meterlo en un error, un prompt o un MCP. */
export async function withSecret<T>(env: CloudflareBindings, admin: SupabaseClient, ctx: SecretCtx,
                                    fn: (token: string) => Promise<T>): Promise<T> {
  const { data, error } = await admin.from('connection_secrets').select('sealed, kid')
    .eq('connection_id', ctx.connectionId).eq('org_id', ctx.orgId).maybeSingle();
  if (error || !data) throw new ApiError('not_found', 'Esta conexión ya no tiene credencial. Vuelve a conectarla.');
  return fn(await open(await getKeys(env, admin, data.kid), data.sealed as Box, ctx));
}

/** Ingesta (cada lote): clave HMAC importada no extraíble, en caché 60 s. Clave = bytes UTF-8 del vgi_… completo. */
const ingestCache = new Map<string, { key: Promise<CryptoKey>; exp: number }>();
export function ingestKey(env: CloudflareBindings, admin: SupabaseClient, ctx: SecretCtx): Promise<CryptoKey> {
  const hit = ingestCache.get(ctx.connectionId);
  if (hit && hit.exp > Date.now()) return hit.key;
  const key = withSecret(env, admin, ctx, (s) => crypto.subtle.importKey('raw', new TextEncoder().encode(s),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']));
  ingestCache.set(ctx.connectionId, { key, exp: Date.now() + 60_000 });
  key.catch(() => ingestCache.delete(ctx.connectionId));
  return key;   // verificar con crypto.subtle.verify('HMAC', key, firma, `${ts}.${cuerpo}`): comparación constante
}

/** Revisión de código (asignaciones/revision-codigo.md, E46/E47): el vgw_ va sellado en code_review_configs.secret_sealed
 *  con AAD (org, id de ESA config, 'github', 'read'): no se puede mover a otra fila ni a otra org. Nunca se escribe en
 *  claro: solo sale una vez en la respuesta de E46. */
export type ConfigSellada = { id: string; org_id: string; secret_sealed: Box };
const ctxWebhook = (orgId: string, configId: string): SecretCtx =>
  ({ orgId, connectionId: configId, provider: 'github', kind: 'read' });

export async function sellarSecretoWebhook(env: CloudflareBindings, admin: SupabaseClient, orgId: string, configId: string,
                                           secreto: string): Promise<{ sealed: Box; kid: string; last4: string }> {
  const keys = await getKeys(env, admin, await activeKid(admin));
  return { sealed: await seal(keys, secreto, ctxWebhook(orgId, configId)), kid: keys.kid, last4: last4(secreto) };
}

/** E47: clave HMAC del webhook (bytes UTF-8 del vgw_… completo), no extraíble, en caché 60 s por config + iv del sellado:
 *  un secreto rotado (P1) vale al instante y el viejo deja de valer. La fila ya viene leída: abrirla solo cuesta las llaves
 *  (en frío). Verificar con crypto.subtle.verify('HMAC', clave, firma, crudo): comparación en tiempo constante. */
const webhookCache = new Map<string, { key: Promise<CryptoKey>; exp: number }>();
export function claveWebhook(env: CloudflareBindings, admin: SupabaseClient, cfg: ConfigSellada): Promise<CryptoKey> {
  const id = `${cfg.id}:${cfg.secret_sealed.iv}`;
  const hit = webhookCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.key;
  const key = (async () => {
    const secreto = await open(await getKeys(env, admin, cfg.secret_sealed.kid), cfg.secret_sealed, ctxWebhook(cfg.org_id, cfg.id));
    return crypto.subtle.importKey('raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  })();
  webhookCache.set(id, { key, exp: Date.now() + 60_000 });
  key.catch(() => webhookCache.delete(id));
  return key;
}

/** Tras rotar el secreto (E46): fuera de la caché de ESTE isolate toda clave de esa config. La caché ya va por iv y el
 *  sellado nuevo trae otro, así que el secreto viejo deja de valer igual; esto solo suelta la clave vieja antes de los 60 s. */
export function olvidarClaveWebhook(configId: string): void {
  for (const id of webhookCache.keys()) if (id.startsWith(`${configId}:`)) webhookCache.delete(id);
}

/** CB_KEY_REUSE (P1, §09.9): huella → connection_id de las credenciales de ESTA org, para comparar en memoria con las huellas
 *  del repo (fingerprint(keys, orgId, valor), la MISMA función del alta). Así repo.ts no toca connection_secrets y las
 *  huellas no viajan en una URL de PostgREST. Una org tiene pocas conexiones. */
export async function fingerprintsOfOrg(_env: CloudflareBindings, admin: SupabaseClient, orgId: string): Promise<Map<string, string>> {
  const { data, error } = await admin.from('connection_secrets').select('connection_id, fingerprint').eq('org_id', orgId);
  if (error) throw new ApiError('internal', 'No se pudieron leer las huellas.');
  return new Map((data ?? []).map((r) => [r.fingerprint as string, r.connection_id as string]));
}
