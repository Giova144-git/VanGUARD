import { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { ApiError } from '../lib/errors.ts';
import { igualesCt } from '../lib/hmac.ts';
import { log } from '../lib/log.ts';
import { HUMO_FETCHES, HUMO_MENSAJES } from '../humo.ts';

// TEMPORAL · prueba de humo de Workers Free (A7.7, S15 15.14): encola 3 mensajes en vg-jobs y cada consumo hace
// 40 fetch a OSV. Exige el secreto VG_HUMO_TOKEN del panel; sin él la ruta no existe (404). Se borra, con el
// secreto, en cuanto la CPU de cada consumo quede anotada.
export const humo = new Hono<AppEnv>();

humo.post('/_humo', async (c) => {
  const esperado = c.env.VG_HUMO_TOKEN;
  const tok = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!esperado || !tok || !(await igualesCt(tok, esperado))) throw new ApiError('not_found', 'Ruta inexistente');
  const mensajes = Array.from({ length: HUMO_MENSAJES }, (_, i) => ({
    body: { v: 1, kind: 'humo', i: i + 1, fetches: HUMO_FETCHES } as const,
  }));
  await c.env.JOBS_Q.sendBatch(mensajes);
  log('info', 'humo.encolado', { rid: c.get('rid'), mensajes: mensajes.length });
  return c.json({ encolados: mensajes.length }, 202);
});
