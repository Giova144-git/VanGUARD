import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.ts';

// Código de §06.11. `_headers` de los assets no se aplica a lo que genera el Worker, así que la API pone las suyas.
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.res = new Response(c.res.body, c.res); // copia mutable
  const h = c.res.headers;
  h.set('Cache-Control', 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Frame-Options', 'DENY');
  h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  h.set('X-Request-Id', c.get('rid'));
  h.delete('Access-Control-Allow-Origin'); // mismo origen: nunca CORS (S15)
};
