import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.ts';
import { ApiError } from '../lib/errors.ts';

// Cada ruta de escritura de una org lo declara: pasan owner y admin; viewer y anónimos → 403 (S15 15.3).
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const role = c.get('role');
  if (c.get('isAnon') || (role !== 'owner' && role !== 'admin')) {
    throw new ApiError('forbidden', 'Solo un administrador de la organización puede hacer esto');
  }
  await next();
};
