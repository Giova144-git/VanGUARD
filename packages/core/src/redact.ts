// Redacción de secretos para logs, evidencia, prompts y export (S06 06.5 literal, S15 15.11, S13 13.2). Dos pasadas:
// por clave (segmentos separados por _/-: `path`, `input_tokens` y `max_tokens` salen intactas) y por patrón sobre todo string.
import { CARACTER_VALOR, MARCADORES, REGLA_GENERICA, finColaGenerica, finComillas, valorGenerico } from './secrets/rules.ts';

const CLAVE_SECRETA = /(^|[_-])(token|secret|password|passwd|pat|apikey|api[_-]key|authorization|cookie|sealed|wdek|ivk|private[_-]key)($|[_-])/i;
const CLAVE_TELEFONO = /^(phone|phone_e164|to|from|to_number|wa_id|recipient)$/i;
// Cuadráticos con muchas cabeceras sin pie o muchos `postgres://u:` sin @ (como en HEAD): tapaClaves usa su versión lineal.
const PRIVADA = /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g;
const CONEXION = /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/([^:\s/@]+):[^@\s]+@/g;
/** [patrón con bandera g, reemplazo]. Lo que el reemplazo conserva va al principio, en grupos ($1, $2) o en el grupo 1 si
 *  es literal (Bearer): tapaClaves calcula con eso qué tapa cada uno. */
export const PATRONES_SECRETO: ReadonlyArray<readonly [RegExp, string]> = [
  [PRIVADA, '[REDACTADO:clave_privada]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[REDACTADO:jwt]'],      // firma opcional, como el cable trampa de S05
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/g, '[REDACTADO:supabase]'],
  [/\bsbp_[A-Za-z0-9_]{20,}/g, '[REDACTADO:supabase]'],
  [/\bgithub_pat_\w{20,}/g, '[REDACTADO:github]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTADO:github]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTADO:api_key]'],
  [/\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, '[REDACTADO:api_key]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTADO:api_key]'],                                        // `sk-…` genérico (S15 15.11)
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/g, '[REDACTADO:api_key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTADO:token]'],                                  // Slack (S13)
  // vgi_ ingesta (S05), vgk_ MCP, vgs_ (S13), vgw_ webhook de GitHub (revisión de código). El cable trampa (edge.ts,
  // comun.ts, looks_like_secret) sigue sin vgw_ a propósito: revision-codigo.md §11 VIA-1.
  [/\bvg[iksw]_[A-Za-z0-9_-]{20,}/g, '[REDACTADO:token]'],
  [/\bcf(?:k|ut|at)_[A-Za-z0-9_-]{30,}/g, '[REDACTADO:cloudflare]'],                             // formatos nuevos de Cloudflare (token-formats)
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTADO:api_key]'],                                       // clave de Google (PSI, S10)
  // Parámetros con secreto, dentro o fuera de una URL: key= de PSI, ?token=, &access_token=, client_secret=, sig=…
  [/(^|[?&\s;,"'(])((?:access_|refresh_|id_|auth_)?token|api[_-]?key|key|client_secret|secret|password|passwd|sig|signature)=([^&\s"'<>#;,)]+)/gi,
    '$1$2=[REDACTADO]'],
  [/\b(?:AKIA|ASIA)[A-Z2-7]{16}\b/g, '[REDACTADO:token]'],
  // Cabecera Authorization pegada en texto (log, evidencia, README): se tapa entera, con o sin esquema.
  [/\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s,;"']+/gi, '$1[REDACTADO]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTADO]'],
  [CONEXION, '$1://$2:[REDACTADO]@'],
];
// Secretos SIN prefijo reconocible (token de Cloudflare de 40 car., secreto de AWS) asignados a una clave con nombre de
// secreto. Fuera de PATRONES_SECRETO a propósito: así la bandera `secreto` de checkFixPrompt no salta con placeholders
// (YOUR_CLOUDFLARE_API_TOKEN). Todas las capas miran el MISMO texto (una vista en la que nuestros marcadores son un NUL
// inerte de su misma longitud) y se tapa la unión de sus tramos: ninguna depende de lo que otra tapó antes. En orden, una
// capa podía partir el valor de otra (la genérica corta en el primer símbolo y ASIGNACION ya no veía la contraseña entera).
// 1. La propia CB_SECRET_GENERIC (secrets/rules.ts), regex y filtro del valor: todo valor que la regla daría como hallazgo
//    queda tapado y la evidencia de un secreto no lleva en claro otro de su línea. El tramo sigue por la cola del valor
//    (finColaGenerica) hasta el delimitador: más allá de los 150 car. o del primer símbolo sigue siendo el secreto.
// 2. AUTH_JSON, ASIGNACION y CAMEL: lo que la genérica no mira (clave entre comillas en JSON, :=, %3D, %253D, &#61;,
//    valores con símbolos o con poca entropía). La clave admite sufijo tras _ . o - (SECRET_KEY, CF_API_TOKEN_PROD,
//    app.api.key). Como la genérica, piden un dígito en el valor: así no tapan código (`apiKey: env.ANTHROPIC_API_KEY`,
//    `auth: MiddlewareHandler`, `token = body.read_token.trim()`) ni placeholders. Tampoco una llamada
//    (`crypto.randomBytes(32)`, `sha256hex(org|ip)`). Respetan [SECRET:…] y process.env, import.meta o ${ en el valor.
// Entre comillas, el tramo de las tres llega a la de cierre (finComillas).
// 3. Lo que tapaba HEAD sigue tapado. Los patrones y la quita de queries corren DESPUÉS, sobre un texto con [REDACTADO]
//    donde había un tramo, y un tramo puede partir lo que un patrón tapaba entero: el [REDACTADO] se come el `https://` o
//    el `?` de una URL con query (y lo que va tras el primer `&`, X-Amz-Signature, code=, sig=, salía en claro), deja a
//    `Bearer a.key=…` menos de 8 car. de token, se come la cabeza de un `postgres://u:…@` o de un bloque de clave privada,
//    o da a un `Authorization` un límite de palabra que no tenía y su valor se traga un `Bearer` cuyo token queda suelto.
//    Por eso se calcula lo que tapaba HEAD y lo que tapará la salida (tapadoPorHead sin y con la unión) y todo lo de HEAD
//    que la salida no tape entra en la unión; hasta que no falte nada (lo que entra cambia lo que ven los patrones).
const GENERICA = new RegExp(REGLA_GENERICA.re.source, REGLA_GENERICA.re.flags);   // copia propia: su lastIndex es nuestro
const AUTH_JSON = /\b(authorization["']?\s*[:=]\s*["'])([^"'\r\n]+)/gi;        // "Authorization":"token …", { Authorization: 'Basic …' }
const REFERENCIA = /process\.env|import\.meta|\$\{/;                             // "Bearer ${VANGUARD_MCP_TOKEN}" no es un secreto
const SEPARADOR = String.raw`["']?\s*(?::?=|:|%(?:25)?3[Dd]|&#61;|&#x3[Dd];)\s*["']?)(?!process\.env|import\.meta|\$\{)(`
  + CARACTER_VALOR + '{16,})';
const ASIGNACION = new RegExp(String.raw`((?:token|secret|passw(?:or)?d|(?<![A-Za-z0-9])pass(?:phrase)?|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?key|(?<=[_.-])key|(?<![A-Za-z0-9])auth|credentials?|creds)(?:[_.-][\w.-]{0,19})?`
  + SEPARADOR, 'gi');
// camelCase, sin la i para distinguir mayúsculas: secretKey, encryptionKey, apiKeyLive, githubTokenStaging.
const CAMEL = new RegExp(String.raw`((?:(?<=[a-z0-9])Key|[Tt]oken|[Ss]ecret|[Pp]assw(?:or)?d|[Cc]redentials?)(?:[A-Z0-9][A-Za-z0-9]{0,19})?`
  + SEPARADOR, 'g');
const tapable = (v: string) => /\d/.test(v) && !REFERENCIA.test(v) && !/^[A-Za-z_$][\w$.]*\(/.test(v);
// URL y su query, la que redactString quita. La query va opcional y se mira después: obligatoria, la regex era
// cuadrática con `http://` repetido sin `?` (650 ms con 100 KB).
const URL_QUERY = /(https?:\/\/[^\s?#]+)(\?[^\s#]*)?/g;
// Versiones lineales de PRIVADA (cada cabecera con el primer pie que le sigue, lo que hace su `*?`) y de CONEXION (la @,
// opcional y mirada después).
const PRIVADA_INI = /-----BEGIN[^-]*PRIVATE KEY-----/g, PRIVADA_FIN = /-----END[^-]*PRIVATE KEY-----/g;
const CONEXION_LINEAL = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:([^@\s]+)(@)?/g;
// Cabezas con lo que tapan detrás de un blanco: si la salida se come la cabeza y no el token, el token también entra.
// Mejor que HEAD: en `token=…-Bearer tok` o `token=…Authorization: Basic tok` el param= se comía la cabeza y el token
// quedaba suelto en claro. Todas las cabezas, también las que caen dentro del valor de otra (por eso no matchAll del
// patrón entero), y el valor con una regex fija en su sitio.
const CABEZAS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/Bearer\s+/gi, /[A-Za-z0-9._~+/=-]{8,}/y],
  [/authorization\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?/gi, /[^\s,;"']+/y],
];
const MAX_VUELTAS = 8;
type Tramo = readonly [number, number];
const porInicio = (a: Tramo, b: Tramo) => a[0] - b[0];
/** Unión de tramos: ordenados, disjuntos y sin dos pegados. */
function juntar(ts: readonly Tramo[]): Tramo[] {
  const out: Array<[number, number]> = [];
  for (const [a, b] of [...ts].sort(porInicio)) {
    const u = out[out.length - 1];
    if (u && a <= u[1]) u[1] = Math.max(u[1], b); else if (b > a) out.push([a, b]);
  }
  return out;
}
/** t con los tramos (unión) cambiados por NUL de su misma longitud. */
function rellenar(t: string, ts: readonly Tramo[]): string {
  let out = '', desde = 0;
  for (const [a, b] of ts) { out += t.slice(desde, a) + '\0'.repeat(b - a); desde = b; }
  return out + t.slice(desde);
}
/** Lo que HEAD tapaba en t: los patrones en orden y la quita de queries, sobre una copia en la que lo ya tapado es NUL de
 *  su misma longitud (las posiciones son las de t, y para los patrones de después un NUL vale lo que un [REDACTADO]). */
function tapadoPorHead(t: string): { patrones: Tramo[]; queries: Tramo[] } {
  const out: Tramo[] = [], queries: Tramo[] = [];
  let w = t;
  for (const [re, rep] of PATRONES_SECRETO) {
    if (re === PRIVADA || re === CONEXION) {
      const ts: Tramo[] = [];
      if (re === PRIVADA) {
        const pies = [...w.matchAll(PRIVADA_FIN)];
        let pie = 0, finBloque = 0;
        for (const m of w.matchAll(PRIVADA_INI)) {
          if (m.index < finBloque) continue;                                  // dentro del bloque anterior
          while (pie < pies.length && pies[pie]!.index < m.index + m[0].length) pie++;
          const p = pies[pie];
          if (!p) break;
          finBloque = p.index + p[0].length;
          ts.push([m.index, finBloque]);
        }
      } else
        for (const m of w.matchAll(CONEXION_LINEAL))
          if (m[2] !== undefined) { const arroba = m.index + m[0].length - 1; ts.push([arroba - (m[1] ?? '').length, arroba]); }
      for (const x of ts) out.push(x);
      w = rellenar(w, ts);
      continue;
    }
    // Lo que el reemplazo conserva delante ($1$2=, $1://$2:, o el `Bearer ` del grupo 1) y detrás (la @).
    const i = rep.indexOf('[REDACTADO'), pre = rep.slice(0, i), suf = rep.slice(rep.indexOf(']', i) + 1);
    w = w.replace(re, (m: string, ...g: unknown[]) => {
      const idx = g[g.length - 2] as number, grupo = (n: number) => (typeof g[n - 1] === 'string' ? g[n - 1] as string : '');
      const queda = !pre ? 0 : pre.startsWith('$') ? pre.replace(/\$(\d)/g, (_, n: string) => grupo(Number(n))).length : grupo(1).length;
      const d = m.length - suf.length;
      if (d > queda) out.push([idx + queda, idx + d]);
      return m.slice(0, queda) + '\0'.repeat(Math.max(0, d - queda)) + m.slice(d);
    });
  }
  for (const m of w.matchAll(URL_QUERY)) if (m[2] !== undefined) queries.push([m.index + (m[1] ?? '').length, m.index + m[0].length]);
  return { patrones: out, queries };
}
function tapaClaves(s: string): string {
  const vista = s.replace(MARCADORES, (m) => '\0'.repeat(m.length));    // [SECRET:…] no casa como clave ni como valor
  const tramos: Tramo[] = [];
  GENERICA.lastIndex = 0;
  let hasta = 0;
  for (let m = GENERICA.exec(vista); m; m = GENERICA.exec(vista)) {      // sin vacías: cada coincidencia avanza
    const v = m[REGLA_GENERICA.grupo] ?? '';
    if (!valorGenerico(v)) continue;
    const fin = m.index + m[0].length, ini = fin - v.length;                // el valor cierra la coincidencia
    // hasta crece: cada car. de cola se mira una vez. Las comillas, desde el fin propio (como mucho 256 car. por valor).
    hasta = Math.max(finColaGenerica(vista, Math.max(fin, hasta)), finComillas(vista, ini, fin));
    tramos.push([ini, hasta]);
  }
  for (const m of vista.matchAll(AUTH_JSON))                               // solo marcadores y blancos: nada que tapar
    if (!REFERENCIA.test(m[2] ?? '') && /[^\0\s]/.test(m[2] ?? '')) tramos.push([m.index + (m[1] ?? '').length, m.index + m[0].length]);
  for (const re of [ASIGNACION, CAMEL])
    for (const m of vista.matchAll(re)) {
      const ini = m.index + (m[1] ?? '').length;
      if (tapable(m[2] ?? '')) tramos.push([ini, finComillas(vista, ini, m.index + m[0].length)]);
    }
  if (!tramos.length) return s;
  // Un tramo que pisa una URL con query antes de su `?`, o en él, sigue hasta el fin de la query (j solo avanza: lineal).
  const urls: Array<readonly [number, number, number]> = [];               // [inicio de la URL, su `?`, fin de la query]
  for (const m of vista.matchAll(URL_QUERY))
    if (m[2] !== undefined) urls.push([m.index, m.index + (m[1] ?? '').length, m.index + m[0].length]);
  let j = 0;
  let union = juntar(juntar(tramos).map(([ini, f]): Tramo => {
    let fin = f;
    while (j < urls.length && urls[j]![1] < ini) j++;                      // su `?` queda antes: la regla la sigue viendo
    for (; j < urls.length && urls[j]![0] < fin; j++) fin = Math.max(fin, urls[j]![2]);
    return [ini, fin];
  }));
  // 3. Entra en la unión lo de HEAD que la salida no tapa y lo que HEAD tapaba con un patrón y la unión pisa a medias
  //    (`Bearer a.key=…` sale `Bearer [REDACTADO]`, no `Bearer [REDACTADO][REDACTADO]`). Tras MAX_VUELTAS, todo lo de HEAD.
  const h0 = tapadoPorHead(vista), patrones = juntar(h0.patrones), head = juntar([...h0.patrones, ...h0.queries]);
  const cabezas: Array<readonly [number, number, number]> = [];            // [inicio, inicio de lo tapado, fin]
  for (const [cabeza, valor] of CABEZAS) {
    let ini = -1, fin = -1;                                                 // el último valor visto: varias cabezas, un valor
    for (const m of vista.matchAll(cabeza)) {
      const v = m.index + m[0].length;
      if (v < ini || v >= fin) { valor.lastIndex = v; ini = v; fin = valor.exec(vista) ? valor.lastIndex : v; }
      if (fin > v) cabezas.push([m.index, v, fin]);
    }
  }
  const dentro = (h: Tramo, o: Tramo | undefined) => !!o && o[0] <= h[0] && o[1] >= h[1];
  // El primer tramo de ts (unión, en orden) que acaba después de x: búsqueda binaria.
  const tras = (ts: readonly Tramo[], x: number) => {
    let lo = 0, hi = ts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid]![1] <= x) lo = mid + 1; else hi = mid; }
    return ts[lo];
  };
  for (let vuelta = 0; head.length || cabezas.length; vuelta++) {
    const hs = tapadoPorHead(rellenar(vista, union));
    const salida = juntar([...union, ...hs.patrones, ...hs.queries]);
    const faltan: Tramo[] = [];
    let k = 0, q = 0;
    for (const h of head) {                                                 // todos en orden: lineal
      while (k < salida.length && salida[k]![1] <= h[0]) k++;
      if (!dentro(h, salida[k])) faltan.push(h);
    }
    for (const h of patrones) {
      while (q < union.length && union[q]![1] <= h[0]) q++;
      const u = union[q];
      if (u && u[0] < h[1] && !dentro(h, u)) faltan.push(h);
    }
    for (const [c0, c1, c2] of cabezas) {
      const o = tras(salida, c0);
      if (o && o[0] < c1 && !dentro([c1, c2], tras(salida, c1))) faltan.push([c1, c2]);
    }
    if (!faltan.length) break;
    union = juntar([...union, ...(vuelta < MAX_VUELTAS ? faltan : head)]);
    if (vuelta >= MAX_VUELTAS) break;
  }
  let out = '', desde = 0;
  for (const [ini, fin] of union) { out += s.slice(desde, ini) + '[REDACTADO]'; desde = fin; }
  return out + s.slice(desde);
}
const tel = (t: string) => { const d = t.replace(/\D/g, ''); return '+' + d.slice(0, 2) + '•••' + d.slice(-4); };   // +58•••4567 (S15 15.11)
// Atajo de CPU: las capas de asignación necesitan una de sus palabras clave y un separador (: = %3D &#61;); la mayoría de
// los strings de una evidencia no traen las dos cosas y se ahorran seis pasadas.
const PISTA_CLAVE = /access|api|auth|cred|key|pass|secret|token/i, PISTA_SEP = /[:=%&]/;
export function redactString(entrada: string): string {
  const conClave = PISTA_CLAVE.test(entrada) && PISTA_SEP.test(entrada);
  // Las capas por clave, lo primero: la genérica tiene que ver el texto tal cual lo ve scan.ts; después, los patrones.
  const s = conClave ? tapaClaves(entrada) : entrada;
  let fin = s;
  for (const [re, rep] of PATRONES_SECRETO) fin = fin.replace(re, rep);
  fin = fin
    .replace(URL_QUERY, (u: string, url: string, q?: string) => (q === undefined ? u : url))   // query strings fuera
    .replace(/\b([\w.+-])[\w.+-]*@((?:[\w-]+\.)+[A-Za-z]{2,})\b/g, '$1***@$2')                  // a***@dominio; respeta paquete@1.2.3
    .replace(/\+\d{8,15}\b/g, tel);                                                             // +58•••4567
  // Otra vez si algo cambió: a***@ y +58••• alargan un valor corto, un patrón puede llevarse el `example` que descartaba
  // un valor, y un tramo ligado puede comerse la comilla en la que paraba otro valor; sin esta pasada, f(f(x)) ≠ f(x).
  return conClave && fin !== entrada ? tapaClaves(fin) : fin;
}
export function redact<T>(v: T, prof = 0): T {
  if (typeof v === 'string') return redactString(v) as T;
  if (prof >= 8) return '[demasiado profundo]' as T;
  if (Array.isArray(v)) return v.map((x) => redact(x, prof + 1)) as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      o[k] = CLAVE_SECRETA.test(k) && x != null && x !== '' ? '[REDACTADO]'
           : CLAVE_TELEFONO.test(k) && typeof x === 'string' && /^\+?\d{8,15}$/.test(x) ? tel(x)
           : redact(x, prof + 1);
    return o as T;
  }
  return v;
}

// ── Export (S13 13.2): pura e idempotente, claves ordenadas; orden fijo patrones → claves → IP → truncar ──────────────
export type OpcionesExport = { ips: 'mask_24' | 'full' };
// Clave anclada al final: no toca `path`, `paths_4xx`, `dedupe_key`, `rule_id` ni `fingerprint_short`.
const CLAVE_EXPORT = /^(.*[_-])?(pass(word)?|passwd|secret|token|api_?key|authorization|cookie|private_key|pat|sealed|wdek)$/i;
const TRUNCADO = '…[truncado]';
const MAX_STR = 2000, MAX_TITULO = 300, MAX_FIX = 12000;
// El resultado mide como mucho `max` (marcador incluido): así una segunda pasada no vuelve a cortar.
const recortar = (s: string, max: number) => (s.length > max ? s.slice(0, max - TRUNCADO.length) + TRUNCADO : s);

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function gruposV6(s: string): string[] | null {                        // los 8 grupos de una IPv6 sin zona, o null
  if (!s.includes(':') || !/^[0-9a-f:]+$/i.test(s)) return null;
  const partes = s.split('::');
  if (partes.length > 2) return null;
  const izq = partes[0] ? partes[0].split(':') : [];
  const der = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  if ([...izq, ...der].some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const faltan = 8 - izq.length - der.length;
  if (partes.length === 2 ? faltan < 1 : faltan !== 0) return null;
  return [...izq, ...Array<string>(partes.length === 2 ? faltan : 0).fill('0'), ...der];
}
const v4Mapeada = (s: string) => /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s)?.[1];
const esIp = (s: string) => IPV4.test(s) || gruposV6(s) !== null || IPV4.test(v4Mapeada(s) ?? '');
/** IPv4 → a.b.c.0/24; IPv6 → 3 primeros grupos + ::/48. Deja igual lo ya enmascarado y lo que no es una IP. */
function enmascararIp(s: string): string {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.0\/24$/.test(s) || /^[0-9a-f:]+::\/48$/i.test(s)) return s;
  const v4 = IPV4.test(s) ? s : v4Mapeada(s);
  if (v4 && IPV4.test(v4)) return v4.split('.').slice(0, 3).join('.') + '.0/24';
  const g = gruposV6(s);
  return g ? g.slice(0, 3).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/48' : s;
}
// Solo por posición conocida, nunca por regex libre (rompería versiones como 2.0.0.1).
function ipPorPosicion(clave: string, s: string): string {
  if (clave === 'ip' || clave === 'ips' || clave === 'client_ip') return enmascararIp(s);   // top_ips[].ip cae en `ip`
  if (clave === 'target' && esIp(s)) return enmascararIp(s);                              // actions.target
  if ((clave === 'resource' || clave === 'target') && s.startsWith('ip:')) return 'ip:' + enmascararIp(s.slice(3));
  return s;
}
function exportar(v: unknown, o: OpcionesExport, clave: string, padre: string, prof: number): unknown {
  if (typeof v === 'string') {
    let s = redactString(v);
    if (o.ips === 'mask_24') s = ipPorPosicion(clave, s);
    const max = clave === 'text' && padre === 'fix' ? MAX_FIX : clave === 'title' || clave === 'resource' ? MAX_TITULO : MAX_STR;
    return recortar(s, max);
  }
  if (prof >= 8) return '[demasiado profundo]';
  if (Array.isArray(v)) return v.map((x) => exportar(x, o, clave, padre, prof + 1));       // ips[] hereda la clave `ips`
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const x = src[k];
      out[k] = CLAVE_EXPORT.test(k) && x != null && x !== '' ? '[REDACTADO]' : exportar(x, o, k, clave, prof + 1);
    }
    return out;
  }
  return v;
}
/** Redacción de todo lo que sale en un export o por el MCP: patrones de redact() + clave anclada + IP + longitud. */
export function redactForExport<T>(value: T, opts: OpcionesExport): T {
  return exportar(value, opts, '', '', 0) as T;
}
