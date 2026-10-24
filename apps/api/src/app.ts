import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from './env.ts';
import { fail } from './lib/errors.ts';
import { errorHandler } from './mw/error.ts';
import { requestId } from './mw/request-id.ts';
import { securityHeaders } from './mw/security-headers.ts';
import { rutas } from './rutas/index.ts';

// Orden de middlewares de S15 15.3. originGuard, auth y rateLimit en /api/*, y orgMember + anonReadOnly en
// /api/orgs/:org/*, entran con el hito 1; /ingest, /webhooks y /mcp con sus hitos.
export const app = new Hono<AppEnv>();

app.use('*', requestId);
app.use('*', securityHeaders);
app.onError(errorHandler);
app.notFound((c) => fail(c, 'not_found', 'Ruta inexistente'));
app.use('/api/*', bodyLimit({
  maxSize: 1024 * 1024,
  onError: (c) => fail(c, 'invalid_body', 'El cuerpo de la petición pasa de 1 MB', undefined, 413),
}));
app.route('/api', rutas);
