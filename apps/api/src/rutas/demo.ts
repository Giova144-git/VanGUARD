import { Hono, type Context } from 'hono';
import { DemoJoin, DemoSandbox } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

// «Ver demo» por visitante y volátil (0026_sandbox_demo.sql). Cada usuario, anónimo o con cuenta, recibe SU copia de la
// org de demo como owner (una viva como mucho) y nadie se une ya a la demo compartida. La copia vive mientras la web
// late: sin latido 10 min, la purga por minuto la borra (y al anónimo que se quede sin orgs).
//   E4  · POST /api/demo/join    → { org_id, sandbox: true } · crea o devuelve la sandbox viva (vg_sandbox_join).
//   E4b · POST /api/demo/latido  { org_id } → 204 · 404 si no es su sandbox (o ya se purgó). Anula un cierre pendiente.
//   E4d · POST /api/demo/cerrando { org_id } → 204 · 404 si no es suya · pagehide con fetch keepalive (Authorization):
//         no borra; la marca para que la purga la borre en 20 s si no llega otro latido (una recarga lo manda al cargar).
//   E4c · POST /api/demo/salir   { org_id } → 204 · la borra ya; idempotente; sirve con fetch keepalive (Authorization).
// Con el cliente admin y RPC security definer solo para service_role: el candado por usuario y los cupos (10 por IP y
// hora, 200 vivas) viven en la base, así que dos pestañas a la vez no crean dos copias.
export const demo = new Hono<AppEnv>();

const enc = new TextEncoder();

/** HMAC-SHA256 de la IP con la pimienta de huellas (VG_FP_PEPPER) y dominio propio: la base nunca guarda la IP y sin la
 *  pimienta el hash no se puede revertir probando las 2³² IPv4. Sin cf-connecting-ip (local) → null: sin cupo por IP. */
export async function hashIp(env: CloudflareBindings, ip: string | undefined): Promise<string | null> {
  const limpia = (ip ?? '').trim().toLowerCase();
  if (!limpia) return null;
  const key = await crypto.subtle.importKey('raw', enc.encode(env.VG_FP_PEPPER || 'vanguard-sin-pimienta'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('HMAC', key, enc.encode(`sandbox-ip|${limpia}`));
  return Array.from(new Uint8Array(firma), (b) => b.toString(16).padStart(2, '0')).join('');
}

function fallo(c: Context<AppEnv>, evento: string, error: { code?: string; message?: string }): never {
  const msg = error.message ?? '';
  if (error.code === 'P0002') throw new ApiError('not_found', 'La demo todavía no está preparada');
  if (msg.includes('sandbox_cupo_ip')) {
    c.header('Retry-After', '3600');
    throw new ApiError('rate_limited', 'Abriste demasiadas demos desde esta conexión. Vuelve a intentarlo en una hora.',
      { reason: 'sandbox_ip' });
  }
  if (msg.includes('sandbox_cupo_global')) {
    c.header('Retry-After', '300');
    throw new ApiError('rate_limited', 'La demo está llena ahora mismo. Vuelve a intentarlo en unos minutos.',
      { reason: 'sandbox_global' });
  }
  // La purga ya borró a este invitado (su sesión es de antes): que la web vuelva a entrar como anónimo.
  if (error.code === '23503') throw new ApiError('unauthorized', 'Tu sesión de demo terminó. Vuelve a entrar.');
  log('error', evento, { rid: c.get('rid'), code: error.code ?? null });
  throw new ApiError('internal', 'No pudimos abrir la demo');
}

demo.post('/demo/join', async (c) => {
  const ipHash = await hashIp(c.env, c.req.header('cf-connecting-ip'));
  const { data, error } = await db(c.env).rpc('vg_sandbox_join', { p_user: c.get('userId'), p_ip_hash: ipHash });
  if (error) fallo(c, 'demo.sandbox_error', error);
  if (typeof data !== 'string') {
    log('error', 'demo.sandbox_sin_id', { rid: c.get('rid') });
    throw new ApiError('internal', 'No pudimos abrir la demo');
  }
  log('info', 'demo.sandbox', { rid: c.get('rid'), user: c.get('userId'), anon: c.get('isAnon') });
  return c.json(DemoJoin.parse({ org_id: data, sandbox: true }));
});

demo.post('/demo/latido', async (c) => {
  const { org_id } = await cuerpo(c, DemoSandbox);
  const { data, error } = await db(c.env).rpc('vg_sandbox_latido', { p_org: org_id.toLowerCase(), p_user: c.get('userId') });
  if (error) {
    log('error', 'demo.latido_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos mantener la demo abierta');
  }
  if (data !== true) throw new ApiError('not_found', 'Esa demo ya no existe');
  return c.body(null, 204);
});

demo.post('/demo/cerrando', async (c) => {
  const { org_id } = await cuerpo(c, DemoSandbox);
  const { data, error } = await db(c.env).rpc('vg_sandbox_cerrando', { p_org: org_id.toLowerCase(), p_user: c.get('userId') });
  if (error) {
    log('error', 'demo.cerrando_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos cerrar la demo');
  }
  if (data !== true) throw new ApiError('not_found', 'Esa demo ya no existe');
  return c.body(null, 204);
});

demo.post('/demo/salir', async (c) => {
  const { org_id } = await cuerpo(c, DemoSandbox);
  const { data, error } = await db(c.env).rpc('vg_sandbox_salir', { p_org: org_id.toLowerCase(), p_user: c.get('userId') });
  if (error) {
    log('error', 'demo.salir_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos cerrar la demo');
  }
  const r = (data ?? {}) as { borrada?: unknown; usuario_borrado?: unknown };
  log('info', 'demo.salir', { rid: c.get('rid'), borrada: r.borrada === true, usuario_borrado: r.usuario_borrado === true });
  return c.body(null, 204);
});
