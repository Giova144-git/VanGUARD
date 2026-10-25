import { redactString, scanArchivo } from '@vanguard/core';
import type { MsgScan, ResultadoPaso } from '../jobs.ts';
import { withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ProviderError, codigoHttp, pedir } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { clasificarSitio } from './cloudflare-sitio.ts';
import { escribirDetalleModulo } from './cobertura.ts';
import { guardarHallazgos, type Borrador } from './comun.ts';

// Paso cloudflare en modo sitio (asignaciones/cloudflare-por-url.md §BACK 2). Siempre, por HTTP: un GET a / (sin seguir
// redirecciones a otro host), un GET a http:// para ver si redirige a https y GET a una lista FIJA y corta de rutas
// sensibles, todo con plazo y tamaño acotados y el User-Agent de VanGUARD. El host es el de la conexión y solo él sale
// por aquí (lista de salida propia de este paso: no se abre la general). Con token de cuenta (meta.account_id), además
// la configuración del proyecto de Pages o del script. El modo zona no cambia. ≈ 7 subpeticiones HTTP + 2–3 de Cloudflare.

export const UA_VANGUARD = 'VanGUARD-auditoria/1.0 (+https://officialvanguard.com)';
const PLAZO_SITIO = 8_000;
const MAX_CUERPO = 4096;
const SEIS_MESES_S = 15_552_000;
const CF = 'https://api.cloudflare.com/client/v4';

type Respuesta = { status: number; headers: Headers; cuerpo: Uint8Array; location: string | null };

// Una petición al sitio: solo a ESE host (https, o http para CF_SITE_HTTP), sin credenciales ni puerto, sin seguir
// redirecciones (las del mismo host las sigue sitioGet, ≤ 3), cuerpo recortado a MAX_CUERPO. Lanza si no se pudo.
async function pedirSitio(host: string, url: string, plazo = PLAZO_SITIO): Promise<Respuesta> {
  const u = new URL(url);
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname !== host || u.username || u.password || u.port) {
    throw new ProviderError('invalid');
  }
  let r: Response;
  try {
    r = await fetch(u.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(plazo),
      headers: { 'User-Agent': UA_VANGUARD, Accept: '*/*' } });
  } catch (e) {
    throw new ProviderError((e as Error)?.name === 'TimeoutError' ? 'timeout' : 'unavailable');
  }
  const cuerpo = new Uint8Array(MAX_CUERPO);
  let n = 0;
  const lector = r.body?.getReader();
  try {
    while (lector && n < MAX_CUERPO) {
      const { done, value } = await lector.read();
      if (done || !value) break;
      const trozo = value.subarray(0, MAX_CUERPO - n);
      cuerpo.set(trozo, n);
      n += trozo.length;
    }
  } catch { /* cuerpo cortado: se analiza lo leído */ }
  await lector?.cancel().catch(() => {});
  return { status: r.status, headers: r.headers, cuerpo: cuerpo.subarray(0, n), location: r.headers.get('location') };
}

async function sitioGet(host: string, ruta: string): Promise<Respuesta> {
  let url = `https://${host}${ruta}`;
  for (let salto = 0; ; salto++) {
    const r = await pedirSitio(host, url);
    if (r.status < 300 || r.status >= 400 || !r.location || salto === 3) return r;
    let sig: URL;
    try { sig = new URL(r.location, url); } catch { return r; }
    if (sig.hostname !== host || sig.protocol !== 'https:') return r;   // a otro host: no se sigue
    url = sig.href;
  }
}

// ── Reglas por HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────
export const RUTAS_EXPUESTAS = ['/.env', '/.git/config', '/.git/HEAD', '/.DS_Store', '/backup.zip'] as const;
type RutaExpuesta = (typeof RUTAS_EXPUESTAS)[number];
const texto = (b: Uint8Array) => new TextDecoder().decode(b);
const pareceHtml = (t: string) => /^\s*(<!doctype|<html|<head|<body|<script|<\?xml)/i.test(t);
/** ¿El contenido es de verdad lo que dice la ruta? (un fallback de SPA que devuelve index.html con 200 no cuenta). */
export function contenidoExpuesto(ruta: RutaExpuesta, b: Uint8Array): boolean {
  const t = texto(b);
  if (ruta === '/.env') return !pareceHtml(t) && /^[ \t]*(export[ \t]+)?[A-Z_][A-Z0-9_]{1,63}[ \t]*=/m.test(t);
  if (ruta === '/.git/config') return /^\s*\[core\]/m.test(t);
  if (ruta === '/.git/HEAD') return /^ref: refs\/heads\/[\w./-]+\s*$|^[0-9a-f]{40}\s*$/.test(t.trim());
  if (ruta === '/.DS_Store') return b.length >= 8 && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 1 && texto(b.subarray(4, 8)) === 'Bud1';
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;   // PK\x03\x04
}
// Evidencia sin contenido sensible: en .env solo los NOMBRES de las variables (≤ 10), redactados.
function evidenciaExpuesta(ruta: RutaExpuesta, b: Uint8Array): Record<string, unknown> {
  if (ruta !== '/.env') return { path: ruta, bytes: b.length };
  const nombres = [...texto(b).matchAll(/^[ \t]*(?:export[ \t]+)?([A-Z_][A-Z0-9_]{1,63})[ \t]*=/gm)].map((x) => x[1]!).slice(0, 10);
  return { path: ruta, variables: nombres.map((v) => redactString(v)) };
}

export type DatosSitio = { host: string; raiz: Respuesta | null; http: Respuesta | null;
  expuestas: { ruta: RutaExpuesta; r: Respuesta | null }[] };

/** Hallazgos HTTP del sitio a partir de las respuestas (puro). */
export function reglasSitio(d: DatosSitio): Borrador[] {
  const out: Borrador[] = [];
  const recurso = `site:${d.host}`;
  const h = d.raiz?.headers;
  if (h) {
    const hsts = h.get('strict-transport-security');
    const max = Number(/max-age\s*=\s*"?(\d+)/i.exec(hsts ?? '')?.[1] ?? NaN);
    if (!hsts || !(max >= SEIS_MESES_S)) {
      out.push({ rule_id: 'CF_SITE_HSTS', severity: 'medium', confirmed: true, resource: recurso,
        title: `${d.host} no fuerza HTTPS con HSTS de al menos 6 meses`, evidence: { header: hsts ? 'max-age bajo' : 'ausente', max_age: Number.isFinite(max) ? max : null } });
    }
    const csp = h.get('content-security-policy');
    if (!csp) out.push({ rule_id: 'CF_SITE_CSP', severity: 'medium', confirmed: true, resource: recurso,
      title: `${d.host} no tiene Content-Security-Policy`, evidence: { header: 'ausente' } });
    if (!/frame-ancestors/i.test(csp ?? '') && !h.get('x-frame-options')) out.push({ rule_id: 'CF_SITE_FRAME', severity: 'medium',
      confirmed: true, resource: recurso, title: `${d.host} se puede incrustar en otra web (clickjacking)`,
      evidence: { frame_ancestors: false, x_frame_options: false } });
    if ((h.get('x-content-type-options') ?? '').toLowerCase().trim() !== 'nosniff') out.push({ rule_id: 'CF_SITE_NOSNIFF',
      severity: 'low', confirmed: true, resource: recurso, title: `${d.host} no envía X-Content-Type-Options: nosniff`, evidence: {} });
    const acao = (h.get('access-control-allow-origin') ?? '').trim();
    if (acao === '*' && (h.get('access-control-allow-credentials') ?? '').toLowerCase() === 'true') {
      out.push({ rule_id: 'CF_SITE_CORS', severity: 'high', confirmed: true, resource: recurso,
        title: `${d.host} permite CORS desde cualquier origen con credenciales`, evidence: { allow_origin: '*', credentials: true } });
    }
  }
  const http = d.http;
  if (http) {
    const loc = http.location ? (() => { try { return new URL(http.location!, `http://${d.host}/`); } catch { return null; } })() : null;
    const aHttps = http.status >= 300 && http.status < 400 && loc?.protocol === 'https:';
    if (!aHttps) out.push({ rule_id: 'CF_SITE_HTTP', severity: 'medium', confirmed: true, resource: recurso,
      title: `${d.host} responde por http:// sin redirigir a https://`, evidence: { status: http.status } });
  }
  for (const { ruta, r } of d.expuestas) {
    if (r && r.status === 200 && contenidoExpuesto(ruta, r.cuerpo)) {
      out.push({ rule_id: 'CF_SITE_EXPOSED', severity: 'critical', confirmed: true, resource: `${recurso}${ruta}`,
        title: `${d.host}${ruta} es público`, evidence: evidenciaExpuesta(ruta, r.cuerpo), dedupe_input: `${recurso}${ruta}` });
    }
  }
  return out;
}

// ── Con token: configuración del proyecto ───────────────────────────────────────────────────────────────────────────
const NOMBRE_SECRETO = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|API_?KEY|(^|_)KEY($|_)|CREDENTIAL|DATABASE_URL|DSN)/i;
/** ¿Una variable en texto plano parece un secreto? Por su nombre o por el escáner de secretos de core (nunca se guarda). */
export const pareceSecreto = (nombre: string, valor: string) =>
  NOMBRE_SECRETO.test(nombre) || scanArchivo('variables.env', `${nombre}=${valor}`).length > 0;

type EnvPages = Record<string, { type?: string; value?: string } | null | undefined>;
type ProyectoPages = { deployment_configs?: { production?: { env_vars?: EnvPages | null }; preview?: { env_vars?: EnvPages | null } } };
type Vinculo = { type?: string; name?: string; text?: string };

export function reglasPages(host: string, proyecto: string, p: ProyectoPages): Borrador[] {
  const vistas = new Set<string>();
  for (const entorno of ['production', 'preview'] as const) {
    for (const [nombre, v] of Object.entries(p.deployment_configs?.[entorno]?.env_vars ?? {})) {
      if (v?.type === 'plain_text' && pareceSecreto(nombre, String(v.value ?? ''))) vistas.add(nombre);
    }
  }
  return [...vistas].slice(0, 20).map((nombre) => ({ rule_id: 'CF_PAGES_PLAINTEXT', severity: 'high', confirmed: true,
    resource: `pages:${proyecto}:${nombre}`.slice(0, 120), dedupe_input: `pages:${proyecto}:${nombre}`,
    title: `La variable ${redactString(nombre).slice(0, 64)} de Pages (${proyecto}) parece un secreto y está en texto plano`,
    evidence: { project: proyecto, variable: redactString(nombre), host } }));
}

export function reglasWorker(host: string, script: string, vinculos: readonly Vinculo[], devActivo: boolean, dominioPropio: boolean): Borrador[] {
  const out: Borrador[] = vinculos.filter((b) => b.type === 'plain_text' && b.name && pareceSecreto(b.name, String(b.text ?? '')))
    .slice(0, 20).map((b) => ({ rule_id: 'CF_WORKER_PLAINTEXT', severity: 'high', confirmed: true,
      resource: `worker:${script}:${b.name}`.slice(0, 120), dedupe_input: `worker:${script}:${b.name}`,
      title: `La variable ${redactString(b.name!).slice(0, 64)} del Worker ${script} parece un secreto y está en texto plano`,
      evidence: { script, variable: redactString(b.name!), host } }));
  if (devActivo && dominioPropio) out.push({ rule_id: 'CF_WORKER_DEVSUBDOMAIN', severity: 'low', confirmed: true,
    resource: `worker:${script}`, title: `El Worker ${script} sigue publicado en workers.dev además de en ${host}`,
    evidence: { script, workers_dev: true } });
  return out;
}

async function cf<T>(token: string, path: string): Promise<T> {
  const r = await pedir(`${CF}${path}`, { headers: { Authorization: `Bearer ${token}` } }, 20_000);
  if (!r.ok) { await r.body?.cancel(); throw new ProviderError(codigoHttp(r.status), r.status); }
  return (await r.json()) as T;
}

export async function pasoCloudflareSitio(env: CloudflareBindings, m: MsgScan, conn: { id: string; meta: Record<string, unknown> })
  : Promise<ResultadoPaso> {
  const s = clasificarSitio(String(conn.meta.site_url ?? ''));
  if ('error' in s) return { status: 'failed', error_code: 'invalid' };
  const host = s.host;
  const intento = async (f: () => Promise<Respuesta>) => { try { return await f(); } catch { return null; } };
  const [raiz, http, ...exp] = await Promise.all([
    intento(() => sitioGet(host, '/')),
    intento(() => pedirSitio(host, `http://${host}/`)),
    ...RUTAS_EXPUESTAS.map((ruta) => intento(() => pedirSitio(host, `https://${host}${ruta}`))),
  ]);
  if (!raiz) {
    // Sin la portada no hay revisión HTTP: nada «mirado», nunca un verde.
    await escribirDetalleModulo(env, m, 'cloudflare', { modo: 'url', miradas: { sitio_http: false, configuracion: false } });
    return { status: 'failed', error_code: 'unavailable' };
  }
  const borradores = reglasSitio({ host, raiz, http, expuestas: RUTAS_EXPUESTAS.map((ruta, i) => ({ ruta, r: exp[i] ?? null })) });

  // Con token (meta.account_id): la configuración del proyecto. Si falla, el paso sigue solo con HTTP.
  let configuracion = false;
  const cuenta = typeof conn.meta.account_id === 'string' && /^[a-f0-9]{32}$/.test(conn.meta.account_id) ? conn.meta.account_id : null;
  const proyecto = typeof conn.meta.project === 'string' ? conn.meta.project : null;
  const tipo = conn.meta.site_kind === 'custom' ? conn.meta.project_kind : conn.meta.site_kind;
  if (cuenta && proyecto && (tipo === 'pages' || tipo === 'workers')) {
    try {
      const extra = await withSecret(env, db(env), { orgId: m.org_id, connectionId: conn.id, provider: 'cloudflare', kind: 'read' },
        async (t) => {
          if (tipo === 'pages') {
            const p = await cf<{ result?: ProyectoPages }>(t, `/accounts/${cuenta}/pages/projects/${encodeURIComponent(proyecto)}`);
            return reglasPages(host, proyecto, p.result ?? {});
          }
          const base = `/accounts/${cuenta}/workers/scripts/${encodeURIComponent(proyecto)}`;
          const [ajustes, sub] = await Promise.all([
            cf<{ result?: { bindings?: Vinculo[] } }>(t, `${base}/settings`),
            cf<{ result?: { enabled?: boolean } }>(t, `${base}/subdomain`).catch(() => ({ result: { enabled: false } })),
          ]);
          return reglasWorker(host, proyecto, ajustes.result?.bindings ?? [], sub.result?.enabled === true, s.kind === 'custom');
        });
      borradores.push(...extra);
      configuracion = true;
    } catch (e) {
      log('warn', 'cloudflare.sitio_config_error', { code: e instanceof ProviderError ? e.code : 'error' });
    }
  }
  const g = await guardarHallazgos(env, m, 'cloudflare', conn.id, borradores, true);
  await escribirDetalleModulo(env, m, 'cloudflare', { modo: 'url', miradas: { sitio_http: g.descartadas === 0, configuracion } });
  return { status: 'done', findings: g.n, ...(g.error_code ? { error_code: g.error_code } : {}) };
}
