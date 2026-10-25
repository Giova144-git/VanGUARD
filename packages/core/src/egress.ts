// Lista de salida del Worker (S06 06.3): lib/http.ts del BACK llama a assertAllowedUrl() antes de cada fetch.
// Solo https:, host EXACTO de la lista (nada de sufijos) y sin credenciales en la URL. Sin zipball (A7): fuera
// codeload.github.com y www.cisa.gov, que solo usa la Edge Function vg-codebase con su propia lista.
export const HOSTS_SALIDA: readonly string[] = [
  'api.supabase.com',                // Management API del cliente (PAT sbp_fc)
  'api.cloudflare.com',              // tokens de lectura y de acciones del cliente
  'api.github.com',                  // repo acotado: /repos, git/trees y contents (A7.3)
  'raw.githubusercontent.com',       // DeepWiki: archivos crudos del commit exacto (paso `area`, <= 25 por paso)
  'api.osv.dev',
  'api.anthropic.com',
  'api.kapso.ai',
  'demo.officialvanguard.com',
  'accshmgmfrqrxubpuxcl.supabase.co', // <ref>.supabase.co propio (incluye functions/v1/vg-codebase)
  'api.elevenlabs.io',               // P1: la llamada va después de WhatsApp (A8)
  'www.googleapis.com',              // P1: PSI
  'api.twilio.com',                  // P1: plan B de voz (S15 15.10)
];
const PERMITIDOS = new Set(HOSTS_SALIDA);
// Servidor de voz (apps/voz en Render, asignaciones/llamada-ataque.md): su host sale de VOZ_URL y no se conoce aquí. Solo
// un subdominio de UNA etiqueta de onrender.com (nada de sufijos engañosos ni subdominios anidados).
export const HOST_VOZ = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onrender\.com$/;

/** Lanza si la URL no puede salir del Worker; si puede, devuelve la URL ya parseada. El mensaje nunca lleva la URL
 *  (podría traer un secreto en la query). */
export function assertAllowedUrl(url: string | URL): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('EGRESS_BLOCKED:url'); }
  if (u.protocol !== 'https:') throw new Error('EGRESS_BLOCKED:protocolo');
  if (u.username !== '' || u.password !== '') throw new Error('EGRESS_BLOCKED:credenciales');
  if (u.port !== '') throw new Error('EGRESS_BLOCKED:puerto');
  if (!PERMITIDOS.has(u.hostname) && !HOST_VOZ.test(u.hostname)) throw new Error('EGRESS_BLOCKED:host');
  return u;
}
