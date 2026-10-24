import { Hono } from 'hono';
import { Module } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { ApiError } from '../lib/errors.ts';
import { estadoModulo } from '../estado/modulo.ts';

// E6 · GET /api/orgs/:org/modules/:module/state · user · P0. module fuera de los 4 → 404.
export const modules = new Hono<AppEnv>();

modules.get('/orgs/:org/modules/:module/state', async (c) => {
  const m = Module.safeParse(c.req.param('module'));
  if (!m.success) throw new ApiError('not_found', 'Módulo desconocido');
  return c.json(await estadoModulo(c.env, c.get('orgId'), m.data));
});
