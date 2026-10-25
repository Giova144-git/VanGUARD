import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.ts';
import { ApiError } from '../lib/errors.ts';

// Una sesión anónima («Ver demo») solo lee: cualquier escritura bajo /api/orgs/:org/* → 403, salvo E15, que al
// viewer solo le devuelve el prompt ya guardado (matriz de §06.6), y salvo en SU sandbox (0026): allí es owner y hace lo
// mismo que una cuenta normal. orgMember ya comprobó que es miembro; sandbox sale de la base (orgs.sandbox_of).
const ESCRITURA = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FIX_PROMPT = /^\/api\/orgs\/[^/]+\/findings\/[^/]+\/fix-prompt$/;

export const anonReadOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('isAnon') && !c.get('sandbox') && ESCRITURA.has(c.req.method)
      && !(c.req.method === 'POST' && FIX_PROMPT.test(c.req.path))) {
    throw new ApiError('forbidden', 'Crea una cuenta con correo para conectar tus servicios');
  }
  await next();
};
