import { Hono } from 'hono';
import { Id, McpTokenCreate, McpTokenCreated, McpTokenPublic } from '@vanguard/contracts';
import { MCP_SCOPES, type AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { hashToken, nuevoToken } from '../lib/mcp-token.ts';
import { requireAdmin } from '../mw/admin.ts';

// E29 · POST, E29b · GET y DELETE /api/orgs/:org/mcp-tokens · admin (S13 §13.7). Nunca se lee ni devuelve token_hash.
// En P1 todo token lleva los cuatro alcances (solo lectura); el revocado es inmediato porque /mcp consulta la tabla.
export const mcpTokens = new Hono<AppEnv>();

const MAX_VIVOS = 10;
const COLUMNAS = 'id, name, scopes, last4, created_at, last_used_at, expires_at, revoked_at';
const DIA_MS = 86_400_000;

const t = (x: unknown) => (typeof x === 'string' ? iso(x) : null);
const aPublico = (f: Record<string, unknown>) => McpTokenPublic.parse({ ...f, created_at: iso(String(f.created_at)),
  last_used_at: t(f.last_used_at), expires_at: t(f.expires_at), revoked_at: t(f.revoked_at) });

mcpTokens.get('/orgs/:org/mcp-tokens', requireAdmin, async (c) => {
  const { data, error } = await db(c.env).from('mcp_tokens').select(COLUMNAS).eq('org_id', c.get('orgId'))
    .order('created_at', { ascending: false }).limit(50);
  if (error) {
    log('error', 'mcp_tokens.lista_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos leer los tokens MCP');
  }
  return c.json(((data ?? []) as Record<string, unknown>[]).map(aPublico));
});

mcpTokens.post('/orgs/:org/mcp-tokens', requireAdmin, async (c) => {
  const b = await cuerpo(c, McpTokenCreate);
  const admin = db(c.env);
  const orgId = c.get('orgId');
  const ahora = new Date();
  const { data: vivos, error: ev } = await admin.from('mcp_tokens').select('id, expires_at').eq('org_id', orgId)
    .is('revoked_at', null).limit(MAX_VIVOS + 50);
  if (ev) {
    log('error', 'mcp_tokens.conteo_error', { rid: c.get('rid'), code: ev.code });
    throw new ApiError('internal', 'No pudimos crear el token');
  }
  const n = ((vivos ?? []) as { expires_at: string | null }[])
    .filter((v) => !v.expires_at || Date.parse(v.expires_at) > ahora.getTime()).length;
  if (n >= MAX_VIVOS) throw new ApiError('conflict', `Ya hay ${MAX_VIVOS} tokens activos. Revoca uno para crear otro.`);

  const token = nuevoToken();
  const fila = { org_id: orgId, name: b.name, token_hash: await hashToken(token), last4: token.slice(-4), scopes: [...MCP_SCOPES],
    created_by: c.get('userId'), expires_at: new Date(ahora.getTime() + b.expires_in_days * DIA_MS).toISOString() };
  const { data, error } = await admin.from('mcp_tokens').insert(fila).select('id, name, scopes, last4, expires_at').single();
  if (error || !data) {
    log('error', 'mcp_tokens.crear_error', { rid: c.get('rid'), code: error?.code ?? null });
    throw new ApiError('internal', 'No pudimos crear el token');
  }
  log('info', 'mcp_token.created', { rid: c.get('rid'), user: c.get('userId'), token_id: data.id, dias: b.expires_in_days });
  return c.json(McpTokenCreated.parse({ ...data, token, expires_at: t(data.expires_at) }), 201);
});

mcpTokens.delete('/orgs/:org/mcp-tokens/:id', requireAdmin, async (c) => {
  const id = Id.safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError('not_found', 'Token no encontrado');
  const { data, error } = await db(c.env).from('mcp_tokens').update({ revoked_at: new Date().toISOString() })
    .eq('id', id.data).eq('org_id', c.get('orgId')).is('revoked_at', null).select('id').maybeSingle();
  if (error) throw new ApiError('internal', 'No pudimos revocar el token');
  if (!data) throw new ApiError('not_found', 'Token no encontrado o ya revocado');
  log('info', 'mcp_token.revoked', { rid: c.get('rid'), user: c.get('userId'), token_id: id.data });
  return c.body(null, 204);
});
