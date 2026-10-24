// Redacción de secretos para logs, evidencia, prompts y export (S06 06.5 literal, S15 15.11, S13 13.2). Dos pasadas:
// por clave (segmentos separados por _/-: `path`, `input_tokens` y `max_tokens` salen intactas) y por patrón sobre todo string.
const CLAVE_SECRETA = /(^|[_-])(token|secret|password|passwd|pat|apikey|api[_-]key|authorization|cookie|sealed|wdek|ivk|private[_-]key)($|[_-])/i;
const CLAVE_TELEFONO = /^(phone|phone_e164|to|from|to_number|wa_id|recipient)$/i;
/** [patrón con bandera g, reemplazo]. */
export const PATRONES_SECRETO: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[REDACTADO:clave_privada]'],
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
  [/\bvg[iks]_[A-Za-z0-9_-]{20,}/g, '[REDACTADO:token]'],                                     // vgi_ ingesta (S05), vgk_ MCP, vgs_ (S13)
  [/\bcf(?:k|ut|at)_[A-Za-z0-9_-]{30,}/g, '[REDACTADO:cloudflare]'],                             // formatos nuevos de Cloudflare (token-formats)
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTADO:api_key]'],                                       // clave de Google (PSI, S10)
  // Parámetros con secreto, dentro o fuera de una URL: key= de PSI, ?token=, &access_token=, client_secret=, sig=…
  [/(^|[?&\s;,"'(])((?:access_|refresh_|id_|auth_)?token|api[_-]?key|key|client_secret|secret|password|passwd|sig|signature)=([^&\s"'<>#;,)]+)/gi,
    '$1$2=[REDACTADO]'],
  [/\b(?:AKIA|ASIA)[A-Z2-7]{16}\b/g, '[REDACTADO:token]'],
  // Cabecera Authorization pegada en texto (log, evidencia, README): se tapa entera, con o sin esquema.
  [/\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s,;"']+/gi, '$1[REDACTADO]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTADO]'],
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/([^:\s/@]+):[^@\s]+@/g, '$1://$2:[REDACTADO]@'],
];
const tel = (t: string) => { const d = t.replace(/\D/g, ''); return '+' + d.slice(0, 2) + '•••' + d.slice(-4); };   // +58•••4567 (S15 15.11)
export function redactString(s: string): string {
  for (const [re, rep] of PATRONES_SECRETO) s = s.replace(re, rep);
  return s
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, '$1')                                          // query strings fuera
    .replace(/\b([\w.+-])[\w.+-]*@((?:[\w-]+\.)+[A-Za-z]{2,})\b/g, '$1***@$2')                  // a***@dominio; respeta paquete@1.2.3
    .replace(/\+\d{8,15}\b/g, tel);                                                             // +58•••4567
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
