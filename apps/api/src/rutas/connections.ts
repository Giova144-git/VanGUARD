import { Hono, type Context } from 'hono';
import { ConnectionCreate, ConnectionCreated, ConnectionPublic, ConnectionTest, Id, type PermCheck } from '@vanguard/contracts';
import { guardKey, type KeyRejection } from '@vanguard/core';
import { newIngestSecret, type SecretCtx } from '@vanguard/core/crypto';
import { deshacerBloqueos, EN_CURSO_MS } from '../actions/block-ip.ts';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { createConnectionWithSecret, withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';
import { esHostProduccion } from '../mw/prod-host.ts';
import { probarCloudflareAcciones, probarCloudflareLectura } from '../scans/cloudflare.ts';
import { probarGithub } from '../scans/repo.ts';
import type { Sondeo } from '../scans/sondeo.ts';
import { normalizarRef, probarSupabase } from '../scans/supabase.ts';

// E7–E10 (S15 15.4). Orden de E8 (§05.7): zod → guardKey en CADA token → sondeo → connectionId → sellado → 201.
// Si falla cualquier paso, no queda nada guardado. El token solo vive en memoria durante la petición.
export const connections = new Hono<AppEnv>();

const COLUMNAS = 'id, provider, kind, label, status, last4, scopes, meta, capabilities, expires_at, last_checked_at, last_error';
type Fila = { id: string; provider: string; kind: string; label: string; status: string; last4: string | null; scopes: string[];
  meta: Record<string, unknown>; capabilities: Record<string, unknown>; expires_at: string | null; last_checked_at: string | null;
  last_error: string | null };

const MENSAJE_RECHAZO: Record<KeyRejection, string> = {
  service_role: 'Esa es una clave service_role: salta toda la seguridad de tu base. VanGUARD solo necesita un token de solo lectura (empieza por sbp_fc). No la guardamos.',
  sb_secret: 'Esa es una secret key de Supabase (sb_secret_): salta toda la seguridad de tu base. VanGUARD solo necesita un token de solo lectura (empieza por sbp_fc). No la guardamos.',
  legacy_pat: 'Ese token ve todos tus proyectos. Crea uno con alcance a un solo proyecto y solo lectura.',
  classic_github_pat: 'Los tokens clásicos de GitHub dan acceso a todos tus repos. Usa un token fine-grained de un solo repo con Contents: Read-only.',
  global_api_key: 'Esa es la Global API Key de Cloudflare (control total). Crea un API Token con permisos de lectura.',
  invalid_chars: 'El token tiene caracteres invisibles o no válidos. Cópialo de nuevo.',
  too_long: 'Eso es demasiado largo para ser un token.',
};

const REVOKE_URL: Record<string, string> = {
  supabase: 'https://supabase.com/dashboard/account/tokens',
  cloudflare: 'https://dash.cloudflare.com/profile/api-tokens',
  github: 'https://github.com/settings/personal-access-tokens',
};

// Solo booleanos en capabilities (ConnectionPublic): lo demás no sale.
export function aPublica(f: Fila): ConnectionPublic {
  const caps = Object.fromEntries(Object.entries(f.capabilities ?? {}).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>;
  return ConnectionPublic.parse({ ...f, scopes: f.scopes ?? [], meta: f.meta ?? {}, capabilities: caps,
    expires_at: f.expires_at ? iso(f.expires_at) : null, last_checked_at: f.last_checked_at ? iso(f.last_checked_at) : null });
}

function guardar(provider: 'supabase' | 'cloudflare' | 'github', ...tokens: (string | undefined)[]) {
  for (const t of tokens) {
    if (t === undefined) continue;
    const motivo = guardKey(provider, t);   // nunca se registra el valor
    if (motivo) throw new ApiError('key_rejected', MENSAJE_RECHAZO[motivo], { reason: motivo });
  }
}

// Permisos de más que delata el sondeo negativo de probarSupabase (§06.3, §07.2), con el nombre del panel.
const PERMISO_SOBRANTE: Record<string, string> = {
  organizations_read: 'Organizations, propio de un token de acceso total',
  api_gateway_keys_read: 'API Keys',
  data_api_config_read: 'Data API Config',
  edge_functions_secrets_read: 'Edge Function Secrets',
};

// Token con exceso de alcance → 422 key_rejected: no se guarda (E8) o la conexión queda en error (E9).
function errorSobra(sobra: string[]): ApiError {
  const nombres = sobra.map((p) => PERMISO_SOBRANTE[p] ?? p).join('; ');
  return new ApiError('key_rejected', `Ese token tiene permisos de más (${nombres}). Crea uno con alcance a este proyecto `
    + 'y solo Read en Project Settings, Advisors y Database.',
  { reason: sobra.includes('organizations_read') ? 'legacy_pat' : 'excess_scope', excess_permissions: sobra });
}

function exigirSondeo(s: Sondeo) {
  if (s.estado === 'rechazado') {
    throw new ApiError('provider_rejected', s.mensaje ?? 'El proveedor rechazó el token',
      { missing_permissions: s.faltan, ...(s.motivo ? { reason: s.motivo } : {}) });
  }
  if (s.estado === 'caido') throw new ApiError('provider_unavailable', s.mensaje ?? 'El proveedor no respondió');
}

async function leer(c: Context<AppEnv>, ids: string[]): Promise<ConnectionPublic[]> {
  const { data, error } = await db(c.env).from('connections').select(COLUMNAS).eq('org_id', c.get('orgId')).in('id', ids);
  if (error) {
    log('error', 'connections.leer_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos leer la conexión');
  }
  const filas = (data ?? []) as unknown as Fila[];
  return ids.map((id) => filas.find((f) => f.id === id)).filter((f): f is Fila => !!f).map(aPublica);
}

// E7 · GET /api/orgs/:org/connections · user · P0
connections.get('/orgs/:org/connections', async (c) => {
  const { data, error } = await db(c.env).from('connections').select(COLUMNAS).eq('org_id', c.get('orgId'))
    .order('created_at');
  if (error) {
    log('error', 'connections.lista_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos leer tus conexiones');
  }
  return c.json(((data ?? []) as unknown as Fila[]).map(aPublica));
});

// E8 · POST /api/orgs/:org/connections · admin · P0
connections.post('/orgs/:org/connections', requireAdmin, async (c) => {
  const body = await cuerpo(c, ConnectionCreate);
  const env = c.env;
  const admin = db(env);
  const orgId = c.get('orgId');
  const createdBy = c.get('userId');

  if (body.provider === 'ingest') {
    const secreto = newIngestSecret();
    const connectionId = crypto.randomUUID();
    await createConnectionWithSecret(env, admin, { orgId, connectionId, provider: 'ingest', kind: 'read', label: body.label,
      meta: body.purpose === 'cf_webhook' ? { purpose: 'cf_webhook' } : {}, scopes: [], capabilities: {}, expiresAt: null, createdBy }, secreto);
    const [conn] = await leer(c, [connectionId]);
    log('info', 'connection.creada', { rid: c.get('rid'), provider: 'ingest' });
    return c.json(ConnectionCreated.parse({ connection: conn, action_connection: null, checks: [], ingest_secret: secreto }), 201);
  }

  let sondeo: Sondeo;
  let token: string;
  let accion: { token: string; sondeo: Sondeo } | null = null;
  if (body.provider === 'supabase') {
    guardar('supabase', body.pat);
    const ref = normalizarRef(body.project_ref);
    if (!ref) {
      throw new ApiError('invalid_body', 'Revisa los campos marcados',
        { field_errors: { project_ref: ['Pega el ref de 20 letras, la URL de la API o la del panel de tu proyecto'] } });
    }
    token = body.pat.trim();
    sondeo = await probarSupabase(token, ref);
    if (sondeo.sobra?.length) throw errorSobra(sondeo.sobra);   // antes que cualquier otro veredicto: nada se guarda
  } else if (body.provider === 'cloudflare') {
    guardar('cloudflare', body.read_token, body.action_token);
    token = body.read_token.trim();
    if (body.action_token !== undefined && body.action_token.trim() === token) {
      throw new ApiError('key_rejected', 'Usa dos tokens distintos: uno de lectura y otro de acciones', { reason: 'same_token' });
    }
    sondeo = await probarCloudflareLectura(token, body.zone_id);
    if (sondeo.estado === 'ok' && body.action_token !== undefined) {
      const t = body.action_token.trim();
      accion = { token: t, sondeo: await probarCloudflareAcciones(t, body.zone_id, sondeo) };
    }
  } else {
    guardar('github', body.pat);
    token = body.pat.trim();
    if (!token.startsWith('github_pat_')) {
      throw new ApiError('invalid_body', 'Revisa los campos marcados',
        { field_errors: { pat: ['No parece un token fine-grained de GitHub (empieza por github_pat_).'] } });
    }
    const { count, error } = await admin.from('connections').select('id', { count: 'exact', head: true })
      .eq('org_id', orgId).eq('provider', 'github').eq('status', 'active');
    if (error) throw new ApiError('internal', 'No pudimos comprobar tus conexiones');
    if ((count ?? 0) > 0) throw new ApiError('conflict', 'Ya hay un repo conectado. Quítalo antes de conectar otro.');
    sondeo = await probarGithub(token, body.repo_full_name);
  }
  exigirSondeo(sondeo);
  if (accion) exigirSondeo(accion.sondeo);

  const ctx = (kind: 'read' | 'action'): SecretCtx => ({ orgId, connectionId: crypto.randomUUID(), provider: body.provider, kind });
  const lectura = ctx('read');
  await createConnectionWithSecret(env, admin, { ...lectura, label: sondeo.label, meta: sondeo.meta, scopes: sondeo.scopes,
    capabilities: sondeo.capabilities, expiresAt: sondeo.expiresAt, createdBy }, token);
  let accionId: string | null = null;
  if (accion) {
    const a = ctx('action');
    try {
      await createConnectionWithSecret(env, admin, { ...a, label: accion.sondeo.label, meta: accion.sondeo.meta,
        scopes: accion.sondeo.scopes, capabilities: accion.sondeo.capabilities, expiresAt: accion.sondeo.expiresAt, createdBy }, accion.token);
      accionId = a.connectionId;
    } catch (e) {
      // Si la segunda falla, se borra la primera: no queda nada a medias (§05.7).
      await admin.from('connections').delete().eq('id', lectura.connectionId).eq('org_id', orgId);
      throw e;
    }
  }
  const filas = await leer(c, accionId ? [lectura.connectionId, accionId] : [lectura.connectionId]);
  log('info', 'connection.creada', { rid: c.get('rid'), provider: body.provider, con_acciones: accionId !== null });
  return c.json(ConnectionCreated.parse({ connection: filas[0], action_connection: filas[1] ?? null,
    checks: [...sondeo.checks, ...(accion?.sondeo.checks ?? [])], ingest_secret: null }), 201);
});

// E9 · POST /api/orgs/:org/connections/:id/test · admin · P0 — re-sondea con el token descifrado.
connections.post('/orgs/:org/connections/:id/test', requireAdmin, async (c) => {
  const id = Id.safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError('not_found', 'Conexión no encontrada');
  const admin = db(c.env);
  const orgId = c.get('orgId');
  const { data: fila, error } = await admin.from('connections').select('id, provider, kind, meta')
    .eq('id', id.data).eq('org_id', orgId).maybeSingle();
  if (error) throw new ApiError('internal', 'No pudimos leer la conexión');
  if (!fila) throw new ApiError('not_found', 'Conexión no encontrada');
  const meta = (fila.meta ?? {}) as Record<string, unknown>;
  const ahora = new Date().toISOString();
  if (fila.provider === 'ingest') return c.json(ConnectionTest.parse({ ok: true, checks: [], checked_at: ahora }));

  const ctx: SecretCtx = { orgId, connectionId: fila.id, provider: fila.provider, kind: fila.kind };
  const sondeo = await withSecret(c.env, admin, ctx, async (t) => {
    if (fila.provider === 'supabase') return probarSupabase(t, String(meta.project_ref ?? ''));
    if (fila.provider === 'github') return probarGithub(t, String(meta.repo_full_name ?? ''));
    const zoneId = String(meta.zone_id ?? '');
    return fila.kind === 'action'
      ? probarCloudflareAcciones(t, zoneId, { estado: 'ok', faltan: [], checks: [], capabilities: {}, scopes: [], meta, label: '', expiresAt: null })
      : probarCloudflareLectura(t, zoneId);
  });
  const sobra = sondeo.sobra ?? [];
  const primerError = (sondeo.checks.find((x: PermCheck) => x.required && !x.ok)?.error_code) ?? null;
  // Con permisos de más la conexión queda en error (la auditoría solo usa las activas) y se responde key_rejected.
  const status = sobra.length ? 'error' : sondeo.estado === 'ok' ? 'active' : sondeo.motivo === 'unauthorized' ? 'revoked' : 'error';
  const lastError = sobra.length ? 'excess_scope' : sondeo.estado === 'ok' ? null : primerError ?? 'unavailable';
  const cambios: Record<string, unknown> = { status, last_checked_at: ahora, last_error: lastError };
  if (!sobra.length && sondeo.estado !== 'caido' && sondeo.checks.length > 1) {
    cambios.capabilities = sondeo.capabilities;
    cambios.scopes = sondeo.scopes;
  }
  const { error: eu } = await admin.from('connections').update(cambios).eq('id', fila.id).eq('org_id', orgId);
  if (eu) log('error', 'connections.test_guardar_error', { rid: c.get('rid'), code: eu.code });
  if (sobra.length) throw errorSobra(sobra);
  return c.json(ConnectionTest.parse({ ok: sondeo.estado === 'ok', checks: sondeo.checks, checked_at: ahora }));
});

// Bloqueos que E10 retira por petición (≈ 1 subpetición cada uno + 3): si hay más, se retiran estos y se responde 409.
export const MAX_DESHACER_E10 = 20;

// E10 · DELETE /api/orgs/:org/connections/:id · admin · P0 — borra fila y secreto (cascada).
connections.delete('/orgs/:org/connections/:id', requireAdmin, async (c) => {
  const id = Id.safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError('not_found', 'Conexión no encontrada');
  const admin = db(c.env);
  const orgId = c.get('orgId');
  const { data: fila, error } = await admin.from('connections').select('id, provider, kind')
    .eq('id', id.data).eq('org_id', orgId).maybeSingle();
  if (error) throw new ApiError('internal', 'No pudimos leer la conexión');
  if (!fila) throw new ApiError('not_found', 'Conexión no encontrada');
  if (fila.kind === 'action') {
    // Antes de borrar un token de acciones se deshacen (como E22) sus bloqueos executed; si alguno no se puede retirar,
    // 409 y no se borra nada (§05.8). Retirar toca Cloudflare: solo desde el host de producción (S15 15.3). Un
    // executeBlock en marcha (proposed reciente) aún no tiene previous.connection_id: también 409 hasta que termine.
    const [{ data: activas, error: ea }, enCurso] = await Promise.all([
      admin.from('actions').select('id, org_id, provider_ref, previous')
        .eq('org_id', orgId).eq('status', 'executed').eq('previous->>connection_id', fila.id).limit(MAX_DESHACER_E10 + 1),
      admin.from('actions').select('id').eq('org_id', orgId).eq('status', 'proposed')
        .gte('created_at', new Date(Date.now() - EN_CURSO_MS).toISOString()).limit(1),
    ]);
    if (ea || enCurso.error) throw new ApiError('internal', 'No pudimos comprobar los bloqueos de esta conexión');
    if (Array.isArray(enCurso.data) && enCurso.data.length) {
      throw new ApiError('conflict', 'Se está aplicando un bloqueo ahora mismo. Vuelve a intentarlo en un minuto.', { reason: 'block_in_progress' });
    }
    const lista = (Array.isArray(activas) ? activas : []) as { id: string; org_id: string; provider_ref: string | null; previous: unknown }[];
    if (lista.length) {
      if (!esHostProduccion(c)) throw new ApiError('conflict', 'Hay bloqueos activos: quítalos desde officialvanguard.com antes de borrar este token');
      const tanda = lista.slice(0, MAX_DESHACER_E10);
      const { resultados } = await deshacerBloqueos(c.env, tanda, { rid: c.get('rid') });
      const fallidos = tanda.filter((a) => resultados.get(a.id) !== 'deshecho').length;
      log('info', 'connection.bloqueos_retirados', { rid: c.get('rid'), retirados: tanda.length - fallidos, fallidos });
      if (fallidos) throw new ApiError('conflict', 'Hay bloqueos activos que no pudimos retirar', { reason: 'unblock_failed' });
      if (lista.length > tanda.length) throw new ApiError('conflict', 'Quedan bloqueos activos por retirar. Vuelve a intentarlo.', { reason: 'unblock_pending' });
    }
  }
  const { error: ed } = await admin.from('connections').delete().eq('id', fila.id).eq('org_id', orgId);
  if (ed) throw new ApiError('internal', 'No pudimos borrar la conexión');
  log('info', 'connection.borrada', { rid: c.get('rid'), provider: fila.provider });
  const revoke = REVOKE_URL[fila.provider];
  if (revoke) c.header('X-VG-Revoke-Url', revoke);
  return c.body(null, 204);
});
