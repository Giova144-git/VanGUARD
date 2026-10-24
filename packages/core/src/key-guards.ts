// Guardas de claves pegadas en Conexiones (S15 15.11, canónicas §10.3): rechazos antes de cualquier llamada al proveedor.
// Devuelven el motivo o null; nunca registran el valor.
export type KeyRejection = 'service_role' | 'sb_secret' | 'legacy_pat' | 'classic_github_pat' | 'global_api_key' | 'invalid_chars' | 'too_long';
export function guardKey(provider: 'supabase' | 'cloudflare' | 'github', raw: string): KeyRejection | null {
  const s = raw.trim();
  if (s.length > 400) return 'too_long';
  if (/[^\x21-\x7E]/.test(s)) return 'invalid_chars';                     // invisibles: además evitan cabeceras con el secreto en el error (R01 §9)
  if (/^sb_secret_/i.test(s)) return 'sb_secret';
  if (jwtRole(s) === 'service_role') return 'service_role';               // decodifica el payload sin verificar firma (R11 §4.2)
  if (/^gh[pousr]_/.test(s)) return 'classic_github_pat';
  if (/^cfk_/.test(s) || /^[0-9a-f]{37,45}$/.test(s)) return 'global_api_key';   // nueva con prefijo cfk_; antigua 37–45 hex [verificado: https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/]
  if (provider === 'supabase' && !s.startsWith('sbp_fc')) return 'legacy_pat';
  return null;
}
// multi_project: tras la guarda, si GET /v1/projects devuelve > 1 proyecto [no verificado] → 422 key_rejected

/** `role` del payload de un JWT (cabecera.payload[.firma]) SIN verificar la firma; null si no es un JWT legible. */
export function jwtRole(s: string): string | null {
  const partes = s.split('.');
  if (partes.length < 2 || partes.length > 3) return null;
  try {
    const b = (partes[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const role = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).role : undefined;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}
