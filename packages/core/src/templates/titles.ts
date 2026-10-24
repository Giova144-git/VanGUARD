// Títulos de hallazgos en español (S15 15.2, S07 07.5.1, S09 09.11): una línea, ≤ 120 caracteres (la columna admite 200).
// Textos alineados con los fixtures de `@vanguard/contracts` (hallazgos.ts). Más dos ayudas de texto que usan las
// plantillas de corrección: una línea limpia y un fragmento de código Markdown que no se puede cerrar desde dentro.
import type { Severity } from '@vanguard/contracts';

/** Severidad en español (S11 11.10.1: critical = crítica … info = informativa). Femenino: «vulnerabilidad crítica». */
export const SEVERIDAD_ES: Readonly<Record<Severity, string>> = {
  critical: 'crítica', high: 'alta', medium: 'media', low: 'baja', info: 'informativa',
};
export const MAX_TITULO = 120;

/** Una sola línea (sin caracteres de control ni separadores de línea), espacios colapsados y ≤ `max` con «…». */
export function unaLinea(s: string, max = MAX_TITULO): string {
  const l = String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return l.length > max ? l.slice(0, Math.max(0, max - 1)) + '…' : l;
}

/** Código en línea de Markdown: el delimitador es más largo que cualquier racha de acentos graves del texto, así un
 *  nombre hostil no puede cerrar el fragmento y salir a la prosa. */
export function enCodigo(s: string): string {
  const racha = Math.max(0, ...[...String(s).matchAll(/`+/g)].map((m) => m[0].length));
  const d = '`'.repeat(racha + 1);
  return racha === 0 ? `${d}${s}${d}` : `${d} ${s} ${d}`;
}
/** Nombre de recurso para la prosa de una plantilla: una línea, ≤ 120 caracteres, como código. */
export const nombreEnCodigo = (s: string) => enCodigo(unaLinea(s, MAX_TITULO));

// ── Supabase (S07 07.5) ──────────────────────────────────────────────────────────────────────────────────────────
export const tituloRlsDesactivada = (resource: string) => unaLinea(`RLS desactivada en ${resource} y legible por anon`);
/** SELECT → «leer»; cualquier otra operación → «modificar» (mensaje de S07 07.5.3). */
export const tituloPoliticaPaseTodo = (policyname: string, resource: string, cmd: string) =>
  unaLinea(`La política «${policyname}» deja ${cmd.toUpperCase() === 'SELECT' ? 'leer' : 'modificar'} ${resource} sin sesión`);
export const tituloRpcSinFreno = (resource: string) =>
  unaLinea(`La función ${resource} se puede llamar sin sesión y sin freno`);

/** Traducción fija de los 12 lints más comunes de los advisors (S07 07.5.1); el resto conserva el `title` original.
 *  Map y no objeto: un lint llamado `constructor` no debe dar con el prototipo. */
export const TITULOS_ADVISOR: ReadonlyMap<string, string> = new Map([
  ['rls_disabled_in_public', 'RLS desactivada'],
  ['rls_enabled_no_policy', 'RLS activa sin políticas'],
  ['policy_exists_rls_disabled', 'Políticas creadas con RLS desactivada'],
  ['security_definer_view', 'Vista con SECURITY DEFINER'],
  ['function_search_path_mutable', 'Función con search_path mutable'],
  ['auth_users_exposed', 'auth.users expuesta por la API'],
  ['extension_in_public', 'Extensión instalada en public'],
  ['auth_leaked_password_protection', 'Sin protección de contraseñas filtradas'],
  ['unindexed_foreign_keys', 'Clave foránea sin índice'],
  ['unused_index', 'Índice sin uso'],
  ['duplicate_index', 'Índices duplicados'],
  ['multiple_permissive_policies', 'Varias políticas permisivas para el mismo rol y acción'],
]);
export const SUFIJO_DUPLICADO_RLS = ' (ya contado en RLS desactivada)';

/** Título de un lint: traducción + « en {resource}» (si no es 'proyecto'), o el original; el sufijo de duplicado
 *  (anti-doble conteo de 07.5) nunca se pierde al recortar. */
export function tituloAdvisor(name: string, original: string, resource: string, duplicado = false): string {
  const fijo = TITULOS_ADVISOR.get(name);
  const base = fijo ? (resource && resource !== 'proyecto' ? `${fijo} en ${resource}` : fijo)
    : unaLinea(original, 200) || `Aviso de Supabase: ${name}`;
  return duplicado ? unaLinea(base, MAX_TITULO - SUFIJO_DUPLICADO_RLS.length) + SUFIJO_DUPLICADO_RLS : unaLinea(base);
}

// ── Codebase (S09) ────────────────────────────────────────────────────────────────────────────────────────────────
const nombreArchivo = (path: string) => path.split('/').pop() ?? path;
export const tituloEnvSubido = (path: string) => unaLinea(`Archivo ${path || '.env'} subido al repositorio`);
export const tituloGitignoreSinEnv = (existeGitignore = true) =>
  existeGitignore ? 'El .gitignore no excluye .env' : 'El repositorio no tiene .gitignore en la raíz';

const TIPO_SECRETO: ReadonlyArray<readonly [RegExp, string]> = [
  [/SERVICE_ROLE/, 'Clave service_role de Supabase'],
  [/SUPABASE/, 'Clave secreta de Supabase'],
  [/POSTGRES/, 'Cadena de conexión a Postgres con contraseña'],
  [/GITHUB/, 'Token de GitHub'],
  [/AWS/, 'Clave de acceso de AWS'],
  [/STRIPE/, 'Clave live de Stripe'],
  [/ANTHROPIC/, 'Clave de la API de Anthropic'],
  [/OPENAI/, 'Clave de la API de OpenAI'],
  [/PRIVATE_KEY/, 'Clave privada'],
];
/** `CB_SECRET_*`: «… en .env» si el archivo es un .env; si no, «… en el código». */
export function tituloSecreto(ruleId: string, path: string): string {
  const tipo = TIPO_SECRETO.find(([re]) => re.test(ruleId))?.[1] ?? 'Posible credencial';
  const archivo = nombreArchivo(path);
  return unaLinea(`${tipo} ${/^\.env/.test(archivo) ? `en ${archivo}` : 'en el código'}`);
}

/** `CB_DEP_VULN`: «lodash 4.17.15 tiene 6 vulnerabilidades; la más grave es alta», «… tiene 1 vulnerabilidad crítica
 *  (CVE-…)» y, si alguna está en KEV, «; una se explota en la vida real (CVE-…)» (ejemplo de S09 09.11). */
export function tituloDependencia(name: string, version: string,
  avisos: readonly { id: string; severidad: Severity; kev?: boolean }[]): string {
  const n = avisos.length;
  const orden: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  const peor = orden.find((s) => avisos.some((a) => a.severidad === s)) ?? 'info';
  const kev = avisos.find((a) => a.kev);
  const base = n === 1 ? `${name} ${version} tiene 1 vulnerabilidad ${SEVERIDAD_ES[peor]}`
    : `${name} ${version} tiene ${n} vulnerabilidades`;
  const cola = n === 1 ? ` (${avisos[0]?.id ?? ''})${kev ? ', explotada en la vida real' : ''}`
    : kev ? `; una se explota en la vida real (${kev.id})` : `; la más grave es ${SEVERIDAD_ES[peor]}`;
  return unaLinea(base + cola);
}

// ── Cloudflare (S08 08.7) ─────────────────────────────────────────────────────────────────────────────────────────
export const tituloZonaPausada = (zona: string) => unaLinea(`La zona ${zona} de Cloudflare está pausada`);
