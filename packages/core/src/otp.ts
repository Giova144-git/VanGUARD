// packages/core/src/otp.ts (P0 · chat BACK con pruebas; revisa el ORQUESTADOR. S06 06.7, literal.
// Pruebas: 10^5 códigos, cada dígito de la primera posición entre 9 % y 11 %; otpHash determinista con las mismas Keys,
// distinto si cambia approvalId o code, y distinto de sha256hex(`${approvalId}:${code}`))
import type { Keys } from './crypto.ts';
const te = new TextEncoder();
export function sixDigitCode(): string {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while ((a[0] ?? 0) >= 4_294_000_000); // 4.294.000.000 = 4294 × 10^6: sin sesgo de módulo
  return String((a[0] ?? 0) % 1_000_000).padStart(6, '0');
}
/** HMAC-SHA256(FPK, 'otp|' + approvalId + '|' + code) en hex (64 car.). NUNCA sha256 a secas: con 10^6 códigos
 *  posibles se invierte en milisegundos leyendo approvals (decisión 3 de S05 05.14). */
export async function otpHash(keys: Keys, approvalId: string, code: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keys.fpk, te.encode(`otp|${approvalId}|${code}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}
/** Valor para p_nonce_hash: bytea en formato hex de Postgres ('\x…'), que PostgREST acepta como texto [no verificado: probar en accshmgmfrqrxubpuxcl con una aprobación de prueba]. */
export const otpHashParam = async (keys: Keys, approvalId: string, code: string) => '\\x' + await otpHash(keys, approvalId, code);
