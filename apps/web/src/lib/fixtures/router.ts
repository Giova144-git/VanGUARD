// Enrutador falso del modo fixtures (S14 §14.19). Único archivo que conoce los fixtures; solo se carga con
// import dinámico desde api.ts, así que no entra en el bundle de producción. Cero peticiones de red.
import {
  fixtures as fx, type ConnectionCreated, type ConnectionPublic, type Finding, type Me, type Org, type PermCheck, type ScanRun,
} from '@vanguard/contracts';
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
  if (!conexiones.has(org)) conexiones.set(org, vacia(org) ? [] : structuredClone(fx.connections as unknown as ConnectionPublic[]));  // el literal con satisfies no casa con Record<string, boolean>
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

// Hallazgos por org, con estado (PATCH) y has_fix_prompt (fix-prompt).
const hallazgos = new Map<string, Finding[]>();
const hallazgosDe = (org: string) => {
  if (!hallazgos.has(org)) hallazgos.set(org, vacia(org) ? [] : structuredClone(fx.findings as unknown as Finding[]));
  return hallazgos.get(org)!;
};
const hallazgo = (org: string, id: string) => hallazgosDe(org).find((f) => f.id === id) ?? falla(404, 'not_found', 'Este hallazgo no existe');

function listarHallazgos(org: string, q: URLSearchParams) {
  return structuredClone(hallazgosDe(org).filter((f) =>
    (!q.get('module') || f.module === q.get('module')) && (!q.get('severity') || f.severity === q.get('severity'))
    && (!q.get('status') || f.status === q.get('status'))));
}

function patchHallazgo(org: string, id: string, body: unknown) {
  const f = hallazgo(org, id);
  const b = (body ?? {}) as { status?: string; reason?: string };
  if (b.status === 'ignored' && (!b.reason || b.reason.trim().length < 3))
    falla(422, 'invalid_body', 'Explica por qué lo ignoras', { field_errors: { reason: ['Explica por qué lo ignoras'] } });
  if (b.status !== 'open' && b.status !== 'fixed' && b.status !== 'ignored') falla(422, 'invalid_body', 'Estado no válido');
  f.status = b.status as Finding['status'];
  f.status_reason = b.status === 'ignored' ? b.reason!.trim() : null;
  return structuredClone(f);
}

async function promptFalso(org: string, id: string) {
  const f = hallazgo(org, id);
  const cached = f.has_fix_prompt;
  if (!cached && tipoSesionFalsa() === 'anonima') falla(403, 'forbidden', 'Modo demo: solo lectura');
  if (!cached) await espera(1500);                                  // simula la llamada a Claude (~10 s en la real)
  f.has_fix_prompt = true;
  return { ...fx.fixPrompt, cached };
}

// Auditoría simulada: 0 → 100 en 12 s por los pasos de scanDone (S14 §14.19); con ?escenario=vacio, «repo» sale skipped.
const DURACION = 12_000;
const scans = new Map<string, number>();
function iniciarScan() {
  const id = crypto.randomUUID();
  scans.set(id, Date.now());
  return { scan_run_id: id };
}
function verScan(id: string): ScanRun {
  const inicio = scans.get(id);
  if (inicio == null) {
    if (id === fx.scanDone.id) return fx.scanDone as ScanRun;
    if (id === fx.scanRunning.id) return fx.scanRunning as ScanRun;
    return falla(404, 'not_found', 'Esa auditoría no existe');
  }
  const base = fx.scanDone as ScanRun;
  const t = Math.min(1, (Date.now() - inicio) / DURACION);
  const n = base.steps.length;
  const steps = base.steps.map((s, i): ScanRun['steps'][number] => {
    if (escenario() === 'vacio' && s.name === 'repo' && t >= i / n) return { name: s.name, status: 'skipped' };
    return t >= (i + 1) / n ? s : t >= i / n ? { name: s.name, status: 'running' } : { name: s.name, status: 'pending' };
  });
  const hecho = t >= 1;
  const actual = steps.find((s) => s.status === 'running')?.name ?? null;
  return {
    ...base, id, kind: 'full_audit', status: hecho ? 'succeeded' : 'running', progress: Math.round(t * 100), step: hecho ? null : actual, steps,
    score: t >= (n - 1) / n ? base.score : null, coverage: t >= (n - 1) / n ? base.coverage : null, summary: hecho ? base.summary : null,
    created_at: new Date(inicio).toISOString(), started_at: new Date(inicio).toISOString(),
    finished_at: hecho ? new Date(inicio + DURACION).toISOString() : null,
  };
}

const ORG = '\\/api\\/orgs\\/([^/]+)';
const r = (s: string) => new RegExp(`^${s}$`);
const rutas: [string, RegExp, H][] = [
  ['GET',  r('\\/api\\/me'),                      () => me()],
  ['POST', r('\\/api\\/demo\\/join'),             () => ({ org_id: ORG_DEMO })],
  ['POST', r('\\/api\\/orgs'),                    (_m, b) => crearOrg(b)],
  ['GET',  r(`${ORG}\\/overview`),                (m) => vacia(m[1]!) ? fx.overviewVacio : fx.overview],
  ['GET',  r(`${ORG}\\/modules\\/(\\w+)\\/state`), (m) => fx.moduleState[m[2] as keyof typeof fx.moduleState] ?? falla(404, 'not_found', 'Módulo desconocido')],
  ['GET',  r(`${ORG}\\/connections`),             (m) => structuredClone(listaDe(m[1]!))],   // copia: TanStack no ve cambios en el mismo array
  ['POST', r(`${ORG}\\/connections`),             (m, b) => conectarFalso(m[1]!, b)],
  ['POST', r(`${ORG}\\/connections\\/([^/]+)\\/test`), (m) => probarFalso(m[1]!, m[2]!)],
  ['DELETE', r(`${ORG}\\/connections\\/([^/]+)`), (m) => quitarFalso(m[1]!, m[2]!)],
  ['POST', r(`${ORG}\\/scans`),                   () => iniciarScan()],
  ['GET',  r(`${ORG}\\/findings`),                (m, _b, q) => listarHallazgos(m[1]!, q)],
  ['GET',  r(`${ORG}\\/findings\\/([^/]+)`),      (m) => structuredClone(hallazgo(m[1]!, m[2]!))],
  ['PATCH', r(`${ORG}\\/findings\\/([^/]+)`),     (m, b) => patchHallazgo(m[1]!, m[2]!, b)],
  ['POST', r(`${ORG}\\/findings\\/([^/]+)\\/fix-prompt`), (m) => promptFalso(m[1]!, m[2]!)],
  ['GET',  r(`${ORG}\\/incidents`),               (m) => vacia(m[1]!) ? [] : fx.incidents],
  ['GET',  r(`${ORG}\\/incidents\\/([^/]+)`),     () => fx.incidentDetail],
  ['GET',  r(`${ORG}\\/traffic`),                 () => fx.traffic],
  ['GET',  r(`${ORG}\\/scans\\/([^/]+)`),         (m) => verScan(m[2]!)],
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
