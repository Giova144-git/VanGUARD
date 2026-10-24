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
export function extraerRepo(entrada: string): string | null {
  const v = entrada.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  return REPO.test(v) ? v : null;
}

export const zoneIdValido = (z: string) => /^[0-9a-f]{32}$/.test(z.trim());
