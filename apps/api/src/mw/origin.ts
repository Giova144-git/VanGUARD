import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.ts';
import { ApiError } from '../lib/errors.ts';

// SPA y API comparten origen: sin CORS. En escrituras, un Origin de otro host → 403 (S15 15.3). El host se compara
// con el de la propia petición, así valen el apex y el *.workers.dev sin otra var; Vite en local solo con VG_ENV=local.
const ESCRITURA = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const VITE_LOCAL = 'http://localhost:5173';

export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && ESCRITURA.has(c.req.method)) {
    const local = c.env.VG_ENV === 'local' && origin === VITE_LOCAL;
    let mismo = false;
    try { mismo = new URL(origin).host === new URL(c.req.url).host; } catch { mismo = false; }
    if (!mismo && !local) throw new ApiError('forbidden', 'Origen no permitido');
  }
  await next();
};
