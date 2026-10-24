import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from './env.ts';
import { fail } from './lib/errors.ts';
import { anonReadOnly } from './mw/anon.ts';
import { auth } from './mw/auth.ts';
import { errorHandler } from './mw/error.ts';
import { orgMember } from './mw/org.ts';
import { originGuard } from './mw/origin.ts';
import { rateLimit } from './mw/rate.ts';
import { requestId } from './mw/request-id.ts';
import { securityHeaders } from './mw/security-headers.ts';
import { demasiadoGrande, ingest, MAX_CUERPO } from './rutas/ingest.ts';
import { rutas } from './rutas/index.ts';
import { webhooksGithub } from './rutas/webhooks-github.ts';
import { webhooksKapso } from './rutas/webhooks-kapso.ts';

// Orden de middlewares de S15 15.3. /mcp entra con su hito.
export const app = new Hono<AppEnv>();

const limiteCuerpo = bodyLimit({
  maxSize: 1024 * 1024,
  onError: (c) => fail(c, 'invalid_body', 'El cuerpo de la petición pasa de 1 MB', undefined, 413),
});

app.use('*', requestId);
app.use('*', securityHeaders);
app.onError(errorHandler);
app.notFound((c) => fail(c, 'not_found', 'Ruta inexistente'));
app.use('/api/*', limiteCuerpo);
app.use('/api/*', originGuard, auth, rateLimit);          // auth se salta las rutas públicas (mw/auth.ts)
app.use('/api/orgs/:org/*', orgMember, anonReadOnly);    // cada ruta de escritura declara además requireAdmin
app.route('/api', rutas);
// Webhooks: sin sesión ni originGuard (los autentica su firma); RL_API con clave ip:<cf-connecting-ip> (no hay userId).
app.use('/webhooks/*', rateLimit, limiteCuerpo);
app.route('/webhooks', webhooksKapso);
app.route('/webhooks', webhooksGithub);                  // E47: revisión de código en cada push (revision-codigo.md)
// Ingesta (E30): sin sesión, originGuard ni RL_API (la víctima manda ~20 rps); la autentica su HMAC. Límite propio de
// 64 KB, también sin Content-Length (bodyLimit cuenta el cuerpo al leerlo).
app.use('/ingest/*', bodyLimit({ maxSize: MAX_CUERPO, onError: demasiadoGrande }));
app.route('/ingest', ingest);
