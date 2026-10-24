// Inyección de prompts (S06 06.4 literal): cercado de datos externos, banderas deterministas de entrada y filtro de salida
// de IA-1. Más el cercado del Markdown de export (S13 13.4: fenceMd, escapeMdInline). API canónica: no hay otra versión.
import { PATRONES_SECRETO } from './redact.ts';
export const CANARIO = 'VG-CANARIO-3F9A71C2';                                              // S11 capa 8
export const DOMINIOS_OK = ['supabase.com', 'cloudflare.com', 'github.com', 'osv.dev', 'nvd.nist.gov']; // canónicas §8
const BORRADO = /\brm\s+-rf\b|\bdrop\s+(table|schema|database)\b|\btruncate\s+table\b|\bdisable\s+row\s+level\s+security\b|\bgit\s+push\s+(-f|--force)\b|--no-verify\b|\bdesactiv\w*\s+(la\s+|el\s+)?(rls|row level security|waf|firewall|autenticaci[oó]n|https)\b|\bborr\w*\s+(la\s+|el\s+)?(tabla|base de datos|esquema)\b/i;
export const PATRONES_INYECCION: ReadonlyArray<readonly [string, RegExp]> = [
  ['ignora_instrucciones', /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|above|prior|all|earlier)\b.{0,40}\b(instructions?|rules?|prompts?)\b|\b(ignora|olvida|omite|desobedece)\b.{0,40}\b(lo anterior|instrucciones|reglas)\b/i],
  ['etiqueta_rol', /<\/?\s*(system|assistant|user|human|datos_no_confiables|evidencia_no_confiable|instructions?)\b[^>]*>/i],
  ['prefijo_rol', /(^|\n)\s*(system|assistant|human)\s*:|\b(you are now|eres ahora|developer mode)\b/i],
  ['no_avisar', /\b(do not|don't|never|no)\s+(alert|notify|call|escalate|report|avises|alertes|llames|escales|notifiques|reportes)\b/i],
  ['pipe_a_shell', /\b(curl|wget|iwr|irm|invoke-webrequest)\b[^\n|]{0,200}\|\s*(ba|z)?sh\b|\biex\s*\(/i],
  ['borrado', BORRADO],
  ['base64_largo', /[A-Za-z0-9+/]{120,}={0,2}/],
  ['invisible', /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u],
];
const MAX_STR = 2000, MAX_ARR = 50, MAX_PROF = 6;
function normalizar(v: unknown, prof = 0): unknown {
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + '…[truncado]' : v;
  if (v && typeof v === 'object') {
    if (prof >= MAX_PROF) return '[demasiado profundo]';
    if (Array.isArray(v)) return v.slice(0, MAX_ARR).map((x) => normalizar(x, prof + 1));
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, normalizar(o[k], prof + 1)]));
  }
  return v ?? null;
}
function* textos(v: unknown, prof = 0): Generator<string> {                             // cada string y cada clave, sin escapar
  if (typeof v === 'string') { yield v; return; }
  if (v === null || typeof v !== 'object' || prof > MAX_PROF) return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) { yield k; yield* textos(x, prof + 1); }
}
/** Banderas sobre la evidencia: marcan suspected_injection; nunca cambian severidad ni alerta. */
export function scanInjection(datos: unknown): string[] {
  const f = new Set<string>();
  for (const t of textos(datos)) for (const [id, re] of PATRONES_INYECCION) if (re.test(t)) f.add(id);
  return [...f];
}
/** Recibe datos YA pasados por redact(). Claves ordenadas = bytes estables = caché estable (S11). */
export function wrapUntrusted(origen: string, datos: unknown): string {
  const json = JSON.stringify(normalizar(datos)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<datos_no_confiables origen="${origen.replace(/[^a-z0-9_]/gi, '')}">\n${json}\n</datos_no_confiables>`;
}
const BLOQUEAN = new Set(['ignora_instrucciones', 'etiqueta_rol', 'pipe_a_shell', 'base64_largo', 'invisible']);
const NEGADO = /\b(no|nunca|jam[aá]s|never|not|don't|evita|prohibido)\s+(\w+\s+){0,2}$/i;   // «no desactives RLS»
/** Filtro de la salida de IA-1: [] = se acepta; si no, plantilla de la regla y estas banderas en injection_flags. */
export function checkFixPrompt(texto: string, extraHosts: string[] = []): string[] {
  const f = new Set<string>();
  const ok = [...DOMINIOS_OK, ...extraHosts.map((h) => h.toLowerCase())];
  for (const m of texto.matchAll(/\bhttps?:\/\/([^\s/?#)>\]"'`\\]+)/gi)) {          // ? # \ cortan el host: sin bypass
    const host = (m[1] ?? '').split('@').pop()!.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');   // fuera user@
    if (!ok.some((d) => host === d || host.endsWith('.' + d))) f.add('url_no_permitida');
  }
  for (const [id, re] of PATRONES_INYECCION) if (BLOQUEAN.has(id) && re.test(texto)) f.add(id);
  for (const m of texto.matchAll(new RegExp(BORRADO.source, 'gi')))                  // pipe_a_shell NO admite negación
    if (!NEGADO.test(texto.slice(Math.max(0, m.index! - 60), m.index))) { f.add('borrado'); break; }
  if (texto.includes(CANARIO)) f.add('canario');
  if (PATRONES_SECRETO.some(([re]) => new RegExp(re.source).test(texto))) f.add('secreto');
  return [...f];
}
/** API que usan S11 (turno user) y S15: bloque cercado + banderas de entrada en una sola llamada. */
export function fence(origen: string, datos: unknown): { block: string; flags: string[] } {
  return { block: wrapUntrusted(origen, datos), flags: scanInjection(datos) };
}
export const detectInjection = scanInjection;                                               // alias (S11 11.11–11.12)
export const checkModelText = (texto: string, extraHosts: string[] = []) => checkFixPrompt(texto, extraHosts); // alias

// ── Markdown de export (S13 13.4) ────────────────────────────────────────────────────────────────────────────────
/** Evidencia cercada para el Markdown: JSON con 2 espacios donde `<`, `>` y el acento grave van como \u003c, \u003e y
 *  \u0060 (solo pueden aparecer dentro de strings JSON, así que el JSON sigue siendo válido y no puede cerrar ni la
 *  etiqueta ni el bloque de código). Recibe la evidencia YA redactada. */
export function fenceMd(fuente: string, ev: unknown): string {
  if (!/^[a-z0-9_:-]+$/.test(fuente)) throw new Error('FENCE_BAD_SOURCE');
  const json = (JSON.stringify(ev, null, 2) ?? 'null')
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/`/g, '\\u0060');
  return `<datos_no_confiables fuente="${fuente}">\n\`\`\`json\n${json}\n\`\`\`\n</datos_no_confiables>`;
}
/** Texto libre fuera del cercado (title, resource, nombres de conexión): una sola línea, ≤ 300 caracteres y con
 *  `\`, `` ` ``, `<`, `>`, `[`, `]` y `|` escapados (la barra primero, para que no anule los escapes). */
export function escapeMdInline(s: string): string {
  const linea = s.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
  const corta = linea.length > 300 ? linea.slice(0, 299) + '…' : linea;
  return corta.replace(/[\\`<>[\]|]/g, (c) => '\\' + c);
}
