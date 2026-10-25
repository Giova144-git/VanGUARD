import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.ts';
import { fail } from '../lib/errors.ts';
import { db } from '../lib/db.ts';
import { log } from '../lib/log.ts';
import { hashToken } from '../lib/mcp-token.ts';

// /mcp (S13 §13.7): solo Bearer vgk_, sin sesión de Supabase ni originGuard (no hay cookie que robar). El tenant sale del
// token: cada petición consulta mcp_tokens, así que revocar es inmediato. ANTES de esa consulta, RL_API con clave
// mcp-ip:<cf-connecting-ip>: un vgk_ inventado ya no lee la tabla sin freno. El mcp:<token_id> (§06.9) lo cobra
// mcp/protocolo.ts por cada petición JSON-RPC (cada tools/call y cada prompts/get), no una vez por POST.
const BEARER = /^Bearer\s+(vgk_[A-Za-z0-9_-]{43})$/i;   // el token en sí distingue mayúsculas: lo comprueba el hash

export const mcpAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deny = () => {
    // Sin resource_metadata: con la cabecera configurada el cliente no intenta OAuth (P2) y marca la conexión fallida.
    c.header('WWW-Authenticate', 'Bearer realm="VanGUARD", error="invalid_token"');
    return fail(c, 'unauthorized', 'Token MCP inválido, revocado o vencido. Crea uno en VanGUARD → Llevar a tu IA.');
  };
  const m = BEARER.exec(c.req.header('authorization') ?? '');
  if (!m?.[1]) return deny();
  const ip = await c.env.RL_API.limit({ key: `mcp-ip:${c.req.header('cf-connecting-ip') ?? 'local'}` });
  if (!ip.success) {
    c.header('Retry-After', '60');
    return fail(c, 'rate_limited', 'Demasiadas peticiones desde esta IP. Espera un minuto.');
  }
  const { data: t, error } = await db(c.env).from('mcp_tokens').select('id, org_id, scopes, expires_at, last_used_at')
    .eq('token_hash', await hashToken(m[1])).is('revoked_at', null).maybeSingle();
  if (error) {
    log('error', 'mcp.auth_error', { rid: c.get('rid'), code: error.code });
    return fail(c, 'internal', 'No pudimos comprobar el token. Prueba de nuevo en un minuto.');
  }
  const fila = t as { id: string; org_id: string; scopes: string[]; expires_at: string | null; last_used_at: string | null } | null;
  if (!fila || (fila.expires_at && Date.parse(fila.expires_at) <= Date.now())) return deny();
  c.set('mcp', { tokenId: fila.id, orgId: fila.org_id, scopes: fila.scopes ?? [] });
  // last_used_at como mucho una escritura por minuto. Con await y no con waitUntil: en Node (dev-node.ts) Hono no tiene
  // executionCtx y acceder a c.executionCtx lanza.
  if (!fila.last_used_at || Date.parse(fila.last_used_at) < Date.now() - 60_000) {
    await db(c.env).from('mcp_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', fila.id).eq('org_id', fila.org_id);
  }
  await next();
};
