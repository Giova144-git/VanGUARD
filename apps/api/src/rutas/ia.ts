import { Hono } from 'hono';
import { AiUsage } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

// E28 · GET /api/orgs/:org/ai/usage · user · P1 (PLAN_MAESTRO §11, «API de gasto»). vg_ai_status(org) y SOLO
// {today_usd, cap_usd, enabled, level} por AiUsage.parse: zod descarta calls_1m y nunca sale el gasto global ni el de
// otra org (la org es la de la ruta, ya validada por orgMember). Con IA_CORTE=1 la IA está apagada aunque la base diga
// otra cosa: enabled false y level off, como overview y llamarIA.
export const ia = new Hono<AppEnv>();

ia.get('/orgs/:org/ai/usage', async (c) => {
  const { data, error } = await db(c.env).rpc('vg_ai_status', { p_org: c.get('orgId') });
  const e = (data ?? null) as Record<string, unknown> | null;
  if (error || !e) {
    log('error', 'ia.uso_error', { rid: c.get('rid'), code: error?.code ?? null });
    throw new ApiError('internal', 'No pudimos leer el gasto de IA');
  }
  const corte = c.env.IA_CORTE === '1';
  return c.json(AiUsage.parse({ today_usd: Number(e.today_usd ?? 0), cap_usd: Number(e.cap_usd ?? 0),
    enabled: corte ? false : e.enabled === true, level: corte ? 'off' : e.level }));
});
