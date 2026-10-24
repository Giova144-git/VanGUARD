import { evaluarSupabase, SQL1, SQL2, SQL3B, type FilaSql1, type FilaSql2, type FilaSql3, type LintAdvisor } from '@vanguard/core';
import type { FnPaso } from '../jobs.ts';
import { withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ProviderError, check, codigoHttp, pedir, sondear } from '../lib/http.ts';
import { conexionActiva, guardarHallazgos } from './comun.ts';
import { sondeoFallido, veredicto, type Sondeo } from './sondeo.ts';

// Cliente de la Management API de Supabase (§07.3, extracto normativo) y sondeo de permisos del PAT (§07.2).
const REF = /^[a-z]{20}$/;
const PATH = /^(\/[A-Za-z0-9._-]+)*(\?[A-Za-z0-9_=,&.-]*)?$/; // ruta saneada: nada de ../, espacios ni %
const API = 'https://api.supabase.com/v1/projects';

// El campo project_ref acepta el ref, la URL de la API o la del panel; otra cosa → null (422 invalid_body).
export function normalizarRef(entrada: string): string | null {
  const s = entrada.trim();
  if (REF.test(s)) return s;
  const api = /^https?:\/\/([a-z]{20})\.supabase\.co\/?$/.exec(s);
  if (api?.[1]) return api[1];
  const panel = /supabase\.com\/dashboard\/project\/([a-z]{20})(?:[/?#]|$)/.exec(s);
  return panel?.[1] ?? null;
}

export async function mgmt(pat: string, ref: string, path: string,
  o: { method?: 'GET' | 'POST'; body?: unknown; text?: boolean; timeoutMs?: number; tries?: number } = {}): Promise<unknown> {
  if (!REF.test(ref) || !PATH.test(path)) throw new ProviderError('invalid');
  const url = `${API}/${ref}${path}`;
  const tries = o.tries ?? 3;
  for (let i = 0; ; i++) {
    let r: Response;
    try {
      r = await pedir(url, { method: o.method ?? 'GET',
        headers: { Authorization: `Bearer ${pat}`, Accept: o.text ? 'text/plain' : 'application/json',
                   ...(o.body ? { 'Content-Type': 'application/json' } : {}) },
        body: o.body ? JSON.stringify(o.body) : undefined }, o.timeoutMs ?? 8000);
    } catch (e) {
      if (i + 1 < tries) { await backoff(i); continue; }
      throw e;
    }
    if ((r.status === 429 || r.status >= 500) && i + 1 < tries) {
      await r.body?.cancel();                                  // Workers: no dejar respuestas colgadas (6 conexiones a la vez)
      const reset = Number(r.headers.get('X-RateLimit-Reset'));
      await backoff(i, r.status === 429 && reset > 0 ? Math.min(reset, 30) * 1000 : undefined); continue;
    }
    if (r.status < 200 || r.status >= 300) {
      await r.body?.cancel();
      throw new ProviderError(codigoHttp(r.status), r.status);   // 400 de metrics = proyecto no activo → invalid
    }
    const t = await r.text();
    if (o.text) return t;
    try { return t ? JSON.parse(t) : null; } catch { throw new ProviderError('invalid', r.status); }
  }
}
const backoff = (i: number, ms?: number) => new Promise((r) => setTimeout(r, ms ?? 500 * 2 ** i + Math.random() * 250));

export const sqlRead = async <T>(pat: string, ref: string, query: string): Promise<T[]> => {
  try {
    const out = await mgmt(pat, ref, '/database/query/read-only', { method: 'POST', body: { query }, timeoutMs: 20000, tries: 1 });
    if (!Array.isArray(out)) throw new ProviderError('invalid');   // forma de la respuesta 201 [no verificado]: prueba 08:00
    return out as T[];
  } catch (e) {
    if (e instanceof ProviderError && e.status === 500) throw new ProviderError('invalid', 500);   // error de SQL: no transitorio
    throw e;
  }
};

// Permisos prohibidos y el GET que los delata (cuerpo cancelado sin leer). organizations_read lo tiene todo PAT de acceso
// total: cierra el hueco del prefijo sbp_fc de guardKey. /api-keys va SIN ?reveal: nunca pedimos los valores.
const PROHIBIDOS = (base: string) => [
  ['organizations_read', 'https://api.supabase.com/v1/organizations'],
  ['api_gateway_keys_read', `${base}/api-keys`],
  ['data_api_config_read', `${base}/postgrest`],
  ['edge_functions_secrets_read', `${base}/secrets`],
] as const;

// Sondeo por permiso (§07.2): un intento, 8 s, como máximo 5 a la vez. 403 = «te falta ESE permiso», nunca «token roto».
export async function probarSupabase(pat: string, ref: string): Promise<Sondeo> {
  const h = { Authorization: `Bearer ${pat}`, Accept: 'application/json' };
  let proyecto: { name?: string; region?: string; status?: string };
  try {
    proyecto = (await mgmt(pat, ref, '', { tries: 1 })) as typeof proyecto;
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : 'unavailable';
    const c = [{ permission: 'project_admin_read', ok: false, required: true, error_code: code }];
    if (code === 'unauthorized') {
      return sondeoFallido('rechazado', c, { motivo: 'unauthorized', mensaje: 'El token no es válido o ya caducó' });
    }
    if (code === 'forbidden' || code === 'not_found') {
      return sondeoFallido('rechazado', c, { motivo: 'project_not_in_token', faltan: ['project_admin_read'],
        mensaje: 'Ese token no tiene acceso a ese proyecto: créalo eligiendo este proyecto y Project Settings · Read' });
    }
    return sondeoFallido('caido', c, { mensaje: 'Supabase no respondió. Vuelve a intentarlo en un minuto.' });
  }
  const base = `${API}/${ref}`;
  const [health, advisors, sql, metrics, authCfg] = await Promise.all([
    sondear(`${base}/health?services=db,rest&timeout_ms=2000`, { headers: h }, 8000),
    sondear(`${base}/advisors/security`, { headers: h }, 8000),
    sondear(`${base}/database/query/read-only`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'select 1 as ok' }) }, 8000),
    sondear(`${base}/analytics/endpoints/metrics`, { headers: { ...h, Accept: 'text/plain' } }, 8000),
    sondear(`${base}/config/auth`, { headers: h }, 8000),
  ]);
  const checks = [
    { permission: 'project_admin_read', ok: true, required: true },
    check('advisors_read', true, advisors),
    check('database_read', true, sql),
    check('analytics_logs_read', false, metrics),
    check('auth_config_read', false, authCfg),
  ];
  const v0 = veredicto(checks);
  const ok = (r: number | string) => typeof r === 'number' && r >= 200 && r < 300;

  // Sondeo negativo (§06.3, §07.2): permisos que el PAT NO debe tener. Va DESPUÉS del lote para no pasar de 5 a la vez.
  // 2xx → los tiene (sobra); otro 4xx salvo 429 → no los tiene; 429, 5xx, red o plazo → no se sabe → caido (502).
  // database_write no se sondea: haría falta POST /database/query, prohibido en el código (§07.3).
  let sobra: string[] = [];
  let negCaido = false;
  if (v0.estado !== 'caido' && v0.motivo !== 'unauthorized') {
    const prohibidos = PROHIBIDOS(base);
    const negativos = await Promise.all(prohibidos.map(([, url]) => sondear(url, { headers: h }, 8000)));
    const noLoTiene = (r: number | string) => typeof r === 'number' && r >= 400 && r < 500 && r !== 429;
    sobra = prohibidos.filter((_, i) => ok(negativos[i] ?? 'unavailable')).map(([id]) => id);
    negCaido = negativos.some((r) => !ok(r) && !noLoTiene(r));
  }
  const v = v0.estado === 'ok' && negCaido ? { ...v0, estado: 'caido' as const } : v0;
  const name = typeof proyecto?.name === 'string' && proyecto.name ? proyecto.name.slice(0, 60) : ref;
  return {
    ...v,
    ...(v.motivo === 'unauthorized' ? { mensaje: 'El token no es válido o ya caducó' } : {}),
    ...(v.estado === 'caido' ? { mensaje: 'Supabase no respondió. Vuelve a intentarlo en un minuto.' } : {}),
    sobra,
    checks,
    capabilities: { project: true, health: ok(health), advisors: ok(advisors), sql_read_only: ok(sql),
                    analytics: ok(metrics), auth_config: ok(authCfg) },
    scopes: checks.filter((c) => c.ok).map((c) => c.permission),
    meta: { project_ref: ref, project_name: name, region: typeof proyecto?.region === 'string' ? proyecto.region : null,
            project_status: typeof proyecto?.status === 'string' ? proyecto.status : null },
    label: `Supabase · ${name}`,
    expiresAt: null,
  };
}

// ── Paso supabase de la auditoría (§07.5, S15 15.8): advisors (seguridad y rendimiento) + SQL 1, 2 y 3b de solo lectura.
// El PAT solo existe dentro de withSecret. Un chequeo que falla queda «sin mirar» (p_complete = false), nunca verde.
type Resultado<T> = { ok: true; v: T } | { ok: false; code: string };
const intentar = async <T>(f: () => Promise<T>): Promise<Resultado<T>> => {
  try { return { ok: true, v: await f() }; } catch (e) { return { ok: false, code: e instanceof ProviderError ? e.code : 'unavailable' }; }
};

export const pasoSupabase: FnPaso = async (env, m) => {
  const conn = await conexionActiva(env, m, 'supabase');
  if (!conn) return { status: 'skipped', error_code: 'no_connection' };
  const ref = String(conn.meta.project_ref ?? '');
  const caps = conn.capabilities as Record<string, boolean | undefined>;
  const admin = db(env);
  const ctx = { orgId: m.org_id, connectionId: conn.id, provider: 'supabase' as const, kind: 'read' as const };
  const r = await withSecret(env, admin, ctx, async (pat) => {
    const sinPermiso = <T>(): Promise<Resultado<T>> => Promise.resolve({ ok: false, code: 'forbidden' });
    const [advS, advP, s1, s2, s3] = await Promise.all([
      caps.advisors === false ? sinPermiso<unknown>() : intentar(() => mgmt(pat, ref, '/advisors/security')),
      caps.advisors === false ? sinPermiso<unknown>() : intentar(() => mgmt(pat, ref, '/advisors/performance')),
      caps.sql_read_only === false ? sinPermiso<FilaSql1[]>() : intentar(() => sqlRead<FilaSql1>(pat, ref, SQL1)),
      caps.sql_read_only === false ? sinPermiso<FilaSql2[]>() : intentar(() => sqlRead<FilaSql2>(pat, ref, SQL2)),
      caps.sql_read_only === false ? sinPermiso<FilaSql3[]>() : intentar(() => sqlRead<FilaSql3>(pat, ref, SQL3B)),
    ]);
    return { advS, advP, s1, s2, s3 };
  });
  const todos = [r.advS, r.advP, r.s1, r.s2, r.s3];
  const malos = todos.filter((x): x is { ok: false; code: string } => !x.ok);
  if (malos.some((x) => x.code === 'unauthorized')) throw new ProviderError('unauthorized', 401);
  if (malos.length === todos.length && malos.some((x) => x.code === 'unavailable' || x.code === 'timeout' || x.code === 'rate_limited')) {
    throw new ProviderError('unavailable');   // todo caído por la red: reintenta el paso
  }
  const lints = (x: Resultado<unknown>) => (x.ok ? ((x.v as { lints?: LintAdvisor[] } | null)?.lints ?? []) : []);
  const borradores = evaluarSupabase({
    advisors: r.advS.ok || r.advP.ok ? [...lints(r.advS), ...lints(r.advP)] : null,
    sql1: r.s1.ok ? r.s1.v : null, sql2: r.s2.ok ? r.s2.v : null, sql3: r.s3.ok ? r.s3.v : null,
  });
  const g = await guardarHallazgos(env, m, 'supabase', conn.id, borradores, malos.length === 0);
  return { status: 'done', findings: g.n, ...(malos.length ? { error_code: `parcial:${malos.length}` } : {}) };
};
