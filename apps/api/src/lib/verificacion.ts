import type { SupabaseClient } from '@supabase/supabase-js';
import type { Keys } from '@vanguard/core/crypto';
import { igualesCt } from './hmac.ts';
import { getKeys } from './keyring.ts';

// Verificación de contactos por WhatsApp (asignaciones/back-whatsapp-real.md B1, B3 y B5). E26 muestra el código y el
// enlace wa.me; E31 recibe «VERIFICAR <código>» desde el teléfono (el `from` lo autentica Meta; el código solo dice QUÉ
// contacto se verifica) y lo compara con casaCodigo. Nunca se registran el código ni el texto.

// kid FIJO, no el activo: rotar kek_active no invalida los códigos ya mostrados en Ajustes.
export const KID_VERIFICACION = 'v1';
export const VERIFICAR = /^\s*VERIFICAR\s+([0-9A-F]{6})\b/i;
export const BAJA = /^\s*(BAJA|STOP|SALIR)\b/i;
// Tope del prellenado oficial de wa.me (que ?text= tenga el mismo tope está sin verificar).
export const MAX_TEXTO_ENLACE = 140;
// Ventana de servicio de 24 h de Meta con 10 min de margen: fuera de ella solo sale una plantilla aprobada (131047).
export const VENTANA_MS = (23 * 60 + 50) * 60_000;

const CODIGO = /^[0-9A-F]{6}$/;
const NUMERO_VISIBLE = /^\d{8,15}$/;
const te = new TextEncoder();

/** 6 primeros hex, en mayúsculas, de HMAC-SHA256(fpk, 'contact|' + org + '|' + contacto). Con el org_id dentro, el
 *  mismo id en otra org da otro código. Pura: E26 la llama con UNA getKeys por petición. */
export async function codigoConClaves(keys: Pick<Keys, 'fpk'>, orgId: string, contactId: string): Promise<string> {
  const firma = new Uint8Array(await crypto.subtle.sign('HMAC', keys.fpk, te.encode(`contact|${orgId}|${contactId}`)));
  return Array.from(firma.subarray(0, 3), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function clavesVerificacion(env: CloudflareBindings, admin: SupabaseClient): Promise<Keys> {
  return getKeys(env, admin, KID_VERIFICACION);
}

export async function codigoVerificacion(env: CloudflareBindings, admin: SupabaseClient, orgId: string,
  contactId: string): Promise<string> {
  return codigoConClaves(await clavesVerificacion(env, admin), orgId, contactId);
}

/** ¿El código propuesto (de un mensaje entrante) es el de ese contacto? Mayúsculas y espacios no cuentan; la comparación
 *  va en tiempo constante. */
export async function casaCodigo(env: CloudflareBindings, admin: SupabaseClient, orgId: string, contactId: string,
  propuesto: string): Promise<boolean> {
  const esperado = await codigoVerificacion(env, admin, orgId, contactId);
  return igualesCt(esperado, propuesto.trim().toUpperCase());
}

/** Texto prellenado del enlace: el opt-in de Meta dice qué se acepta y nombra al negocio. Mide 99 caracteres. */
export function textoEnlace(codigo: string): string {
  if (!CODIGO.test(codigo)) throw new RangeError('VERIFICACION_CODIGO');
  return `VERIFICAR ${codigo}. Acepto recibir alertas de seguridad de VanGUARD en este WhatsApp. BAJA para salir`;
}

/** Número visible de VanGUARD (solo dígitos) para wa.me, o null si falta o no tiene forma de teléfono. */
export function numeroVisible(env: Pick<CloudflareBindings, 'KAPSO_DISPLAY_NUMBER'>): string | null {
  const n = env.KAPSO_DISPLAY_NUMBER ?? '';
  return NUMERO_VISIBLE.test(n) ? n : null;
}

export function enlaceVerificacion(numero: string, codigo: string): string {
  return `https://wa.me/${numero}?text=${encodeURIComponent(textoEnlace(codigo))}`;
}

/** ¿Se puede mandar un mensaje de servicio (no plantilla) a ese contacto? Sí si nos escribió hace ≤ 23 h 50 min, o
 *  siempre con KAPSO_SANDBOX='1' (en el sandbox el código de unión no llega como message.received). E27 y el despachador. */
export function ventanaAbierta(env: Pick<CloudflareBindings, 'KAPSO_SANDBOX'>, waLastInboundAt: unknown,
  ahora: number = Date.now()): boolean {
  if (env.KAPSO_SANDBOX === '1') return true;
  if (typeof waLastInboundAt !== 'string') return false;
  const t = Date.parse(waLastInboundAt);
  return Number.isFinite(t) && ahora - t <= VENTANA_MS;
}
