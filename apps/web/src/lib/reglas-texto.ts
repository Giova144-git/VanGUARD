// «Por qué importa»: una o dos frases por rule_id (S14 §14.15, Canon §9). Sin texto para la regla → solo el título.
const TEXTO: Record<string, string> = {
  SB_RLS_DISABLED: 'Cualquiera con tu clave pública puede leer esta tabla completa.',
  SB_POLICY_ALLOW_ALL: 'La política deja pasar a todos: con tu clave pública se puede leer o cambiar lo que protege.',
  SB_FUNCTION_NO_LIMIT: 'Esta función se puede llamar sin freno: alguien puede gastar tus recursos o tu cupo.',
  SB_AUTH_REDIRECT_WILDCARD: 'Una URL de redirección con comodín permite robar sesiones con un enlace preparado.',
  SB_CPU_HIGH: 'Tu base está al límite de CPU: las peticiones se vuelven lentas o fallan.',
  CB_ENV_COMMITTED: 'Subiste un archivo .env: quien vea el repo ve tus claves.',
  CB_GITIGNORE_NO_ENV: 'Tu .gitignore no excluye los .env: el próximo commit puede subir tus claves.',
  CB_DEP_CVE: 'Usas una versión de esta dependencia con una vulnerabilidad pública conocida.',
  CF_ADMIN_EXPOSED: 'Tu ruta de administración responde a cualquiera desde internet.',
  CF_PATH_SCAN: 'Esta IP está probando rutas una tras otra: es un escaneo buscando puntos débiles.',
  CF_UA_TOOL: 'Esta IP usa una herramienta de ataque automatizada.',
  CF_IP_FLOOD: 'Esta IP te manda muchas más peticiones de lo normal.',
  CF_WAF_01: 'Las reglas gratuitas del WAF de Cloudflare no están activas en tu zona.',
};

export function porQueImporta(rule: string): string | null {
  if (TEXTO[rule]) return TEXTO[rule];
  if (rule.startsWith('CB_SECRET_')) return 'Hay una clave en tu código: quien vea el repo puede usarla. Rótala y sácala del repo.';
  return null;
}

// Referencias que el FRONT construye: nunca se usan URLs que vengan dentro de la evidencia.
export function referencias(evidencia: unknown): { id: string; href: string }[] {
  const ids = new Set<string>();
  const recorrer = (v: unknown, n = 0) => {
    if (n > 6) return;
    if (typeof v === 'string') { if (/^CVE-\d{4}-\d{4,}$/.test(v) || /^GHSA-[\w-]+$/.test(v)) ids.add(v); }
    else if (Array.isArray(v)) v.forEach((x) => recorrer(x, n + 1));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => recorrer(x, n + 1));
  };
  recorrer(evidencia);
  return [...ids].flatMap((id) => id.startsWith('CVE-')
    ? [{ id, href: `https://www.cve.org/CVERecord?id=${id}` }, { id: `${id} · OSV`, href: `https://osv.dev/vulnerability/${id}` }]
    : [{ id, href: `https://osv.dev/vulnerability/${id}` }]);
}
