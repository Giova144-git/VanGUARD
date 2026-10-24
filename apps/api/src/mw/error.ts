import type { ErrorHandler } from 'hono';
import type { AppEnv } from '../env.ts';
import { ApiError, fail } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

// ApiError → {error:{code,message,request_id,details?}}; cualquier otra cosa → 500 internal.
// Nunca se registra err.message: puede llevar un token o el cuerpo de un tercero (R01 §9.1).
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof ApiError) return fail(c, err.code, err.message, err.details, err.status);
  log('error', 'api.error_interno', { rid: c.get('rid'), name: err instanceof Error ? err.name : typeof err });
  return fail(c, 'internal', 'Algo falló de nuestro lado. Vuelve a intentarlo en unos segundos.');
};
