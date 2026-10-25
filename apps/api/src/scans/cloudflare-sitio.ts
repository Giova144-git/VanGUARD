import type { PermCheck } from '@vanguard/contracts';
import { parseIp } from '@vanguard/core';
import { ProviderError, codigoHttp, pedir } from '../lib/http.ts';
import { sondeoFallido, type Sondeo } from './sondeo.ts';

// Cloudflare sin zona (asignaciones/cloudflare-por-url.md §BACK 1): un sitio de Pages, de Workers o su dominio propio.
// La URL se normaliza a https://host (sin ruta ni query) y se clasifica; con un token de CUENTA (Pages · Read y Workers
// Scripts · Read) se busca el proyecto o el script para leer su configuración. Sin token, o si el token no ve el sitio,
// la conexión queda activa solo con revisión HTTP. Nunca se guarda nada del proyecto salvo su nombre y la cuenta.

const CF = 'https://api.cloudflare.com/client/v4';
const PLAZO = 20_000;
export type TipoSitio = 'pages' | 'workers' | 'custom';
export type Sitio = { site_url: string; host: string; kind: TipoSitio; project: string | null };
export type MetaSitio = { mode: 'url'; site_url: string; site_kind: TipoSitio; project: string | null; account_id: string | null;
  config_read: boolean };

const ETIQUETA = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Hosts de VanGUARD: auditar el propio producto no es una conexión de cliente.
const PROPIOS = ['officialvanguard.com', 'vanguard.giovannizm14.workers.dev'];
const esPropio = (h: string) => PROPIOS.some((p) => h === p || h.endsWith(`.${p}`));

/** https://host normalizado y su tipo, o el motivo por el que no vale (mensaje para field_errors.url). */
export function clasificarSitio(url: string): Sitio | { error: string } {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return { error: 'Pega la URL completa, con https://' }; }
  if (u.protocol !== 'https:') return { error: 'Solo sitios con https://' };
  if (u.username || u.password) return { error: 'La URL no puede llevar usuario ni contraseña' };
  if (u.port) return { error: 'Sin puerto: usa la URL pública del sitio' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const etiquetas = host.split('.');
  if (parseIp(host) || host.includes(':') || etiquetas.length < 2 || !etiquetas.every((e) => ETIQUETA.test(e))
    || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { error: 'Usa un dominio público, no una IP ni localhost' };
  }
  if (esPropio(host)) return { error: 'Ese es un dominio de VanGUARD: conecta el sitio que quieres revisar' };
  if (host === 'pages.dev' || host === 'workers.dev') return { error: 'Falta el nombre del proyecto en la URL' };
  const site_url = `https://${host}`;
  if (host.endsWith('.pages.dev')) {
    const p = etiquetas.slice(0, -2);   // proyecto.pages.dev o rama.proyecto.pages.dev
    if (p.length < 1 || p.length > 2) return { error: 'No parece un sitio de Pages (<proyecto>.pages.dev)' };
    return { site_url, host, kind: 'pages', project: p[p.length - 1]! };
  }
  if (host.endsWith('.workers.dev')) {
    const p = etiquetas.slice(0, -2);   // script.subdominio.workers.dev
    if (p.length !== 2) return { error: 'No parece un Worker (<script>.<subdominio>.workers.dev)' };
    return { site_url, host, kind: 'workers', project: p[0]! };
  }
  return { site_url, host, kind: 'custom', project: null };
}

async function cf<T>(token: string, path: string): Promise<T> {
  const r = await pedir(`${CF}${path}`, { headers: { Authorization: `Bearer ${token}` } }, PLAZO);
  if (!r.ok) { await r.body?.cancel(); throw new ProviderError(codigoHttp(r.status), r.status); }
  try { return (await r.json()) as T; } catch { throw new ProviderError('invalid', r.status); }
}
const codigo = (e: unknown) => (e instanceof ProviderError ? e.code : 'unavailable');

type Lista<T> = { result?: T[] | null };
type ProyectoPages = { name?: string; domains?: string[] | null; subdomain?: string };
type DominioWorker = { hostname?: string; service?: string };

/** Sondeo de E8 en modo sitio. Sin token: ok con revisión HTTP. Con token: 401 → rechazado (no se guarda); si no ve el
 *  sitio, ok igual con config_read false y el mensaje. Subpeticiones: ≤ 4 con token. */
export async function probarCloudflareSitio(token: string | null, s: Sitio): Promise<Sondeo> {
  const base = { label: `Cloudflare · ${s.host}`.slice(0, 80), expiresAt: null, scopes: [] as string[], faltan: [] as string[] };
  const meta = (m: Partial<MetaSitio>): MetaSitio => ({ mode: 'url', site_url: s.site_url, site_kind: s.kind,
    project: s.project, account_id: null, config_read: false, ...m });
  if (!token) {
    return { ...base, estado: 'ok', checks: [{ permission: 'site_http', ok: true, required: true }],
      capabilities: { site_http: true, config_read: false }, meta: meta({}) };
  }
  let cuenta: string | null = null;
  try {
    const r = await cf<Lista<{ id?: string }>>(token, '/accounts?per_page=5');
    cuenta = (r.result ?? []).map((a) => a.id).find((id): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) ?? null;
  } catch (e) {
    const c = codigo(e);
    const checks: PermCheck[] = [{ permission: 'account_read', ok: false, required: true, error_code: c }];
    if (c === 'unauthorized') return sondeoFallido('rechazado', checks, { motivo: 'unauthorized', mensaje: 'Cloudflare no reconoce este token' });
    if (c !== 'forbidden') return sondeoFallido('caido', checks, { mensaje: 'Cloudflare no respondió. Vuelve a intentarlo en un minuto.' });
  }
  const sinConfig = (mensaje: string, checks: PermCheck[]): Sondeo => ({ ...base, estado: 'ok', mensaje,
    checks: [{ permission: 'site_http', ok: true, required: true }, ...checks],
    capabilities: { site_http: true, config_read: false }, meta: meta({ account_id: cuenta }) });
  if (!cuenta) return sinConfig('El token no ve ninguna cuenta: revisamos el sitio solo por HTTP', []);

  let proyecto = s.project;
  let kind = s.kind;
  try {
    if (kind === 'custom') {
      // Dominio propio: ¿de un proyecto de Pages o de un Worker de la cuenta?
      const [pages, workers] = await Promise.allSettled([
        cf<Lista<ProyectoPages>>(token, `/accounts/${cuenta}/pages/projects?per_page=50`),
        cf<Lista<DominioWorker>>(token, `/accounts/${cuenta}/workers/domains`),
      ]);
      const pg = pages.status === 'fulfilled'
        ? (pages.value.result ?? []).find((p) => (p.domains ?? []).some((d) => d.toLowerCase() === s.host)) : undefined;
      const wk = workers.status === 'fulfilled'
        ? (workers.value.result ?? []).find((d) => (d.hostname ?? '').toLowerCase() === s.host) : undefined;
      if (pg?.name) { kind = 'pages'; proyecto = pg.name; }
      else if (wk?.service) { kind = 'workers'; proyecto = wk.service; }
      else return sinConfig('El token no ve ese proyecto: revisamos el sitio solo por HTTP. Si el dominio es una zona de tu cuenta, conéctalo en modo zona.', []);
    }
    const ruta = kind === 'pages' ? `/accounts/${cuenta}/pages/projects/${encodeURIComponent(proyecto ?? '')}`
      : `/accounts/${cuenta}/workers/scripts/${encodeURIComponent(proyecto ?? '')}/settings`;
    await cf<unknown>(token, ruta);
    const permiso = kind === 'pages' ? 'pages_read' : 'workers_scripts_read';
    return { ...base, estado: 'ok', checks: [{ permission: 'site_http', ok: true, required: true }, { permission: permiso, ok: true }],
      capabilities: { site_http: true, config_read: true }, meta: { ...meta({ account_id: cuenta, config_read: true, project: proyecto }),
        project_kind: kind } };
  } catch (e) {
    const c = codigo(e);
    const permiso = kind === 'pages' ? 'pages_read' : 'workers_scripts_read';
    return sinConfig('El token no ve ese proyecto: revisamos el sitio solo por HTTP', [{ permission: permiso, ok: false, error_code: c }]);
  }
}
