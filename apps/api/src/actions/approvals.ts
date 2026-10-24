// Botones de WhatsApp (S12 12.6 y 12.9, S15 15.10): parser del id, nonces de un solo uso y canje de ack/snz. Cada botón
// es una fila de approvals con SOLO sha256(nonce) (el nonce viaja en el id del botón y no se guarda), recipient = teléfono
// sin '+' y 10 min de vida. El canje es atómico con vg_redeem_approval (0005). ok/no/blk llegan con el hito siguiente.
import { db } from '../lib/db.ts';
import { sha256Hex } from '../lib/hmac.ts';
import { log } from '../lib/log.ts';

export type AccionBoton = 'ack' | 'snz' | 'ok' | 'no' | 'blk';
export type Boton = { accion: AccionBoton; codigo: string; nonce: string };

// Misma regex que S15 15.10. Nonce de 16–43 car. base64url. blk lanza un propose (E20), nunca un bloqueo directo.
const BOTON = /^(ack|snz|ok|no|blk):([A-Z0-9]{6}):([A-Za-z0-9_-]{16,43})$/;

export function parsearBoton(p: string): Boton | null {
  const m = BOTON.exec(p);
  return m ? { accion: m[1] as AccionBoton, codigo: m[2]!, nonce: m[3]! } : null;
}

/** Vida de un botón de alerta (S15 15.10: expires_at = now() + 10 min, igual que el default de approvals). */
export const VIDA_BOTON_MS = 10 * 60_000;
/** «Silenciar 1 h» (S12 12.3). */
export const SILENCIO_BOTON_MS = 60 * 60_000;
/** approvals.action_kind de cada botón de la alerta (check de 0005: 'ack' y 'mute'). */
export const ACCION_APROBACION = { ack: 'ack', snz: 'mute' } as const;

/** 16 bytes aleatorios en base64url sin relleno (22 car.), como pide §12.6. */
export function nuevoNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** bytea por supabase-js: texto hex con prefijo \x (formato de entrada de bytea en PostgREST, S15 E20). */
export const aBytea = (hex: string) => '\\x' + hex;
export const hashNonce = async (nonce: string) => aBytea(await sha256Hex(nonce));

export type FilaBoton = {
  org_id: string; incident_id: string; action_kind: 'ack' | 'mute'; channel: 'whatsapp'; recipient: string;
  nonce_hash: string; expires_at: string; params: Record<string, unknown>;
};

/** Las filas de approvals de los botones ack y snz de UN mensaje. `recipient` = E.164 sin '+' (el `from` del webhook). */
export async function filasBotones(o: { org_id: string; incident_id: string; recipient: string;
  nonces: { ack: string; snz: string }; ahora?: number }): Promise<FilaBoton[]> {
  const expires_at = new Date((o.ahora ?? Date.now()) + VIDA_BOTON_MS).toISOString();
  return Promise.all((['ack', 'snz'] as const).map(async (b) => ({
    org_id: o.org_id, incident_id: o.incident_id, action_kind: ACCION_APROBACION[b], channel: 'whatsapp' as const,
    recipient: o.recipient, nonce_hash: await hashNonce(o.nonces[b]), expires_at, params: {},
  })));
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const REMITENTE = /^[1-9][0-9]{7,14}$/;

/** Por qué un botón ack/snz tuvo o no efecto (va al log; ninguno se contesta por WhatsApp en este hito). */
export type ResultadoBoton = 'aplicado' | 'sin_canje' | 'tipo_distinto' | 'otro_incidente' | 'no_contacto' | 'resuelto'
  | 'ya_ack' | 'remitente_invalido' | 'error';

/** E31 · ack/snz (S15 15.10): canje atómico del nonce (sha256, un solo uso, no caducado, recipient = remitente) y luego,
 *  con la org de la fila canjeada: el incidente debe ser de esa org y tener el código del botón, y el remitente un
 *  contacto verificado de esa org. Solo entonces ack → status 'ack', acked_at, acked_via 'whatsapp'; snz → muted_until
 *  = ahora + 1 h y details.muted_at. Cualquier otra cosa no tiene efecto. Nunca lanza. */
export async function canjearBotonAlerta(env: CloudflareBindings, b: Boton, remitente: string, rid: string,
  ahora = Date.now()): Promise<ResultadoBoton> {
  if (b.accion !== 'ack' && b.accion !== 'snz') return 'tipo_distinto';
  if (!REMITENTE.test(remitente)) return 'remitente_invalido';
  try {
    const admin = db(env);
    const { data, error } = await admin.rpc('vg_redeem_approval',
      { p_approval: null, p_nonce_hash: await hashNonce(b.nonce), p_recipient: remitente });
    if (error) {
      log('error', 'kapso.canje_error', { rid, code: error.code ?? null });
      return 'error';
    }
    // setof approvals: 0 filas = vencido, ya usado, de otro remitente o inexistente.
    const fila = obj(Array.isArray(data) ? data[0] : data);
    const org = str(fila.org_id), incidente = str(fila.incident_id);
    if (!org) return 'sin_canje';
    if (fila.channel !== 'whatsapp' || fila.action_kind !== ACCION_APROBACION[b.accion] || !incidente) return 'tipo_distinto';

    const [i, c] = await Promise.all([
      admin.from('incidents').select('id, code, status, acked_at, muted_until, details')
        .eq('id', incidente).eq('org_id', org).maybeSingle(),
      admin.from('contacts').select('id, verified_at').eq('org_id', org).eq('phone_e164', `+${remitente}`).maybeSingle(),
    ]);
    if (i.error || c.error) {
      log('error', 'kapso.boton_lectura_error', { rid, code: i.error?.code ?? c.error?.code ?? null });
      return 'error';
    }
    const inc = obj(i.data);
    if (str(inc.code) !== b.codigo) return 'otro_incidente';
    if (!str(obj(c.data).verified_at)) return 'no_contacto';
    const status = str(inc.status);
    if (!status || status === 'resolved') return 'resuelto';

    const t = new Date(ahora).toISOString();
    let cambio: Obj;
    if (b.accion === 'ack') {
      if (str(inc.acked_at)) return 'ya_ack';   // el primer ack es el del cronómetro: no se pisa
      // mitigated no retrocede a ack (open → ack → mitigated); solo gana acked_at.
      cambio = { status: status === 'open' ? 'ack' : status, acked_at: t, acked_via: 'whatsapp' };
    } else {
      // Un silencio más largo ya puesto (E19 admite hasta 24 h) no se acorta.
      const previo = Date.parse(str(inc.muted_until) ?? '');
      const hasta = Math.max(ahora + SILENCIO_BOTON_MS, Number.isFinite(previo) ? previo : 0);
      cambio = { muted_until: new Date(hasta).toISOString(), details: { ...obj(inc.details), muted_at: t } };
    }
    // Guarda por status: si housekeeping o E21 lo cambiaron entre la lectura y aquí, no se pisa.
    const { error: eu } = await admin.from('incidents').update(cambio)
      .eq('id', incidente).eq('org_id', org).eq('status', status);
    if (eu) {
      log('error', 'kapso.boton_update_error', { rid, code: eu.code ?? null });
      return 'error';
    }
    return 'aplicado';
  } catch (e) {
    log('error', 'kapso.boton_error', { rid, name: e instanceof Error ? e.name : typeof e });
    return 'error';
  }
}
