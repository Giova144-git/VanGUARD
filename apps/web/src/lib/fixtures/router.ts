// Enrutador falso del modo fixtures (S14 §14.19). Único archivo que conoce los fixtures; solo se carga con
// import dinámico desde api.ts, así que no entra en el bundle de producción. Cero peticiones de red.
import { fixtures as fx, type ConnectionCreated, type ConnectionPublic, type Me, type Org, type PermCheck } from '@vanguard/contracts';
import { ApiError } from '../errores';
import { tipoSesionFalsa } from '../supabase-doble';

type H = (m: RegExpMatchArray, body: unknown, q: URLSearchParams) => unknown;
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const falla = (s: number, c: string, m: string, d?: Record<string, unknown>): never => { throw new ApiError(s, c, m, undefined, d); };

const ORG_DEMO = fx.me.orgs[0]!.id;

// ?escenario=vacio prueba onboarding y estados vacíos; se recuerda en la pestaña para no perderlo al navegar.
function escenario(): 'lleno' | 'vacio' {
  try {
    const q = new URLSearchParams(location.search).get('escenario');
    if (q) sessionStorage.setItem('vg-fx-escenario', q);
    return sessionStorage.getItem('vg-fx-escenario') === 'vacio' ? 'vacio' : 'lleno';
  } catch { return 'lleno'; }
}

// Estado en memoria de la pestaña: organizaciones creadas con /start.
const orgsNuevas: Org[] = [];
const esDemo = (org: string) => org === ORG_DEMO;
const vacia = (org: string) => escenario() === 'vacio' || !esDemo(org);

function me(): Me {
  const base = tipoSesionFalsa() === 'anonima' ? fx.meViewer : fx.me;
  return { ...base, orgs: [...base.orgs, ...orgsNuevas.map((o) => ({ id: o.id, name: o.name, role: 'owner' as const, is_demo: false }))] };
}

function crearOrg(body: unknown): Org {
  if (tipoSesionFalsa() === 'anonima') falla(403, 'forbidden', 'Crea una cuenta con correo para conectar tus servicios');
  const name = String((body as { name?: unknown } | null)?.name ?? '').trim();
  if (name.length < 2 || name.length > 80) falla(422, 'invalid_body', 'El nombre debe tener entre 2 y 80 caracteres', { field_errors: { name: ['2 a 80 caracteres'] } });
  if (orgsNuevas.length >= 3) falla(409, 'conflict', 'Ya eres dueño de 3 organizaciones');
  const org: Org = {
    id: crypto.randomUUID(), name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    is_demo: false, created_at: new Date().toISOString(),
  };
  orgsNuevas.push(org);
  return org;
}

// Conexiones por org: la demo arranca con las del fixture; una org nueva (o ?escenario=vacio), vacía.
const conexiones = new Map<string, ConnectionPublic[]>();
const listaDe = (org: string) => {
  if (!conexiones.has(org)) conexiones.set(org, vacia(org) ? [] : structuredClone(fx.connections));
  return conexiones.get(org)!;
};

const CHECKS: Record<'supabase' | 'cloudflare' | 'github', PermCheck[]> = {
  supabase: [
    { permission: 'project_admin_read', ok: true, required: true }, { permission: 'advisors_read', ok: true, required: true },
    { permission: 'database_read', ok: true, required: true }, { permission: 'analytics_logs_read', ok: false, required: false, error_code: 'forbidden' },
  ],
  cloudflare: fx.permChecks,
  github: [{ permission: 'metadata:read', ok: true, required: true }, { permission: 'contents:read', ok: true, required: true }],
};

// Simula la guarda del BACK (key-guards.ts): 422 key_rejected para claves que pueden escribir.
function guardaFalsa(token: string) {
  if (/^sb_secret_|^gh[pousr]_|^cfk_/.test(token))
    falla(422, 'key_rejected', 'Esa clave puede escribir: VanGUARD solo acepta tokens de solo lectura', { reason: 'write_capable' });
}

function conectarFalso(org: string, body: unknown): ConnectionCreated {
  const b = (body ?? {}) as Record<string, string | undefined>;
  const ahora = new Date().toISOString();
  const base = { id: crypto.randomUUID(), kind: 'read' as const, status: 'active' as const, capabilities: {}, expires_at: null,
    last_checked_at: ahora, last_error: null };
  const lista = listaDe(org);
  let connection: ConnectionPublic, action_connection: ConnectionPublic | null = null, checks: PermCheck[] = [], ingest_secret: string | null = null;
  switch (b.provider) {
    case 'supabase':
      guardaFalsa(b.pat ?? '');
      connection = { ...base, provider: 'supabase', label: `Supabase · ${b.project_ref}`, last4: (b.pat ?? '').slice(-4),
        scopes: ['project_admin_read', 'advisors_read', 'database_read'], meta: { project_ref: b.project_ref } };
      checks = CHECKS.supabase;
      break;
    case 'cloudflare':
      guardaFalsa(b.read_token ?? ''); if (b.action_token) guardaFalsa(b.action_token);
      connection = { ...base, provider: 'cloudflare', label: 'Cloudflare · officialvanguard.com', last4: (b.read_token ?? '').slice(-4),
        scopes: ['zone_read', 'analytics_read'], meta: { zone_id: b.zone_id, zone_name: 'officialvanguard.com', plan: 'free' } };
      if (b.action_token) action_connection = { ...connection, id: crypto.randomUUID(), kind: 'action', label: `${connection.label} · blindaje`,
        last4: b.action_token.slice(-4), scopes: ['firewall_read'] };
      checks = CHECKS.cloudflare;
      break;
    case 'github':
      guardaFalsa(b.pat ?? '');
      connection = { ...base, provider: 'github', label: `GitHub · ${b.repo_full_name}`, last4: (b.pat ?? '').slice(-4),
        scopes: ['metadata:read', 'contents:read'], meta: { repo_full_name: b.repo_full_name, default_branch: 'main' } };
      checks = CHECKS.github;
      break;
    case 'ingest':
      connection = { ...base, provider: 'ingest', label: b.label ?? 'Mi app', last4: null, scopes: [], meta: { purpose: 'ingest' } };
      ingest_secret = 'vgi_' + crypto.randomUUID().replace(/-/g, '');
      break;
    default:
      return falla(422, 'invalid_body', 'Proveedor desconocido');
  }
  lista.push(connection);
  if (action_connection) lista.push(action_connection);
  return { connection, action_connection, checks, ingest_secret };
}

function probarFalso(org: string, id: string) {
  const c = listaDe(org).find((x) => x.id === id) ?? falla(404, 'not_found', 'Esa conexión no existe');
  c.last_checked_at = new Date().toISOString();
  const checks = c.provider === 'ingest' ? [] : c.kind === 'action'
    ? [{ permission: 'firewall_edit', ok: true, required: true }] : CHECKS[c.provider];
  return { ok: checks.every((k) => k.ok || k.required === false), checks, checked_at: c.last_checked_at };
}

const REVOCAR: Record<string, string> = {
  supabase: 'https://supabase.com/dashboard/account/tokens', cloudflare: 'https://dash.cloudflare.com/profile/api-tokens',
  github: 'https://github.com/settings/personal-access-tokens',
};
function quitarFalso(org: string, id: string) {
  const lista = listaDe(org);
  const i = lista.findIndex((x) => x.id === id);
  if (i < 0) falla(404, 'not_found', 'Esa conexión no existe');
  const [c] = lista.splice(i, 1);
  const url = REVOCAR[c!.provider];
  return new Response(null, { status: 204, headers: url ? { 'x-vg-revoke-url': url } : {} });
}

const ORG = '\\/api\\/orgs\\/([^/]+)';
const r = (s: string) => new RegExp(`^${s}$`);
const rutas: [string, RegExp, H][] = [
  ['GET',  r('\\/api\\/me'),                      () => me()],
  ['POST', r('\\/api\\/demo\\/join'),             () => ({ org_id: ORG_DEMO })],
  ['POST', r('\\/api\\/orgs'),                    (_m, b) => crearOrg(b)],
  ['GET',  r(`${ORG}\\/overview`),                (m) => vacia(m[1]!) ? fx.overviewVacio : fx.overview],
  ['GET',  r(`${ORG}\\/modules\\/(\\w+)\\/state`), (m) => fx.moduleState[m[2] as keyof typeof fx.moduleState] ?? falla(404, 'not_found', 'Módulo desconocido')],
  ['GET',  r(`${ORG}\\/connections`),             (m) => listaDe(m[1]!)],
  ['POST', r(`${ORG}\\/connections`),             (m, b) => conectarFalso(m[1]!, b)],
  ['POST', r(`${ORG}\\/connections\\/([^/]+)\\/test`), (m) => probarFalso(m[1]!, m[2]!)],
  ['DELETE', r(`${ORG}\\/connections\\/([^/]+)`), (m) => quitarFalso(m[1]!, m[2]!)],
  ['POST', r(`${ORG}\\/scans`),                   () => ({ scan_run_id: fx.scanDone.id })],   // el progreso por pasos llega en el hito 4
  ['GET',  r(`${ORG}\\/findings`),                (m) => vacia(m[1]!) ? [] : fx.findings],
  ['GET',  r(`${ORG}\\/incidents`),               (m) => vacia(m[1]!) ? [] : fx.incidents],
  ['GET',  r(`${ORG}\\/incidents\\/([^/]+)`),     () => fx.incidentDetail],
  ['GET',  r(`${ORG}\\/traffic`),                 () => fx.traffic],
  ['GET',  r(`${ORG}\\/scans\\/([^/]+)`),         () => fx.scanDone],
  ['GET',  r(`${ORG}\\/contacts`),                () => fx.contacts],
  ['GET',  r(`${ORG}\\/ai\\/usage`),              () => fx.aiUsage],
  ['GET',  r(`${ORG}\\/perf\\/runs`),             () => fx.perfRuns],
  ['GET',  r(`${ORG}\\/mcp-tokens`),              () => fx.mcpTokens],
  // Rutas que el FRONT pide con {crudo:true} devuelven un Response de verdad.
  ['GET',  r(`${ORG}\\/export`),                  () => new Response(fx.exportMd, {
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="vanguard-demo-20261024.md"' } })],
];

export async function fixtureFetch<T>(ruta: string, o: { method?: string; body?: unknown }): Promise<T> {
  await espera(250);
  const [camino = '', consulta = ''] = ruta.split('?');
  const q = new URLSearchParams(consulta);
  for (const [met, re, h] of rutas) {
    const m = camino.match(re);
    if (m && met === (o.method ?? 'GET')) return h(m, o.body, q) as T;
  }
  throw new ApiError(404, 'not_found', `Sin fixture para ${o.method ?? 'GET'} ${camino}`);
}
