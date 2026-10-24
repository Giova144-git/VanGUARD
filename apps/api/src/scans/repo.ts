import type { PermCheck } from '@vanguard/contracts';
import { ProviderError, codigoHttp, pedir } from '../lib/http.ts';
import { sondeoFallido, type Sondeo } from './sondeo.ts';

// GitHub (§09.2): PAT fine-grained de un solo repo. Obligatorios metadata:read y contents:read; Dependabot no bloquea.
const GH = 'https://api.github.com';
const UA = 'VanGUARD/1.0 (+https://officialvanguard.com)';   // GitHub exige User-Agent
const PLAZO = 10_000;
export const ghHeaders = (t: string) => ({ Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA });

const fallo = (permission: string, required: boolean, e: unknown): PermCheck =>
  ({ permission, ok: false, required, error_code: e instanceof ProviderError ? e.code : 'unavailable' });

export async function probarGithub(token: string, repo: string): Promise<Sondeo> {
  let r: Response;
  try { r = await pedir(`${GH}/repos/${repo}`, { headers: ghHeaders(token) }, PLAZO); } catch (e) {
    return sondeoFallido('caido', [fallo('metadata:read', true, e)], { mensaje: 'GitHub no respondió. Vuelve a intentarlo.' });
  }
  if (!r.ok) {
    await r.body?.cancel();
    const c: PermCheck[] = [{ permission: 'metadata:read', ok: false, required: true, error_code: codigoHttp(r.status) }];
    if (r.status === 401) return sondeoFallido('rechazado', c, { motivo: 'unauthorized', faltan: ['metadata:read'],
      mensaje: 'El token no es válido o caducó.' });
    if (r.status === 403 || r.status === 404) return sondeoFallido('rechazado', c, { faltan: ['metadata:read'],
      mensaje: `Tu token no ve ${repo}. Revisa que lo marcaste en Only select repositories. Si el repo es de una organización, puede que un admin tenga que aprobar el token.` });
    return sondeoFallido('caido', c, { mensaje: 'GitHub no respondió. Vuelve a intentarlo.' });
  }
  const j = (await r.json()) as { id: number; full_name: string; default_branch: string; private: boolean };
  const exp = r.headers.get('github-authentication-token-expiration');           // [no verificado: cabecera y formato]
  const checks: PermCheck[] = [{ permission: 'metadata:read', ok: true, required: true }];
  const [c, d] = await Promise.all([
    pedir(`${GH}/repos/${repo}/commits?sha=${encodeURIComponent(j.default_branch)}&per_page=1`, { headers: ghHeaders(token) }, PLAZO)
      .then(async (x) => { await x.body?.cancel(); return x.status; }).catch((e: unknown) => e),
    pedir(`${GH}/repos/${repo}/dependabot/alerts?per_page=1`, { headers: ghHeaders(token) }, PLAZO)
      .then(async (x) => { await x.body?.cancel(); return x.status; }).catch((e: unknown) => e),
  ]);
  const aCheck = (permission: string, required: boolean, s: unknown): PermCheck => typeof s === 'number'
    ? (s >= 200 && s < 300 ? { permission, ok: true, required } : { permission, ok: false, required, error_code: codigoHttp(s) })
    : fallo(permission, required, s);
  checks.push(aCheck('contents:read', true, c), aCheck('dependabot_alerts:read', false, d));
  const contents = checks[1]!;
  const estado = contents.ok ? 'ok' : contents.error_code === 'forbidden' || contents.error_code === 'not_found' ? 'rechazado' : 'caido';
  return {
    estado,
    faltan: estado === 'rechazado' ? ['contents:read'] : [],
    ...(estado === 'rechazado' ? { mensaje: 'Falta el permiso Contents: Read-only.' } : {}),
    ...(estado === 'caido' ? { mensaje: 'GitHub no respondió. Vuelve a intentarlo.' } : {}),
    checks,
    capabilities: { metadata: true, contents: contents.ok, dependabot_alerts: checks[2]?.ok === true },
    scopes: checks.filter((x) => x.ok).map((x) => x.permission),
    meta: { repo_full_name: j.full_name, default_branch: j.default_branch, private: j.private, repo_id: j.id },
    label: `GitHub · ${j.full_name}`.slice(0, 80),
    expiresAt: exp && !Number.isNaN(Date.parse(exp)) ? new Date(exp).toISOString() : null,
  };
}

// ── Paso repo de la auditoría (§09.4): árbol por sha, archivos de riesgo acotados y contenido solo en memoria ──
export type EntradaArbol = { path: string; size: number };
export const LIM_REPO = { archivos: 20, bytesArchivo: 1_000_000, bytesTotal: 3_000_000, lockfiles: 6, envs: 5 };
const FUERA = /(^|\/)(node_modules|vendor|dist|build|\.git)\//;
const BINARIO = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|woff2?|ttf|eot|mp[34]|mov|exe|dll|so|dylib|wasm|bin)$/i;
const LOCK = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|composer\.lock|package\.json|composer\.json)$/;
const ENV = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_EJEMPLO = /\.(example|sample|template)$/i;
const CONFIG = /(^|\/)(wrangler\.(toml|json|jsonc)|\.npmrc|\.pypirc|docker-compose[^/]*\.ya?ml|Dockerfile|vercel\.json|netlify\.toml|firebase\.json)$|^supabase\/config\.toml$|^\.github\/workflows\/[^/]+\.ya?ml$/;
const CODIGO_RIESGO = /(supabase|admin|secret|key|token|cred|config|client|firebase|stripe|auth|env)/i;
const CODIGO = /\.(ts|tsx|js|jsx|mjs|cjs|php|py|go|rb|java|kt|cs|rs|vue|svelte)$/i;

// elegirArchivosRiesgo (§09.4): en este orden hasta 20 archivos y 3 MB; nunca uno > 1 MB (el tamaño sale del árbol).
export function elegirArchivosRiesgo(arbol: EntradaArbol[], lim = LIM_REPO): string[] {
  const validos = arbol.filter((e) => !FUERA.test(e.path) && !BINARIO.test(e.path) && e.size <= lim.bytesArchivo);
  const elegidos: EntradaArbol[] = [];
  let total = 0;
  const tomar = (xs: EntradaArbol[], max = Infinity) => {
    let n = 0;
    for (const e of xs) {
      if (elegidos.length >= lim.archivos || n >= max) return;
      if (elegidos.some((x) => x.path === e.path) || total + e.size > lim.bytesTotal) continue;
      elegidos.push(e); total += e.size; n++;
    }
  };
  tomar(validos.filter((e) => LOCK.test(e.path)), lim.lockfiles);
  tomar(validos.filter((e) => e.path === '.gitignore'));
  tomar(validos.filter((e) => ENV.test(e.path) && !ENV_EJEMPLO.test(e.path)), lim.envs);
  tomar(validos.filter((e) => CONFIG.test(e.path)));
  tomar(validos.filter((e) => CODIGO.test(e.path) && CODIGO_RIESGO.test(e.path)).sort((a, b) => a.size - b.size));
  return elegidos.map((e) => e.path);
}

async function ghJson<T>(token: string, url: string): Promise<T> {
  const r = await pedir(url, { headers: ghHeaders(token) }, 30_000);
  if (!r.ok) { await r.body?.cancel(); throw new ProviderError(codigoHttp(r.status), r.status); }
  return (await r.json()) as T;
}

// rama → sha → árbol (3 subpeticiones). El árbol truncado deja la cobertura parcial (lo dice coverage.detail).
export async function arbolRepo(token: string, repo: string): Promise<{ sha: string; rama: string; arbol: EntradaArbol[]; truncado: boolean }> {
  const info = await ghJson<{ default_branch: string }>(token, `${GH}/repos/${repo}`);
  const commits = await ghJson<{ sha: string }[]>(token,
    `${GH}/repos/${repo}/commits?sha=${encodeURIComponent(info.default_branch)}&per_page=1`);
  const sha = commits[0]?.sha;
  if (!sha) throw new ProviderError('not_found');
  const t = await ghJson<{ tree?: { path: string; type: string; size?: number }[]; truncated?: boolean }>(token,
    `${GH}/repos/${repo}/git/trees/${sha}?recursive=1`);
  const arbol = (t.tree ?? []).filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size ?? 0 }));
  return { sha, rama: info.default_branch, arbol, truncado: t.truncated === true };
}

// Contenido crudo de las rutas elegidas, 5 en paralelo y solo en memoria. Un archivo que falla se omite.
export async function leerContenidos(token: string, repo: string, sha: string, rutas: string[]): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  let k = 0;
  const hilo = async () => {
    while (k < rutas.length) {
      const path = rutas[k++]!;
      const url = `${GH}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`;
      try {
        const r = await pedir(url, { headers: { ...ghHeaders(token), Accept: 'application/vnd.github.raw+json' } }, 30_000);
        if (r.ok) out.push({ path, content: await r.text() }); else await r.body?.cancel();
      } catch { /* se omite: el paso no muere por un archivo */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, rutas.length) }, hilo));
  return out;
}
