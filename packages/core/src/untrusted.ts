// Inyección de prompts (S06 06.4 literal): cercado de datos externos, banderas deterministas de entrada y filtro de salida
// de IA-1. Más el cercado del Markdown de export (S13 13.4: fenceMd, escapeMdInline). API canónica: no hay otra versión.
// Todo texto se mira en NFKC (＜system＞ → <system>, U+00A0 → espacio) y, además, sin invisibles y sin comentarios /* */:
// una bandera salta si casa en cualquiera de las tres variantes. Cuantificadores acotados: nada cuadrático.
import { PATRONES_SECRETO } from './redact.ts';
export const CANARIO = 'VG-CANARIO-3F9A71C2';                                              // S11 capa 8
export const DOMINIOS_OK = ['supabase.com', 'cloudflare.com', 'github.com', 'osv.dev', 'nvd.nist.gov']; // canónicas §8
const BORRADO = new RegExp([
  // rm con recursivo y forzado en cualquier orden y forma (-rf, -fr, -r -f, -Rf, --recursive --force); git rm --cached no
  String.raw`\brm(?=(?:\s+-[\w-]+){0,5}?\s+(?:-[a-z]*r[a-z]*|--recursive)\b)(?=(?:\s+-[\w-]+){0,5}?\s+(?:-[a-z]*f[a-z]*|--force)\b)`,
  String.raw`\bdrop\s+(?:table|schema|database)\b`,
  String.raw`\btruncate\s+table\b|\btruncate\s+(?:only\s+)?[\w."]+(?:\s*,\s*[\w."]+)*[ \t]*(?:;|\r?\n|$|cascade\b|restart\b)`,
  String.raw`\bdisable\s+row\s+level\s+security\b`,
  String.raw`\bgit\s+push\b[^\n;|&]{0,200}\s(?:-[a-z]*f[a-z]*|--force|\+[\w/.:-]+)\b|--no-verify\b`,   // -f, -uf, --force…, +rama
  // DELETE sin WHERE: acaba en ; o en fin de línea y lo que sigue no es where/using (el WHERE puede ir en la línea de abajo)
  String.raw`\bdelete\s+from\s+(?:only\s+)?[\w."]+(?:\s+(?:as\s+)?(?!(?:where|using|returning)\b)[a-z_]\w*)?[ \t]*(?:;|returning\b|(?=\r?\n|$)(?!\s*(?:where|using)\b))`,
  String.raw`\bdesactiv[\wáéíóú]*\s+(?:la\s+|el\s+)?(?:rls|row level security|waf|firewall|autenticaci[oó]n|https)\b`,
  String.raw`\bborr[\wáéíóú]*\s+(?:la\s+|el\s+)?(?:tabla|base de datos|esquema)\b`,
].join('|'), 'i');
const BORRADO_G = new RegExp(BORRADO.source, 'gi');
// La ruta va por tramos que acaban en «/» y no cruzan «|»: con dos (?:\S*/)? seguidos, cada «|» de los 200 caracteres
// probaba todos los cortes posibles (cuadrático). LINEA cruza la continuación «\⏎» de los bloques de código.
const RUTA = String.raw`(?:[^\s/|]*/)*`;
const LINEA = String.raw`(?:[^\n]|\\\r?\n){0,200}`;
const SHELL = String.raw`(?:(?:ba|z|da|k|fi|c|tc)?sh|python\d*|node|perl|ruby|php|pwsh|powershell|iex|invoke-expression)\b`;
const PIPE_A_SHELL = new RegExp([
  // descarga |[&] [sudo [-u root] …] [ruta/][env … [ruta/]] shell o intérprete: sh, bash, /bin/sh, python3, pwsh, iex…
  String.raw`\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b${LINEA}\|&?\s*(?:sudo\s+(?:-[a-z]\s+(?!-)[\w.-]+\s+|-\S+\s+)*)?${RUTA}(?:env\s+(?:-\S+\s+)*${RUTA})?${SHELL}`,
  String.raw`\b(?:(?:ba|z|da|k)?sh|source)\s+(?:<\s*)?<\(`,                                // bash <(curl …)
  String.raw`\$\(\s*(?:curl|wget|irm|iwr)\b`,                                              // sh -c "$(curl …)"
  // bash -c "`curl …`", eval `curl …`; un `curl -sI …` suelto es código en línea de Markdown y no salta
  String.raw`(?:\beval|\b(?:ba|z|da|k)?sh\s+-c)\s+["']?\x60\s*(?:curl|wget|irm|iwr)\b`,
  String.raw`\bbase64\s+(?:-d|--decode)\b${LINEA}\|&?\s*${RUTA}\w*sh\b`,
  String.raw`\|\s*(?:iex|invoke-expression)\b|\b(?:iex|invoke-expression)\s*\(`,
].join('|'), 'i');
// Formato e ignorables por defecto (U+00AD, U+061C, U+180E, U+3164, U+200B–U+200F, bidi, etiquetas, selectores…). Se
// excluyen el ZWJ entre dos emojis y el VS15/VS16 tras un emoji o un keycap: forman la señal de aviso U+26A0 U+FE0F o las
// familias y oficios con ZWJ (salidas del modelo, commits con gitmoji) y ahí no esconden texto; fuera de un emoji siguen
// marcando, como el ZWJ del rango U+200B–U+200F de antes.
const INVISIBLE = /(?!(?<=\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\uFE0F]?)\u200D(?=\p{Extended_Pictographic})|(?<=[\p{Extended_Pictographic}#*0-9])[\uFE0E\uFE0F])[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const INVISIBLES = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;                        // para la variante «limpia»
export const PATRONES_INYECCION: ReadonlyArray<readonly [string, RegExp]> = [
  ['ignora_instrucciones', /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|above|prior|all|earlier)\b.{0,40}\b(instructions?|rules?|prompts?)\b|\b(ignora|olvida|omite|desobedece)\b.{0,40}\b(lo anterior|instrucciones|reglas)\b/i],
  ['etiqueta_rol', /<\/?\s*(system|assistant|user|human|datos_no_confiables|evidencia_no_confiable|instructions?)\b[^>]*>/i],
  ['prefijo_rol', /(^|\n)\s*(system|assistant|human)\s*:|\b(you are now|eres ahora|developer mode)\b/i],
  ['no_avisar', /\b(do not|don't|never|no)\s+(alert|notify|call|escalate|report|avises|alertes|llames|escales|notifiques|reportes)\b/i],
  ['pipe_a_shell', PIPE_A_SHELL],
  ['borrado', BORRADO],
  ['base64_largo', /[A-Za-z0-9+/]{120,}={0,2}/],
  ['invisible', INVISIBLE],
];
/** Quita los comentarios /* … *\/ en tiempo lineal (una regex perezosa es cuadrática con muchos /* sin cerrar). */
function sinComentarios(t: string): string {
  let out = '', i = 0;
  for (let a = t.indexOf('/*'); a >= 0; a = t.indexOf('/*', i)) {
    const b = t.indexOf('*/', a + 2);
    if (b < 0) break;
    out += t.slice(i, a) + ' ';
    i = b + 2;
  }
  return out + t.slice(i);
}
/** El texto (ya en NFKC), sin invisibles («dr\u00ADop» → «drop») y además sin comentarios («DROP/**\/TABLE»). */
function variantes(t: string): string[] {
  const limpio = t.replace(INVISIBLES, '');
  return [...new Set([t, limpio, sinComentarios(limpio)])];
}
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
function* textos(v: unknown, prof = 0): Generator<string> {                             // cada string y cada clave, en NFKC
  if (typeof v === 'string') { yield v.normalize('NFKC'); return; }
  if (v === null || typeof v !== 'object' || prof > MAX_PROF) return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) { yield k.normalize('NFKC'); yield* textos(x, prof + 1); }
}
/** Banderas sobre la evidencia: marcan suspected_injection; nunca cambian severidad ni alerta. */
export function scanInjection(datos: unknown): string[] {
  const f = new Set<string>();
  for (const t of textos(datos)) for (const v of variantes(t)) for (const [id, re] of PATRONES_INYECCION) if (re.test(v)) f.add(id);
  return [...f];
}
/** Recibe datos YA pasados por redact(). Claves ordenadas = bytes estables = caché estable (S11). */
export function wrapUntrusted(origen: string, datos: unknown): string {
  const json = JSON.stringify(normalizar(datos)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<datos_no_confiables origen="${origen.replace(/[^a-z0-9_]/gi, '')}">\n${json}\n</datos_no_confiables>`;
}
const BLOQUEAN = new Set(['ignora_instrucciones', 'etiqueta_rol', 'pipe_a_shell', 'base64_largo', 'invisible']);
const NEGADO = /\b(no|nunca|jam[aá]s|never|not|don['’]t|evita|prohibido)\s+([\wáéíóúüñ]+\s+){0,2}$/i;   // «no desactives RLS»
const NO_NIEGA = /\b(olvid\w*|dejes|dudes|temas|forget|fail|hesitate|skip)\b/i;    // «No olvides ejecutar…», «Never forget to…»
const negado = (antes: string) => { const n = NEGADO.exec(antes); return !!n && !NO_NIEGA.test(n[0]); };
// Bandera `secreto`: los formatos de proveedor (los que redact() tapa con [REDACTADO:tipo]) con sus flags. Los genéricos
// (Authorization/Bearer, param=valor, cadena de conexión) solo cuentan si el valor parece un secreto real: un prompt de
// corrección legítimo dice «Authorization: Bearer $SUPABASE_ANON_KEY», «API_KEY=tu_clave» o «Bearer <TU_TOKEN>».
const SECRETO = PATRONES_SECRETO.filter(([, rep]) => rep.startsWith('[REDACTADO:'))
  .map(([re]) => new RegExp(re.source, re.flags.replace('g', '')));
const SECRETO_GENERICO = [
  /\b(?:authorization\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?|bearer\s+)([A-Za-z0-9._~+/=-]{20,})/gi,
  /(?:^|[?&\s;,"'(])(?:(?:access_|refresh_|id_|auth_)?token|api[_-]?key|client_secret|secret|password|passwd)\s*[=:]\s*["']?([^&\s"'<>#;,)]{16,})/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:([^@\s]{8,})@/gi,
];
const PLACEHOLDER = /^[[<${%*]|redactad|your|tu_|example|ejemplo|xxxx|changeme|placeholder|aqui/i;
const NOMBRE_ENV = /^[A-Z][A-Z0-9]*_[A-Z0-9_]*$/;                                       // CF_API_TOKEN, SUPABASE_ANON_KEY
const valorReal = (v: string) =>
  !PLACEHOLDER.test(v) && !NOMBRE_ENV.test(v) && (/\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v)));
const secretoGenerico = (v: string) => SECRETO_GENERICO.some((re) => [...v.matchAll(re)].some((m) => valorReal(m[1] ?? '')));
// Hosts de salida (06.3): esquema especial con o sin barras (https:evil, https:/evil), cualquier esquema con //, relativo
// al protocolo (//evil.x), www. y git@host:; la barra invertida vale como barra, como en el navegador. El grupo 1 corta en
// la puntuación de prosa (lo que enlaza un linkificador); el resto de la autoridad, hasta el blanco, /, ? o #, lo miran
// tramos() y autoridadPeligrosa().
const HOST = String.raw`([^\s/?#)>\]"'\x60<]+)`;
const URLS = [
  new RegExp(String.raw`\b(?:https?|wss?|ftp):/*` + HOST, 'gi'),
  new RegExp(String.raw`\b[a-z][a-z0-9+.-]{1,20}://` + HOST, 'gi'),                     // ssh://, git+ssh://… (C:// no)
  // relativo al protocolo, solo donde un navegador o el Markdown lo enlazan (src="//…", url(//…), [a](//…), href=//…):
  // un dominio con punto y detrás / ? # : comilla, cierre, blanco o fin. Un comentario de código (// x, //console.log(y),
  // x = 1 //window.location) no es una URL
  new RegExp(String.raw`(?<=["'(=<\x60])//([a-z0-9-]+(?:\.[a-z0-9-]+)+\.?)(?![^/?#:"'\x60\s)>\]])`, 'gi'),
  new RegExp(String.raw`(?<![\w.@/:-])(www\.[^\s/?#)>\]"'\x60<]+)`, 'gi'),
];
const GIT = /\bgit@([^\s:/@]{1,253}):/gi;
const AUTORIDAD = /[^\s/?#]*/y;
const PROSA = new Set(')>]"\'`},;.!*_');                                                // puntuación final de prosa
const permitido = (h: string, ok: string[]) => ok.some((d) => h === d || h.endsWith('.' + d));
function hostOk(crudo: string, ok: string[]): boolean {
  if (crudo.length > 300) return false;                                                // ningún host mide tanto
  let e = crudo.length;
  while (e > 0 && PROSA.has(crudo[e - 1]!)) e--;                     // a mano: «[…]+$» retrocede en cuadrático
  const host = crudo.slice(0, e).toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9.-]+$/.test(host) && permitido(host, ok);
}
/** Tramo de autoridad desde `desde` hasta el primer blanco, /, ? o # (`fin`; `finProsa`, sin la puntuación final) y las
 *  últimas posiciones de @, de < > [ ] ^ | (host inválido), de «:» y de un no dígito antes de finProsa. */
interface Tramo { desde: number; fin: number; finProsa: number; arroba: number; prohibido: number; dosPuntos: number;
  noDigito: number; hostArroba?: boolean }
/** Se calcula una vez por tramo y sirve a todas las URLs que empiezan dentro: lineal aunque un JSON sin blancos traiga
 *  miles de URLs (el lookahead sin tope que había por URL era cuadrático). */
function tramos(u: string): (i: number) => Tramo {
  let t: Tramo = { desde: 0, fin: 0, finProsa: 0, arroba: -1, prohibido: -1, dosPuntos: -1, noDigito: -1 };
  return (i) => {
    if (i >= t.desde && i < t.fin) return t;
    AUTORIDAD.lastIndex = i;
    AUTORIDAD.test(u);
    const fin = AUTORIDAD.lastIndex;
    let finProsa = fin;
    while (finProsa > i && PROSA.has(u[finProsa - 1]!)) finProsa--;
    t = { desde: i, fin, finProsa, arroba: -1, prohibido: -1, dosPuntos: -1, noDigito: -1 };
    for (let k = i; k < fin; k++) {
      const ch = u[k]!;
      if (ch === '@') t.arroba = k;
      if (k >= finProsa) continue;
      if ('<>[]^|'.includes(ch)) t.prohibido = k;
      if (ch === ':') t.dosPuntos = k;
      if (ch < '0' || ch > '9') t.noDigito = k;
    }
    return t;
  };
}
/** La autoridad u[ini, finProsa) (sin @) vista por un navegador: el WHATWG admite " ) ' ` en el host, así que
 *  supabase.com".evil.com va a evil.com. Peligrosa si la URL es válida y el host acaba en un dominio registrable limpio
 *  fuera de la lista. El cierre de un string de JSON («supabase.com","b":"c», puerto inválido) o un final basura
 *  («supabase.com","https») no llevan a ningún host: así el JSON re-serializado de claude.ts no da falsos positivos. */
function autoridadPeligrosa(u: string, ini: number, fin1: number, t: Tramo, ok: string[]): boolean {
  if (t.finProsa <= fin1 || t.prohibido >= ini) return false;      // nada detrás del host corto, o host inválido
  if (t.dosPuntos >= ini && t.noDigito > t.dosPuntos) return false; // puerto con letras: URL inválida
  if (t.finProsa - ini > 800) return false;                        // ni todo en %XX cabe en los 253 de un nombre DNS
  let host: string;
  try { host = new URL('http://' + u.slice(ini, t.finProsa)).hostname.replace(/\.$/, ''); } catch { return false; }
  return !permitido(host, ok) && /(?:^|\.)[a-z0-9-]+\.[a-z0-9-]+$/.test(host);
}
function urlsPermitidas(u: string, ok: string[]): boolean {
  for (const m of u.matchAll(GIT)) if (!hostOk(m[1] ?? '', ok)) return false;
  for (const re of URLS) {
    const tramo = tramos(u);
    for (const m of u.matchAll(re)) {
      const corto = m[1] ?? '', fin1 = (m.index ?? 0) + m[0].length, ini = fin1 - corto.length;
      if ([...corto].every((ch) => PROSA.has(ch))) continue;      // «https:;» de una CSP: el esquema solo, sin host
      const t = tramo(ini);
      if (t.arroba < ini) {                                          // sin userinfo
        if (!hostOk(corto, ok) || autoridadPeligrosa(u, ini, fin1, t, ok)) return false;
        continue;
      }
      // userinfo: el host es lo de detrás del último @ (https://supabase.com)@evil.example); una vez por tramo
      t.hostArroba ??= t.fin - t.arroba - 1 <= 300 && hostOk(u.slice(t.arroba + 1, t.fin), ok);
      if (!t.hostArroba) return false;
      // …y si el @ va tras ) > " ' o `, el Markdown enlaza lo de antes: [guía](https://evil.example)@supabase.com.
      // Tras ] o < no: es un marcador en el userinfo (https://user:[TOKEN]@github.com)
      if (t.arroba >= fin1 && /[)>"'`]/.test(u.charAt(fin1)) && !hostOk(corto.slice(corto.lastIndexOf('@') + 1), ok))
        return false;
    }
  }
  return true;
}
// La barra invertida vale como barra (https:\\evil). Un \\host con punto al principio o tras un no alfanumérico es una
// ruta UNC (Windows la abre como recurso de red y el navegador como file://host): cuenta como enlace aunque no lo
// preceda una comilla. Una ruta C:\Users\x\config.json no.
const barras = (v: string) => v.replace(/(^|[^\w\\/:])\\\\(?=[a-z0-9-]+\.)/gi, '$1https://').replace(/\\/g, '/');
/** Filtro de la salida de IA-1: [] = se acepta; si no, plantilla de la regla y estas banderas en injection_flags. */
export function checkFixPrompt(texto: string, extraHosts: string[] = []): string[] {
  const vs = variantes(texto.normalize('NFKC'));
  const f = new Set<string>();
  const ok = [...DOMINIOS_OK, ...extraHosts.map((h) => h.toLowerCase())];
  if (vs.some((v) => !urlsPermitidas(barras(v), ok))) f.add('url_no_permitida');
  for (const [id, re] of PATRONES_INYECCION) if (BLOQUEAN.has(id) && vs.some((v) => re.test(v))) f.add(id);
  for (const v of vs) for (const m of v.matchAll(BORRADO_G))                             // pipe_a_shell NO admite negación
    if (!negado(v.slice(Math.max(0, m.index! - 60), m.index))) f.add('borrado');
  if (vs.some((v) => v.includes(CANARIO))) f.add('canario');
  if (vs.some((v) => SECRETO.some((re) => re.test(v)) || secretoGenerico(v))) f.add('secreto');
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
