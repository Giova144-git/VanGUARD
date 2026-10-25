import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.ts';
import { ApiError } from '../lib/errors.ts';

// requireProdHost (S15 15.3): solo con VG_ENV=production y en el host de APP_ORIGIN (hoy officialvanguard.com).
// Lo usan E20, E21, E22 y E27. En www (aún Custom Domain) o en *.workers.dev responde 403: es lo correcto.
export function esHostProduccion(c: Context<AppEnv>): boolean {
  if (c.env.VG_ENV !== 'production' || !c.env.APP_ORIGIN) return false;
  try { return new URL(c.req.url).hostname === new URL(c.env.APP_ORIGIN).hostname; } catch { return false; }
}

export const requireProdHost: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!esHostProduccion(c)) throw new ApiError('forbidden', 'Solo disponible en officialvanguard.com');
  await next();
};

// Productores de vg-jobs (E11, E16, E23; S15 15.7): en producción, solo desde el host real, para que un despliegue de
// prueba no encole en la cola de producción. En local (VG_ENV=local) la cola es el doble en línea de dev-node.ts.
export const requireColaPropia: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.VG_ENV !== 'local' && !esHostProduccion(c)) throw new ApiError('forbidden', 'Solo disponible en officialvanguard.com');
  // La vista previa (develop) no tiene cola a propósito: sin JOBS_Q, 503 ANTES de tocar la base. Si no, la ruta crearía
  // un scan_run o una wiki_run que falla con «No se pudo encolar» en la base de producción.
  if (!(c.env as { JOBS_Q?: unknown }).JOBS_Q) {
    throw new ApiError('provider_unavailable', 'Las auditorías no corren en la vista previa', { reason: 'sin_cola' }, 503);
  }
  await next();
};
