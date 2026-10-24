// Reglas en vivo del borde (S15 15.9 literal, S12 12.2): filas de vg_edge_window (una por IP, últimos 60 s) → reglas
// disparadas y un incidente por IP. Puro: sin red ni base. La IP completa solo va a `ip`, `resource` y `details`; el
// título y los mensajes llevan la IP recortada (186.92.x.x) y la herramienta de una lista fija, nunca el user-agent crudo.
import { parseIp, textoIp } from '../ip.ts';
import { redactString } from '../redact.ts';
import { unaLinea } from '../templates/titles.ts';

export type EdgeRuleId = 'CF_ADMIN_EXPOSED' | 'CF_PATH_SCAN' | 'CF_UA_TOOL' | 'CF_IP_FLOOD';
/** Fila de vg_edge_window (0006): conteos de una IP en la ventana; `total` = peticiones de toda la org en la ventana. */
export type EdgeWindowRow = { ip: string; n: number; paths_4xx: number; probe_hits: number; admin_ok: number;
  n5xx: number; p95_ms: number | null; ua_top: string | null; total: number };
export type EdgeHit = { rule_id: EdgeRuleId; severity: 'critical' | 'high'; ip: string; row: EdgeWindowRow };

// Literal de S15 15.9 / S12 12.2. Sin bandera g: test() no guarda estado entre filas.
export const TOOL_UA = /(sqlmap|nikto|nmap|masscan|zgrab|nuclei|wpscan|python-requests|go-http-client|curl\/|aiohttp|scrapy|headlesschrome)/i;
/** Umbrales [propuesta] de canónicas §9.1. Los de volumen (paths_4xx, n) se multiplican por f = meta.ingest_factor (P1). */
export const UMBRALES_EDGE = Object.freeze({
  admin_ok: 1, paths_4xx: 20, probe_hits: 1, ua_n: 20, flood_n: 100, flood_share: 0.2, flood_5xx: 0.05, flood_p95_ms: 2000,
});
/** Orden de rule_ids del incidente (el de los fixtures y el ejemplo de E17). */
export const ORDEN_REGLAS_EDGE: readonly EdgeRuleId[] = ['CF_UA_TOOL', 'CF_PATH_SCAN', 'CF_ADMIN_EXPOSED', 'CF_IP_FLOOD'];

const factor = (f: number) => (Number.isFinite(f) && f > 0 ? f : 1);
const uaVacia = (ua: string | null) => !(ua ?? '').trim();

/** S15 15.9: una entrada por regla disparada y fila. Lineal en filas. Las razones se comparan multiplicando enteros
 *  (n/total ≥ 0,20 ⇔ 5·n ≥ total; n5xx/n ≥ 0,05 ⇔ 20·n5xx ≥ n) para que el borde exacto no dependa del redondeo. */
export function evaluateEdge(rows: readonly EdgeWindowRow[], f = 1): EdgeHit[] {
  const k = factor(f), U = UMBRALES_EDGE, out: EdgeHit[] = [];
  for (const r of rows) {
    if (r.admin_ok >= U.admin_ok) out.push({ rule_id: 'CF_ADMIN_EXPOSED', severity: 'critical', ip: r.ip, row: r });
    if (r.paths_4xx >= U.paths_4xx * k || r.probe_hits >= U.probe_hits)
      out.push({ rule_id: 'CF_PATH_SCAN', severity: 'high', ip: r.ip, row: r });
    if (r.n >= U.ua_n * k && (uaVacia(r.ua_top) || TOOL_UA.test(r.ua_top ?? '')))
      out.push({ rule_id: 'CF_UA_TOOL', severity: 'high', ip: r.ip, row: r });
    if (r.n >= U.flood_n * k && r.total > 0 && r.n * 5 >= r.total) {
      const crit = (r.n > 0 && r.n5xx * 20 >= r.n) || (r.p95_ms ?? 0) >= U.flood_p95_ms;
      out.push({ rule_id: 'CF_IP_FLOOD', severity: crit ? 'critical' : 'high', ip: r.ip, row: r });
    }
  }
  return out;
}

// ── Filas tal como llegan de PostgREST ───────────────────────────────────────────────────────────────────────────
const entero = (v: unknown): number => {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
};
const real = (v: unknown): number | null => {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
};
/** Una fila cruda de `rpc('vg_edge_window')` (bigint/numeric pueden llegar como texto) → EdgeWindowRow, o null si no
 *  trae IP. `total` nunca queda por debajo de `n`. */
export function normalizarFilaVentana(raw: unknown): EdgeWindowRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ip = typeof o.ip === 'string' ? o.ip.trim() : '';
  if (!ip || ip.length > 64) return null;
  const n = entero(o.n);
  return { ip, n, paths_4xx: entero(o.paths_4xx), probe_hits: entero(o.probe_hits), admin_ok: entero(o.admin_ok),
    n5xx: entero(o.n5xx), p95_ms: real(o.p95_ms), ua_top: typeof o.ua_top === 'string' ? o.ua_top.slice(0, 200) : null,
    total: Math.max(entero(o.total), n) };
}

// ── IP: forma canónica (dedupe) y recortada (títulos y mensajes) ─────────────────────────────────────────────────
/** IP suelta en forma canónica (IPv6 corta en minúsculas); acepta el sufijo /32 o /128 que puede traer un inet. */
export function ipCanonica(s: string): string | null {
  const ip = parseIp(String(s ?? '').trim().replace(/\/(32|128)$/, ''));
  return ip ? textoIp(ip) : null;
}
/** IP recortada para títulos y mensajes: IPv4 /16 → 186.92.x.x; IPv6 /32 → 2800:3f0:x:x:x:x:x:x. Nunca devuelve el
 *  texto de entrada si no es una IP. */
export function ipCorta(s: string): string {
  const t = String(s ?? '').trim().replace(/\/\d{1,3}$/, '');
  const ip = parseIp(t);
  if (ip && ip.v === 4) return `${(ip.n >>> 24) & 255}.${(ip.n >>> 16) & 255}.x.x`;
  if (ip && ip.v === 6) {
    const n = ip.n;
    const g = (i: number) => Number((n >> BigInt(112 - 16 * i)) & 0xffffn).toString(16);
    return `${g(0)}:${g(1)}:x:x:x:x:x:x`;
  }
  const mapeada = /:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(t);          // ::ffff:1.2.3.4
  return mapeada && +mapeada[1]! <= 255 && +mapeada[2]! <= 255 ? `${mapeada[1]}.${mapeada[2]}.x.x` : 'x.x.x.x';
}
const IPV4_SUELTA = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** `incidents.resource` para mensajes: ip:186.92.14.7 → ip:186.92.x.x; otros recursos en una línea (≤ 80) y con
 *  cualquier IPv4 suelta recortada. */
export function recursoCorto(resource: string): string {
  const r = String(resource ?? '');
  if (r.startsWith('ip:')) return 'ip:' + ipCorta(r.slice(3));
  return unaLinea(r.replace(IPV4_SUELTA, (m) => ipCorta(m)), 80);
}

// ── User-agent: solo la herramienta de la lista fija sale a textos ───────────────────────────────────────────────
const HERRAMIENTA = new RegExp(TOOL_UA.source + '(\\/?[0-9][0-9.]{0,15})?', 'i');
/** Herramienta + versión tal como casó TOOL_UA (sqlmap/1.8, curl/8.4.0, Nmap) o null. Solo letras, dígitos, . - /:
 *  «sqlmap … IGNORE ALL RULES» da «sqlmap». */
export function herramientaUa(ua: string | null | undefined): string | null {
  const m = HERRAMIENTA.exec(ua ?? '');
  return m ? m[0].replace(/\.+$/, '') : null;
}
/** Nombre corto de la herramienta en minúsculas (sqlmap, curl, headlesschrome) o null. */
export function nombreHerramienta(ua: string | null | undefined): string | null {
  const m = TOOL_UA.exec(ua ?? '');
  return m ? m[1]!.toLowerCase().replace(/\/$/, '') : null;
}
/** {ua} de la plantilla de CF_UA_TOOL: la herramienta, «sin User-Agent» o «herramienta desconocida». */
export const uaParaMensaje = (ua: string | null | undefined): string =>
  herramientaUa(ua) ?? (uaVacia(ua ?? null) ? 'sin User-Agent' : 'herramienta desconocida');

// Port del check private.looks_like_secret de incidents (0001): un UA con forma de clave haría fallar el insert del
// incidente (el atacante esquivaría la alerta). Con bandera g para reemplazar todas.
const PARECE_SECRETO = /(sb_secret_[A-Za-z0-9_-]{16,}|sbp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|vg[iks]_[A-Za-z0-9_-]{20,}|cf(k|ut|at)_[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.)/g;
/** UA para `details.ua_top`: sin formas de clave, redactado (correos, teléfonos, query) y en una línea de ≤ 120. */
export function uaSegura(ua: string | null | undefined): string | null {
  if (ua == null) return null;
  return unaLinea(redactString(String(ua).replace(PARECE_SECRETO, '[REDACTADO]')), 120).replace(PARECE_SECRETO, '[REDACTADO]');
}

// ── Incidente por IP (canónicas §9.1) ────────────────────────────────────────────────────────────────────────────
/** Título del incidente (≤ 120): herramienta de la lista fija y la IP recortada. «Escaneo con sqlmap y /admin abierto
 *  desde 186.92.x.x» (ejemplo de S15 15.9 y E17). */
export function tituloIncidenteEdge(reglas: readonly string[], ua: string | null | undefined, ip: string): string {
  const A = reglas.includes('CF_ADMIN_EXPOSED'), S = reglas.includes('CF_PATH_SCAN');
  const T = reglas.includes('CF_UA_TOOL'), F = reglas.includes('CF_IP_FLOOD');
  const h = nombreHerramienta(ua) ?? 'herramienta';
  const base = A ? (T ? `Escaneo con ${h} y /admin abierto` : S ? 'Escaneo de rutas y /admin abierto'
      : F ? 'Inundación y /admin abierto' : 'Ruta de admin abierta sin sesión')
    : T && S ? `Escaneo de rutas con ${h}`
    : T ? (F ? `Inundación con ${h}` : `Tráfico con ${h}`)
    : S ? (F ? 'Inundación y escaneo de rutas' : 'Escaneo de rutas')
    : 'Inundación de peticiones';
  return unaLinea(`${base} desde ${ipCorta(ip)}`);
}

export type ContextoEdge = {
  org_id: string;
  host: string;            // connections.label de la conexión ingest que trajo los eventos ({host} de §12.6)
  f?: number;              // meta.ingest_factor (P1, defecto 1)
};
/** `incidents.details` (S15 15.9) + host, source y share_pct (lo que pide la plantilla de CF_IP_FLOOD). */
export type DetallesEdge = {
  ip: string; host: string; source: 'ingest'; ua_top: string | null; n_60s: number; total_60s: number; share_pct: number;
  paths_4xx: number; probe_hits: number; admin_ok: number; n5xx: number; p95_ms: number | null;
};
export type IncidenteEdge = {
  ip: string;                           // canónica y completa: p_ip, resource y details; nunca a títulos ni mensajes
  rule_ids: EdgeRuleId[];               // en ORDEN_REGLAS_EDGE
  severity: 'critical' | 'high';        // la mayor de sus reglas
  title: string;
  resource: string;                     // ip:186.92.14.7 (≤ 48 car.; la columna admite 120)
  resource_corto: string;               // ip:186.92.x.x ({recurso} de §12.6)
  dedupe_input: string;                 // org_id|edge|ip
  details: DetallesEdge;
  hits: EdgeHit[];
};
export type IncidenteEdgeConClave = IncidenteEdge & { dedupe_key: string };

export const dedupeInputEdge = (orgId: string, ip: string) => `${orgId}|edge|${ip}`;
const te = new TextEncoder();
/** sha256hex(org_id|edge|ip): hex de 64 (check de incidents.dedupe_key). WebCrypto estándar, sin importar crypto.ts. */
export async function dedupeKeyEdge(orgId: string, ip: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(dedupeInputEdge(orgId, ip))));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

const detalles = (ip: string, r: EdgeWindowRow, host: string): DetallesEdge => ({
  ip, host: unaLinea(host, 60), source: 'ingest', ua_top: uaSegura(r.ua_top), n_60s: r.n, total_60s: r.total,
  share_pct: r.total > 0 ? Math.min(100, Math.round((100 * r.n) / r.total)) : 0, paths_4xx: r.paths_4xx,
  probe_hits: r.probe_hits, admin_ok: r.admin_ok, n5xx: r.n5xx, p95_ms: r.p95_ms === null ? null : Math.round(r.p95_ms),
});

/** Agrupa por IP las reglas disparadas en la ventana: un IncidenteEdge por IP con alguna regla, critical primero.
 *  Lineal en filas. Una fila con IP no válida no abre incidente (no se podría deduplicar ni bloquear). */
export function agruparEdge(rows: readonly EdgeWindowRow[], ctx: ContextoEdge): IncidenteEdge[] {
  const porIp = new Map<string, { row: EdgeWindowRow; hits: EdgeHit[] }>();
  for (const h of evaluateEdge(rows, ctx.f ?? 1)) {
    const ip = ipCanonica(h.ip);
    if (!ip) continue;
    const g = porIp.get(ip);
    if (g) g.hits.push(h); else porIp.set(ip, { row: h.row, hits: [h] });
  }
  const out: IncidenteEdge[] = [];
  for (const [ip, { row, hits }] of porIp) {
    const reglas = new Set(hits.map((h) => h.rule_id));
    const rule_ids = ORDEN_REGLAS_EDGE.filter((r) => reglas.has(r));
    out.push({
      ip, rule_ids, severity: hits.some((h) => h.severity === 'critical') ? 'critical' : 'high',
      title: tituloIncidenteEdge(rule_ids, row.ua_top, ip), resource: `ip:${ip}`, resource_corto: `ip:${ipCorta(ip)}`,
      dedupe_input: dedupeInputEdge(ctx.org_id, ip), details: detalles(ip, row, ctx.host), hits,
    });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
}

/** agruparEdge + dedupe_key de cada incidente: lo que la evaluación en vivo pasa a vg_upsert_incident. */
export async function evaluarVentanaEdge(rows: readonly EdgeWindowRow[], ctx: ContextoEdge): Promise<IncidenteEdgeConClave[]> {
  const xs = agruparEdge(rows, ctx);
  const claves = await Promise.all(xs.map((x) => dedupeKeyEdge(ctx.org_id, x.ip)));
  return xs.map((x, i) => ({ ...x, dedupe_key: claves[i]! }));
}
