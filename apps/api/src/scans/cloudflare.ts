import type { PermCheck } from '@vanguard/contracts';
import { hostCanonico, reglaBajoAtaque, TTL_BAJO_ATAQUE_S } from '@vanguard/core';
import { cabecerasCf, mutarEnSeco } from '../actions/cf-seco.ts';
import type { FnPaso } from '../jobs.ts';
import { withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ProviderError, check, codigoHttp, pedir, sondear } from '../lib/http.ts';
import { escribirDetalleModulo } from './cobertura.ts';
import { conexionActiva, guardarHallazgos } from './comun.ts';
import { pasoCloudflareSitio } from './cloudflare-sitio.ts';
import { sondeoFallido, veredicto, type Sondeo } from './sondeo.ts';

// Sondeo de los tokens de Cloudflare (§08.2–08.3): lectura obligatoria con zone_read y analytics_read; acciones opcional.
const CF = 'https://api.cloudflare.com/client/v4';
const PLAZO = 20_000; // Cloudflare: 20 s (S15 15.3)

type Zona = { name?: string; status?: string; paused?: boolean; account?: { id?: string }; plan?: { legacy_id?: string; name?: string } };
type Verificado = { status?: string; expires_on?: string };

async function cfJson<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await pedir(`${CF}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json', ...(init.headers ?? {}) } }, PLAZO);
  if (!r.ok) { await r.body?.cancel(); throw new ProviderError(codigoHttp(r.status), r.status); }
  try { return (await r.json()) as T; } catch { throw new ProviderError('invalid', r.status); }
}

// G0 (§08.5): límites de la zona; un error de permiso de GraphQL llega con HTTP 200 dentro de errors[].
const G0 = `query Limites($zoneTag: string) {
  viewer { zones(filter: { zoneTag: $zoneTag }) { settings {
    httpRequestsAdaptiveGroups { enabled maxDuration maxPageSize notOlderThan availableFields }
  } } }
}`;
const G0B = '{ __type(name: "ZoneHttpRequestsAdaptiveGroupsDimensions") { fields { name } } }';
type GqlErr = { message?: string; extensions?: { code?: string } };
type G0Res = { data?: { viewer?: { zones?: { settings?: { httpRequestsAdaptiveGroups?: {
  maxDuration?: number; maxPageSize?: number; notOlderThan?: number; availableFields?: string[] } } }[] } }; errors?: GqlErr[] | null };
const esPermiso = (e: GqlErr) => /authz|not authorized|does not have (access|permission)|permission/i
  .test(`${e.extensions?.code ?? ''} ${e.message ?? ''}`);

async function verificar(token: string, accountId?: string): Promise<{ tipo: 'user' | 'account'; v: Verificado } | null> {
  try {
    const u = await cfJson<{ result?: Verificado }>(token, '/user/tokens/verify');
    return { tipo: 'user', v: u.result ?? {} };
  } catch (e) {
    if (!(e instanceof ProviderError) || e.status !== 401 || !accountId) return null;
  }
  try {   // token de cuenta: el verify de usuario da 401 (código 1000)
    const a = await cfJson<{ result?: Verificado }>(token, `/accounts/${accountId}/tokens/verify`);
    return { tipo: 'account', v: a.result ?? {} };
  } catch { return null; }
}

async function zona(token: string, zoneId: string): Promise<{ z: Zona } | { error: Sondeo }> {
  try {
    const r = await cfJson<{ result?: Zona }>(token, `/zones/${zoneId}`);
    return { z: r.result ?? {} };
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : 'unavailable';
    const c: PermCheck[] = [{ permission: 'zone_read', ok: false, required: true, error_code: code }];
    if (code === 'unauthorized') {
      return { error: sondeoFallido('rechazado', c, { motivo: 'unauthorized', mensaje: 'Cloudflare no reconoce este token' }) };
    }
    if (code === 'forbidden' || code === 'not_found') {
      return { error: sondeoFallido('rechazado', c, { faltan: ['zone_read'],
        mensaje: 'El token no ve esta zona: en el paso 2 elige Specific zone → tu dominio' }) };
    }
    return { error: sondeoFallido('caido', c, { mensaje: 'Cloudflare no respondió. Vuelve a intentarlo en un minuto.' }) };
  }
}

const caduca = (v: Verificado | undefined) =>
  v?.expires_on && !Number.isNaN(Date.parse(v.expires_on)) ? new Date(v.expires_on).toISOString() : null;
const inactivo = (v: Verificado | undefined) => v?.status && v.status !== 'active';

export async function probarCloudflareLectura(token: string, zoneId: string): Promise<Sondeo> {
  const zr = await zona(token, zoneId);
  if ('error' in zr) return zr.error;
  const z = zr.z;
  const ver = await verificar(token, z.account?.id);
  if (inactivo(ver?.v)) {
    return sondeoFallido('rechazado', [{ permission: 'zone_read', ok: true, required: true }],
      { motivo: 'unauthorized', mensaje: 'Ese token de Cloudflare está desactivado o caducó' });
  }
  const h = { Authorization: `Bearer ${token}` };
  const gql = (query: string, variables?: Record<string, unknown>) => pedir(`${CF}/graphql`, { method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) }, PLAZO)
    .then(async (r) => (r.ok ? ((await r.json()) as G0Res) : (await r.body?.cancel(), codigoHttp(r.status))))
    .catch((e: unknown) => (e instanceof ProviderError ? e.code : 'unavailable' as const));
  const base = `${CF}/zones/${zoneId}`;
  const [ssl, dns, fw, waf, bot, g0, g0b] = await Promise.all([
    sondear(`${base}/settings/ssl`, { headers: h }, PLAZO),
    sondear(`${base}/dns_records?per_page=5`, { headers: h }, PLAZO),
    sondear(`${base}/firewall/access_rules/rules?per_page=5`, { headers: h }, PLAZO),
    sondear(`${base}/rulesets/phases/http_request_firewall_custom/entrypoint`, { headers: h }, PLAZO),
    sondear(`${base}/bot_management`, { headers: h }, PLAZO),
    gql(G0, { zoneTag: zoneId }),
    gql(G0B),
  ]);
  const activa = z.status === 'active';
  let analytics: PermCheck;
  let limites: { max_duration_s: number | null; max_page_size: number | null; not_older_than_s: number | null } | null = null;
  let campos: string[] = [];
  if (typeof g0 === 'string') analytics = { permission: 'analytics_read', ok: false, required: true, error_code: g0 };
  else if (g0.errors?.length) {
    // Con la zona pending, un error que no es de permiso no rechaza: analytics_read queda invalid (§08.2 paso 5).
    const permiso = g0.errors.some(esPermiso);
    analytics = { permission: 'analytics_read', ok: false, required: permiso || activa, error_code: permiso ? 'forbidden' : 'invalid' };
  } else {
    const s = g0.data?.viewer?.zones?.[0]?.settings?.httpRequestsAdaptiveGroups;
    limites = { max_duration_s: s?.maxDuration ?? null, max_page_size: s?.maxPageSize ?? null, not_older_than_s: s?.notOlderThan ?? null };
    campos = s?.availableFields ?? [];
    analytics = { permission: 'analytics_read', ok: true, required: true };
  }
  const nombres = typeof g0b === 'string' ? [] : ((g0b.data as { __type?: { fields?: { name?: string }[] } } | undefined)
    ?.__type?.fields ?? []).map((f) => f.name);
  const checks: PermCheck[] = [
    { permission: 'zone_read', ok: true, required: true },
    check('zone_settings_read', false, ssl),
    check('dns_read', false, dns),
    analytics,
    check('firewall_read', false, fw),
    check('waf_read', false, waf, true),     // 404 = sin reglas propias: cuenta como OK
    check('bot_read', false, bot),
  ];
  const v = veredicto(checks);
  const caps: Record<string, boolean> = Object.fromEntries(checks.map((c) => [c.permission, c.ok]));
  const name = typeof z.name === 'string' ? z.name : zoneId;
  return {
    ...v,
    ...(v.estado === 'rechazado' && v.faltan.includes('analytics_read')
      ? { mensaje: 'Te falta el permiso Zone · Analytics · Read en el token de lectura' } : {}),
    ...(v.estado === 'caido' ? { mensaje: 'Cloudflare no respondió. Vuelve a intentarlo en un minuto.' } : {}),
    checks,
    capabilities: { ...caps, zone_active: activa,
                    graphql_client_ip: campos.includes('dimensions_clientIP') || nombres.includes('clientIP') },
    scopes: checks.filter((c) => c.ok).map((c) => c.permission),
    meta: { zone_id: zoneId, zone_name: name, account_id: z.account?.id ?? null,
            plan: z.plan?.legacy_id ?? z.plan?.name?.toLowerCase() ?? null, zone_status: z.status ?? null,
            zone_paused: z.paused === true, token_type: ver?.tipo ?? null, cf_graphql: limites,
            threshold_factor: 1, watch_hosts: [], cf_cursor: null, cf_fw_cursor: null },
    label: `Cloudflare · ${name}`,
    expiresAt: caduca(ver?.v),
  };
}

// Sonda de Zone · Config Rules · Edit (modo-bajo-ataque.md §5, E9): GET del entrypoint de http_config_settings y la
// misma regla que mandaría E21 (con http.request.timestamp.sec en la expresión) por mutarEnSeco: dry_run, nunca escribe.
// Solo un 403 guarda config_rules_edit:false; un fallo de red, un 4xx de validación o un token inválido omiten la clave
// (E55 dirá sin_probar y E56 lo valida): un fallo pasajero no esconde el botón. required:false: un token con solo
// Firewall Services · Edit sigue conectando. 2 subpeticiones (+1 si se colara una escritura y hubiera que borrarla).
export const REF_SONDA = 'vg_ua_sonda';
type Sonda = { check: PermCheck; capacidad: { config_rules_edit?: boolean } };
async function sondaConfigRules(token: string, zoneId: string, zona: unknown): Promise<Sonda> {
  const mal = (error_code: PermCheck['error_code'], capacidad: Sonda['capacidad'] = {}): Sonda =>
    ({ check: { permission: 'config_rules_edit', ok: false, required: false, error_code }, capacidad });
  if (!/^[a-f0-9]{32}$/.test(zoneId)) return mal('invalid');
  const host = hostCanonico(`vanguard-sonda.${typeof zona === 'string' ? zona : ''}`) ?? 'vanguard-sonda.example.com';
  const regla = reglaBajoAtaque(host, REF_SONDA, 'VanGUARD · sonda de permiso (dry_run, no se publica)',
    new Date(Date.now() + TTL_BAJO_ATAQUE_S * 1000));
  let ep: Response;
  try {
    ep = await pedir(`${CF}/zones/${zoneId}/rulesets/phases/http_config_settings/entrypoint`, { headers: cabecerasCf(token) }, PLAZO);
  } catch {
    return mal('unavailable');
  }
  let id: unknown = null;
  if (ep.ok) { try { id = ((await ep.json()) as { result?: { id?: unknown } }).result?.id; } catch { id = null; } }
  else await ep.body?.cancel();
  if (ep.status === 403) return mal('forbidden', { config_rules_edit: false });
  if (!ep.ok && ep.status !== 404) return mal(ep.status === 408 || ep.status === 429 || ep.status >= 500 ? 'unavailable' : 'invalid');
  const seco = ep.ok && typeof id === 'string' && /^[A-Za-z0-9]{1,64}$/.test(id)
    ? await mutarEnSeco(token, zoneId, `/rulesets/${id}/rules`, regla, REF_SONDA)
    : ep.status === 404
      ? await mutarEnSeco(token, zoneId, '/rulesets',
        { name: 'default', kind: 'zone', phase: 'http_config_settings', rules: [regla] }, REF_SONDA)
      : { tipo: 'sin_respuesta' as const };
  if (seco.tipo === 'valida') {
    return { check: { permission: 'config_rules_edit', ok: true, required: false }, capacidad: { config_rules_edit: true } };
  }
  if (seco.tipo === 'sin_permiso') return mal('forbidden', { config_rules_edit: false });
  if (seco.tipo === 'rechazada' || seco.tipo === 'token_invalido') return mal('invalid');
  return mal('unavailable');
}

// Token de acciones («Modo blindaje»): el GET de access rules al conectar (la escritura se prueba al confirmar) y, en
// paralelo, la sonda de Config Rules · Edit del modo bajo ataque.
export async function probarCloudflareAcciones(token: string, zoneId: string, lectura: Sondeo): Promise<Sondeo> {
  const [fw, cfg] = await Promise.all([
    sondear(`${CF}/zones/${zoneId}/firewall/access_rules/rules?per_page=5`, { headers: { Authorization: `Bearer ${token}` } }, PLAZO),
    sondaConfigRules(token, zoneId, lectura.meta.zone_name),
  ]);
  const checks = [check('firewall_read', true, fw), cfg.check];
  const v = veredicto(checks);
  const meta = { ...lectura.meta };
  delete meta.cf_cursor;
  delete meta.cf_fw_cursor;
  return {
    ...v,
    ...(v.estado === 'rechazado' ? { mensaje: 'El token de acciones no ve las reglas de acceso de esta zona (Firewall Services)' } : {}),
    checks,
    capabilities: { firewall_read: checks[0]?.ok === true, ...cfg.capacidad },
    scopes: checks.filter((c) => c.ok).map((c) => c.permission),
    meta,
    label: `${lectura.label} · blindaje`.slice(0, 80),
    expiresAt: null,
  };
}

// ── Paso cloudflare de la auditoría (§08.7). P0: CF_ZONE_01 (zona pausada: solo DNS, sin WAF ni proxy), critical.
// Con status !== 'active' no hay hallazgo: es la fila de aviso de §08.3. CF_TLS_*/CF_WAF_01 son P0 tardío.
export function reglasZona(z: { name?: string; status?: string; paused?: boolean }, zoneId: string) {
  if (z.paused !== true || z.status !== 'active') return [];
  return [{ rule_id: 'CF_ZONE_01', severity: 'critical', confirmed: true,
    title: `La zona ${z.name ?? zoneId} está pausada: Cloudflare solo resuelve DNS, sin WAF ni proxy`.slice(0, 200),
    resource: `zone:${zoneId}`, evidence: { zone_id: zoneId, zone_name: z.name ?? null, paused: true, status: z.status } }];
}

// Una lectura de la zona. Un zone_id mal formado nunca llega a GET /zones/ (devolvería la lista de zonas) y una respuesta
// sin el objeto de la zona es 'invalid': sin zona no hay «mirado», nunca un {} que pase por zona sana.
const ZONE_ID = /^[a-f0-9]{32}$/;
export async function zonaParaAuditar(token: string, zoneId: string): Promise<Zona> {
  if (!ZONE_ID.test(zoneId)) throw new ProviderError('invalid');
  const z = (await cfJson<{ result?: unknown }>(token, `/zones/${zoneId}`)).result;
  if (!z || typeof z !== 'object' || Array.isArray(z)) throw new ProviderError('invalid');
  return z as Zona;
}

// Paso cloudflare completo: CF_ZONE_01 con el cable trampa (15.8 regla 9) y coverage.detail.cloudflare.miradas.
// zona = la zona se leyó y su fila, si la hubo, quedó guardada (un descarte la deja sin mirar: E6 no pinta 0 ✓).
// ≈ 12 subpeticiones del paso (conexión 2, secreto 2, Cloudflare 1, RPC 1–8, coverage 2).
export const pasoCloudflare: FnPaso = async (env, m) => {
  const conn = await conexionActiva(env, m, 'cloudflare');
  if (!conn) return { status: 'skipped', error_code: 'no_connection' };
  // Modo sitio (cloudflare-por-url.md): sin zona; su revisión va aparte y el modo zona no cambia.
  if (conn.meta.mode === 'url') return pasoCloudflareSitio(env, m, conn);
  const zoneId = String(conn.meta.zone_id ?? '');
  const ctx = { orgId: m.org_id, connectionId: conn.id, provider: 'cloudflare' as const, kind: 'read' as const };
  const z = await withSecret(env, db(env), ctx, (t) => zonaParaAuditar(t, zoneId));
  const g = await guardarHallazgos(env, m, 'cloudflare', conn.id, reglasZona(z, zoneId), true, 'CF_ZONE_01');
  await escribirDetalleModulo(env, m, 'cloudflare', { miradas: { zona: g.descartadas === 0 } });
  return { status: 'done', findings: g.n, ...(g.error_code ? { error_code: g.error_code } : {}) };   // tripwire
};
