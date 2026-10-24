import { Hono } from 'hono';
import { Org, OrgCreate } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';

// E3 · POST /api/orgs · user no anónimo · P0. Org + membresía owner en una transacción con vg_create_org() (§05).
export const orgs = new Hono<AppEnv>();

const MAX_ORGS_OWNER = 3; // [propuesta] de §15.4
const INTENTOS_SLUG = 3;
const ALFABETO = 'abcdefghijklmnopqrstuvwxyz0123456789';

// slugify(name) recortado a 35 car. (vacío → 'org') + '-' + 4 car. [a-z0-9]: cabe en el check de 3–40 car. de §05.
export function slugDe(name: string): string {
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 35).replace(/-+$/g, '') || 'org';
  const azar = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALFABETO[b % ALFABETO.length]).join('');
  return `${base}-${azar}`;
}

orgs.post('/orgs', async (c) => {
  if (c.get('isAnon')) throw new ApiError('forbidden', 'Crea una cuenta con correo para crear una organización');
  const { name } = await cuerpo(c, OrgCreate);
  const admin = db(c.env);
  const uid = c.get('userId');

  const { count, error: ec } = await admin.from('org_members').select('org_id', { count: 'exact', head: true })
    .eq('user_id', uid).eq('role', 'owner');
  if (ec) {
    log('error', 'orgs.conteo_error', { rid: c.get('rid'), code: ec.code });
    throw new ApiError('internal', 'No pudimos crear la organización');
  }
  if ((count ?? 0) >= MAX_ORGS_OWNER) {
    throw new ApiError('conflict', `Ya eres dueño de ${MAX_ORGS_OWNER} organizaciones`);
  }

  let id: string | null = null;
  for (let i = 0; i < INTENTOS_SLUG && !id; i++) {
    const { data, error } = await admin.rpc('vg_create_org', { p_name: name, p_slug: slugDe(name), p_owner: uid });
    if (!error) id = data as string;
    else if (error.code !== '23505') {
      log('error', 'orgs.crear_error', { rid: c.get('rid'), code: error.code });
      throw new ApiError('internal', 'No pudimos crear la organización');
    }
  }
  if (!id) throw new ApiError('internal', 'No pudimos crear la organización');

  const { data: fila, error: ef } = await admin.from('orgs').select('id, name, slug, is_demo, created_at')
    .eq('id', id).single();
  if (ef || !fila) {
    log('error', 'orgs.leer_error', { rid: c.get('rid'), code: ef?.code ?? null });
    throw new ApiError('internal', 'No pudimos crear la organización');
  }
  return c.json(Org.parse({ ...fila, created_at: iso(fila.created_at) }), 201);
});
