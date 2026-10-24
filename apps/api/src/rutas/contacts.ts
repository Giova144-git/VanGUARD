import { Hono } from 'hono';
import { Contact, ContactsPut } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';

// E26 · GET y PUT /api/orgs/:org/contacts · admin · P0 (S15 15.4). Solo admins: el viewer no ve teléfonos (§06.6).
// PUT reemplaza la lista con vg_replace_contacts (una transacción que conserva verified_at), nunca delete + insert.
export const contacts = new Hono<AppEnv>();

const COLUMNAS = 'id, name, phone_e164, whatsapp, voice, priority, verified_at';

export function aContacto(fila: unknown): Contact {
  const f = fila as Record<string, unknown>;
  return Contact.parse({ id: f.id, name: f.name, phone_e164: f.phone_e164, whatsapp: f.whatsapp, voice: f.voice,
    priority: f.priority, verified_at: typeof f.verified_at === 'string' ? iso(f.verified_at) : null });
}

contacts.get('/orgs/:org/contacts', requireAdmin, async (c) => {
  const { data, error } = await db(c.env).from('contacts').select(COLUMNAS).eq('org_id', c.get('orgId'))
    .order('priority');
  if (error) {
    log('error', 'contacts.lista_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos leer los contactos');
  }
  return c.json((data ?? []).map(aContacto));
});

contacts.put('/orgs/:org/contacts', requireAdmin, async (c) => {
  const lista = await cuerpo(c, ContactsPut);
  const { data, error } = await db(c.env).rpc('vg_replace_contacts', { p_org: c.get('orgId'), p_rows: lista });
  if (error) {
    log('error', 'contacts.reemplazo_error', { rid: c.get('rid'), code: error.code });
    if (error.code === '23505') throw new ApiError('conflict', 'Hay teléfonos repetidos en la lista');
    if (error.code === '23514') throw new ApiError('invalid_body', 'Revisa los contactos: algún dato no es válido');
    throw new ApiError('internal', 'No pudimos guardar los contactos');
  }
  const filas = (Array.isArray(data) ? data : []).map(aContacto).sort((a, b) => a.priority - b.priority);
  log('info', 'contacts.reemplazo', { rid: c.get('rid'), user: c.get('userId'), n: filas.length });
  return c.json(filas);
});
