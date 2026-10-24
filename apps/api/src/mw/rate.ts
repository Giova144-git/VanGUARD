import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.ts';
import { fail } from '../lib/errors.ts';

// RL_API = 300 por 60 s (S15 15.3): clave u:<user_id> tras auth; ip:<cf-connecting-ip> en rutas públicas.
export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const uid = c.get('userId');
  const key = uid ? `u:${uid}` : `ip:${c.req.header('cf-connecting-ip') ?? 'local'}`;
  const { success } = await c.env.RL_API.limit({ key });
  if (!success) {
    c.header('Retry-After', '60');
    return fail(c, 'rate_limited', 'Demasiadas peticiones. Espera un minuto.');
  }
  await next();
};
