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

// En una sandbox de «Ver demo» (0026) E20, E21, E22, E56 y E27 no tocan nada real (Cloudflare en seco, WhatsApp
// registrado sin enviar): el host da igual y la demo funciona también en local y en las previews.
export const requireProdHostOSandbox: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('sandbox') && !esHostProduccion(c)) throw new ApiError('forbidden', 'Solo disponible en officialvanguard.com');
  await next();
};

// ¿Puede esta petición encolar en vg-jobs? En local (VG_ENV=local) la cola es el doble en línea de dev-node.ts.
export const colaPropia = (c: Context<AppEnv>) => c.env.VG_ENV === 'local' || esHostProduccion(c);

// Productores de vg-jobs (E11, E16, E23; S15 15.7): en producción, solo desde el host real, para que un despliegue de
// prueba no encole en la cola de producción.
export const requireColaPropia: MiddlewareHandler<AppEnv> = async (c, next) => {
  // La vista previa (develop, VG_ENV=preview) no tiene cola a propósito: 503 ANTES de tocar la base y antes del 403 de
  // host. Si no, la ruta crearía un scan_run o una wiki_run que falla con «No se pudo encolar» en la base de producción.
  if (esVistaPrevia(c.env)) {
    throw new ApiError('preview_unsupported', 'Las auditorías no corren en la vista previa');
  }
  if (!colaPropia(c)) throw new ApiError('forbidden', 'Solo disponible en officialvanguard.com');
  await next();
};

/** Vista previa de Workers: VG_ENV=preview o sin el binding de la cola. Overview.preview y E11 lo usan. */
export const esVistaPrevia = (env: CloudflareBindings): boolean =>
  (env.VG_ENV as string | undefined) === 'preview' || !(env as { JOBS_Q?: unknown }).JOBS_Q;
