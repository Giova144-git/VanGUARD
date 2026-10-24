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
