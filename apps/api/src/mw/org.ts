import type { MiddlewareHandler } from 'hono';
import { Role } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

// :org es orgs.id (uuid). Quien no es miembro recibe 404, no 403: no se confirma que la org exista (S15 15.3).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const orgMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  // En minúsculas: orgId entra en el AAD y en la huella; con mayúsculas se salta la dedupe y el secreto no se abre.
  const org = (c.req.param('org') ?? '').toLowerCase();
  if (!UUID.test(org)) throw new ApiError('not_found', 'Organización no encontrada');
  const { data, error } = await db(c.env).from('org_members').select('role, orgs(sandbox_of)')
    .eq('org_id', org).eq('user_id', c.get('userId')).maybeSingle();
  if (error) {
    log('error', 'org.miembro_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos comprobar tu acceso a esta organización');
  }
  const role = Role.safeParse(data?.role);
  if (!role.success) throw new ApiError('not_found', 'Organización no encontrada');
  c.set('orgId', org);
  c.set('role', role.data);
  // Sandbox de «Ver demo» (0026): lo decide la fila de la org, nunca el cliente. Cambia anon.ts y admin.ts, ejecuta las
  // acciones de Cloudflare en seco y no deja salir WhatsApp (S15 15.3).
  const o = (data as { orgs?: { sandbox_of?: unknown } | null } | null)?.orgs;
  c.set('sandbox', typeof o?.sandbox_of === 'string' && o.sandbox_of !== '');
  await next();
};
