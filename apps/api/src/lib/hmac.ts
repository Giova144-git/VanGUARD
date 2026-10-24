// Comparaciones de secretos en tiempo constante con WebCrypto estándar (corre igual en Workers y en Node 24).
const enc = new TextEncoder();

// Compara los SHA-256 de las dos cadenas: misma longitud siempre y sin cortar en el primer byte distinto.
export async function igualesCt(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= (u[i] ?? 0) ^ (v[i] ?? 0);
  return d === 0;
}

// Hex de 2·n caracteres → n bytes, o null si no es hex o no mide eso (sin lanzar: es entrada de un tercero).
export function hexABytes(hex: string, n: number): Uint8Array<ArrayBuffer> | null {
  if (hex.length !== n * 2 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Firma HMAC-SHA256 en hex sobre el cuerpo CRUDO (Kapso: X-Webhook-Signature; E31, S15 15.4). crypto.subtle.verify
// compara en tiempo constante; sin secreto o con una firma ilegible → false (falla cerrada, nunca se acepta sin verificar).
export async function verificarHmacHex(secreto: string | undefined, cuerpo: ArrayBuffer | string,
  firmaHex: string | null | undefined): Promise<boolean> {
  if (!secreto || !firmaHex) return false;
  const firma = hexABytes(firmaHex.trim().replace(/^sha256=/i, ''), 32);
  if (!firma) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, firma, typeof cuerpo === 'string' ? enc.encode(cuerpo) : cuerpo);
}

export async function sha256Hex(datos: ArrayBuffer | string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', typeof datos === 'string' ? enc.encode(datos) : datos);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}
