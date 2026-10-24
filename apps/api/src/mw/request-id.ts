import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.ts';

// cf-ray en el Worker (correlaciona con Workers Logs); uuid en Node.
export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('rid', c.req.header('cf-ray') ?? crypto.randomUUID());
  await next();
};
