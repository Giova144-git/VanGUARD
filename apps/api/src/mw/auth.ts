import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';

// Bearer de Supabase validado lo primero con getClaims, nunca con getSession() en servidor (canónicas §7, S15 15.3).
// Rutas públicas: E1, la herramienta de voz (su propio token, P1) y los JSON Schema (E35).
const PUBLICAS = new Set(['/api/health', '/api/voz/respuesta']);
const esPublica = (ruta: string) => PUBLICAS.has(ruta) || ruta.startsWith('/api/schemas/');

export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (esPublica(c.req.path)) return next();
  const tok = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!tok) throw new ApiError('unauthorized', 'Inicia sesión para continuar');
  const { data, error } = await db(c.env).auth.getClaims(tok);
  const sub = data?.claims?.sub;
  if (error || typeof sub !== 'string' || !sub) throw new ApiError('unauthorized', 'Tu sesión venció');
  const isAnon = data?.claims?.is_anonymous === true;
  const email = data?.claims?.email;
  c.set('userId', sub);
  c.set('isAnon', isAnon);
  c.set('email', !isAnon && typeof email === 'string' && email ? email : null);
  await next();
};
