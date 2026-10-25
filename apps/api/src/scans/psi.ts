import type { SupabaseClient } from '@supabase/supabase-js';
import { sha256hex } from '@vanguard/core/crypto';
import type { FnPaso, MsgScan, ResultadoPaso } from '../jobs.ts';
import { db } from '../lib/db.ts';
import { ProviderError, pedir } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { PARECE_SECRETO } from './comun.ts';
import { leerAcotado } from './repo.ts';

// «Medir ahora» de Rendimiento (función 5, PLAN_MAESTRO §10.2–10.5): un kind 'lighthouse' de E11 lleva un único paso psi
// (una estrategia por medición, como fija ScanCreate) que llama a PageSpeed Insights v5 y escribe UNA fila en perf_runs con
// el formato de la siembra (demo/seed-perf.sql, §10.11). Sin Edge Function vg-psi: el parámetro `fields` de Google deja
// fuera capturas, pantalla completa y entidades (≈330 KB en vez del LHR de 0,5–1,5 MB; JSON.parse ≈ 1 ms en V8).
// El Worker nunca pide la URL del cliente: solo Google la carga. La clave va solo en la query a googleapis.com y nunca en
// logs ni errores (pedir() registra el motivo, nunca la URL).

export type Strategy = 'mobile' | 'desktop';
const ESTRATEGIAS: readonly string[] = ['mobile', 'desktop'];
const PSI = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CATEGORIAS = ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO'];
// La API de PSI admite hasta 120 s por análisis (§10.1): 130 s caben en el reloj de un consumidor de cola (15 min).
export const PLAZO_PSI = 130_000;
// Con la máscara de abajo la respuesta ronda 330–340 KB (las ~150 auditorías del mapa audits; medido por el ORQUESTADOR
// con example.com). 1 MB deja margen; más es que Google mandó otra cosa: se corta sin parsear.
export const TOPE_CUERPO_PSI = 1_000_000;
const TOPE_ERROR = 16_384;   // el cuerpo de un 4xx/5xx solo se mira para el «Lighthouse returned error: X»
// Errores de clave de las APIs de Google (mensaje y google.rpc.ErrorInfo.reason): «API key not valid…», «API key expired…».
const CLAVE_MALA = /API key (?:not valid|expired)|API_KEY_(?:INVALID|EXPIRED)/i;
const VERSION = /^[A-Za-z0-9_.-]{1,40}$/;   // el check de perf_runs.version_label
const URL_BD = /^https:\/\/[a-z0-9.-]+(\/[^?#\s]*)?$/;   // el check de perf_runs.url (0007)

// Métricas de §10.3: audits.<id>.numericValue, TTFB de metrics (respaldo server-response-time) y el contexto de
// resource-summary. audits y categories son MAPAS del LHR: la máscara de `fields` de Google no deja elegir claves
// dentro de un mapa (400 INVALID_ARGUMENT, probado por el ORQUESTADOR), así que van enteros; resumirLhr toma lo suyo.
export const CAMPOS_PSI = 'lighthouseResult(lighthouseVersion,fetchTime,finalUrl,finalDisplayedUrl,runtimeError,categories,audits)';

// ── Guarda de la URL (E11 y otra vez en el paso) ─────────────────────────────────────────────────────────────────────
// Nunca se mide VanGUARD: su apex y subdominios, el Worker de respaldo en workers.dev y su proyecto de Supabase. En
// ejecución se suman los hosts de APP_ORIGIN y SUPABASE_URL (hostsPropios).
export const HOSTS_PROPIOS: readonly string[] = ['officialvanguard.com', 'giovannizm14.workers.dev',
  'accshmgmfrqrxubpuxcl.supabase.co'];
// Nombres que no son de internet (RFC 6761/6762 y los de red local de uso común): ni localhost ni .local ni .internal.
const INTERNOS = ['localhost', 'local', 'internal', 'lan', 'arpa', 'test', 'invalid', 'example', 'onion'];
const ETIQUETA = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class UrlNoMedible extends Error {
  readonly motivo: string;
  constructor(motivo: string, mensaje: string) {
    super(mensaje);
    this.name = 'UrlNoMedible';
    this.motivo = motivo;
  }
}

const hostDe = (u: string | undefined) => { try { return u ? new URL(u).hostname.toLowerCase() : null; } catch { return null; } };
export const hostsPropios = (env: Partial<Pick<CloudflareBindings, 'APP_ORIGIN' | 'SUPABASE_URL'>>): string[] =>
  [...new Set([...HOSTS_PROPIOS, hostDe(env.APP_ORIGIN), hostDe(env.SUPABASE_URL)].filter((h): h is string => !!h))];

/** https de internet, sin IPs, credenciales ni puertos, y nunca un host propio → `https://host/ruta` (sin query ni
 *  fragmento: el check de perf_runs.url y el histórico de E24 comparan por esa forma). Lanza UrlNoMedible con el motivo.
 *  permitidos: hosts exactos que se saltan SOLO la regla de host propio (la víctima de la demo, ver urlMedibleOrg). */
export function urlMedible(raw: string, propios: readonly string[] = HOSTS_PROPIOS, permitidos: readonly string[] = []): string {
  const no = (motivo: string, mensaje: string): never => { throw new UrlNoMedible(motivo, mensaje); };
  if (raw.length > 2048) no('largo', 'La URL es demasiado larga (máximo 2048 caracteres)');
  let u: URL | null = null;
  try { u = new URL(raw); } catch { /* abajo */ }
  if (!u) return no('url', 'No es una URL válida');
  if (u.protocol !== 'https:') no('https', 'Solo medimos URLs https://');
  if (u.username || u.password) no('credenciales', 'Quita el usuario y la contraseña de la URL');
  if (u.port) no('puerto', 'Solo medimos el puerto estándar de https (443)');
  // URL ya normaliza 2130706433, 0x7f.1 o 127.1 a 127.0.0.1; IPv6 llega entre corchetes.
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') || /^\d+(\.\d+){3}$/.test(h)) no('ip', 'No medimos direcciones IP: usa el dominio del sitio');
  if (INTERNOS.some((s) => h === s || h.endsWith(`.${s}`))) no('interno', 'No medimos hosts locales ni de red interna');
  const etiquetas = h.split('.');
  if (etiquetas.length < 2 || !etiquetas.every((e) => ETIQUETA.test(e))) no('host', 'Usa un dominio público, como tusitio.com');
  if (!permitidos.includes(h) && propios.some((p) => h === p || h.endsWith(`.${p}`))) {
    no('propio', 'Esa URL es de VanGUARD: mide la de tu sitio');
  }
  const limpia = `https://${h}${u.pathname || '/'}`;
  if (!URL_BD.test(limpia)) no('url', 'No es una URL válida');
  if (PARECE_SECRETO.test(limpia)) no('secreto', 'La URL parece llevar un secreto: quítalo antes de medir');
  return limpia;
}

// Excepción (decisión de Giovanni, sáb 24-oct): la víctima de la demo se mide, pero SOLO desde la org de demo
// (orgs.is_demo; prueba v2-regresion de §10.11). La org solo se lee si la URL es exactamente ese host.
export const HOST_VICTIMA_DEMO = 'demo.officialvanguard.com';
export async function urlMedibleOrg(admin: SupabaseClient, orgId: string, raw: string, propios: readonly string[]): Promise<string> {
  try {
    return urlMedible(raw, propios);
  } catch (e) {
    if (!(e instanceof UrlNoMedible) || e.motivo !== 'propio' || hostDe(raw)?.replace(/\.$/, '') !== HOST_VICTIMA_DEMO) throw e;
    const { data, error } = await admin.from('orgs').select('is_demo').eq('id', orgId).maybeSingle();
    if (error) throw new ProviderError('unavailable');
    if ((data as { is_demo?: unknown } | null)?.is_demo !== true) throw e;
    return urlMedible(raw, propios, [HOST_VICTIMA_DEMO]);
  }
}

/** La petición a PSI: estrategia siempre explícita (el valor por defecto de Google es DESKTOP), las 4 categorías en el enum
 *  oficial, locale es, `fields` y prettyPrint=false (parámetros de sistema de las APIs de Google). Lleva la clave: nunca se
 *  registra ni se devuelve. */
export function urlPsi(url: string, s: Strategy, clave: string): string {
  const q = new URLSearchParams({ url, strategy: s.toUpperCase(), locale: 'es', fields: CAMPOS_PSI, prettyPrint: 'false' });
  for (const c of CATEGORIAS) q.append('category', c);
  q.append('key', clave);
  return `${PSI}?${q}`;
}

// ── Del LHR recortado a la fila de perf_runs (mismo formato que summarize/toPerfRow de scripts/perf-medir.ts) ──────────
type Auditoria = { numericValue?: unknown; details?: { items?: unknown } };
export type LhrRecortado = {
  lighthouseVersion?: unknown; fetchTime?: unknown; finalUrl?: unknown; finalDisplayedUrl?: unknown;
  runtimeError?: { code?: unknown };
  categories?: Record<string, { score?: unknown } | undefined>; audits?: Record<string, Auditoria | undefined>;
};
type N = number | null;
export type Metricas = { lcp_ms: N; tbt_ms: N; cls: N; fcp_ms: N; si_ms: N; ttfb_ms: N; tti_ms: N; total_bytes: N; script_bytes: N;
  request_count: N };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const entero = (v: unknown) => { const n = num(v); return n === null ? null : Math.round(n); };
const texto = (v: unknown) => (typeof v === 'string' && v ? v : null);
export const METRICAS_VACIAS: Metricas = { lcp_ms: null, tbt_ms: null, cls: null, fcp_ms: null, si_ms: null, ttfb_ms: null,
  tti_ms: null, total_bytes: null, script_bytes: null, request_count: null };

/** scores con las claves del LHR tal cual (best-practices con guion) y metrics de §10.3; lo que falte va null. */
export function resumirLhr(lhr: LhrRecortado): { scores: Record<string, number | null>; metrics: Metricas } {
  const a = lhr.audits ?? {};
  const valor = (id: string) => a[id]?.numericValue;
  const items = (id: string) => {
    const x = a[id]?.details?.items;
    return (Array.isArray(x) ? x : []) as Record<string, unknown>[];
  };
  const fila = (tipo: string) => items('resource-summary').find((x) => x?.resourceType === tipo);
  const cls = num(valor('cumulative-layout-shift'));
  return {
    scores: Object.fromEntries(Object.entries(lhr.categories ?? {}).map(([k, c]) => [k, num(c?.score)])),
    metrics: {
      lcp_ms: entero(valor('largest-contentful-paint')), tbt_ms: entero(valor('total-blocking-time')),
      cls: cls === null ? null : Math.round(cls * 10_000) / 10_000,
      fcp_ms: entero(valor('first-contentful-paint')), si_ms: entero(valor('speed-index')),
      ttfb_ms: entero(items('metrics')[0]?.timeToFirstByte ?? valor('server-response-time')),
      tti_ms: entero(valor('interactive')), total_bytes: entero(fila('total')?.transferSize),
      script_bytes: entero(fila('script')?.transferSize), request_count: entero(fila('total')?.requestCount),
    },
  };
}

/** El uuidFrom de §10.2 (v5, variante RFC): el mismo texto da el mismo id, así una re-entrega no duplica la fila. */
export async function uuidFrom(s: string): Promise<string> {
  const h = await sha256hex(s);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Lo que E11 deja en scan_runs.params.perf (§10.2): url ya pasada por urlMedible, una estrategia y la etiqueta opcional.
export type ParamsPerf = { url: string; strategy: Strategy; version_label: string | null };
export function leerParams(params: unknown): ParamsPerf | null {
  const p = (params as { perf?: Record<string, unknown> } | null | undefined)?.perf;
  if (!p || typeof p.url !== 'string' || typeof p.strategy !== 'string' || !ESTRATEGIAS.includes(p.strategy)) return null;
  const v = typeof p.version_label === 'string' && VERSION.test(p.version_label) ? p.version_label : null;
  return { url: p.url, strategy: p.strategy as Strategy, version_label: v };
}

const urlFinal = (lhr: LhrRecortado) => {
  const f = texto(lhr.finalDisplayedUrl) ?? texto(lhr.finalUrl);
  try { const u = f ? new URL(f) : null; return u ? `${u.origin}${u.pathname}`.slice(0, 2048) : null; } catch { return null; }
};

// Una medición = una fila (rep 1, run_group = el id del scan): sin LHR o con runtime_error va sin métricas y no es la
// representativa (perf_points y las medianas la saltan, §10.3), pero E24 la lista y la app ve el motivo.
async function escribir(env: CloudflareBindings, m: MsgScan, p: ParamsPerf, lhr: LhrRecortado | null, runtime: string | null) {
  const r = lhr && !runtime ? resumirLhr(lhr) : { scores: {}, metrics: METRICAS_VACIAS };
  const at = new Date(String(lhr?.fetchTime ?? ''));
  const fila = { id: await uuidFrom(`${m.scan_run_id}|psi|1`), org_id: m.org_id, scan_run_id: m.scan_run_id, url: p.url,
    strategy: p.strategy, source: 'psi', lighthouse_version: texto(lhr?.lighthouseVersion), scores: r.scores, metrics: r.metrics,
    run_group: m.scan_run_id, rep: 1, is_representative: runtime === null, trigger: 'manual', version_label: p.version_label,
    final_url: lhr ? urlFinal(lhr) : null, runtime_error: runtime,
    ...(Number.isNaN(at.getTime()) ? {} : { created_at: at.toISOString() }) };   // created_at = fetchTime, como la siembra
  const { error } = await db(env).from('perf_runs').insert(fila);
  // 23505: la misma fila (id determinista) ya la escribió una entrega anterior que no llegó a marcar el paso.
  if (error && error.code !== '23505') {
    log('error', 'psi.guardar_error', { code: error.code ?? null });
    throw new ProviderError('unavailable');
  }
}

type Traza = { strategy?: Strategy; http?: number };
const RUNTIME = (): ResultadoPaso => ({ status: 'done', error_code: 'runtime_error' });

async function medir(env: CloudflareBindings, m: MsgScan, traza: Traza): Promise<ResultadoPaso> {
  const admin = db(env);
  const [{ data: scan, error }, { data: ya, error: ey }] = await Promise.all([
    admin.from('scan_runs').select('params').eq('id', m.scan_run_id).eq('org_id', m.org_id).maybeSingle(),
    admin.from('perf_runs').select('id, runtime_error').eq('org_id', m.org_id).eq('run_group', m.scan_run_id).limit(1).maybeSingle(),
  ]);
  if (error || ey) throw new ProviderError('unavailable');
  // Re-entrega con la fila ya escrita (falló marcar el paso): no se gasta otra llamada a PSI.
  if (ya) return ya.runtime_error ? RUNTIME() : { status: 'done' };
  const p = leerParams(scan?.params);
  if (!p) return { status: 'failed', error_code: 'sin_parametros' };
  traza.strategy = p.strategy;
  // Otra vez aquí y no solo en E11 (§10.2): lo que llega a Google es la URL del cliente ya validada, nunca una interna.
  try { p.url = await urlMedibleOrg(admin, m.org_id, p.url, hostsPropios(env)); } catch (e) {
    if (!(e instanceof UrlNoMedible)) throw e;   // falló leer la org (ProviderError): reintenta el mensaje
    return { status: 'failed', error_code: 'url_no_medible' };
  }
  const clave = env.PSI_API_KEY?.trim();
  if (!clave) return { status: 'failed', error_code: 'psi_sin_clave' };

  // Red, plazo o 5xx/429 lanzan ProviderError transitorio y guarded reintenta el mensaje (REINTENTOS.psi de jobs.ts).
  const r = await pedir(urlPsi(p.url, p.strategy, clave), { headers: { accept: 'application/json' } }, PLAZO_PSI);
  traza.http = r.status;
  if (!r.ok) {
    const { texto: cuerpo } = await leerAcotado(r, TOPE_ERROR, undefined, { ignorarLargo: true });
    // La página no carga (NO_FCP, FAILED_DOCUMENT_REQUEST…): reintentar no sirve. Se mira con una regex, sin parsear.
    const lh = /Lighthouse returned error: ([A-Z_]{2,60})/.exec(cuerpo)?.[1];
    if (lh) { await escribir(env, m, p, null, lh); return RUNTIME(); }
    if (r.status === 429) throw new ProviderError('rate_limited', 429);
    if (r.status >= 500) throw new ProviderError('unavailable', r.status);
    // Clave inválida, API sin activar o sin cuota (401/403) y un `fields` que Google no acepta son nuestros: no son de la
    // página del cliente ni se arreglan reintentando. La clave mala o caducada llega como 400 INVALID_ARGUMENT (API_KEY_*),
    // no como 401: sin esto se vería «tu página falla», con fila y cupo gastados.
    if (r.status === 401 || r.status === 403 || (r.status === 400 && CLAVE_MALA.test(cuerpo))) {
      return { status: 'failed', error_code: 'psi_clave' };
    }
    if (r.status === 400 && /field selection/i.test(cuerpo)) return { status: 'failed', error_code: 'psi_fields' };
    await escribir(env, m, p, null, `PSI_${r.status}`);   // 400: Google no acepta la URL
    return RUNTIME();
  }
  const { texto: crudo, cortado } = await leerAcotado(r, TOPE_CUERPO_PSI);
  if (cortado) return { status: 'failed', error_code: 'psi_respuesta_grande' };   // sin JSON.parse de un LHR entero
  let j: { lighthouseResult?: unknown } | null;
  try { j = JSON.parse(crudo) as { lighthouseResult?: unknown } | null; } catch { throw new ProviderError('unavailable', r.status); }
  const lhr = j?.lighthouseResult && typeof j.lighthouseResult === 'object' ? (j.lighthouseResult as LhrRecortado) : null;
  if (!lhr) { await escribir(env, m, p, null, 'PSI_NO_LHR'); return RUNTIME(); }
  const rt = texto(lhr.runtimeError?.code);
  const runtime = rt && rt !== 'NO_ERROR' ? rt.slice(0, 60) : null;
  await escribir(env, m, p, lhr, runtime);
  return runtime ? RUNTIME() : { status: 'done' };
}

// Paso psi de vg-jobs. PF_REGRESSION no se evalúa aún: compareRuns no existe en @vanguard/core (RND-11, §10.6).
// psi.fin: duración, estrategia, código HTTP de Google y desenlace; nunca la clave ni la URL.
export const pasoPsi: FnPaso = async (env, m) => {
  const t0 = Date.now();
  const traza: Traza = {};
  try {
    const r = await medir(env, m, traza);
    const st = 'status' in r ? r : null;
    log('info', 'psi.fin', { ms: Date.now() - t0, strategy: traza.strategy ?? null, http: traza.http ?? null,
      status: st?.status ?? null, codigo: st?.error_code ?? null });
    return r;
  } catch (e) {
    log('warn', 'psi.fin', { ms: Date.now() - t0, strategy: traza.strategy ?? null, http: traza.http ?? null, status: 'error',
      codigo: e instanceof ProviderError ? e.code : 'error' });
    throw e;
  }
};
