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
