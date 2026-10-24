import { Hono } from 'hono';
import { Me } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

// E2 · GET /api/me · user · P0. El usuario sale del JWT ya validado por auth; las orgs, de sus membresías.
export const me = new Hono<AppEnv>();

type Fila = { role: string; orgs: { id: string; name: string; is_demo: boolean } | null };

me.get('/me', async (c) => {
  const uid = c.get('userId');
  const { data, error } = await db(c.env).from('org_members').select('role, orgs(id, name, is_demo)')
    .eq('user_id', uid).order('created_at');
  if (error) {
    log('error', 'me.error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos cargar tus organizaciones');
  }
  const orgs = ((data ?? []) as unknown as Fila[]).flatMap((f) =>
    f.orgs ? [{ id: f.orgs.id, name: f.orgs.name, role: f.role, is_demo: f.orgs.is_demo }] : []);
  return c.json(Me.parse({ user: { id: uid, email: c.get('email'), is_anonymous: c.get('isAnon') }, orgs }));
});
