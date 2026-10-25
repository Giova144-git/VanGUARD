import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.ts';
import { ApiError } from '../lib/errors.ts';

// ¿Administra esta org? owner o admin; un anónimo nunca, salvo en SU sandbox de «Ver demo» (0026), donde es owner.
export function administra(c: Context<AppEnv>): boolean {
  const role = c.get('role');
  return (!c.get('isAnon') || c.get('sandbox') === true) && (role === 'owner' || role === 'admin');
}

// Cada ruta de escritura de una org lo declara: pasan owner y admin; viewer y anónimos → 403 (S15 15.3).
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!administra(c)) {
    throw new ApiError('forbidden', 'Solo un administrador de la organización puede hacer esto');
  }
  await next();
};
