import { Hono, type Context } from 'hono';
import { ConfirmBody, Id, ProposeAction, RespuestaEscritura } from '@vanguard/contracts';
import { otpHashParam } from '@vanguard/core';
import {
  COLUMNAS_INCIDENTE_BLOQUEO, leerIncidenteBloqueo, MAX_INTENTOS, proponerBloqueo, type SinEntrega,
} from '../actions/approvals.ts';
import { deshacerBloqueos, executeBlock, MENSAJE_DESHACER, type AprobacionCanjeada } from '../actions/block-ip.ts';
import { deshacerBajoAtaque, executeUnderAttack, MENSAJE_DESHACER_BAJO_ATAQUE } from '../actions/under-attack.ts';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError, fail } from '../lib/errors.ts';
import { activeKid, getKeys } from '../lib/keyring.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';
import { requireProdHost } from '../mw/prod-host.ts';

// E20 · POST actions/propose, E21 · POST actions/:approvalId/confirm y E22 · POST actions/:actionId/undo · admin · solo
// officialvanguard.com · P0 (S15 15.4, §08.8, §12.9). propose nunca toca Cloudflare: simula y crea las aprobaciones de
// 10 min; confirm canjea el código de 6 dígitos (HMAC con la FPK, máx. 5 intentos) y ejecuta executeBlock, el mismo que
// usa el botón ok de WhatsApp; undo borra la regla. Anti-IDOR: aprobación y acción se leen por id Y org_id (otra org → 404).
// E21 y E22 despachan por tipo en la primera línea (modo-bajo-ataque.md §5): under_attack_on va a confirmarBajoAtaque y a
// deshacerModoBajoAtaque (abajo); la rama block_ip no cambia. Proponer el modo bajo ataque es E56 (rutas/bajo-ataque.ts).
export const actions = new Hono<AppEnv>();

type Fila = Record<string, unknown>;
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const KID = /^v\d{1,4}$/;

const MENSAJE_IP: Record<string, string> = {
  not_an_ip: 'Eso no es una IP suelta',
  private_ip: 'Es una IP privada o reservada: no se bloquea en Cloudflare',
  documentation_range: 'Es una IP de documentación: no existe en internet',
  own_ip: 'Es tu propia IP: te dejarías fuera',
  allowlisted: 'Esa IP está en tu lista de permitidas',
  range_too_wide: 'Solo se bloquean IP sueltas (/32 o /128)',
  cloudflare_ip: 'Es una IP de Cloudflare: bloquearla cortaría tu propio tráfico',
};
export const MENSAJE_ENTREGA: Record<SinEntrega, string> = {
  sin_contacto: 'Añade un contacto con WhatsApp para recibir el código',
  sin_verificar: 'Verifica tu contacto de WhatsApp para recibir el código',
  ventana: 'Escribe cualquier mensaje a VanGUARD desde tu WhatsApp y vuelve a intentarlo',
  dry_run: 'El envío por WhatsApp solo funciona en officialvanguard.com',
  sin_config: 'El envío por WhatsApp no está configurado en el servidor',
  kapso: 'No pudimos enviarte el código por WhatsApp. Vuelve a intentarlo.',
};

// RL_COSTLY (§06.9, P1): 10 por minuto con la clave dada.
export async function limitar(c: Context<AppEnv>, key: string) {
  const { success } = await c.env.RL_COSTLY.limit({ key });
  if (!success) {
    c.header('Retry-After', '60');
    return fail(c, 'rate_limited', 'Demasiados intentos seguidos. Espera un minuto.');
  }
  return null;
}

const idDe = (raw: string | undefined, mensaje: string) => {
  const r = Id.safeParse(raw);
  if (!r.success) throw new ApiError('not_found', mensaje);
  return r.data;
};

actions.post('/orgs/:org/actions/propose', requireAdmin, requireProdHost, async (c) => {
  const limitado = await limitar(c, `u:${c.get('userId')}`);
  if (limitado) return limitado;
  const body = await cuerpo(c, ProposeAction);
  // ActionKind ya trae los tipos del check de §05; P0 solo implementa block_ip con mode block (§08.8).
  if (body.kind !== 'block_ip') {
    throw new ApiError('invalid_body', 'Esa acción todavía no está disponible', { field_errors: { kind: ['Solo block_ip por ahora'] } });
  }
  if (body.mode !== 'block') {
    throw new ApiError('invalid_body', 'Desafiar la IP todavía no está disponible', { field_errors: { mode: ['Solo block por ahora'] } });
  }
  const orgId = c.get('orgId');
  const rid = c.get('rid');
  const { data, error } = await db(c.env).from('incidents').select(COLUMNAS_INCIDENTE_BLOQUEO)
    .eq('id', body.incident_id).eq('org_id', orgId).maybeSingle();
  if (error) {
    log('error', 'accion.incidente_error', { rid, code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer el incidente');
  }
  const incidente = leerIncidenteBloqueo(data);
  if (!incidente) throw new ApiError('not_found', 'Incidente no encontrado');

  const r = await proponerBloqueo(c.env, { orgId, incidente, target: body.target, connectionId: body.connection_id, rid,
    entrega: 'app', requestedBy: c.get('userId'), ipOperador: c.req.header('cf-connecting-ip') ?? null });
  if (!r.ok) {
    if (r.motivo === 'ip') throw new ApiError('invalid_body', MENSAJE_IP[r.reason] ?? 'No se puede bloquear esa IP', { reason: r.reason });
    if (r.motivo === 'sin_conexion') throw new ApiError('conflict', 'Activa el Modo blindaje con un token de acciones', { reason: 'no_action_connection' });
    if (r.motivo === 'ya_bloqueada') throw new ApiError('conflict', 'Esa IP ya está bloqueada', { reason: 'already_blocked', action_id: r.action_id });
    log('warn', 'accion.propuesta_sin_entrega', { rid, incidente: incidente.code, motivo: r.detalle });
    throw new ApiError('provider_unavailable', MENSAJE_ENTREGA[r.detalle], { reason: r.detalle });
  }
  log('info', 'accion.propuesta', { rid, user: c.get('userId'), incidente: incidente.code, delivery: r.respuesta.delivery,
    recipient_masked: r.recipient_masked });
  return c.json(r.respuesta);
});

// 0 filas en el canje → motivo, releyendo por id Y org_id (H9 de §14): usada, vencida, quemada o código malo.
async function motivoSinCanje(c: Context<AppEnv>, id: string): Promise<never> {
  const { data, error } = await db(c.env).from('approvals').select('attempts, expires_at, used_at')
    .eq('id', id).eq('org_id', c.get('orgId')).maybeSingle();
  if (error || !data) {
    log('error', 'accion.relectura_error', { rid: c.get('rid'), code: error?.code ?? null });
    throw new ApiError('internal', 'No pudimos comprobar el código');
  }
  const f = data as Fila;
  const intentos = typeof f.attempts === 'number' ? f.attempts : MAX_INTENTOS;
  // «Vuelve a proponerlo»: sirve al bloqueo de IP y al modo bajo ataque.
  if (str(f.used_at)) throw new ApiError('conflict', 'Ese código ya se usó. Vuelve a proponerlo.', { reason: 'used' });
  if (Date.parse(str(f.expires_at) ?? '') <= Date.now()) throw new ApiError('conflict', 'El código venció. Vuelve a proponerlo.', { reason: 'expired' });
  if (intentos >= MAX_INTENTOS) throw new ApiError('conflict', 'Demasiados intentos: vuelve a proponerlo.', { reason: 'locked' });
  throw new ApiError('invalid_body', 'Código incorrecto', { reason: 'wrong_code', attempts_left: MAX_INTENTOS - intentos });
}

actions.post('/orgs/:org/actions/:approvalId/confirm', requireAdmin, requireProdHost, async (c) => {
  const id = idDe(c.req.param('approvalId'), 'Aprobación no encontrada');
  const { code } = await cuerpo(c, ConfirmBody);
  const limitado = await limitar(c, `otp:${id}`);
  if (limitado) return limitado;
  const admin = db(c.env);
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const rid = c.get('rid');
  // Pre-lectura (§06.7): sin ella, alguien de otra org que conozca el uuid quemaría la aprobación con 5 intentos.
  const pre = await admin.from('approvals').select('id, action_kind, params, expires_at, used_at, attempts')
    .eq('id', id).eq('org_id', orgId).eq('channel', 'in_app').eq('recipient', userId).maybeSingle();
  if (pre.error) {
    log('error', 'accion.aprobacion_error', { rid, code: pre.error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer la aprobación');
  }
  const previa = pre.data as Fila | null;
  if (previa?.action_kind === 'under_attack_on') return confirmarBajoAtaque(c, id, code, previa);
  if (!previa || previa.action_kind !== 'block_ip') throw new ApiError('not_found', 'Aprobación no encontrada');
  // El kid con el que se firmó el código va en params: una rotación de la KEK en esos 10 min no lo invalida.
  const kid = str((previa.params as Fila | null)?.kid);
  const keys = await getKeys(c.env, admin, kid && KID.test(kid) ? kid : await activeKid(admin));
  const { data, error } = await admin.rpc('vg_redeem_approval',
    { p_approval: id, p_nonce_hash: await otpHashParam(keys, id, code), p_recipient: userId });
  if (error) {
    log('error', 'accion.canje_error', { rid, code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos comprobar el código');
  }
  const fila = (Array.isArray(data) ? data[0] : data) as Fila | null | undefined;
  if (!fila || fila.id !== id) return motivoSinCanje(c, id);

  const x = await executeBlock(c.env, fila as unknown as AprobacionCanjeada, { rid });
  log('info', 'accion.confirmada', { rid, user: userId, resultado: x.tipo, action_id: 'action_id' in x ? x.action_id : null });
  if (x.tipo === 'ejecutado') return c.json(RespuestaEscritura.parse({ ok: true, resultado: x.resultado, en: x.en, action_id: x.action_id }));
  if (x.tipo === 'rechazado') {
    return c.json(RespuestaEscritura.parse({ ok: false, error: x.error, ...(x.action_id ? { action_id: x.action_id } : {}) }));
  }
  if (x.tipo === 'caido') throw new ApiError('provider_unavailable', 'Cloudflare no respondió. Vuelve a proponer el bloqueo.');
  if (x.tipo === 'en_curso') throw new ApiError('conflict', 'Ese bloqueo ya se está aplicando', { reason: 'in_progress', action_id: x.action_id });
  log('error', 'accion.params_invalidos', { rid });
  throw new ApiError('internal', 'La aprobación está incompleta. Vuelve a proponer el bloqueo.');
});

actions.post('/orgs/:org/actions/:actionId/undo', requireAdmin, requireProdHost, async (c) => {
  const id = idDe(c.req.param('actionId'), 'Acción no encontrada');
  const orgId = c.get('orgId');
  const rid = c.get('rid');
  const { data, error } = await db(c.env).from('actions').select('id, org_id, kind, status, provider_ref, previous')
    .eq('id', id).eq('org_id', orgId).maybeSingle();
  if (error) {
    log('error', 'accion.lectura_error', { rid, code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer la acción');
  }
  const accion = data as Fila | null;
  if (accion?.kind === 'under_attack_on') return deshacerModoBajoAtaque(c, id, accion);
  if (!accion || accion.kind !== 'block_ip') throw new ApiError('not_found', 'Acción no encontrada');
  if (accion.status === 'undone') throw new ApiError('conflict', 'Ese bloqueo ya estaba retirado', { reason: 'undone' });
  // failed con provider_ref y previous = la caducidad no pudo retirar la regla (housekeeping): se puede reintentar aquí.
  const sinRetirar = accion.status === 'failed' && str(accion.provider_ref) !== null
    && typeof accion.previous === 'object' && accion.previous !== null;
  if (accion.status !== 'executed' && !sinRetirar) throw new ApiError('conflict', 'No hay ningún bloqueo activo que retirar', { reason: 'not_executed' });

  const { resultados } = await deshacerBloqueos(c.env, [{ id, org_id: orgId, provider_ref: str(accion.provider_ref),
    previous: accion.previous }], { rid });
  const r = resultados.get(id) ?? 'invalido';
  log('info', 'accion.deshacer', { rid, user: c.get('userId'), action_id: id, resultado: r });
  if (r === 'deshecho') return c.json(RespuestaEscritura.parse({ ok: true, resultado: 'Bloqueo retirado', en: new Date().toISOString() }));
  if (r === 'caido') throw new ApiError('provider_unavailable', MENSAJE_DESHACER.caido);
  // Permiso, token, credencial u otro 4xx: la fila no cambia (se puede reintentar al arreglar el token).
  return c.json(RespuestaEscritura.parse({ ok: false, error: MENSAJE_DESHACER[r] }));
});

// ── Modo bajo ataque en E21 y E22 (modo-bajo-ataque.md §5) ─────────────────────────────────────────────────────────────
// E21 · under_attack_on: el mismo canje que el bloqueo (kid de params, HMAC con la FPK, 5 intentos, un solo uso) y
// executeUnderAttack, el que llamará también el «Sí, activar» del botón de WhatsApp. ≈ 14–16 subpeticiones.
async function confirmarBajoAtaque(c: Context<AppEnv>, id: string, code: string, previa: Fila) {
  const admin = db(c.env);
  const userId = c.get('userId');
  const rid = c.get('rid');
  const kid = str((previa.params as Fila | null)?.kid);
  const keys = await getKeys(c.env, admin, kid && KID.test(kid) ? kid : await activeKid(admin));
  const { data, error } = await admin.rpc('vg_redeem_approval',
    { p_approval: id, p_nonce_hash: await otpHashParam(keys, id, code), p_recipient: userId });
  if (error) {
    log('error', 'accion.canje_error', { rid, code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos comprobar el código');
  }
  const fila = (Array.isArray(data) ? data[0] : data) as Fila | null | undefined;
  if (!fila || fila.id !== id) return motivoSinCanje(c, id);

  const x = await executeUnderAttack(c.env, fila as unknown as AprobacionCanjeada, { rid });
  log('info', 'accion.bajo_ataque_confirmado', { rid, user: userId, resultado: x.tipo,
    action_id: 'action_id' in x ? x.action_id : null });
  if (x.tipo === 'ejecutado') {
    return c.json(RespuestaEscritura.parse({ ok: true, resultado: x.resultado, en: x.en, action_id: x.action_id }));
  }
  if (x.tipo === 'rechazado') {
    return c.json(RespuestaEscritura.parse({ ok: false, error: x.error, ...(x.action_id ? { action_id: x.action_id } : {}) }));
  }
  if (x.tipo === 'caido') throw new ApiError('provider_unavailable', 'Cloudflare no respondió. Vuelve a proponerlo.');
  if (x.tipo === 'en_curso') {
    throw new ApiError('conflict', 'El modo bajo ataque se está activando ahora mismo', { reason: 'in_progress', action_id: x.action_id });
  }
  log('error', 'accion.params_invalidos', { rid });
  throw new ApiError('internal', 'La aprobación está incompleta. Vuelve a proponerlo.');
}

// E22 · under_attack_on: DELETE de la regla de configuración (deshacerBajoAtaque). Admite la failed que la caducidad no
// pudo retirar (provider_ref y previous), como el bloqueo. 5 subpeticiones.
async function deshacerModoBajoAtaque(c: Context<AppEnv>, id: string, accion: Fila) {
  const rid = c.get('rid');
  if (accion.status === 'undone') throw new ApiError('conflict', 'El modo bajo ataque ya estaba desactivado', { reason: 'undone' });
  const sinRetirar = accion.status === 'failed' && str(accion.provider_ref) !== null
    && typeof accion.previous === 'object' && accion.previous !== null;
  if (accion.status !== 'executed' && !sinRetirar) {
    throw new ApiError('conflict', 'No hay ningún modo bajo ataque activo que retirar', { reason: 'not_executed' });
  }
  const { resultados } = await deshacerBajoAtaque(c.env, [{ id, org_id: c.get('orgId'), provider_ref: str(accion.provider_ref),
    previous: accion.previous }], { rid });
  const r = resultados.get(id) ?? 'invalido';
  log('info', 'accion.bajo_ataque_deshacer', { rid, user: c.get('userId'), action_id: id, resultado: r });
  if (r === 'deshecho') {
    return c.json(RespuestaEscritura.parse({ ok: true, resultado: 'Modo bajo ataque desactivado', en: new Date().toISOString() }));
  }
  if (r === 'caido') throw new ApiError('provider_unavailable', MENSAJE_DESHACER_BAJO_ATAQUE.caido);
  return c.json(RespuestaEscritura.parse({ ok: false, error: MENSAJE_DESHACER_BAJO_ATAQUE[r] }));
}
