// Redacción de secretos y neutralización de etiquetas de datos ANTES de armar cualquier prompt.
// Regla: nada que parezca secreto sale hacia un modelo. Base: deepwiki/src/redact.mjs de Andrés (commit 14c229a),
// ampliada con Supabase, GitHub fine-grained, Slack, SendGrid, GitLab, npm, Hugging Face, cadenas de conexión, Bearer,
// asignaciones genéricas (también «=>» y define()/setX()) y literales largos de alta entropía.
// Presupuesto: corre dentro de un paso del Worker con 10 ms de CPU. Todos los patrones son lineales: o el cuantificador
// no tiene nada detrás (el greedy acierta sin retroceder) o está acotado cuando hay que buscar un separador.

export const REDACTADO = '[REDACTADO]';
export type Redaccion = { texto: string; n: number };

// `prefijo`: el grupo 1 se conserva delante de [REDACTADO] (p. ej. «postgres://usuario:» o «Bearer »).
type Patron = { re: RegExp; prefijo?: true };

const PATRONES: Patron[] = [
  // Clave privada PEM/OpenSSH/PGP. Si el archivo llegó recortado y falta el END, se tapa hasta el final del texto.
  { re: /-----BEGIN[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },                         // Anthropic
  { re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g },      // OpenAI con prefijo de proyecto
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9]{20,}/g },                     // OpenAI y similares (lista de Andrés)
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g },          // Stripe secretas (pk_ es pública)
  { re: /\bwhsec_[A-Za-z0-9]{20,}/g },                            // secreto de webhook
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },                        // GitHub clásico
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },                      // GitHub fine-grained
  { re: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g },                    // Slack
  { re: /hooks\.slack\.com\/services\/[A-Za-z0-9\/]{10,}/g },     // webhook de Slack (la ruta es la credencial)
  { re: /\bsb_secret_[A-Za-z0-9_-]{10,}/g },                      // Supabase secreta (sb_publishable_ es pública: no se toca)
  { re: /\bsbp_[A-Za-z0-9]{20,}/g },                              // token personal de Supabase
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },                       // AWS
  { re: /\bAIza[0-9A-Za-z_-]{35}/g },                             // Google API key
  { re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },        // SendGrid (también dentro de setApiKey(...))
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g },                          // GitLab personal
  { re: /\bnpm_[A-Za-z0-9]{36,}/g },                              // npm
  { re: /\bhf_[A-Za-z0-9]{30,}/g },                               // Hugging Face
  // JWT (incluye las claves anon/service_role de Supabase). Solo empieza donde NO hay un carácter base64url
  // delante: así un adversario que repita «-eyJ» sin puntos no hace que cada intento vuelva a recorrer la misma racha.
  { re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,300}\.[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,1000}/g },
  // Credencial dentro de una URL (postgres://usuario:clave@host, https://x:token@github.com): queda usuario y host.
  // La clave es greedy hasta el último «@» antes de «/» o espacio, para no dejar a medias claves con «@».
  { re: /\b([a-z][a-z0-9+.-]{1,15}:\/\/[^\s:@\/]{1,100}:)[^\s\/]{1,200}(?=@)/gi, prefijo: true },
  { re: /\b((?:Bearer|Basic)[ \t]+)[A-Za-z0-9._~+\/-]{16,}=*/g, prefijo: true },
  { re: /\b(token[ \t]+)[0-9a-fA-F]{40}\b/gi, prefijo: true },     // Authorization: token <40 hex> (GitHub viejo)
];

// Nombres que delatan un secreto. «pass» solo como palabra propia (DB_PASS, pass=) y no dentro de «bypass».
const CLAVES = '(?:secret|token|passw(?:or)?d|passphrase|pwd|(?<![a-z])pass\\b|api[_-]?key|private[_-]?key'
  + '|access[_-]?key|(?:encryption|signing|app|master|account|auth)[_-]?key|credential|(?<![a-z])salt\\b)';

// Asignación genérica: clave que nombra un secreto + separador + valor (entre comillas o suelto). Va al final para
// no contar dos veces lo que ya tapó un patrón específico. El valor suelto no lleva nada detrás (sin retroceso);
// si justo después viene «(», «[», «{» o «<» es una expresión de código (jwt.sign(...)), no un secreto.
// Separadores: «=», «:», «:=» y «=>» (arreglos de PHP/Laravel, hashes de Ruby); con «=>» solo valores entre comillas,
// porque `token => token.trim()` es una función flecha.
const ASIGNACION = new RegExp(
  '(' + CLAVES + '[A-Za-z0-9_.-]{0,30}["\'`]?[ \\t]{0,5}(=>|:=|[:=])[ \\t]{0,5})'
  + '(?:"([^"\\n]{4,})|\'([^\'\\n]{4,})|`([^`\\n]{4,})|([^\\s"\'`,;(){}\\[\\]<>]{6,}))',
  'gi',
);
const ES_CLAVE = new RegExp(CLAVES, 'i');
// Llamadas que reciben el secreto como argumento literal: define('DB_PASSWORD', '...') y define('AUTH_KEY', '...') de
// wp-config.php, y setters como setPassword("...") o setApiKey('...'). El nombre se comprueba después, en la función.
const LLAMADA = /(\b(?:define[ \t]*\([ \t]*(["'])([A-Za-z0-9_]{1,80})\2[ \t]*,|set([A-Za-z0-9_]{1,60})[ \t]*\()[ \t]*)(?:"([^"\n]{4,})"|'([^'\n]{4,})')/gi;
// Último recurso: literal entre comillas de 32+ caracteres base64/base64url con mayúsculas, minúsculas y dígitos (alta
// entropía). Sin «-» para no tocar UUIDs ni nombres en kebab-case.
const LITERAL_LARGO = /(["'`])([A-Za-z0-9+\/=_]{32,400})\1/g;
// Valores que no son secretos sino referencias o tipos: se dejan porque ayudan a entender el código.
const NO_SECRETO = /^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|getenv|Deno\.env|System\.getenv|ENV\[|env[.(\[]|\$\{|\{\{|\$\(|\$[A-Za-z_][A-Za-z0-9_]*$|sb_publishable_|(?:string|number|boolean|bigint|undefined|unknown|object)$)/i;

export function redactar(texto: string): Redaccion {
  let n = 0;
  let t = texto;
  for (const { re, prefijo } of PATRONES) {
    t = t.replace(re, (_m: string, p1: unknown) => {
      n++;
      return (prefijo && typeof p1 === 'string' ? p1 : '') + REDACTADO;
    });
  }
  t = t.replace(ASIGNACION, (m: string, pre: string, sep: string, dq?: string, sq?: string, bq?: string,
    suelto?: string, pos?: number, todo?: string) => {
    const valor = dq ?? sq ?? bq ?? suelto ?? '';
    if (yaTapado(valor) || NO_SECRETO.test(valor)) return m;
    if (sep === '=>' && suelto !== undefined) return m;                   // función flecha, no secreto
    if (bq !== undefined && valor.includes('${')) return m;              // plantilla con interpolación
    if (suelto !== undefined && typeof pos === 'number' && typeof todo === 'string'
      && '([{<'.includes(todo.charAt(pos + m.length) || ' ')) return m;  // llamada o acceso: código, no secreto
    n++;
    const comilla = dq !== undefined ? '"' : sq !== undefined ? "'" : bq !== undefined ? '`' : '';
    return pre + comilla + REDACTADO;
  });
  t = t.replace(LLAMADA, (m: string, pre: string, _q?: string, constante?: string, setter?: string, dq?: string,
    sq?: string) => {
    const nombre = constante ?? setter ?? '';
    const valor = dq ?? sq ?? '';
    const esSecreto = ES_CLAVE.test(nombre) || (constante !== undefined && /_(?:KEY|SALT)$/i.test(nombre));
    if (!esSecreto || yaTapado(valor) || NO_SECRETO.test(valor)) return m;
    n++;
    const c = dq !== undefined ? '"' : "'";
    return `${pre}${c}${REDACTADO}${c}`;
  });
  t = t.replace(LITERAL_LARGO, (m: string, c: string, v: string) => {
    if (!/[A-Z]/.test(v) || !/[a-z]/.test(v) || !/[0-9]/.test(v) || NO_SECRETO.test(v)) return m;
    n++;
    return `${c}${REDACTADO}${c}`;
  });
  return { texto: t, n };
}

// Ya tapado, también si llegó escapado por sanearMarkdown (\[REDACTADO\]): así redactar sigue siendo idempotente.
const yaTapado = (valor: string) => valor.includes('REDACTADO');

// Neutraliza las etiquetas de datos dentro del contenido del repo para que un archivo no pueda «cerrar» su bloque y
// hablarle al modelo desde fuera. Cubre <repo_file>, <repo_paths>, <repo_summary>, <vanguard_findings> y cualquier
// otra repo_*/vanguard_* futura, de apertura o cierre, con atributos, espacios, mayúsculas o escritas como &lt; o
// \u003c. Cambia el «<» por «‹»: el modelo ve que ahí había algo, pero ya no es una etiqueta.
const ETIQUETA_DATO = /(?:<|&lt;|\\u003c|\\x3c)(\s{0,5}\/?\s{0,5})((?:repo|vanguard)[_-][A-Za-z_]{1,40})/gi;

export function escaparEtiquetas(texto: string): string {
  return texto.replace(ETIQUETA_DATO, (_m: string, medio: string, nombre: string) => `‹${medio}${nombre}`);
}

// Para valores que van DENTRO de un atributo (path="..."): una ruta de git puede contener comillas, < o saltos.
export function escaparAtributo(valor: string): string {
  return valor.replace(/[&"<>\r\n\t]/g, (c) =>
    c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : ' ');
}

// Atajo para el pipeline: redacta y luego neutraliza etiquetas, en ese orden.
export function prepararDato(texto: string): Redaccion {
  const r = redactar(texto);
  return { texto: escaparEtiquetas(r.texto), n: r.n };
}
