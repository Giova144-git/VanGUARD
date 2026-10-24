import { Hono } from 'hono';
import { DemoJoin } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

// E4 · POST /api/demo/join · user (anónimo o no) · P0. Idempotente y nunca rebaja un rol existente (misma semántica
// que join_demo_org() de §05, que queda como plan B del FRONT por supabase.rpc). Con el cliente admin porque el
// Worker no tiene la publishable key para actuar con el JWT del usuario.
export const demo = new Hono<AppEnv>();

demo.post('/demo/join', async (c) => {
  const admin = db(c.env);
  const { data: org, error: eo } = await admin.from('orgs').select('id').eq('is_demo', true).maybeSingle();
  if (eo) {
    log('error', 'demo.buscar_error', { rid: c.get('rid'), code: eo.code });
    throw new ApiError('internal', 'No pudimos abrir la demo');
  }
  if (!org) throw new ApiError('not_found', 'La demo todavía no está preparada');
  const { error } = await admin.from('org_members')
    .upsert({ org_id: org.id, user_id: c.get('userId'), role: 'viewer' }, { onConflict: 'org_id,user_id', ignoreDuplicates: true });
  if (error) {
    log('error', 'demo.unir_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos abrir la demo');
  }
  return c.json(DemoJoin.parse({ org_id: org.id }));
});
