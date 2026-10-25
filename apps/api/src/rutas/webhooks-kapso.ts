import { Hono, type Context } from 'hono';
import { redact, textoSeguro, unaLinea } from '@vanguard/core';
import {
  canjearBotonAlerta, canjearBotonBloqueo, canjearBotonRevision, COSTE_BOTON_BLOQUEO, COSTE_BOTON_REVISION, parsearBoton,
  type AccionBoton, type Boton,
} from '../actions/approvals.ts';
import {
  canjearBotonPropuesta, confirmarEscritura, COSTE_BOTON_CONFIRMACION, COSTE_BOTON_PROPUESTA,
} from '../actions/botones-escritura.ts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { fail } from '../lib/errors.ts';
import { igualesCt, sha256Hex, verificarHmacHex } from '../lib/hmac.ts';
import { log } from '../lib/log.ts';
import { BAJA, clavesVerificacion, codigoConClaves, VERIFICAR } from '../lib/verificacion.ts';
import { enmascararTelefono, enviarTexto, KapsoError } from '../notify/kapso.ts';

// E31 · POST /webhooks/kapso · firma de Kapso · P0 (S15 15.4 y 15.10). Orden: cuerpo crudo → HMAC en tiempo constante
// ANTES de parsear (firma mala o sin secreto → 401 sin efecto) → dedupe por X-Idempotency-Key en webhook_events →
// 200 inmediato (Kapso exige 200 en ≤ 10 s) y el proceso sigue en waitUntil. Entrantes (asignaciones/back-whatsapp-real.md
// B3): cualquiera registra wa_last_inbound_at; botón → canje (registro ACCIONES por id del botón, con los del anexo
// avisos-whatsapp-botones.md); «VERIFICAR <código>» y «BAJA/STOP/SALIR» → contacts.
export const webhooksKapso = new Hono<AppEnv>();

type Obj = Record<string, unknown>;
type Estado = 'sent' | 'delivered' | 'read' | 'failed';

const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const lista = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

const ESTADO_DE_EVENTO: Record<string, Estado> = {
  'whatsapp.message.sent': 'sent',
  'whatsapp.message.delivered': 'delivered',
  'whatsapp.message.read': 'read',
  'whatsapp.message.failed': 'failed',
};
// Estados desde los que se puede pasar a cada uno: un delivered que llega después del read no lo deshace.
const DESDE: Record<Estado, string[]> = {
  sent: ['queued'],
  delivered: ['queued', 'sent'],
  read: ['queued', 'sent', 'delivered'],
  failed: ['queued', 'sent', 'delivered'],
};
const CLAVE_VALIDA = /^[\x21-\x7e]{1,200}$/;   // cabe en webhook_events.external_id (≤ 200)
const MAX_ITEMS = 100;
const MAX_CUERPO = 300;                        // del texto entrante solo se mira el principio
const MAX_CANDIDATOS = 20;                     // contactos con el mismo teléfono (uno por org como mucho)
const REMITENTE = /^[1-9][0-9]{7,14}$/;        // E.164 sin '+', como el `from` de Meta

// Subpeticiones por invocación: Workers Free admite 50; nos quedamos en 40 y una ya se fue en el dedupe. Cada paso
// reserva su peor caso antes de empezar (fetch con su reintento de red = 2, RL_WA = 1, cada consulta o rpc = 1); el
// número de candidatos no cuenta: sus códigos se calculan en memoria con una sola getKeys.
export const PRESUPUESTO = 40;
export type Presupuesto = { quedan: number; omitidos: number };
const COSTE = {
  estado: 1,       // update de notifications
  entrada: 1,      // update de contacts.wa_last_inbound_at
  boton: 4,        // vg_redeem_approval + incidente y contacto + update del incidente
  verificar: 6,    // getKeys + candidatos + (update + orgs + envío·2 | orgs + RL_WA + envío·2 | RL_WA + envío·2)
  baja: 4,         // update + RL_WA + envío·2
  bloqueo: COSTE_BOTON_BLOQUEO + 3,   // canje y propuesta de blk + RL_WA + envío·2 de la respuesta
  // ok/no: el canje sirve al bloqueo (executeBlock o cancelación) y a la confirmación de iss/rpr/uat (crearIssue,
  // reabrirPr o executeUnderAttack): se reserva el mayor de los dos + RL_WA + envío·2.
  confirmacion: Math.max(COSTE_BOTON_BLOQUEO, COSTE_BOTON_CONFIRMACION) + 3,
  revision: COSTE_BOTON_REVISION + 3, // canje, revisión, contacto y escrituras de fix/rvs + RL_WA + envío·2
  propuesta: COSTE_BOTON_PROPUESTA + 3,   // canje de iss/rpr/uat, guardas, filas ok/no e interactivo + RL_WA + envío·2
} as const;
function gastar(p: Presupuesto, n: number): boolean {
  if (p.quedan < n) {
    p.omitidos++;
    return false;
  }
  p.quedan -= n;
  return true;
}

// Con buffering (que va apagado) Kapso manda {data:[…]}; sin él, un evento por petición.
export function itemsDe(payload: unknown): Obj[] {
  const p = obj(payload);
  return (Array.isArray(p.data) ? p.data : [p]).slice(0, MAX_ITEMS).map(obj);
}

// id del botón: interactivo (message.interactive.button_reply.id) o botón de plantilla (message.button.payload).
export const idBoton = (m: Obj): string | null =>
  str(obj(obj(m.interactive).button_reply).id) ?? str(obj(m.button).payload);

// Código corto del error de entrega: message.kapso.statuses[].errors[].code (131047 = ventana de 24 h cerrada); de
// respaldo message.errors[].code. Solo [A-Za-z0-9_.-], nunca el mensaje del proveedor.
export function codigoError(m: Obj): string | null {
  const errores = [...lista(obj(m.kapso).statuses).flatMap((s) => lista(obj(s).errors)), ...lista(m.errors)];
  for (const e of errores.reverse()) {
    const code = obj(e).code;
    const s = typeof code === 'number' || typeof code === 'string' ? String(code) : '';
    if (/^[A-Za-z0-9_.-]{1,40}$/.test(s)) return s;
  }
  return null;
}

// Hora del estado según Kapso (epoch en segundos, como string) si es creíble; si no, la de recepción.
function instante(m: Obj, estado: Estado, ahora: number): string {
  const s = lista(obj(m.kapso).statuses).map(obj).find((x) => x.status === estado);
  const t = Number(s?.timestamp ?? NaN) * 1000;
  return Number.isFinite(t) && Math.abs(ahora - t) < 7 * 864e5 ? new Date(t).toISOString() : new Date(ahora).toISOString();
}

// Lo que se guarda en webhook_events.payload_redacted: una proyección mínima pasada por redact(), sin teléfonos, sin
// textos libres ni nonces (el payload crudo trae `conversation.phone_number`, que redact() no reconoce por clave).
export function resumenKapso(evento: string | null, payload: unknown) {
  return redact({
    event: evento,
    items: itemsDe(payload).slice(0, 20).map((it) => {
      const m = obj(it.message);
      const boton = idBoton(m);
      return { message_id: str(m.id), type: str(m.type), status: str(obj(m.kapso).status), error_code: codigoError(m),
        button: boton ? parsearBoton(boton)?.accion ?? 'desconocido' : null };
    }),
  });
}

async function actualizarEstado(env: CloudflareBindings, m: Obj, estado: Estado, rid: string) {
  const pid = str(m.id);
  if (!pid || pid.length > 120) return;
  const t = instante(m, estado, Date.now());
  const error = estado === 'failed' ? codigoError(m) ?? 'failed' : null;
  const cambio = estado === 'sent' ? { status: 'sent', sent_at: t }
    : estado === 'delivered' ? { status: 'delivered', delivered_at: t }
    : estado === 'read' ? { status: 'read', read_at: t }
    : { status: 'failed', error };
  // Sin org_id a propósito: el webhook no tiene org; el wamid de Kapso identifica la fila por sí solo.
  const { data, error: e } = await db(env).from('notifications').update(cambio)
    .eq('provider_id', pid).eq('channel', 'whatsapp').in('status', DESDE[estado]).select('id');
  if (e) {
    log('error', 'kapso.estado_error', { rid, estado, code: e.code });
    return;
  }
  log('info', 'kapso.estado', { rid, estado, filas: Array.isArray(data) ? data.length : 0, ...(error ? { error_code: error } : {}) });
}

// ── Textos de servicio (dentro de la ventana de 24 h: el usuario acaba de escribir) ─────────────────────────────────
// El de código no válido y el de la baja son iguales exista o no el teléfono en alguna org: no revelan nada.
export const textoListo = (org: string) =>
  `Listo: este WhatsApp recibirá alertas de seguridad de VanGUARD para "${org}". Para dejar de recibirlas escribe BAJA.`;
export const TEXTO_CODIGO_NO_VALIDO =
  'No pudimos verificar ese código. Envía el mensaje tal como aparece en Ajustes de VanGUARD e inténtalo de nuevo.';
export const TEXTO_BAJA =
  'Listo: este WhatsApp ya no recibirá alertas de seguridad de VanGUARD. Para volver a activarlas, verifícalo desde Ajustes.';

// URL con esquema, www.… o algo con forma de dominio (acme.com): WhatsApp los vuelve enlace.
const URL_EN_TEXTO = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*|[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.[a-z]{2,}\b\S*/giu;
const sinUrl = (s: string) => s.replace(URL_EN_TEXTO, ' ');

/** Nombre de la org para la confirmación: sin caracteres de formato (bidi, ancho cero), sin URL, redactado, en una
 *  línea de ≤ 40 y sin comillas dobles (va entre comillas). Vacío → «tu organización». */
export function nombreParaMensaje(nombre: string): string {
  const base = sinUrl(String(nombre).slice(0, 200).replace(/\p{Cf}/gu, ''));
  const t = unaLinea(sinUrl(textoSeguro(base, 40)).replace(/"/g, "'"), 40);
  return t || 'tu organización';
}

// ── Registro de acciones de botón por id (`accion:CODIGO:nonce`) ─────────────────────────────────────────────────
// Cada acción reserva su peor caso de subpeticiones antes de empezar y hace su canje. Un canje sin efecto (repetido,
// vencido, de otra org, remitente que no es contacto) queda en el log; las respuestas de servicio van con RL_WA: un botón
// viejo repetido no gasta cupo sin tope.
type Accion = {
  coste: number;
  ejecutar: (env: CloudflareBindings, b: Boton, remitente: string, rid: string, enmascarado: string | null) => Promise<void>;
};

// ack/snz (§15.10): canje del nonce y efecto sobre el incidente; no se contestan.
const ALERTA: Accion = {
  coste: COSTE.boton,
  async ejecutar(env, b, remitente, rid, enmascarado) {
    const resultado = await canjearBotonAlerta(env, b, remitente, rid);
    log(resultado === 'aplicado' ? 'info' : 'warn', 'kapso.boton_canje',
      { rid, accion: b.accion, codigo: b.codigo, resultado, remitente: enmascarado });
  },
};

// ok/no/blk (§12.9, S15 15.10): ok → executeBlock (el mismo de E21), no → cancela, blk → propone con entrega por
// WhatsApp. El ok/no de iss, rpr y uat se canjea aquí mismo y, por su action_kind, va a confirmarEscritura
// (actions/botones-escritura.ts): «Sí, crear», «Sí, reabrir» y «Sí, activar» con sus «Cancelar».
const BIEN_BLOQUEO = ['ejecutado', 'ya_estaba', 'cancelado', 'propuesto', 'issue_creado', 'pr_reabierto', 'bajo_ataque_activo',
  'ya_confirmado'];
const bloqueo = (coste: number): Accion => ({
  coste,
  async ejecutar(env, b, remitente, rid, enmascarado) {
    const c = await canjearBotonBloqueo(env, b, remitente, rid, undefined, confirmarEscritura);
    log(BIEN_BLOQUEO.includes(c.resultado) ? 'info' : 'warn', 'kapso.bloqueo_canje',
      { rid, accion: b.accion, codigo: b.codigo, resultado: c.resultado, remitente: enmascarado });
    if (c.texto) await responderConTope(env, remitente, c.texto, `bloqueo_${b.accion}`, rid);
  },
});
const BLOQUEO = bloqueo(COSTE.bloqueo);
const CONFIRMACION = bloqueo(COSTE.confirmacion);

// fix/rvs (anexo de botones): «Enviarme el arreglo» y «Silenciar repo 1 h» del aviso de revisión. La respuesta («Hecho: …»
// o «No se pudo: …») solo va al remitente verificado de la org de la aprobación; sin canje, el aviso de botón vencido
// solo si es contacto verificado de alguna org (quien hizo BAJA no recibe nada).
const REVISION: Accion = {
  coste: COSTE.revision,
  async ejecutar(env, b, remitente, rid, enmascarado) {
    const c = await canjearBotonRevision(env, b, remitente, rid);
    log(['arreglo_enviado', 'silenciado'].includes(c.resultado) ? 'info' : 'warn', 'kapso.revision_canje',
      { rid, accion: b.accion, codigo: b.codigo, resultado: c.resultado, remitente: enmascarado });
    if (c.texto) await responderConTope(env, remitente, c.texto, `revision_${b.accion}`, rid);
  },
};

// iss («Crear issue»), rpr («Reabrir el PR») y uat («Modo bajo ataque»): escriben en sistemas del cliente, así que el
// botón solo pide (regla 2 del anexo): canje y guardas y, si casan, la confirmación «Sí, …» / «Cancelar» al remitente
// (esa es la respuesta). «No se pudo: …» o el botón vencido, solo al contacto verificado (con RL_WA).
const PROPUESTA: Accion = {
  coste: COSTE.propuesta,
  async ejecutar(env, b, remitente, rid, enmascarado) {
    const c = await canjearBotonPropuesta(env, b, remitente, rid);
    log(c.resultado === 'propuesto' ? 'info' : 'warn', 'kapso.escritura_canje',
      { rid, accion: b.accion, codigo: b.codigo, resultado: c.resultado, remitente: enmascarado });
    if (c.texto) await responderConTope(env, remitente, c.texto, `escritura_${b.accion}`, rid);
  },
};

const ACCIONES: Readonly<Record<AccionBoton, Accion>> = {
  ack: ALERTA, snz: ALERTA, ok: CONFIRMACION, no: CONFIRMACION, blk: BLOQUEO, fix: REVISION, rvs: REVISION,
  iss: PROPUESTA, rpr: PROPUESTA, uat: PROPUESTA,
};

async function registrarBoton(env: CloudflareBindings, m: Obj, remitente: string, rid: string, p: Presupuesto) {
  const b = parsearBoton(idBoton(m) ?? '');
  const enmascarado = remitente.length >= 8 ? enmascararTelefono(remitente) : null;
  log('info', 'kapso.boton', { rid, accion: b?.accion ?? 'desconocido', codigo: b?.codigo ?? null, remitente: enmascarado });
  if (!b) return;
  const accion = ACCIONES[b.accion];
  if (!gastar(p, accion.coste)) return;
  await accion.ejecutar(env, b, remitente, rid, enmascarado);
}

// Cualquier entrante abre la ventana de 24 h de ese teléfono en TODAS las orgs (la ventana es por usuario y número de
// VanGUARD, no por org), en una sola sentencia.
async function registrarEntrada(env: CloudflareBindings, tel: string, rid: string) {
  const { data, error } = await db(env).from('contacts').update({ wa_last_inbound_at: new Date().toISOString() })
    .eq('phone_e164', `+${tel}`).select('id');
  if (error) log('error', 'kapso.entrada_error', { rid, code: error.code ?? null });
  else log('debug', 'kapso.entrada', { rid, filas: Array.isArray(data) ? data.length : 0 });
}

// Respuesta de servicio. Un fallo de Kapso se registra (código corto, nunca el texto) y no corta nada.
async function responder(env: CloudflareBindings, tel: string, texto: string, tipo: string, rid: string) {
  try {
    await enviarTexto(env, `+${tel}`, texto);
    log('info', 'kapso.respuesta', { rid, tipo, remitente: enmascararTelefono(tel) });
  } catch (e) {
    log('warn', 'kapso.respuesta_error', { rid, tipo, remitente: enmascararTelefono(tel),
      code: e instanceof KapsoError ? e.code : 'unavailable', detalle: e instanceof KapsoError ? e.detalle : null });
  }
}

// Las respuestas que cualquiera puede provocar (código malo, BAJA, repetición) llevan RL_WA: 3 por minuto y teléfono.
// Sin binding o si falla, no se responde (falla cerrada: cada respuesta gasta cupo).
async function responderConTope(env: CloudflareBindings, tel: string, texto: string, tipo: string, rid: string) {
  let pasa = false;
  try {
    pasa = (await env.RL_WA.limit({ key: `wa:${tel}` })).success;
  } catch {
    log('warn', 'kapso.rl_wa_error', { rid });
  }
  if (!pasa) {
    log('info', 'kapso.respuesta_limitada', { rid, tipo, remitente: enmascararTelefono(tel) });
    return;
  }
  await responder(env, tel, texto, tipo, rid);
}

async function nombreDeOrg(env: CloudflareBindings, org: string, rid: string): Promise<string> {
  const { data, error } = await db(env).from('orgs').select('name').eq('id', org).maybeSingle();
  if (error) log('warn', 'kapso.org_error', { rid, code: error.code ?? null });
  return nombreParaMensaje(str(obj(data).name) ?? '');
}

// «VERIFICAR <código>». Quien prueba ser dueño del teléfono es el `from` (lo autentica Meta); el código solo dice QUÉ
// contacto: es un HMAC con el org_id dentro, así que se recalcula el de CADA contacto con ese teléfono (todas las orgs)
// con UNA getKeys y se compara en tiempo constante. Los ya verificados entran en la búsqueda solo para que repetir el
// mensaje sea idempotente: sus fechas no se tocan y se vuelve a confirmar (con RL_WA).
async function verificar(env: CloudflareBindings, tel: string, propuesto: string, rid: string) {
  const admin = db(env);
  const e164 = `+${tel}`;
  const remitente = enmascararTelefono(tel);
  const { data, error } = await admin.from('contacts').select('id, org_id, verified_at')
    .eq('phone_e164', e164).eq('whatsapp', true).limit(MAX_CANDIDATOS);
  if (error) {
    log('error', 'kapso.verificar_error', { rid, paso: 'candidatos', code: error.code ?? null });
    return;
  }
  const candidatos = (Array.isArray(data) ? data : []).map(obj);
  let casa: { id: string; org: string; verificado: boolean } | null = null;
  if (candidatos.length) {
    let keys: Awaited<ReturnType<typeof clavesVerificacion>>;
    try {
      keys = await clavesVerificacion(env, admin);
    } catch (e) {
      log('error', 'kapso.verificar_error', { rid, paso: 'claves', name: e instanceof Error ? e.name : typeof e });
      return;
    }
    const codigo = propuesto.toUpperCase();
    for (const c of candidatos) {
      const id = str(c.id), org = str(c.org_id);
      if (id && org && await igualesCt(await codigoConClaves(keys, org, id), codigo)) {
        casa = { id, org, verificado: !!str(c.verified_at) };
        break;
      }
    }
  }
  if (!casa) {
    log('info', 'kapso.verificar', { rid, resultado: 'no_casa', remitente });
    await responderConTope(env, tel, TEXTO_CODIGO_NO_VALIDO, 'codigo_no_valido', rid);
    return;
  }
  if (casa.verificado) {
    log('info', 'kapso.verificar', { rid, resultado: 'ya_verificado', org_id: casa.org, remitente });
    await responderConTope(env, tel, textoListo(await nombreDeOrg(env, casa.org, rid)), 'listo', rid);
    return;
  }
  const t = new Date().toISOString();
  const u = await admin.from('contacts').update({ verified_at: t, optin_at: t })
    .eq('id', casa.id).eq('org_id', casa.org).eq('phone_e164', e164).is('verified_at', null).select('id');
  if (u.error) {
    log('error', 'kapso.verificar_error', { rid, paso: 'update', code: u.error.code ?? null });
    return;
  }
  if (!Array.isArray(u.data) || u.data.length === 0) {
    // Otro evento lo verificó entre la lectura y el update: ese ya respondió.
    log('info', 'kapso.verificar', { rid, resultado: 'carrera', org_id: casa.org, remitente });
    return;
  }
  log('info', 'kapso.verificar', { rid, resultado: 'verificado', org_id: casa.org, remitente });
  await responder(env, tel, textoListo(await nombreDeOrg(env, casa.org, rid)), 'listo', rid);
}

// «BAJA», «STOP» o «SALIR»: verified_at = null en TODAS las filas con ese teléfono (la política de Meta exige respetar
// cualquier baja). optin_at se conserva: es la evidencia histórica del consentimiento que hubo; un VERIFICAR nuevo lo
// reescribe. La confirmación es la misma haya filas o no.
async function darDeBaja(env: CloudflareBindings, tel: string, rid: string) {
  const { data, error } = await db(env).from('contacts').update({ verified_at: null }).eq('phone_e164', `+${tel}`).select('id');
  if (error) {
    log('error', 'kapso.baja_error', { rid, code: error.code ?? null });
    return;
  }
  log('info', 'kapso.baja', { rid, filas: Array.isArray(data) ? data.length : 0, remitente: enmascararTelefono(tel) });
  await responderConTope(env, tel, TEXTO_BAJA, 'baja', rid);
}

// whatsapp.message.received: 1) última entrada; 2) botón → canje; 3) texto → VERIFICAR o BAJA; el resto no se contesta.
async function procesarEntrante(env: CloudflareBindings, it: Obj, rid: string, p: Presupuesto) {
  const m = obj(it.message);
  const digitos = (str(m.from) ?? str(obj(it.conversation).phone_number) ?? '').replace(/\D/g, '');
  const tel = REMITENTE.test(digitos) ? digitos : null;
  if (!tel) log('info', 'kapso.sin_telefono', { rid, type: str(m.type) });   // p. ej. usuario con nombre de usuario
  else if (gastar(p, COSTE.entrada)) await registrarEntrada(env, tel, rid);

  if (idBoton(m)) {
    await registrarBoton(env, m, digitos, rid, p);
    return;
  }
  if (!tel) return;
  const cuerpo = str(m.type) === 'text' ? (str(obj(m.text).body) ?? '').slice(0, MAX_CUERPO) : '';
  const v = VERIFICAR.exec(cuerpo);
  if (v) {
    if (gastar(p, COSTE.verificar)) await verificar(env, tel, v[1]!, rid);
  } else if (BAJA.test(cuerpo)) {
    if (gastar(p, COSTE.baja)) await darDeBaja(env, tel, rid);
  } else {
    log('debug', 'kapso.texto_ignorado', { rid, type: str(m.type) });   // cada respuesta gasta cupo: no se contesta
  }
}

// Proceso de un webhook ya verificado y deduplicado. Nunca lanza: corre en waitUntil.
export async function procesarKapso(env: CloudflareBindings, evento: string | null, payload: unknown, rid: string,
  p: Presupuesto = { quedan: PRESUPUESTO - 1, omitidos: 0 }) {
  for (const it of itemsDe(payload)) {
    try {
      if (evento === 'whatsapp.message.received') {
        await procesarEntrante(env, it, rid, p);
        continue;
      }
      const m = obj(it.message);
      const estado = evento ? ESTADO_DE_EVENTO[evento] : ESTADO_DE_EVENTO[`whatsapp.message.${String(obj(m.kapso).status)}`];
      if (!estado) log('debug', 'kapso.evento_ignorado', { rid, evento });
      else if (gastar(p, COSTE.estado)) await actualizarEstado(env, m, estado, rid);
    } catch (e) {
      log('error', 'kapso.proceso_error', { rid, name: e instanceof Error ? e.name : typeof e });
    }
  }
  if (p.omitidos) log('warn', 'kapso.presupuesto_agotado', { rid, omitidos: p.omitidos });
}

// waitUntil del Worker (y del doble de dev-node.ts); sin ExecutionContext, c.executionCtx lanza y se espera aquí.
function enSegundoPlano(c: Context<AppEnv>, p: Promise<unknown>): Promise<unknown> | undefined {
  try {
    c.executionCtx.waitUntil(p);
    return undefined;
  } catch {
    return p;
  }
}

webhooksKapso.post('/kapso', async (c) => {
  const rid = c.get('rid');
  const crudo = await c.req.arrayBuffer();
  if (!(await verificarHmacHex(c.env.KAPSO_WEBHOOK_SECRET, crudo, c.req.header('x-webhook-signature')))) {
    log('warn', 'kapso.firma_rechazada', { rid, con_secreto: !!c.env.KAPSO_WEBHOOK_SECRET });
    return fail(c, 'unauthorized', 'Firma no válida');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(crudo));
  } catch {
    return fail(c, 'invalid_body', 'El cuerpo no es JSON válido');
  }
  const evento = (c.req.header('x-webhook-event') ?? '').trim().slice(0, 80) || null;
  const cabecera = (c.req.header('x-idempotency-key') ?? '').trim();
  const clave = CLAVE_VALIDA.test(cabecera) ? cabecera : `sha256:${await sha256Hex(crudo)}`;

  const { error } = await db(c.env).from('webhook_events')
    .insert({ provider: 'kapso', external_id: clave, payload_redacted: resumenKapso(evento, payload) });
  if (error?.code === '23505') {
    log('info', 'kapso.duplicado', { rid, evento });
    return c.json({ ok: true });
  }
  if (error) {
    // 500: Kapso reintenta a los 10 s y a los 40 s; sin la fila de dedupe no se procesa nada.
    log('error', 'kapso.dedupe_error', { rid, code: error.code });
    return fail(c, 'internal', 'No pudimos registrar el evento');
  }
  await enSegundoPlano(c, procesarKapso(c.env, evento, payload, rid));
  return c.json({ ok: true });
});
