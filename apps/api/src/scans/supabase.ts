import { estadoAdvisors, evaluarSupabase, MAX_LINTS_POR_ADVISOR, SQL1, SQL2, SQL3B, type FilaSql1, type FilaSql2, type FilaSql3,
  type LintAdvisor } from '@vanguard/core';
import type { FnPaso } from '../jobs.ts';
import { withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ProviderError, check, codigoHttp, pedir, sondear } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { escribirDetalleModulo } from './cobertura.ts';
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

// Respuesta JSON de más bytes que esto → 'invalid' sin parsearla (§A7: 10 ms de CPU). 750 KB ≈ 1000 lints reales por
// advisor; medido en el hilo, 2 × 750 KB ≈ 6,8 ms por paso y 2 × 1,95 MB ≈ 12 ms (solo el parse, ≈ 5,5).
export const MAX_RESPUESTA = 750_000;

// Cuerpo con tope de bytes: un Content-Length de más se rechaza sin leer y, sin él, la lectura se corta al pasar del
// tope (una respuesta de decenas de MB nunca se decodifica entera). null = demasiado grande.
async function leerConTope(r: Response, max: number): Promise<string | null> {
  if (Number(r.headers.get('Content-Length')) > max) { await r.body?.cancel(); return null; }
  if (!r.body) return '';
  const lector = r.body.getReader();
  const dec = new TextDecoder();
  let t = '', n = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) return t + dec.decode();
    n += value.byteLength;
    if (n > max) { await lector.cancel(); return null; }
    t += dec.decode(value, { stream: true });
  }
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
      // 'invalid' de pedir() = host fuera de la lista de salida o redirección a otro host: repetir no lo arregla.
      if (i + 1 < tries && !(e instanceof ProviderError && e.code === 'invalid')) { await backoff(i); continue; }
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
    if (o.text) return r.text();
    const t = await leerConTope(r, MAX_RESPUESTA);
    if (t === null) throw new ProviderError('invalid', r.status);
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
type Fallo = Extract<Resultado<unknown>, { ok: false }>;
const intentar = async <T>(f: () => Promise<T>): Promise<Resultado<T>> => {
  try { return { ok: true, v: await f() }; } catch (e) { return { ok: false, code: e instanceof ProviderError ? e.code : 'unavailable' }; }
};
const TRANSITORIO = new Set(['unavailable', 'timeout', 'rate_limited']);

// Tope de CPU de los advisors (§A7: 10 ms en Free). Cada borrador de advisor cuesta ≈ 0,06-0,1 ms en caliente (evaluar +
// redact + sha256 + filtro; medido en el hilo con 2 × 200 lints reales: 50 borradores ≈ 4-5 ms, los 400 ≈ 32 ms). Los SQL
// (confirmados) cuentan primero y NO se recortan; los advisors se quedan con lo que falte hasta TOPE_BORRADORES, nunca
// menos de TOPE_LINTS_MIN, los más graves primero. Así que no hay cota total: un proyecto con cientos de tablas sin RLS o
// de políticas pase-todo aún puede pasarse de CPU (la cola reintenta y el paso acaba failed por dlq, nunca verde).
// MAX_LINTS_POR_ADVISOR (07.5.1) sigue como tope duro por respuesta.
export const TOPE_BORRADORES = 50;
export const TOPE_LINTS_MIN = 10;

type Tipo = 'security' | 'performance';
const txt = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const bool = (v: unknown) => v === true || v === 't' || v === 'true';
const NOMBRE = /^[a-z0-9_]+$/;
const RANGO: Record<string, number> = { ERROR: 1, WARN: 2, INFO: 3 };
// Gravedad para el recorte: rls_disabled_in_public primero, salvo que SQL 1 ya confirmara esa tabla (saldría como
// duplicado info, §07.5): entonces al final, para no gastar el cupo en duplicados.
const rango = (l: LintAdvisor, rlsSql?: ReadonlySet<string>) => {
  if (txt(l.name).toLowerCase() !== 'rls_disabled_in_public') return RANGO[txt(l.level).toUpperCase()] ?? 4;
  return rlsSql?.has(`${txt(l.metadata?.schema)}.${txt(l.metadata?.name)}`) ? 5 : 0;
};
// Orden estable por gravedad, con el rango calculado una vez por lint.
const porGravedad = <T extends { l: LintAdvisor }>(xs: readonly T[], rlsSql?: ReadonlySet<string>): T[] =>
  xs.map((x) => ({ x, r: rango(x.l, rlsSql) })).sort((a, b) => a.r - b.r).map(({ x }) => x);

// Un advisor cuenta como mirado solo si respondió lints[] y corrió de verdad: `advisor_check_unavailable` y
// `project_not_active` lo dejan sin mirar (§07.5). Se queda con lo que evalAdvisors convertiría en hallazgo, una vez por
// cache_key, ANTES de contar: 250 copias del mismo lint son 1, no un recorte. Tope de MAX_LINTS_POR_ADVISOR: se quedan
// los más graves, `sobran` cuenta el resto (distintos) y se registra advisor_truncado con el número, sin contenido.
export type Advisor = { lints: LintAdvisor[]; sobran: number };
export function leerAdvisor(x: Resultado<unknown>, tipo: Tipo): Resultado<Advisor> {
  if (!x.ok) return x;
  const lints = (x.v as { lints?: unknown } | null)?.lints;
  if (!Array.isArray(lints)) return { ok: false, code: 'invalid' };   // la forma no casa: sin mirar
  const e = estadoAdvisors(lints as LintAdvisor[]);
  if (!e.disponible) return { ok: false, code: 'advisor_check_unavailable' };
  if (e.proyecto_pausado) return { ok: false, code: 'project_not_active' };
  const vistos = new Set<string>();
  const unicos = (lints as (LintAdvisor | null)[]).filter((l): l is LintAdvisor => {
    const k = txt(l?.cache_key);
    if (!k || !NOMBRE.test(txt(l?.name).toLowerCase()) || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  if (unicos.length <= MAX_LINTS_POR_ADVISOR) return { ok: true, v: { lints: unicos, sobran: 0 } };
  log('warn', 'advisor_truncado', { advisor: tipo, n: unicos.length });
  const orden = porGravedad(unicos.map((l) => ({ l }))).map(({ l }) => l);
  return { ok: true, v: { lints: orden.slice(0, MAX_LINTS_POR_ADVISOR), sobran: unicos.length - MAX_LINTS_POR_ADVISOR } };
}

// Recorte por CPU entre los dos advisors: los `cupo` más graves (sin repetir cache_key entre ellos); lo que no cabe se
// suma a los descartes de su advisor. Sin recorte conserva el orden (security y luego performance).
export function recortarLints(adv: Partial<Record<Tipo, Advisor>>, cupo: number, rlsSql?: ReadonlySet<string>):
  { lints: LintAdvisor[]; descartados: Record<Tipo, number> } {
  const vistos = new Set<string>();
  const todos = (['security', 'performance'] as const).flatMap((de) => (adv[de]?.lints ?? []).flatMap((l) => {
    const k = txt(l.cache_key);
    if (vistos.has(k)) return [];
    vistos.add(k);
    return [{ l, de }];
  }));
  const descartados = { security: adv.security?.sobran ?? 0, performance: adv.performance?.sobran ?? 0 };
  if (todos.length <= cupo) return { lints: todos.map(({ l }) => l), descartados };
  log('warn', 'lints_recortados', { n: todos.length, cupo });
  const orden = porGravedad(todos, rlsSql);
  for (const { de } of orden.slice(cupo)) descartados[de]++;
  return { lints: orden.slice(0, cupo).map(({ l }) => l), descartados };
}

// Borradores que darán los SQL sin evaluarlos, con el mismo criterio que evalSql1/2/3 (filas que no dan hallazgo fuera,
// una vez por tabla, por tabla#política y por función: las sobrecargas comparten hallazgo), y las tablas que SQL 1
// confirma (rls off y SELECT para anon).
function cuentaSql(s1: FilaSql1[] | null, s2: FilaSql2[] | null, s3: FilaSql3[] | null) {
  const rlsSql = new Set((s1 ?? []).filter((f) => f && txt(f.tabla) && !bool(f.rls_activa) && bool(f.anon_select))
    .map((f) => `${txt(f.esquema) || 'public'}.${txt(f.tabla)}`));
  const politicas = new Set((s2 ?? []).filter((f) => f && txt(f.tablename) && txt(f.policyname))
    .map((f) => `${txt(f.schemaname) || 'public'}.${txt(f.tablename)}#${txt(f.policyname)}`));
  const rpcs = new Set((s3 ?? []).filter((f) => f && txt(f.funcion) && !bool(f.hay_pre_request))
    .map((f) => `${txt(f.esquema) || 'public'}.${txt(f.funcion)}`));
  return { rlsSql, n: rlsSql.size + politicas.size + rpcs.size };
}

// coverage.detail.supabase.miradas: la clave de cada fuente, y la regla que sale de ella (para el cable trampa).
type Miradas = { advisors: boolean; sql_rls: boolean; sql_politicas: boolean; sql_rpc: boolean };
const REGLA_SQL = { sql_rls: 'SB_RLS_DISABLED', sql_politicas: 'SB_POLICY_ALLOW_ALL', sql_rpc: 'SB_RPC_ANON_NO_LIMIT' } as const;
const DE_REGLA = Object.fromEntries(Object.entries(REGLA_SQL).map(([k, v]) => [v, k])) as Record<string, keyof Miradas>;
const fuenteDe = (rule: string): keyof Miradas | undefined => (rule.startsWith('SB_ADVISOR_') ? 'advisors' : DE_REGLA[rule]);

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
  const sec = leerAdvisor(r.advS, 'security');
  const perf = leerAdvisor(r.advP, 'performance');
  const fuentes = { advisors_security: sec, advisors_performance: perf, sql_rls: r.s1, sql_politicas: r.s2, sql_rpc: r.s3 };
  const sinMirar = Object.fromEntries(Object.entries(fuentes).flatMap(([k, x]) => (x.ok ? [] : [[k, x.code]]))) as Record<string, string>;
  const malos: Fallo[] = Object.values(fuentes).filter((x): x is Fallo => !x.ok);
  if (malos.some((x) => x.code === 'unauthorized')) throw new ProviderError('unauthorized', 401);
  const vio: Miradas = { advisors: sec.ok && perf.ok, sql_rls: r.s1.ok, sql_politicas: r.s2.ok, sql_rpc: r.s3.ok };
  const sql = cuentaSql(r.s1.ok ? r.s1.v : null, r.s2.ok ? r.s2.v : null, r.s3.ok ? r.s3.v : null);
  const { lints, descartados: sobran } = recortarLints({ ...(sec.ok ? { security: sec.v } : {}),
    ...(perf.ok ? { performance: perf.v } : {}) }, Math.max(TOPE_LINTS_MIN, TOPE_BORRADORES - sql.n), r.s1.ok ? sql.rlsSql : undefined);
  const truncado = sobran.security + sobran.performance > 0;
  const detalle = (miradas: Miradas) => ({ miradas, ...(malos.length ? { sin_mirar: sinMirar } : {}),
    ...(truncado ? { lints_descartados: sobran } : {}),
    ...(malos.some((x) => x.code === 'project_not_active') ? { proyecto_pausado: true } : {}) });

  if (malos.length === Object.keys(fuentes).length) {
    if (malos.some((x) => TRANSITORIO.has(x.code))) throw new ProviderError('unavailable');   // todo caído por la red: reintenta
    // Ninguna fuente respondió (permisos recortados, proyecto borrado o pausado…): failed, nunca done con 0 hallazgos
    // (§07, 07.5). El detalle es informativo: si no se puede escribir, el paso falla igual.
    await escribirDetalleModulo(env, m, 'supabase', detalle(vio))
      .catch(() => log('warn', 'supabase.detalle_error', { scan_run_id: m.scan_run_id }));
    return { status: 'failed', error_code: malos[0]?.code ?? 'unavailable', connection_id: conn.id };
  }

  const borradores = evaluarSupabase({
    advisors: sec.ok || perf.ok ? lints : null,
    sql1: r.s1.ok ? r.s1.v : null, sql2: r.s2.ok ? r.s2.v : null, sql3: r.s3.ok ? r.s3.v : null,
  });
  // Auto-verifica todo el módulo (p_rule null) solo si se miró todo y se guardó todo: con lints de más, los que sobran
  // quedarían 'verified'.
  const completo = malos.length === 0 && !truncado;
  const g = await guardarHallazgos(env, m, 'supabase', conn.id, borradores, completo);
  // Con descartes del cable trampa, las fuentes que dieron filas quedan sin mirar: la descartada podía ser suya.
  const tocadas = g.descartadas > 0 ? new Set(borradores.map((b) => fuenteDe(b.rule_id))) : new Set<keyof Miradas | undefined>();
  const miradas = Object.fromEntries(Object.entries(vio).map(([k, v]) =>
    [k, v && !tocadas.has(k as keyof Miradas) && !tocadas.has(undefined)])) as Miradas;
  // Sin esa auto-verificación completa, cada SQL mirado entero (respondió y el cable trampa no lo tocó; los SQL nunca se
  // recortan) verifica su regla con p_rule: una tabla arreglada no se queda 'open' porque sobraran lints o cayera otra
  // fuente. Los SB_ADVISOR_* no (son muchas reglas y lo recortado podía ser suyo). ≤ 3 subpeticiones, una por regla
  // (presupuesto 1). El paso entero:
  // Supabase ≤ 9 (advisors 2 × 3 intentos, SQL 3 × 1) y base ≤ 20 (conexión 2, secreto 2, lote ≤ 8, esto ≤ 3, coverage ≤ 5).
  if (!(completo && g.descartadas === 0)) {
    await Promise.all((Object.keys(REGLA_SQL) as (keyof typeof REGLA_SQL)[]).filter((k) => miradas[k])
      .map((k) => guardarHallazgos(env, m, 'supabase', conn.id, [], true, REGLA_SQL[k], 1)));
  }
  await escribirDetalleModulo(env, m, 'supabase', detalle(miradas));
  const codigo = [g.error_code, malos.length ? `parcial:${malos.length}` : '', truncado ? 'lints_truncados' : '']
    .filter(Boolean).join(',');
  return { status: 'done', findings: g.n, ...(codigo ? { error_code: codigo } : {}) };
};
