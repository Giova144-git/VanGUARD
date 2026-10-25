// Tokens vgk_ del MCP propio (S13 §13.7): 'vgk_' + base64url de 32 bytes aleatorios sin relleno (43 car.). En la base
// solo va sha256 hex del token completo y sus 4 últimos caracteres; el token sale una sola vez, en la respuesta de E29.
export const TOKEN_RE = /^vgk_[A-Za-z0-9_-]{43}$/;

export function nuevoToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return 'vgk_' + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}
