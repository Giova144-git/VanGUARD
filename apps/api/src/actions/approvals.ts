// Botones de WhatsApp (S12 12.6, S15 15.10). Hoy solo el parser; el nonce, el canje con vg_redeem_approval y la
// ejecución de ack/snz/blk/ok/no llegan con el hito 5.
export type AccionBoton = 'ack' | 'snz' | 'ok' | 'no' | 'blk';
export type Boton = { accion: AccionBoton; codigo: string; nonce: string };

// Misma regex que S15 15.10. Nonce de 16–43 car. base64url. blk lanza un propose (E20), nunca un bloqueo directo.
const BOTON = /^(ack|snz|ok|no|blk):([A-Z0-9]{6}):([A-Za-z0-9_-]{16,43})$/;

export function parsearBoton(p: string): Boton | null {
  const m = BOTON.exec(p);
  return m ? { accion: m[1] as AccionBoton, codigo: m[2]!, nonce: m[3]! } : null;
}
