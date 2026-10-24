// Reglas de auditoría del módulo Supabase (S07 07.5, canónicas A9.2, S15 15.9): SQL fijos de solo lectura + funciones
// puras filas → borradores de hallazgo. Sin red: el BACK corre los SQL por POST /v1/projects/{ref}/database/query/read-only
// y los advisors por GET /v1/projects/{ref}/advisors/{security,performance}, y pasa aquí las filas tal cual.
// La evidencia sale ya redactada y sin filas de datos del cliente ni project_ref; dedupe_key lo calcula el BACK con
// dedupeKey(org_id, rule_id, dedupe_input) de crypto.ts.
import type { Severity } from '@vanguard/contracts';
import { redact, redactString } from '../redact.ts';
import { scanInjection } from '../untrusted.ts';
import { tituloAdvisor, tituloPoliticaPaseTodo, tituloRlsDesactivada, tituloRpcSinFreno } from '../templates/titles.ts';

// ── SQL de lista blanca (literal de canónicas A9.2 = S07 07.5.2–07.5.4) ──────────────────────────────────────────────
/** SQL 1 · SB_RLS_DISABLED (también lo usa el monitor sb_exposure, S07 07.5.7). */
export const SQL1 = `select n.nspname as esquema, c.relname as tabla, c.relrowsecurity as rls_activa,
       pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_select, coalesce(s.n_live_tup,0) as filas_estimadas
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_stat_user_tables s on s.relid = c.oid
where c.relkind in ('r','p') and n.nspname = 'public';`;
/** SQL 2 · SB_POLICY_ALLOW_ALL. */
export const SQL2 = `select schemaname, tablename, policyname, cmd, roles from pg_catalog.pg_policies
where schemaname = 'public' and (qual = 'true' or with_check = 'true') and ('anon' = any(roles) or 'public' = any(roles));`;
/** SQL 3 · SB_RPC_ANON_NO_LIMIT (canónico; el BACK usa SQL 3b). */
export const SQL3 = `select n.nspname as esquema, p.proname as funcion, p.prosecdef as definer,
       exists (select 1 from pg_catalog.pg_roles r, unnest(r.rolconfig) cfg
               where r.rolname = 'authenticator' and cfg like 'pgrst.db_pre_request=%') as hay_pre_request
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f' and p.provolatile = 'v'
  and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE');`;
/** SQL 3b (decidido en S07 07.5.4): SQL 3 + columna `args` (para el revoke) + sin funciones de extensiones. */
export const SQL3B = `select n.nspname as esquema, p.proname as funcion, p.prosecdef as definer,
       pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
       exists (select 1 from pg_catalog.pg_roles r, unnest(r.rolconfig) cfg
               where r.rolname = 'authenticator' and cfg like 'pgrst.db_pre_request=%') as hay_pre_request
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f' and p.provolatile = 'v'
  and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
  and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::regclass
                  and d.objid = p.oid and d.deptype = 'e');`;
/** Las únicas consultas que el paso `supabase` puede mandar al endpoint de solo lectura (P0). */
export const SQL_SUPABASE: readonly string[] = Object.freeze([SQL1, SQL2, SQL3B]);

// ── Auth (P1, literal de S07 07.5.6): se filtra al recibir; el resto de los 238 campos (con secretos) se descarta ──
export const AUTH_WHITELIST = ['disable_signup','external_anonymous_users_enabled','password_min_length',
  'password_required_characters','password_hibp_enabled','mfa_totp_enroll_enabled','mfa_totp_verify_enabled',
  'mailer_otp_exp','mailer_otp_length','security_captcha_enabled','refresh_token_rotation_enabled',
  'jwt_exp','site_url','uri_allow_list'] as const;
export const pickAuth = (raw: Record<string, unknown>) =>
  Object.fromEntries(AUTH_WHITELIST.filter(k => k in raw).map(k => [k, raw[k]]));  // el resto se descarta

// ── Identificadores en el SQL para copiar (S07 07.5.2): nunca a pelo ────────────────────────────────────────────────
/** Identificador SQL entre comillas dobles, con cada `"` duplicada: `x; drop table y; --` queda como un nombre. */
export const quoteIdent = (s: string) => '"' + String(s).replace(/"/g, '""') + '"';
/** Literal de texto SQL con cada `'` duplicada (standard_conforming_strings, por defecto desde Postgres 9.1). */
export const quoteLiteral = (s: string) => "'" + String(s).replace(/'/g, "''") + "'";
/** `esquema.objeto` → [esquema, objeto], partiendo por el primer punto (el esquema de estas reglas es `public`, sin
 *  puntos; el objeto puede llevarlos). Sin punto → ['public', recurso]. */
export function partirRecurso(resource: string): [string, string] {
  const i = resource.indexOf('.');
  return i > 0 ? [resource.slice(0, i), resource.slice(i + 1)] : ['public', resource];
}

// ── Filas de entrada (forma del JSON del endpoint de solo lectura; tolerante con bool/bigint en texto) ──────────────
export type FilaSql1 = { esquema?: string; tabla: string; rls_activa: boolean | string; anon_select: boolean | string;
  filas_estimadas?: number | string | null };
export type FilaSql2 = { schemaname?: string; tablename: string; policyname: string; cmd: string;
  roles: readonly string[] | string };
export type FilaSql3 = { esquema?: string; funcion: string; definer: boolean | string; hay_pre_request: boolean | string;
  args?: string | null };
/** Lint de `V1ProjectAdvisorsResponse.lints[]` (S07 07.5.1; `metadata` es opcional). */
export type LintAdvisor = { name: string; title?: string; level?: string; facing?: string; categories?: readonly string[];
  description?: string; detail?: string; remediation?: string; cache_key: string; observed_at?: string;
  metadata?: { schema?: string; name?: string; entity?: string; type?: string; fkey_name?: string;
    fkey_columns?: readonly number[] } | null };

/** FindingDraft de S15 15.9 para este módulo. Sin dedupe_key ni connection_id (los pone el BACK / la RPC). */
export type SbFindingDraft = {
  module: 'supabase'; rule_id: string; severity: Severity; confirmed: boolean; origin: 'rule' | 'provider';
  title: string; resource: string; evidence: Record<string, unknown>; dedupe_input: string; suspected_injection: boolean;
};

// ── Ayudas ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const bool = (v: unknown) => v === true || v === 't' || v === 'true';
const txt = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const MAX_RECURSO = 300;
/** Cifras volátiles a 2 cifras significativas (500, 1.200, 34.000): la evidencia no cambia en cada auditoría y no
 *  invalida el fix_prompt en caché (S07 07.5, S11 11.4). */
export function dosCifras(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 100) return Math.round(n);
  const p = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}
/** `name[]` llega como array JSON o como literal de Postgres `{anon,authenticated}`. */
function roles(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(txt).filter(Boolean);
  const s = txt(v).trim().replace(/^\{|\}$/g, '');
  return s ? s.split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean) : [];
}
const recurso = (esquema: string, nombre: string) => redactString(`${esquema || 'public'}.${nombre}`).slice(0, MAX_RECURSO);
/** Redacta y marca sospecha de inyección por los nombres (la severidad no cambia: prueba 3 de S06 06.8). */
function borrador(d: Omit<SbFindingDraft, 'module' | 'suspected_injection'>): SbFindingDraft {
  const evidence = redact(d.evidence);
  return { module: 'supabase', ...d, title: redactString(d.title), evidence,
    suspected_injection: scanInjection({ resource: d.resource, evidence }).length > 0 };
}

// ── SQL 1 → SB_RLS_DISABLED ─────────────────────────────────────────────────────────────────────────────────────────
/** `rls_activa=false` y `anon_select=true` → critical confirmado, una vez por tabla. */
export function evalSql1(filas: readonly FilaSql1[]): SbFindingDraft[] {
  const out: SbFindingDraft[] = [], vistos = new Set<string>();
  for (const f of filas) {
    if (!f || bool(f.rls_activa) || !bool(f.anon_select)) continue;
    const esquema = txt(f.esquema) || 'public', tabla = txt(f.tabla);
    const resource = recurso(esquema, tabla);
    if (!tabla || vistos.has(resource)) continue;
    vistos.add(resource);
    out.push(borrador({ rule_id: 'SB_RLS_DISABLED', severity: 'critical', confirmed: true, origin: 'rule',
      title: tituloRlsDesactivada(resource), resource, dedupe_input: resource,
      evidence: { esquema, tabla, anon_select: true, filas_estimadas: dosCifras(f.filas_estimadas) } }));
  }
  return out;
}

// ── SQL 2 → SB_POLICY_ALLOW_ALL ─────────────────────────────────────────────────────────────────────────────────────
/** Cada fila → high confirmado; dos políticas pase-todo en la misma tabla son dos hallazgos (dedupe_input con `#`). */
export function evalSql2(filas: readonly FilaSql2[]): SbFindingDraft[] {
  const out: SbFindingDraft[] = [], vistos = new Set<string>();
  for (const f of filas) {
    if (!f) continue;
    const tabla = txt(f.tablename), policyname = txt(f.policyname);
    if (!tabla || !policyname) continue;
    const resource = recurso(txt(f.schemaname), tabla);
    const dedupe_input = `${resource}#${redactString(policyname)}`;
    if (vistos.has(dedupe_input)) continue;
    vistos.add(dedupe_input);
    const cmd = txt(f.cmd).toUpperCase();
    out.push(borrador({ rule_id: 'SB_POLICY_ALLOW_ALL', severity: 'high', confirmed: true, origin: 'rule',
      title: tituloPoliticaPaseTodo(policyname, resource, cmd), resource, dedupe_input,
      evidence: { policyname, cmd, roles: roles(f.roles) } }));
  }
  return out;
}

// ── SQL 3 / 3b → SB_RPC_ANON_NO_LIMIT ───────────────────────────────────────────────────────────────────────────────
/** Nombre sensible → critical (canónicas A9.2). */
export const REGEX_RPC_SENSIBLE = /(otp|login|pass|reset|email|sms|pago|pay|delete|borrar)/i;
const MAX_FIRMAS = 10;
/** `hay_pre_request=false` → high (critical si el nombre es sensible), `confirmed=false` (el freno podría estar fuera
 *  de Postgres). Las sobrecargas comparten hallazgo; con SQL 3b sus firmas van en `args` y `otras_firmas`. */
export function evalSql3(filas: readonly FilaSql3[]): SbFindingDraft[] {
  const porRecurso = new Map<string, { esquema: string; funcion: string; definer: boolean; firmas: string[] }>();
  for (const f of filas) {
    if (!f || bool(f.hay_pre_request)) continue;
    const funcion = txt(f.funcion);
    if (!funcion) continue;
    const esquema = txt(f.esquema) || 'public', resource = recurso(esquema, funcion);
    const g = porRecurso.get(resource) ?? { esquema, funcion, definer: false, firmas: [] };
    g.definer ||= bool(f.definer);
    if (typeof f.args === 'string' && !g.firmas.includes(f.args) && g.firmas.length < MAX_FIRMAS) g.firmas.push(f.args);
    porRecurso.set(resource, g);
  }
  return [...porRecurso].map(([resource, g]) => {
    const evidence: Record<string, unknown> = { funcion: g.funcion };
    if (g.firmas.length > 0) evidence.args = g.firmas[0];
    evidence.definer = g.definer;
    evidence.hay_pre_request = false;
    if (g.firmas.length > 1) evidence.otras_firmas = g.firmas.slice(1);
    return borrador({ rule_id: 'SB_RPC_ANON_NO_LIMIT', severity: REGEX_RPC_SENSIBLE.test(g.funcion) ? 'critical' : 'high',
      confirmed: false, origin: 'rule', title: tituloRpcSinFreno(resource), resource, dedupe_input: resource, evidence });
  });
}

// ── Advisors → SB_ADVISOR_<NAME> ────────────────────────────────────────────────────────────────────────────────────
/** Tope por advisor (S07 07.5.1): el BACK descarta el resto y registra `advisor_truncado` con el número. */
export const MAX_LINTS_POR_ADVISOR = 200;
const NO_SON_HALLAZGO = new Set(['advisor_check_unavailable', 'project_not_active']);
const NIVEL_SEV: Readonly<Record<string, Severity>> = { ERROR: 'high', WARN: 'medium', INFO: 'low' };
const GUIA_SUPABASE = /^https:\/\/supabase\.com\/docs\/[A-Za-z0-9/_.#?=&%-]*$/;
const MAX_DETALLE = 500;

/** Estado del advisor: `advisor_check_unavailable` → «sin mirar»; `project_not_active` → «proyecto pausado». */
export function estadoAdvisors(lints: readonly LintAdvisor[]): { disponible: boolean; proyecto_pausado: boolean } {
  const nombres = new Set(lints.map((l) => txt(l?.name).toLowerCase()));
  return { disponible: !nombres.has('advisor_check_unavailable'), proyecto_pausado: nombres.has('project_not_active') };
}

/** Cada lint → hallazgo `origin:'provider'`, `confirmed:false`, `dedupe_input = cache_key`. ERROR→high, WARN→medium,
 *  INFO→low; `rls_disabled_in_public`→critical, salvo que SQL 1 ya confirmara esa tabla (`rlsConfirmadas`, recursos de
 *  SB_RLS_DISABLED): entonces sale `info` con `duplicado_de` (anti-doble conteo de 07.5). Si SQL 1 no corrió, no se
 *  pasa `rlsConfirmadas` y el lint conserva su critical. */
export function evalAdvisors(lints: readonly LintAdvisor[], opts: { rlsConfirmadas?: Iterable<string> } = {}): SbFindingDraft[] {
  const confirmadas = new Set(opts.rlsConfirmadas ?? []);
  const out: SbFindingDraft[] = [], vistos = new Set<string>();
  for (const l of lints) {
    const name = txt(l?.name).toLowerCase(), cache_key = txt(l?.cache_key);
    if (!/^[a-z0-9_]+$/.test(name) || !cache_key || NO_SON_HALLAZGO.has(name) || vistos.has(cache_key)) continue;
    vistos.add(cache_key);
    const md: NonNullable<LintAdvisor['metadata']> = l.metadata ?? {};
    const esquema = txt(md.schema), objeto = txt(md.name), tipo = txt(md.type);
    const resource = esquema && objeto ? recurso(esquema, objeto) : 'proyecto';
    const nivel = txt(l.level).toUpperCase();
    const evidence: Record<string, unknown> = { lint: name, nivel,
      categorias: (Array.isArray(l.categories) ? l.categories : []).map(txt).filter(Boolean).slice(0, 5) };
    if (esquema) evidence.esquema = esquema;
    if (objeto) {
      if (tipo === 'function') evidence.funcion = objeto;
      else if (!tipo || tipo === 'table') evidence.tabla = objeto;
      else { evidence.objeto = objeto; evidence.tipo = tipo; }
    }
    const detalle = txt(l.detail);
    if (detalle) evidence.detalle = detalle.length > MAX_DETALLE ? detalle.slice(0, MAX_DETALLE) + '…' : detalle;
    if (GUIA_SUPABASE.test(txt(l.remediation))) evidence.remediacion = l.remediation;
    const duplicado = name === 'rls_disabled_in_public' && resource !== 'proyecto' && confirmadas.has(resource);
    if (duplicado) evidence.duplicado_de = 'SB_RLS_DISABLED';
    const severity: Severity = duplicado ? 'info' : name === 'rls_disabled_in_public' ? 'critical' : NIVEL_SEV[nivel] ?? 'low';
    out.push(borrador({ rule_id: 'SB_ADVISOR_' + name.toUpperCase(), severity, confirmed: false, origin: 'provider',
      title: tituloAdvisor(name, txt(l.title), resource, duplicado), resource, dedupe_input: cache_key, evidence }));
  }
  return out;
}

// ── Todo el paso `supabase` de una vez ──────────────────────────────────────────────────────────────────────────────
/** Combina las fuentes que respondieron (`null`/ausente = «sin mirar»: no genera hallazgos ni cuenta como sano).
 *  `advisors` = lints de security + performance ya recortados a MAX_LINTS_POR_ADVISOR cada uno. */
export function evaluarSupabase(e: { advisors?: readonly LintAdvisor[] | null; sql1?: readonly FilaSql1[] | null;
  sql2?: readonly FilaSql2[] | null; sql3?: readonly FilaSql3[] | null }): SbFindingDraft[] {
  const rls = e.sql1 ? evalSql1(e.sql1) : [];
  const adv = e.advisors ? evalAdvisors(e.advisors, e.sql1 ? { rlsConfirmadas: rls.map((d) => d.resource) } : {}) : [];
  return [...adv, ...rls, ...(e.sql2 ? evalSql2(e.sql2) : []), ...(e.sql3 ? evalSql3(e.sql3) : [])];
}
