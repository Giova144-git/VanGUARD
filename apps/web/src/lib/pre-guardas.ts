// Pre-guardas en el navegador (S14 §14.10): bloquean ANTES de enviar las claves peligrosas, así la clave ni siquiera
// sale del navegador. La guarda del BACK (key-guards.ts) sigue siendo la autoridad y responde 422 key_rejected.
export type Rechazo = { titulo: string; explicacion: string };

const payloadJwt = (t: string) => { try { return JSON.parse(atob((t.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; } };

export function preGuardar(valor: string, proveedor: 'supabase' | 'cloudflare' | 'github'): Rechazo | null {
  const v = valor.trim();
  if (/[^\x21-\x7E]/.test(v)) return { titulo: 'Tiene espacios o caracteres raros', explicacion: 'Cópialo de nuevo desde el panel del proveedor.' };
  if (v.length < 20 || v.length > 400) return { titulo: 'Parece incompleto', explicacion: 'Copia el token entero desde el panel del proveedor.' };
  if (v.startsWith('sb_secret_') || (v.split('.').length === 3 && payloadJwt(v)?.role === 'service_role'))
    return { titulo: 'Esta es una clave secreta de Supabase', explicacion: 'Con ella se salta toda la seguridad (RLS) de tu base. VanGUARD nunca la pide y no la enviamos a ningún servidor. Crea un token de acceso con alcance de solo lectura (paso 2).' };
  if (/^gh[pousr]_/.test(v))
    return { titulo: 'Es un token clásico de GitHub', explicacion: 'Da acceso a todos tus repos y puede escribir. Crea uno fine-grained de un solo repo (paso 3).' };
  if (/^cfk_/.test(v) || /^[0-9a-f]{37,45}$/.test(v))   // formatos nueva y antigua (token-formats de Cloudflare)
    return { titulo: 'Parece tu Global API Key de Cloudflare', explicacion: 'Controla toda tu cuenta. Crea un API Token de solo lectura (paso 1).' };
  if (proveedor === 'supabase' && !v.startsWith('sbp_fc'))
    return { titulo: 'Ese token ve todos tus proyectos', explicacion: 'Crea uno con alcance a un solo proyecto y solo lectura: empieza por sbp_fc (paso 2).' };
  return null;
}

// project_ref: acepta https://<ref>.supabase.co, la URL del panel o el ref a secas (S14 §14.10, S07).
export function extraerProjectRef(entrada: string): string | null {
  const v = entrada.trim();
  const m = v.match(/^https?:\/\/([a-z]{20})\.supabase\.co\/?$/) ?? v.match(/supabase\.com\/dashboard\/project\/([a-z]{20})(?:[/?#]|$)/) ?? v.match(/^([a-z]{20})$/);
  return m?.[1] ?? null;
}

// Misma regex que el contrato y §06.3: rechaza acme/. y acme/.. sin petición de red.
const REPO = /^[A-Za-z0-9-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
// owner/repo o la URL de GitHub (con o sin https://, .git, barra final o /tree/<rama>) → owner/repo y la rama si viene.
export function extraerRepoYRama(entrada: string): { repo: string; rama: string | null } | null {
  const v = entrada.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/\/+$/, '');
  const m = v.match(/^([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/(.+))?$/);
  if (!m || !REPO.test(`${m[1]}/${m[2]}`)) return null;
  const rama = m[3] && /^[\w./-]{1,100}$/.test(m[3]) && !m[3].split('/').includes('..') ? m[3] : null;
  return { repo: `${m[1]}/${m[2]}`, rama };
}
export const extraerRepo = (entrada: string): string | null => extraerRepoYRama(entrada)?.repo ?? null;

export const zoneIdValido = (z: string) => /^[0-9a-f]{32}$/.test(z.trim());

// Modo sitio de Cloudflare (asignaciones/cloudflare-por-url.md): la URL de Pages, de un Worker o su dominio propio →
// https://<host>, sin ruta, query ni puerto (como normaliza el BACK). Acepta el host a secas. Como el contrato: solo
// https y un dominio público (ni IP ni localhost); además, fuera los de VanGUARD, que el BACK también rechaza.
export function extraerUrlSitio(entrada: string): { url: string } | { error: string } {
  const v = entrada.trim();
  if (!v) return { error: 'Pega la URL de tu sitio, por ejemplo https://mi-app.pages.dev' };
  if (/^http:\/\//i.test(v)) return { error: 'Solo https: escribe https:// al principio' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && !/^https:\/\//i.test(v)) return { error: 'Solo https: escribe https:// al principio' };
  let u: URL;
  try { u = new URL(/^https:\/\//i.test(v) ? v : `https://${v}`); } catch { return { error: 'Eso no parece una URL: prueba con https://mi-app.pages.dev' }; }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (u.username || u.password) return { error: 'La URL no puede llevar usuario ni contraseña' };
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[') || host === 'localhost' || host.endsWith('.localhost'))
    return { error: 'Tiene que ser un dominio público, no una IP ni localhost' };
  if (host === 'officialvanguard.com' || host.endsWith('.officialvanguard.com')) return { error: 'Ese dominio es de VanGUARD: pega la URL de tu sitio' };
  return { url: `https://${host}` };
}
