// Enrutador falso del modo fixtures (S14 §14.19). Único archivo que conoce los fixtures; solo se carga con
// import dinámico desde api.ts, así que no entra en el bundle de producción. Cero peticiones de red.
import {
  fixtures as fx, AlertPrefsIn, CodeReviewPut, CodeReviewQuery, GATE_CONTEXT, MAX_REPOS_GITHUB, McpTokenCreate, MergeGateAction, MergeGatePut, type McpTokenCreated, type McpTokenPublic, RepoFullName, ScanCreate, WikiRepoRef, ZipResult, type ActionPublic, type AlertPrefs, type CodeReviewSaved,
  type AuditDelta, type CodeReview, type CodeReviewConfig, type CodeReviewState, type ConnectionCreated, type ConnectionPublic, type DeltaLista, type EstadoModulo, type Evolution, type PerfRunExt,
  type MergeGateConfig, type MergeGateSaved, type Overview, type RespuestaEscritura,
  type Finding, type Incident, type IncidentDetail, type MatrizHallazgos, type Me, type Module, type Org, type PermCheck, type ScanKind,
  type ScanRun, type TimelineItem, type WikiRun, type ZipFinding,
  type UnderAttackActivo, type UnderAttackMotivo, type UnderAttackOffer, type UnderAttackProposal,
} from '@vanguard/contracts';
import { z } from 'zod';
import { ApiError } from '../errores';
import { SEVERIDADES, esClave } from '../evolucion';
import { deMapa } from '../severidad';
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
  const anonima = tipoSesionFalsa() === 'anonima';
  const base = anonima ? fx.meViewer : fx.me;
  // Las orgs de /start son de la sesión con correo que las creó: el anónimo de «Ver demo» no es miembro de ellas.
  const propias = anonima ? [] : orgsNuevas.map((o) => ({ id: o.id, name: o.name, role: 'owner' as const, is_demo: false }));
  return { ...base, orgs: [...base.orgs, ...propias] };
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

// Conexiones por org: la demo arranca con las del fixture; una org nueva (o ?escenario=vacio), vacía. El token de Modo
// blindaje de la demo trae Zone · Config Rules · Edit (config_rules_edit: true, lo que guardaría la sonda de E9), así E55
// ofrece el modo bajo ataque con permiso 'ok' como fx.underAttackOffer; sin la clave sería 'sin_probar'.
const conexiones = new Map<string, ConnectionPublic[]>();
function conexionesDemo(): ConnectionPublic[] {
  const lista = structuredClone(fx.connections as unknown as ConnectionPublic[]);   // el literal con satisfies no casa con Record<string, boolean>
  for (const c of lista) if (c.provider === 'cloudflare' && c.kind === 'action') c.capabilities = { ...c.capabilities, config_rules_edit: true };
  return lista;
}
const listaDe = (org: string) => {
  if (!conexiones.has(org)) conexiones.set(org, vacia(org) ? [] : conexionesDemo());
  return conexiones.get(org)!;
};
const conectado = (org: string, p: ConnectionPublic['provider']) =>
  listaDe(org).some((c) => c.provider === p && c.kind === 'read' && c.status === 'active');

// ── Varias codebases (asignaciones/varias-codebases.md §6.5) ─────────────────────────────────────────────────────
// Un repo = una conexión GitHub de lectura. Las parejas viejas de «Reconectar» son el mismo repo (nombre en minúsculas).
const nombreGh = (c: ConnectionPublic) => String(c.meta.repo_full_name ?? '').toLowerCase();
const lecturasGh = (org: string) => listaDe(org).filter((c) => c.provider === 'github' && c.kind === 'read');
// Un representante por repo, en el orden de E7: la activa del grupo o, si ninguna, la más antigua.
function reposGh(org: string): ConnectionPublic[] {
  const grupos = new Map<string, ConnectionPublic>();
  for (const c of lecturasGh(org)) {
    const k = nombreGh(c) || c.id, previa = grupos.get(k);
    if (!previa || (previa.status !== 'active' && c.status === 'active')) grupos.set(k, c);
  }
  return [...grupos.values()];
}
// Tokens GitHub ya usados en cada org: una huella corta en memoria (FNV-1a), nunca el token. huella → conexión.
const huellasGh = new Map<string, Map<string, string>>();
const huellasDe = (org: string) => huellasGh.get(org) ?? huellasGh.set(org, new Map()).get(org)!;
function huella(t: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}
const REPO_2 = String(fx.conexionGithub2.meta.repo_full_name);

// E6 de una org sin los datos de la demo: la forma de la demo con todo «sin mirar» (n:null, comprobado:false), como antes
// de la primera auditoría. Igual que estado/modulo.ts del BACK: sin conexión read activa del proveedor, ok:false con
// 'sin_conexion' (la pantalla pide «Conectar» sin chapa roja); con ella, ok:true. Rendimiento no tiene conexión propia:
// sin mediciones el BACK responde ok:true con todo n:null («Aún no medimos tu web»).
const PROVEEDOR_MODULO: Record<Exclude<Module, 'performance'>, ConnectionPublic['provider']> = {
  supabase: 'supabase', cloudflare: 'cloudflare', codebase: 'github',
};
function estadoVacio(org: string, m: Module): EstadoModulo {
  const e = fx.moduleState[m] as EstadoModulo;
  const sinConexion = m !== 'performance' && !conectado(org, PROVEEDOR_MODULO[m]);
  return {
    ok: !sinConexion, ...(sinConexion ? { error: 'sin_conexion' as const } : {}),
    hora: new Date().toISOString(), contador: { rojo: 0, aviso: 0, cola: 0 },
    cifras: e.cifras.map(({ rol: _r, sub: _s, destino: _d, ...c }) => ({ ...c, n: null })), ahora: [],
    checks: e.checks.map(({ nombre, codigo }) => ({ nombre, codigo, n: null, comprobado: false })),
  };
}
function estadoModulo(org: string, m: string) {
  if (!Object.hasOwn(fx.moduleState, m)) return falla(404, 'not_found', 'Módulo desconocido');   // hasOwn: «constructor» no es un módulo
  return vacia(org) ? estadoVacio(org, m as Module) : fx.moduleState[m as Module];
}

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
// Sonda falsa del permiso del modo bajo ataque (el dry_run de Config Rules de E8/E9): un token de acciones con «sin-config»
// hace de token sin Zone · Config Rules · Edit (la sonda vería un 403: config_rules_edit false); cualquier otro lo trae.
const conConfigRules = (token: string) => !/sin-config/i.test(token);

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
        last4: b.action_token.slice(-4), scopes: ['firewall_read'],
        capabilities: { firewall_read: true, config_rules_edit: conConfigRules(b.action_token) } };
      checks = CHECKS.cloudflare;
      break;
    case 'github': {
      // Como E8 con B1 (varias-codebases §2.1): mismo repo activo → 409 repo_duplicado; mismo repo no activo → la MISMA
      // conexión vuelve a active; 5 repos distintos → 409 tope_repos; el mismo token que otra conexión → 409 sin reason.
      guardaFalsa(b.pat ?? '');
      const repo = String(b.repo_full_name ?? '');
      const previas = lecturasGh(org);
      const mismo = previas.filter((c) => nombreGh(c) === repo.toLowerCase());
      if (mismo.some((c) => c.status === 'active')) falla(409, 'conflict', 'Ese repo ya está conectado.', { reason: 'repo_duplicado' });
      if (!mismo.length && new Set(previas.map(nombreGh)).size >= MAX_REPOS_GITHUB)
        falla(409, 'conflict', `Ya tienes ${MAX_REPOS_GITHUB} repos conectados: quita uno para conectar otro.`, { reason: 'tope_repos' });
      const reconectar = mismo[0];                                  // la más antigua: es la que tiene los hallazgos
      const h = huella((b.pat ?? '').trim());
      const duena = huellasDe(org).get(h);
      if (duena && duena !== reconectar?.id) falla(409, 'conflict', 'Ese token ya está conectado en esta organización.');
      if (reconectar) {
        Object.assign(reconectar, { status: 'active', last4: (b.pat ?? '').slice(-4), last_checked_at: ahora, last_error: null });
        huellasDe(org).set(h, reconectar.id);
        return { connection: structuredClone(reconectar), action_connection: null, checks: CHECKS.github, ingest_secret: null };
      }
      connection = repo.toLowerCase() === REPO_2.toLowerCase() ? structuredClone(fx.conexionGithub2 as ConnectionPublic)
        : { ...base, provider: 'github', label: `GitHub · ${repo}`, last4: (b.pat ?? '').slice(-4), scopes: ['metadata:read', 'contents:read'],
          // La org ya tenía otro repo: los hallazgos de este llevan el repo en la clave (§2.2).
          meta: { repo_full_name: repo, default_branch: 'main', ...(previas.length ? { hallazgos_por_repo: true } : {}) } };
      huellasDe(org).set(h, connection.id);
      checks = CHECKS.github;
      break;
    }
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
  // GitHub kind 'action' es el token de estados del bloqueo de merge: E9 lo sondea leyendo estados, sin escribir. El de
  // acciones de Cloudflare también dice si su token trae Config Rules · Edit (opcional: sin él solo no hay modo bajo ataque).
  const config: PermCheck = c.capabilities?.config_rules_edit === false
    ? { permission: 'config_rules_edit', ok: false, required: false, error_code: 'forbidden' } : { permission: 'config_rules_edit', ok: true, required: false };
  const checks = c.provider === 'ingest' ? [] : c.kind === 'action'
    ? (c.provider === 'github' ? [{ permission: 'statuses:read', ok: true, required: true }] : [{ permission: 'firewall_edit', ok: true, required: true }, config])
    : CHECKS[c.provider];
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
  for (const [h, id] of huellasDe(org)) if (id === c!.id) huellasDe(org).delete(h);   // su token se puede volver a usar
  // Bloqueo de merge (§2.8 y varias §2.6.6): quitar la GitHub de lectura de un repo quita también su token de estados;
  // quitar el token de estados deja el bloqueo pidiendo otro.
  if (c!.provider === 'github' && c!.kind === 'read') {
    const t = lista.findIndex((x) => x.provider === 'github' && x.kind === 'action' && nombreGh(x) === nombreGh(c!));
    if (t >= 0) { lista.splice(t, 1); sinTokenDeEstados(org); }
  }
  if (c!.provider === 'github' && c!.kind === 'action') sinTokenDeEstados(org);
  const url = REVOCAR[c!.provider];
  return new Response(null, { status: 204, headers: url ? { 'x-vg-revoke-url': url } : {} });
}

// Hallazgos por org, con estado (PATCH) y has_fix_prompt (fix-prompt). Antes de leerlos entran los de los ZIP terminados.
const hallazgos = new Map<string, Finding[]>();
const delOrg = (org: string) => {
  if (!hallazgos.has(org)) hallazgos.set(org, vacia(org) ? [] : structuredClone(fx.findings as unknown as Finding[]));
  return hallazgos.get(org)!;
};
const hallazgosDe = (org: string) => {
  for (const [id, c] of zips) if (c.org === org) volcarZip(id, c);
  return delOrg(org);
};
const hallazgo = (org: string, id: string) => {
  if (id === fx.hallazgoRevision.id) sembrarHallazgoRevision(org);   // ?finding= del WhatsApp puede llegar antes que E45
  if (fx.hallazgosCorregidos.some((f) => f.id === id)) conCorregidos(org);   // ídem con «Ver» de los cambios y E51
  return hallazgosDe(org).find((f) => f.id === id) ?? falla(404, 'not_found', 'Este hallazgo no existe');
};

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
// Cada corrida es de la org que la lanzó (anti-IDOR de §15.3). En una org sin los datos de la demo, el paso de un
// proveedor sin conexión sale skipped y no hay hallazgos, puntaje ni resumen de la demo.
const DURACION = 12_000;
const scans = new Map<string, { org: string; inicio: number }>();
const PROVEEDOR_PASO: Partial<Record<ScanRun['steps'][number]['name'], ConnectionPublic['provider']>> = {
  supabase: 'supabase', cloudflare: 'cloudflare', repo: 'github',
};
// Con dos o más repos, E12 trae una línea por repo (ScanRun.repos; varias-codebases §6.5): la del fixture para los dos
// repos de la demo (scanDoneDosRepos) y, para otro, limpio si su conexión está activa o «Conexión quitada» si no.
function reposDeAuditoria(org: string): ScanRun['repos'] {
  const repos = reposGh(org);
  if (repos.length < 2) return undefined;
  return repos.slice(0, MAX_REPOS_GITHUB).map((c) => {
    const delFixture = fx.scanDoneDosRepos.repos.find((x) => x.connection_id === c.id);
    if (c.status === 'active' && delFixture && !vacia(org)) return delFixture;
    const repo_full_name = String(c.meta.repo_full_name ?? '').slice(0, 140);
    return c.status === 'active' ? { connection_id: c.id, repo_full_name, status: 'done' as const, findings: 0 }
      : { connection_id: c.id, repo_full_name, status: 'skipped' as const, error_code: 'no_connection' };
  });
}
// E5 con B4: con dos o más repos, cada hallazgo de «Ahora» lleva su connection_id (el FRONT pinta el chip del repo).
function overviewDe(org: string): Overview {
  if (vacia(org)) return fx.overviewVacio as Overview;
  if (reposGh(org).length < 2) return fx.overview as Overview;
  const porId = new Map(hallazgosDe(org).map((f) => [f.id, f.connection_id]));
  return { ...(fx.overview as Overview), ahora: fx.overview.ahora.map((a) => (a.kind === 'finding' ? { ...a, connection_id: porId.get(a.id) ?? null } : a)) };
}
function iniciarScan(org: string, body: unknown) {
  if ((body as { kind?: unknown } | null)?.kind === 'zip') return iniciarZip(org, body);
  if ((body as { kind?: unknown } | null)?.kind === 'lighthouse') return iniciarMedicion(org, body);
  const id = crypto.randomUUID();
  scans.set(id, { org, inicio: Date.now() });
  return { scan_run_id: id };
}
function verScan(org: string, id: string): ScanRun {
  const zip = zips.get(id);
  if (zip?.org === org) return verZip(id, zip);
  const med = mediciones.get(id);
  if (med?.org === org) return verMedicion(med.id, med);
  const corrida = scans.get(id);
  if (corrida?.org !== org) {
    if (!corrida && !vacia(org) && id === fx.scanDone.id) {                                // scanRunning lleva el mismo id
      const repos = reposDeAuditoria(org);
      return repos ? { ...(fx.scanDone as ScanRun), repos } : fx.scanDone as ScanRun;
    }
    return falla(404, 'not_found', 'Esa auditoría no existe');
  }
  const { inicio } = corrida;
  const sinDemo = vacia(org);
  const base = fx.scanDone as ScanRun;
  const t = Math.min(1, (Date.now() - inicio) / DURACION);
  const n = base.steps.length;
  const steps = base.steps.map((s, i): ScanRun['steps'][number] => {
    const p = PROVEEDOR_PASO[s.name];
    const salta = (escenario() === 'vacio' && s.name === 'repo') || (sinDemo && p !== undefined && !conectado(org, p));
    if (salta && t >= i / n) return { name: s.name, status: 'skipped' };
    const fin = sinDemo && s.findings != null ? { ...s, findings: 0 } : s;
    return t >= (i + 1) / n ? fin : t >= i / n ? { name: s.name, status: 'running' } : { name: s.name, status: 'pending' };
  });
  const hecho = t >= 1;
  const actual = steps.find((s) => s.status === 'running')?.name ?? null;
  const puntaje = !sinDemo && t >= (n - 1) / n;
  const repos = steps.find((s) => s.name === 'repo')?.status === 'done' ? reposDeAuditoria(org) : undefined;
  return {
    ...base, id, kind: 'full_audit', status: hecho ? 'succeeded' : 'running', progress: Math.round(t * 100), step: hecho ? null : actual, steps,
    score: puntaje ? base.score : null, coverage: puntaje ? base.coverage : null, summary: hecho && !sinDemo ? base.summary : null,
    created_at: new Date(inicio).toISOString(), started_at: new Date(inicio).toISOString(),
    finished_at: hecho ? new Date(inicio + DURACION).toISOString() : null, ...(repos ? { repos } : {}),
  };
}

// ── ZIP analizado en el navegador (E11 con kind 'zip' y E23, F-18) ───────────────────────────────────────────
// Como rutas/scans.ts del BACK: E11 crea el scan en waiting_result sin encolar nada; si ya había uno esperando del mismo
// usuario, lo da por perdido (ZIP_RESULT_MISSING), y cualquier otro zip en curso da 409. E23 recibe el ZipResult.
type CorridaZip = { org: string; creado: number; filename: string; requested_by: string; empezo: number | null;
  fin: number | null; fallo: string | null; findings: ZipFinding[]; volcado: boolean };
const zips = new Map<string, CorridaZip>();
const DURACION_ZIP = 8_000;
const EN_CURSO_MS = 15 * 60_000;
const TOPE_ZIPS_DIA = 5;
// `step` recorre la cadena del BACK; steps[] lleva solo los pasos del contrato, como pasosDe('zip').
const PASOS_ZIP = ['zip', 'puntaje', 'resumen_ia'] as const;
const zipsHoy = new Map<string, number>();                       // `${org}|${día en Caracas}` → resultados aceptados
const diaCaracas = () => new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10);
const camposMalos = (e: z.ZodError) => ({ field_errors: z.flattenError(e).fieldErrors });   // igual que cuerpo() del BACK
const avance = (c: CorridaZip) => (c.empezo === null ? 0 : Math.min(1, (Date.now() - c.empezo) / DURACION_ZIP));
const enCursoZip = (c: CorridaZip) => c.fallo === null && avance(c) < 1 && Date.now() - c.creado < EN_CURSO_MS;

function iniciarZip(org: string, body: unknown) {
  exigirAdmin();
  const r = ScanCreate.safeParse(body);
  if (!r.success) return falla(422, 'invalid_body', 'Revisa los campos marcados', camposMalos(r.error));
  const { filename } = r.data as Extract<ScanCreate, { kind: 'zip' }>;
  const yo = me().user.id;
  const enCurso = [...zips].filter(([, c]) => c.org === org && enCursoZip(c));
  const otro = enCurso.find(([, c]) => c.empezo !== null || c.requested_by !== yo);
  if (otro) falla(409, 'conflict', 'Ya hay una auditoría de este tipo en curso', { scan_run_id: otro[0] });
  for (const [, c] of enCurso) { c.fallo = 'ZIP_RESULT_MISSING'; c.fin = Date.now(); }
  const id = crypto.randomUUID();
  zips.set(id, { org, creado: Date.now(), filename, requested_by: yo, empezo: null, fin: null, fallo: null, findings: [], volcado: false });
  return { scan_run_id: id };
}

// El 413 lo da fixtureFetch (bodyLimit de app.ts, antes de orgMember).
function recibirZip(org: string, id: string, body: unknown) {
  exigirAdmin();
  const c = zips.get(id);
  if (c?.org !== org) {
    const deEstaOrg = scans.get(id)?.org === org || mediciones.get(id)?.org === org || (!scans.has(id) && !vacia(org) && id === fx.scanDone.id);
    return deEstaOrg ? falla(409, 'conflict', 'Esta auditoría no es de un ZIP') : falla(404, 'not_found', 'Esa auditoría no existe');
  }
  if (c.empezo !== null || c.fallo !== null || c.requested_by !== me().user.id || Date.now() - c.creado > EN_CURSO_MS)
    return falla(409, 'conflict', 'Esta auditoría ya no espera el resultado del ZIP: vuelve a elegirlo');
  const r = ZipResult.safeParse(body);
  if (!r.success) return falla(422, 'invalid_body', 'Revisa los campos marcados', camposMalos(r.error));
  const clave = `${org}|${diaCaracas()}`;
  const hoy = zipsHoy.get(clave) ?? 0;
  if (hoy >= TOPE_ZIPS_DIA) return falla(429, 'budget_exceeded', `Ya analizaste ${TOPE_ZIPS_DIA} ZIP hoy. Vuelve mañana.`);
  zipsHoy.set(clave, hoy + 1);
  c.empezo = Date.now();
  c.findings = r.data.findings;
  return { scan_run_id: id };
}

function verZip(id: string, c: CorridaZip): ScanRun {
  volcarZip(id, c);
  const { empezo } = c;
  const t = avance(c);
  const hecho = empezo !== null && t >= 1;
  const fase = Math.min(PASOS_ZIP.length - 1, Math.floor(t * PASOS_ZIP.length));
  const pasoZip: ScanRun['steps'][number] = empezo === null ? { name: 'zip', status: 'pending' }
    : fase === 0 && !hecho ? { name: 'zip', status: 'running' } : { name: 'zip', status: 'done', findings: c.findings.length };
  const fecha = (ms: number) => new Date(ms).toISOString();
  return {
    id, kind: 'zip', status: c.fallo ? 'failed' : empezo === null ? 'queued' : hecho ? 'succeeded' : 'running',
    progress: Math.round(t * 100), step: empezo === null ? 'waiting_result' : hecho ? null : PASOS_ZIP[fase]!,   // el reemplazo no toca step, como el BACK
    steps: [pasoZip, { name: 'resumen_ia', status: hecho ? 'done' : fase === 2 ? 'running' : 'pending' }],
    score: null, coverage: null, summary: null, error: c.fallo,
    created_at: fecha(c.creado), started_at: empezo === null ? null : fecha(empezo),
    finished_at: c.fin !== null ? fecha(c.fin) : hecho ? fecha(empezo + DURACION_ZIP) : null,
  };
}

// Al terminar, sus hallazgos pasan a la org con el prefijo zip:<filename>/ que pone el servidor (el FRONT no lo pone).
// Como vg_upsert_findings: uno que ya estaba (misma regla y recurso) se actualiza y, si estaba corregido, reaparece.
function volcarZip(id: string, c: CorridaZip) {
  if (c.volcado || c.empezo === null || avance(c) < 1) return;
  c.volcado = true;
  const lista = delOrg(c.org);
  const en = new Date(c.empezo + DURACION_ZIP).toISOString();
  const prefijo = `zip:${c.filename}/`;
  for (const f of c.findings) {
    const resource = prefijo + f.resource.slice(-(300 - prefijo.length));       // Finding.resource ≤ 300, sin perder el prefijo
    const datos = { scan_run_id: id, severity: f.severity, title: f.title, evidence: { ...f.evidence, fuente: 'zip' }, last_seen_at: en };
    const previo = lista.find((x) => x.module === 'codebase' && x.rule_id === f.rule_id && x.resource === resource);
    if (previo) Object.assign(previo, datos, previo.status === 'fixed' || previo.status === 'verified'
      ? { status: 'open', status_reason: 'reapareció', verified_at: null } : {});
    else lista.push({ ...datos, id: crypto.randomUUID(), module: 'codebase', rule_id: f.rule_id, resource, confirmed: false,   // id nuevo: no pisa los de fx
      origin: 'rule', has_fix_prompt: false, fix_model: null, status: 'open', status_reason: null, suspected_injection: false,
      connection_id: null, first_seen_at: en, verified_at: null });
  }
}

// ── «Medir ahora» (E11 con kind 'lighthouse', F-17) ──────────────────────────────────────────────────────────
// Como el BACK (rutas/scans.ts y scans/psi.ts): solo admin; la URL pasa por urlMedible (https de internet, sin IPs, hosts
// locales, credenciales, puertos, secretos ni hosts de VanGUARD, salvo la víctima de la demo desde la org de demo; sin
// zona de Cloudflare) → 422 invalid_body con reason y field_errors.url; 409 con scan_run_id si hay otra en curso; tope
// diario 10 (la demo 20) → 429 budget_exceeded. Un único paso psi (8 s; en producción ~10 s) y, al terminar, UNA fila
// nueva en perf/runs (rep 1, run_group = el id del scan) con las cifras de la última medición de esa URL y estrategia.
type CorridaPerf = { id: string; org: string; inicio: number; url: string; strategy: 'mobile' | 'desktop'; version_label: string | null; volcada: boolean };
const mediciones = new Map<string, CorridaPerf>();
const perfNuevas = new Map<string, PerfRunExt[]>();             // org → mediciones de esta pestaña (más nuevas primero)
const perfHoy = new Map<string, number>();                     // `${org}|${día en Caracas}` → mediciones creadas
const DURACION_PERF = 8_000;
const perfDe = (org: string) => [...(perfNuevas.get(org) ?? []), ...(vacia(org) ? [] : fx.perfRuns as PerfRunExt[])];

// Copia de urlMedible/urlMedibleOrg (scans/psi.ts): mismos motivos y mensajes. PARECE_SECRETO, el de scans/comun.ts.
const HOSTS_VANGUARD = ['officialvanguard.com', 'giovannizm14.workers.dev', 'accshmgmfrqrxubpuxcl.supabase.co'];
const HOST_VICTIMA_DEMO = 'demo.officialvanguard.com';
const INTERNOS = ['localhost', 'local', 'internal', 'lan', 'arpa', 'test', 'invalid', 'example', 'onion'];
const ETIQUETA_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const URL_BD = /^https:\/\/[a-z0-9.-]+(\/[^?#\s]*)?$/;
const PARECE_SECRETO = /(sb_secret_[A-Za-z0-9_-]{16,}|sbp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|vg[iks]_[A-Za-z0-9_-]{20,}|cf(k|ut|at)_[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.)/;
function urlMedible(org: string, raw: string): string {
  const no = (motivo: string, mensaje: string): never => falla(422, 'invalid_body', mensaje, { reason: motivo, field_errors: { url: [mensaje] } });
  if (raw.length > 2048) no('largo', 'La URL es demasiado larga (máximo 2048 caracteres)');
  let u: URL | null = null;
  try { u = new URL(raw); } catch { /* abajo */ }
  if (!u) return no('url', 'No es una URL válida');
  if (u.protocol !== 'https:') no('https', 'Solo medimos URLs https://');
  if (u.username || u.password) no('credenciales', 'Quita el usuario y la contraseña de la URL');
  if (u.port) no('puerto', 'Solo medimos el puerto estándar de https (443)');
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') || /^\d+(\.\d+){3}$/.test(h)) no('ip', 'No medimos direcciones IP: usa el dominio del sitio');
  if (INTERNOS.some((x) => h === x || h.endsWith(`.${x}`))) no('interno', 'No medimos hosts locales ni de red interna');
  const etiquetas = h.split('.');
  if (etiquetas.length < 2 || !etiquetas.every((e) => ETIQUETA_HOST.test(e))) no('host', 'Usa un dominio público, como tusitio.com');
  if (!(h === HOST_VICTIMA_DEMO && esDemo(org)) && HOSTS_VANGUARD.some((x) => h === x || h.endsWith(`.${x}`))) {
    no('propio', 'Esa URL es de VanGUARD: mide la de tu sitio');
  }
  const limpia = `https://${h}${u.pathname || '/'}`;
  if (!URL_BD.test(limpia)) no('url', 'No es una URL válida');
  if (PARECE_SECRETO.test(limpia)) no('secreto', 'La URL parece llevar un secreto: quítalo antes de medir');
  return limpia;
}

// Mismo orden que E11: admin, cuerpo, URL, 409 de la que está en curso y tope diario.
function iniciarMedicion(org: string, body: unknown) {
  exigirAdmin();
  const r = ScanCreate.safeParse(body);
  if (!r.success) return falla(422, 'invalid_body', 'Revisa los campos marcados', camposMalos(r.error));
  const b = r.data as Extract<ScanCreate, { kind: 'lighthouse' }>;
  const url = urlMedible(org, b.url);
  const enCurso = [...mediciones.values()].find((m) => m.org === org && Date.now() - m.inicio < DURACION_PERF);
  if (enCurso) falla(409, 'conflict', 'Ya hay una medición de rendimiento en curso: espera a que termine', { scan_run_id: enCurso.id });
  const clave = `${org}|${diaCaracas()}`;
  const tope = esDemo(org) ? 20 : 10;
  if ((perfHoy.get(clave) ?? 0) >= tope) falla(429, 'budget_exceeded', `Ya hiciste ${tope} mediciones de rendimiento hoy, el máximo diario. Vuelve mañana.`);
  perfHoy.set(clave, (perfHoy.get(clave) ?? 0) + 1);
  const id = crypto.randomUUID();
  mediciones.set(id, { id, org, inicio: Date.now(), url, strategy: b.strategy, version_label: b.version_label ?? null, volcada: false });
  return { scan_run_id: id };
}

function verMedicion(id: string, m: CorridaPerf): ScanRun {
  volcarMedicion(m);
  const t = Math.min(1, (Date.now() - m.inicio) / DURACION_PERF);
  const hecho = t >= 1;
  const fecha = (ms: number) => new Date(ms).toISOString();
  return {
    id, kind: 'lighthouse', status: hecho ? 'succeeded' : 'running', progress: Math.round(t * 100),
    step: hecho ? null : 'psi',                                   // vg_claim_step deja 'psi' toda la medición
    steps: [{ name: 'psi', status: hecho ? 'done' : 'running' }], score: null, coverage: null, summary: null, error: null,
    created_at: fecha(m.inicio), started_at: fecha(m.inicio), finished_at: hecho ? fecha(m.inicio + DURACION_PERF) : null,
  };
}

function volcarMedicion(m: CorridaPerf) {
  if (m.volcada || Date.now() - m.inicio < DURACION_PERF) return;
  m.volcada = true;
  const previa = perfDe(m.org).find((r) => r.url === m.url && r.strategy === m.strategy);
  const base = previa ?? { scores: { performance: 0.9 }, metrics: { lcp_ms: 1800, tbt_ms: 120, cls: 0.02, fcp_ms: 900, si_ms: 1500, ttfb_ms: 130 } };
  const fila: PerfRunExt = {
    id: crypto.randomUUID(), url: m.url, strategy: m.strategy, source: 'psi', lighthouse_version: '13.5.0',
    run_group: m.id, rep: 1, is_representative: true, trigger: 'manual', version_label: m.version_label, runtime_error: null,
    scores: { ...base.scores }, metrics: { ...base.metrics }, created_at: new Date(m.inicio + DURACION_PERF).toISOString(),
  };
  perfNuevas.set(m.org, [fila, ...(perfNuevas.get(m.org) ?? [])]);
}

// ── Incidentes (S14 §14.19) ──────────────────────────────────────────────────────────────────────────────────
// Cada incidente vive como IncidentDetail. Los simulados guardan su inicio y sus hitos se van llenando con el reloj.
type Simulado = { inicio: number };
const incidentes = new Map<string, IncidentDetail[]>();
const simulados = new Map<string, Simulado>();
const iso = (ms: number) => new Date(ms).toISOString();
const incidentesDe = (org: string) => {
  if (!incidentes.has(org)) incidentes.set(org, vacia(org) ? [] : (fx.incidents as unknown as Incident[]).map((i) =>
    i.id === fx.incidentDetail.id ? structuredClone(fx.incidentDetail as unknown as IncidentDetail)
      : { ...structuredClone(i), notifications: [], actions: [], timeline: [] }));
  return incidentes.get(org)!;
};

// Hitos de la historia de la demo (A9): detectado +6,1 s, WhatsApp +8,4 s, crítica +26,1 s, llamada +27,5 s (P1).
const GUION: { ms: number; kind: TimelineItem['kind']; label: string }[] = [
  { ms: 6_100, kind: 'detected', label: 'Reglas CF_UA_TOOL y CF_PATH_SCAN' },
  { ms: 8_400, kind: 'whatsapp_sent', label: 'WhatsApp a +58 ••• ••43' },
  { ms: 9_600, kind: 'whatsapp_delivered', label: 'WhatsApp entregado' },
  { ms: 26_100, kind: 'severity_up', label: 'Sube a crítica: CF_ADMIN_EXPOSED' },
  { ms: 27_500, kind: 'call_started', label: 'Llamada a +58 ••• ••43' },
];
function avanzar(i: IncidentDetail) {
  const s = simulados.get(i.id);
  if (!s) return i;
  const ms = Date.now() - s.inicio;
  const vistos = new Set(i.timeline.map((t) => t.kind));
  for (const g of GUION) if (ms >= g.ms && !vistos.has(g.kind)) {
    i.timeline.push({ t: iso(s.inicio + g.ms), ms: g.ms, kind: g.kind, label: g.label });
    if (g.kind === 'whatsapp_sent' || g.kind === 'call_started') {
      i.notifications.push({ id: crypto.randomUUID(), channel: g.kind === 'call_started' ? 'voice' : 'whatsapp', recipient_masked: '+58 ••• ••43',
        template: 'incident_v1', status: 'sent', error: null, created_at: iso(s.inicio + g.ms), sent_at: iso(s.inicio + g.ms), delivered_at: null, read_at: null });
      i.notified_at ??= iso(s.inicio + g.ms);
    }
    if (g.kind === 'severity_up') { i.severity = 'critical'; i.rule_ids = [...new Set([...i.rule_ids, 'CF_ADMIN_EXPOSED'])]; }
  }
  i.timeline.sort((a, b) => a.ms - b.ms);
  i.event_count = Math.min(1146, Math.round(ms / 40_000 * 1146));
  i.last_event_at = iso(Date.now());
  return i;
}
const incidente = (org: string, id: string) => {
  const i = incidentesDe(org).find((x) => x.id === id) ?? falla(404, 'not_found', 'Este incidente no existe');
  return avanzar(i);
};
const marca = (i: IncidentDetail, kind: TimelineItem['kind'], label?: string) => {
  const ahora = Date.now();
  i.timeline.push({ t: iso(ahora), ms: ahora - Date.parse(i.timeline.find((t) => t.kind === 'attack_start')?.t ?? i.started_at), kind, ...(label ? { label } : {}) });
};
const sinDetalle = ({ notifications: _n, actions: _a, timeline: _t, ...i }: IncidentDetail): Incident => i;

function listarIncidentes(org: string, q: URLSearchParams) {
  const todos = incidentesDe(org).map(avanzar);
  const abiertos = q.get('status') === 'open';
  return structuredClone(todos.filter((i) => !abiertos || i.status === 'open' || i.status === 'ack').map(sinDetalle))
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

function ackFalso(org: string, id: string) {
  const i = incidente(org, id);
  if (i.status !== 'open') falla(409, 'conflict', 'Este incidente ya no está abierto');
  i.status = 'ack'; i.acked_at = iso(Date.now()); i.acked_via = 'in_app';
  marca(i, 'ack', 'Confirmado desde la app');
  return { ok: true, resultado: 'Lo estás viendo', en: i.acked_at };
}
function muteFalso(org: string, id: string) {
  const i = incidente(org, id);
  if (i.status === 'resolved') falla(409, 'conflict', 'El incidente ya está resuelto');
  i.muted_until = iso(Date.now() + 3_600_000);
  marca(i, 'muted', 'Silenciado 1 h');
  return { ok: true, resultado: 'Silenciado 1 h', en: iso(Date.now()) };
}

// Aprobaciones pendientes: approval_id → incidente, objetivo (IP o host), tipo e intentos. Código válido en fixtures: 123456.
type Aprobacion = { org: string; incident_id: string; target: string; kind: 'block_ip' | 'under_attack_on'; intentos: number; vence: number; usada: boolean };
const aprobaciones = new Map<string, Aprobacion>();
function proponerFalso(org: string, body: unknown) {
  const b = (body ?? {}) as { incident_id?: string; target?: string };
  const i = incidente(org, b.incident_id ?? '');
  const ip = b.target ?? i.resource.replace(/^ip:/, '');
  if (!/^[\d.]+$|^[\da-f:]+$/i.test(ip)) falla(422, 'invalid_body', 'Solo bloqueamos una IP suelta (/32 o /128)', { reason: 'not_an_ip' });
  const approval_id = crypto.randomUUID();
  const vence = Date.now() + 600_000;          // el fixture trae una expires_at fija (sábado): se recalcula aquí (A9)
  aprobaciones.set(approval_id, { org, incident_id: i.id, target: ip, kind: 'block_ip', intentos: 3, vence, usada: false });
  marca(i, 'action_proposed', `Propuesto bloquear ${ip}`);
  return { ...fx.actionProposal, approval_id, efecto: `Bloquear ${ip} (/32) en la zona officialvanguard.com durante 1 h`, expires_at: iso(vence) };
}
function ejecutarBloqueo(org: string, incident_id: string, target: string, approval_id: string) {
  const i = incidente(org, incident_id);
  const ahora = Date.now();
  const accion: ActionPublic = { id: crypto.randomUUID(), kind: 'block_ip', target, status: 'executed', created_at: iso(ahora),
    undone_at: null, expires_at: iso(ahora + 3_600_000), approval_id };
  i.actions.push(accion);
  i.status = 'mitigated'; i.mitigated_at = iso(ahora);
  marca(i, 'action_executed', `IP ${target} bloqueada en el borde`);
  return accion;
}
function confirmarFalso(org: string, approvalId: string, body: unknown) {
  const a = aprobaciones.get(approvalId);
  if (!a || a.org !== org) return falla(404, 'not_found', 'Esa aprobación no existe');
  if (a.usada) return falla(409, 'conflict', 'Esa aprobación ya se usó', { reason: 'used' });
  if (Date.now() > a.vence) return falla(409, 'conflict', 'El código venció, pídelo de nuevo', { reason: 'expired' });
  if (a.intentos <= 0) return falla(409, 'conflict', 'Demasiados intentos: pide un código nuevo', { reason: 'locked' });
  const code = String((body as { code?: unknown } | null)?.code ?? '');
  if (code !== '123456') {
    a.intentos -= 1;
    return falla(422, 'invalid_body', 'Código incorrecto', { reason: 'wrong_code', attempts_left: a.intentos });   // misma forma que E21 (H9)
  }
  a.usada = true;
  if (a.kind === 'under_attack_on') {
    const accion = ejecutarBajoAtaque(org, a.incident_id, a.target, approvalId);
    return { ok: true, resultado: `Modo bajo ataque activo ${TTL_BAJO_ATAQUE / 60_000} min en ${a.target}`, en: accion.created_at, action_id: accion.id };
  }
  const accion = ejecutarBloqueo(org, a.incident_id, a.target, approvalId);
  return { ok: true, resultado: 'IP bloqueada 1 h', en: accion.created_at, action_id: accion.id };
}
function deshacerFalso(org: string, actionId: string) {
  for (const i of incidentesDe(org)) {
    const a = i.actions.find((x) => x.id === actionId);
    if (!a) continue;
    const bajo = a.kind === 'under_attack_on';
    if (a.status === 'undone') falla(409, 'conflict', bajo ? 'El modo bajo ataque ya se desactivó' : 'Ese bloqueo ya se deshizo', { reason: 'already_undone' });
    a.status = 'undone'; a.undone_at = iso(Date.now());
    // Sigue mitigado si queda otra acción viva (un bloqueo y el modo bajo ataque a la vez).
    if (!i.actions.some((x) => x.status === 'executed')) { i.status = i.acked_at ? 'ack' : 'open'; i.mitigated_at = null; }
    marca(i, 'action_undone', bajo ? `Modo bajo ataque desactivado en ${a.target}` : `IP ${a.target} desbloqueada`);
    return { ok: true, resultado: bajo ? 'Modo bajo ataque desactivado' : 'Desbloqueada', en: a.undone_at };
  }
  return falla(404, 'not_found', 'Esa acción no existe');
}

// ── Modo bajo ataque (E55 y E56; confirmar y deshacer, E21 y E22 de arriba; asignaciones/modo-bajo-ataque.md §9) ──
// La demo trae dos IPs inundando demo.officialvanguard.com (fx.underAttackOffer). Como leerOfertaBajoAtaque del BACK: sin
// CF_IP_FLOOD no aplica, resuelto está cerrado, sin host no hay nada; con la regla de acuerdo (ofrece sigue true), sin Modo
// blindaje es sin_conexion y con un token al que la sonda le vio el 403 de Config Rules, sin_permiso, los dos con `copiar`.
// El modo vivo es del host, así que se busca en toda la org.
const APPROVAL_BAJO_ATAQUE = fx.underAttackProposal.approval_id;
const ACTION_BAJO_ATAQUE = 'ac000000-0000-4000-8000-000000000001';   // el de fixtures/ids.ts (el paquete no exporta los ids)
const TTL_BAJO_ATAQUE = fx.underAttackOffer.ttl_s * 1000;
const blindajeDe = (org: string) => listaDe(org).find((c) => c.provider === 'cloudflare' && c.kind === 'action' && c.status === 'active');

// pasosManualesBajoAtaque de core (que la web no puede importar): el mismo texto que fx.underAttackOfferSinPermiso.copiar.
function pasosManuales(host: string, zona: string | null): string {
  return [
    zona ? `Para activarlo a mano en Cloudflare (zona ${zona}):` : 'Para activarlo a mano en Cloudflare:',
    '1. Rules → Configuration Rules → Create rule.',
    `2. If incoming requests match: Hostname · equals · ${host}.`,
    '3. Then the settings are: I\'m Under Attack → On. Deploy.',
    '4. Cuando pase el ataque, borra la regla.',
    'Para hacerlo desde VanGUARD: añade Zone · Config Rules · Edit al token de Modo blindaje y pulsa «Probar conexión».',
  ].join('\n').slice(0, 1500);
}
function activoBajoAtaque(org: string, host: string): UnderAttackActivo | null {
  for (const i of incidentesDe(org)) {
    const a = i.actions.find((x) => x.kind === 'under_attack_on' && x.status === 'executed' && x.target === host);
    if (a) return { action_id: a.id, scope: 'host', target: a.target, created_at: a.created_at, expires_at: a.expires_at, retirada_fallida: false };
  }
  return null;
}
function ofertaBajoAtaque(org: string, id: string): UnderAttackOffer {
  const i = incidente(org, id);
  const host = typeof i.details.host === 'string' && i.details.host ? i.details.host : null;
  const c = blindajeDe(org);
  const zona = typeof c?.meta.zone_name === 'string' ? c.meta.zone_name : null;
  const cap = c?.capabilities.config_rules_edit;
  const permiso = !c ? null : cap === true ? 'ok' : cap === false ? 'falta' : 'sin_probar';
  const base: UnderAttackOffer = { ...fx.underAttackOffer, hostname: host, zone_name: zona, connection_id: c?.id ?? null, permiso,
    activo: host ? activoBajoAtaque(org, host) : null };
  const no = (motivo: UnderAttackMotivo, extra: Partial<UnderAttackOffer> = {}): UnderAttackOffer => ({ ...base, ofrece: false, motivo, scopes: [], ...extra });
  // El orden de ofreceBajoAtaque de core: resuelto da cerrado aunque no haya host (y sin host, ips 0, como el BACK).
  if (!i.rule_ids.includes('CF_IP_FLOOD')) return no('no_aplica', { ips: 0 });
  if (i.status === 'resolved') return no('cerrado', host ? {} : { ips: 0 });
  if (!host) return no('sin_host', { ips: 0 });
  if (!c) return { ...base, motivo: 'sin_conexion', scopes: [], copiar: pasosManuales(host, null) };
  if (permiso === 'falta') return { ...base, motivo: 'sin_permiso', scopes: [], copiar: pasosManuales(host, zona) };
  return base;
}
function proponerBajoAtaque(org: string, id: string): UnderAttackProposal {
  exigirAdmin();
  const o = ofertaBajoAtaque(org, id);
  if (o.activo) return falla(409, 'conflict', `El modo bajo ataque ya está activo en ${o.activo.target}`, { reason: 'already_active', action_id: o.activo.action_id });
  if (o.motivo === 'sin_conexion') return falla(409, 'conflict', 'Activa el Modo blindaje con un token de acciones', { reason: 'no_action_connection' });
  // El dry_run de E56 con ese token daría el 403: el mismo 409 con los pasos para hacerlo a mano.
  if (o.motivo === 'sin_permiso') return falla(409, 'conflict', 'Te falta el permiso Zone · Config Rules · Edit en el token de Modo blindaje',
    { reason: 'sin_permiso', ...(o.copiar ? { copiar: o.copiar } : {}) });
  if (o.motivo === 'cerrado') return falla(409, 'conflict', 'El incidente ya se cerró', { reason: 'resolved' });
  if (o.motivo || !o.hostname) return falla(422, 'invalid_body', 'El modo bajo ataque es solo para inundaciones de tráfico', { reason: o.motivo ?? 'sin_host' });
  const vence = Date.now() + 600_000;          // como en el bloqueo: la expires_at del fixture es fija
  aprobaciones.set(APPROVAL_BAJO_ATAQUE, { org, incident_id: id, target: o.hostname, kind: 'under_attack_on', intentos: 3, vence, usada: false });
  marca(incidente(org, id), 'action_proposed', `Propuesto el modo bajo ataque en ${o.hostname}`);
  return { ...fx.underAttackProposal, expires_at: iso(vence) };
}
function ejecutarBajoAtaque(org: string, incident_id: string, target: string, approval_id: string) {
  const i = incidente(org, incident_id);
  const ahora = Date.now();
  const usado = incidentesDe(org).some((x) => x.actions.some((a) => a.id === ACTION_BAJO_ATAQUE));   // reactivarlo: id nuevo
  const accion: ActionPublic = { id: usado ? crypto.randomUUID() : ACTION_BAJO_ATAQUE, kind: 'under_attack_on', target, status: 'executed',
    created_at: iso(ahora), undone_at: null, expires_at: iso(ahora + TTL_BAJO_ATAQUE), approval_id };
  i.actions.push(accion);
  i.status = 'mitigated'; i.mitigated_at ??= iso(ahora);
  marca(i, 'action_executed', `Modo bajo ataque activo en ${target}`);
  return accion;
}

// Botones que solo existen en modo fixtures (S14 §14.19): ensayar el tramo de incidentes del guion sin BACK.
export function simularAtaque(org: string): string {
  const inicio = Date.now();
  const id = crypto.randomUUID();
  const code = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, 'X');
  const i: IncidentDetail = {
    id, code, module: 'cloudflare', rule_ids: ['CF_UA_TOOL', 'CF_PATH_SCAN'], severity: 'high',
    title: 'Escaneo con herramienta y /admin abierto desde 203.0.x.x', resource: 'ip:203.0.113.7', status: 'open', event_count: 0,
    details: { ua: 'sqlmap/1.8#stable (https://sqlmap.org)', paths: ['/admin', '/.env', '/wp-login.php'] }, started_at: iso(inicio),
    last_event_at: iso(inicio), notified_at: null, acked_at: null, acked_via: null, muted_until: null, mitigated_at: null, resolved_at: null,
    suspected_injection: false, notifications: [], actions: [],
    timeline: [{ t: iso(inicio), ms: 0, kind: 'attack_start', label: 'Primera petición del atacante' }],
  };
  incidentesDe(org).unshift(i);
  simulados.set(id, { inicio });
  return id;
}
export function simularAprobacionWhatsApp(org: string, incidentId: string) {
  const i = incidente(org, incidentId);
  if (i.actions.some((a) => a.kind === 'block_ip' && a.status === 'executed')) return;
  ejecutarBloqueo(org, i.id, i.resource.replace(/^ip:/, ''), crypto.randomUUID());
  i.acked_at ??= iso(Date.now()); i.acked_via ??= 'whatsapp';
}

// ── Ajustes: contactos (E26/E27) y prueba de canal (E28) ─────────────────────────────────────────────────────
type VerificacionFx = { codigo: string; enlace: string };
type ContactoFx = { id: string; name: string; phone_e164: string; whatsapp: boolean; voice: boolean; priority: number;
  verified_at: string | null; verificacion?: VerificacionFx | null };
const contactos = new Map<string, ContactoFx[]>();
const contactosDe = (org: string) => {
  if (!contactos.has(org)) contactos.set(org, vacia(org) ? [] : structuredClone(fx.contacts as unknown as ContactoFx[]));
  return contactos.get(org)!;
};
// Número de VanGUARD de los fixtures (el del enlace de Luis): sirve para armar el wa.me de un contacto nuevo.
const NUMERO_FX = (fx.contacts as unknown as ContactoFx[]).find((c) => c.verificacion)?.verificacion?.enlace.match(/wa\.me\/(\d+)/)?.[1] ?? '15550100';
const nuevaVerificacion = (): VerificacionFx => {
  const codigo = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  return { codigo, enlace: `https://wa.me/${NUMERO_FX}?text=VERIFICAR%20${codigo}` };
};
// «Tras 3 consultas, Luis vuelve verificado» (espec del ORQUESTADOR): simula que llegó su «VERIFICAR <código>» al webhook.
const consultasContactos = new Map<string, number>();
function listarContactos(org: string) {
  exigirAdmin();
  const n = (consultasContactos.get(org) ?? 0) + 1;
  consultasContactos.set(org, n);
  if (n > 3) for (const c of contactosDe(org)) if (c.verificacion) { c.verified_at = new Date().toISOString(); c.verificacion = null; }
  return structuredClone(contactosDe(org));
}
// Tokens MCP (E29/E29b): en memoria por org, como los contactos. El token sale una vez y aquí no se guarda.
const tokensMcp = new Map<string, McpTokenPublic[]>();
const tokensMcpDe = (org: string) => {
  if (!tokensMcp.has(org)) tokensMcp.set(org, vacia(org) ? [] : structuredClone(fx.mcpTokens as McpTokenPublic[]));
  return tokensMcp.get(org)!;
};
const ALCANCES_MCP = ['findings:read', 'incidents:read', 'metrics:read', 'export:read'];
function crearTokenMcp(org: string, b: unknown): McpTokenCreated {
  exigirAdmin();
  const p = McpTokenCreate.safeParse(b);
  if (!p.success) falla(422, 'invalid_body', 'Revisa los campos marcados');
  const lista = tokensMcpDe(org);
  if (lista.filter((t) => !t.revoked_at).length >= 10) falla(409, 'conflict', 'Ya hay 10 tokens activos. Revoca uno para crear otro.');
  const token = 'vgk_' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const ahora = new Date();
  const t: McpTokenPublic = { id: crypto.randomUUID(), name: p.data!.name, scopes: ALCANCES_MCP, last4: token.slice(-4),
    created_at: ahora.toISOString(), last_used_at: null, revoked_at: null,
    expires_at: new Date(ahora.getTime() + p.data!.expires_in_days * 86_400_000).toISOString() };
  lista.unshift(t);
  return { id: t.id, token, name: t.name, scopes: t.scopes, last4: t.last4 ?? undefined, expires_at: t.expires_at };
}
function revocarTokenMcp(org: string, id: string) {
  exigirAdmin();
  const t = tokensMcpDe(org).find((x) => x.id === id && !x.revoked_at);
  if (!t) falla(404, 'not_found', 'Token no encontrado o ya revocado');
  t!.revoked_at = new Date().toISOString();
  return undefined;
}
function exigirAdmin() { if (tipoSesionFalsa() === 'anonima') falla(403, 'forbidden', 'Modo demo: solo lectura'); }

// Revisión de código (E45/E46, asignaciones/revision-codigo.md §4.1 y §6.3). La org de demo arranca con el fixture
// (webhook conectado y el push con la clave de Stripe); una org sin GitHub, con available:false. Tras activar, la 3.ª
// consulta simula el ping de GitHub («Esperando a GitHub» → «Conectada»), como «VERIFICAR» en contactos.
// Varias codebases (§6.5): un estado por conexión (`${org}:${connection_id}`). En la demo, el del repo de la víctima es el
// fixture y el del 2.º repo, codeReviewStateRepo2 (sin activar); cualquier otra conexión GitHub empieza sin config.
const revisiones = new Map<string, { estado: CodeReviewState; consultas: number; altaVista?: boolean }>();
function sembrarHallazgoRevision(org: string) {
  if (!vacia(org) && !delOrg(org).some((f) => f.id === fx.hallazgoRevision.id)) delOrg(org).push(structuredClone(fx.hallazgoRevision as Finding));
}
const CONN_REVISION = fx.codeReviewState.config.connection_id;
function revisionDe(org: string, gh: ConnectionPublic) {
  sembrarHallazgoRevision(org);
  const k = `${org}:${gh.id}`;
  if (!revisiones.has(k)) {
    const demo = !vacia(org);
    const estado = demo && gh.id === CONN_REVISION ? estadoBloqueoDemo() : demo && gh.id === fx.conexionGithub2.id ? fx.codeReviewStateRepo2
      : { available: true, reason: null, config: null, recent: [] };
    revisiones.set(k, { consultas: 0, estado: structuredClone(estado as CodeReviewState) });
  }
  return revisiones.get(k)!;
}

// ── Bloqueo de merge con críticos (E45 con gate, E53, E54; bloqueo-merge-criticos.md §6.5) ──────────────────────────
// La demo arranca con codeReviewStateBloqueo (gate `unchecked`, el PR #7 con ✗). El anexo de cierre de PR va aquí: el
// contrato lo trae opcional y sus fixtures no lo usan; el token de la demo tiene permiso de pull requests y el PR #7 quedó
// cerrado por VanGUARD. La conexión de estados no está en `connections` hasta guardar un token con E53 (como el fixture).
function estadoBloqueoDemo(): CodeReviewState {
  const s = structuredClone(fx.codeReviewStateBloqueo as CodeReviewState);
  if (s.config?.gate) Object.assign(s.config.gate, { close_pr: true, can_close_pr: true });
  for (const r of s.recent) if (r.gate && r.event === 'pull_request' && r.gate.state === 'failure') Object.assign(r.gate, { pr_action: 'closed', pr_close_error: null });
  return s;
}
const GATE_APAGADO = { enabled: false, min_severity: 'critical', state: 'off', context: GATE_CONTEXT, statuses_connection: null,
  protection: null, last_error: null, close_pr: false, can_close_pr: false } satisfies MergeGateConfig;
const estadosGh = (org: string) => listaDe(org).find((c) => c.provider === 'github' && c.kind === 'action');
// El repo del bloqueo (varias §2.6, punto 3): el del token de estados si lo hay; si no, el principal. Solo su config
// trae `gate` en E45; en las demás pestañas no viene y el FRONT no pinta la sección.
function repoBloqueo(org: string): ConnectionPublic | undefined {
  const t = estadosGh(org);
  return t ? lecturasGh(org).find((c) => nombreGh(c) === nombreGh(t)) : githubDe(org);
}
// Como E45: `off` con la revisión o el bloqueo apagados; `needs_token` sin token activo; `error` con last_error; con la
// protección leída (P1), `active` si GitHub exige el check y `needs_protection` si no; si no, `unchecked`.
function estadoGate(cfg: CodeReviewConfig, g: MergeGateConfig): MergeGateConfig['state'] {
  if (!cfg.enabled || !g.enabled) return 'off';
  if (g.statuses_connection?.status !== 'active') return 'needs_token';
  if (g.last_error) return 'error';
  const r = g.protection?.required;
  return r === 'yes' ? 'active' : r === 'no' || r === 'other_source' ? 'needs_protection' : 'unchecked';
}
// La config tal como la ve el FRONT: con `gate` solo en el repo del bloqueo (sembrado apagado la primera vez).
function vistaConfig(org: string, gh: ConnectionPublic, cfg: CodeReviewConfig | null): CodeReviewConfig | null {
  if (!cfg) return null;
  const copia = structuredClone(cfg);
  if (gh.id !== repoBloqueo(org)?.id) { delete copia.gate; return copia; }
  cfg.gate ??= structuredClone(GATE_APAGADO);
  copia.gate = { ...structuredClone(cfg.gate), state: estadoGate(cfg, cfg.gate) };
  return copia;
}
function sinTokenDeEstados(org: string) {
  for (const [k, v] of revisiones) if (k.startsWith(`${org}:`) && v.estado.config?.gate) v.estado.config.gate.statuses_connection = null;
}
const REPOS_DEL_PRODUCTO = new Set(['platanus-hack/platanus-hack-26-ve-team-22', 'giova144-git/vanguard']);
const shaFalso = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');

// E53. Con statuses_pat: guarda prefijo (github_pat_), mismo token que el de lectura, permisos de más (en fixtures, un
// token que contenga «admin» o «contents», para ensayar el 422) y alta o rotación de la MISMA conexión de estados. La
// prueba de la demo cae en el push de las 19:20Z con la clave: ✗ (mergeGateSaved); en otra org, «pendiente».
function guardarBloqueo(org: string, body: unknown): MergeGateSaved {
  exigirAdmin();
  const b = MergeGatePut.safeParse(body);
  if (!b.success) return falla(422, 'invalid_body', 'Revisa los campos marcados', camposMalos(b.error));
  const { enabled, min_severity, statuses_pat, close_pr } = b.data;
  const gh = repoBloqueo(org) ?? falla(404, 'not_found', 'Conecta primero tu repo de GitHub');
  if (gh.status !== 'active') falla(409, 'conflict', 'La conexión de GitHub no está activa', { reason: 'conexion_inactiva' });
  const cfg = revisionDe(org, gh).estado.config;
  if (!cfg?.enabled) return falla(409, 'conflict', 'Activa primero “Revisar cada push”', { reason: 'sin_revision' });
  if (enabled && REPOS_DEL_PRODUCTO.has(nombreGh(gh)))
    falla(409, 'conflict', 'No actives el bloqueo en el repo desde el que se despliega VanGUARD: si VanGUARD falla, no podrías fusionar su propio arreglo', { reason: 'repo_del_producto' });
  const g = (cfg.gate ??= structuredClone(GATE_APAGADO));
  let checks: PermCheck[] = [], probe_sha: string | null = null, probe_state: MergeGateSaved['probe_state'] = null;
  if (statuses_pat !== undefined) {
    const t = statuses_pat.trim();
    guardaFalsa(t);
    if (!t.startsWith('github_pat_')) falla(400, 'invalid_body', 'Usa un token fine-grained (github_pat_…)', { field_errors: { statuses_pat: ['Debe empezar por github_pat_'] } });
    const duena = huellasDe(org).get(huella(t));
    if (duena && lecturasGh(org).some((c) => c.id === duena)) falla(422, 'key_rejected', 'Usa un token nuevo, solo con Commit statuses', { reason: 'same_token' });
    if (/admin|contents/i.test(t))
      falla(422, 'key_rejected', 'Ese token tiene permisos de más (Contents, Administration). Crea uno con solo Commit statuses: Read and write', { reason: 'excess_scope', excess_permissions: ['contents', 'administration'] });
    const ahora = new Date().toISOString(), expira = new Date(Date.now() + 30 * 86_400_000).toISOString();
    let est = estadosGh(org);
    if (est) Object.assign(est, { status: 'active', last4: t.slice(-4), expires_at: expira, last_checked_at: ahora, last_error: null });
    else {
      est = { id: esDemo(org) ? fx.mergeGateSaved.gate.statuses_connection.id : crypto.randomUUID(), provider: 'github', kind: 'action',
        label: `GitHub · estados · ${nombreRepoGh(gh)}`.slice(0, 80), status: 'active', last4: t.slice(-4), scopes: ['statuses:write', 'pull_requests:write'],
        meta: { repo_full_name: gh.meta.repo_full_name, repo_id: gh.meta.repo_id, branch: cfg.branch, purpose: 'commit_statuses' },
        capabilities: { statuses: true, pull_requests: true }, expires_at: expira, last_checked_at: ahora, last_error: null };
      listaDe(org).push(est);
    }
    huellasDe(org).set(huella(t), est.id);
    if (!g.can_close_pr) g.close_pr = true;            // encendido por defecto cuando el token llega con el permiso
    Object.assign(g, { statuses_connection: { id: est.id, status: 'active', last4: est.last4, expires_at: expira }, last_error: null, can_close_pr: true });
    checks = [{ permission: 'statuses:write', ok: true, required: true }, { permission: 'pull_requests:write', ok: true, required: false }];
    probe_sha = esDemo(org) ? fx.mergeGateSaved.probe_sha : shaFalso();
    probe_state = esDemo(org) ? fx.mergeGateSaved.probe_state : 'pending';
  }
  Object.assign(g, { enabled, min_severity });
  if (close_pr !== undefined) g.close_pr = close_pr && g.can_close_pr !== false;
  // P1 (§6.5): sin token y encendido, E53 relee la protección («Comprobar de nuevo»). En fixtures, la de §9: GitHub exige
  // «VanGUARD», los admins pueden saltárselo (demo sin «Do not allow bypassing») y la regla clásica no deja ver si exige PR.
  if (statuses_pat === undefined && enabled && g.statuses_connection?.status === 'active')
    g.protection = { required: 'yes', admins: 'bypass', pr_required: 'unknown', checked_at: new Date().toISOString() };
  return { gate: vistaConfig(org, gh, cfg)!.gate!, checks, probe_sha, probe_state };
}
const nombreRepoGh = (c: ConnectionPublic) => String(c.meta.repo_full_name ?? '');

// E54 (§6.5): override → ✓ «Aprobado a mano» al momento (el BACK lo encola); revert → vuelve el ✗ (o el error de una
// revisión incompleta); reopen_pr → el PR queda «reabierto»; republish (P1) → publica lo que ya se sabe de la revisión,
// solo en la más reciente de ese PR (o de ese commit en un push).
function accionBloqueo(org: string, id: string, body: unknown): RespuestaEscritura {
  exigirAdmin();
  const b = MergeGateAction.safeParse(body);
  if (!b.success) return falla(422, 'invalid_body', 'Revisa los campos marcados', camposMalos(b.error));
  let r: CodeReview | undefined, cfg: CodeReviewConfig | null = null, recientes: CodeReview[] = [];
  for (const [k, v] of revisiones) {
    if (!k.startsWith(`${org}:`)) continue;
    r = v.estado.recent.find((x) => x.id === id);
    if (r) { cfg = v.estado.config; recientes = v.estado.recent; break; }
  }
  if (!r) return falla(404, 'not_found', 'Esa revisión no existe');
  if (!cfg?.enabled || !cfg.gate?.enabled) falla(409, 'conflict', 'El bloqueo está apagado', { reason: 'apagado' });
  const g = r.gate, ahora = new Date().toISOString();
  switch (b.data.op) {
    case 'override':
      if (!g || g.override_at || (g.state !== 'failure' && g.state !== 'error')) falla(409, 'conflict', 'Esta revisión no tiene nada que aprobar', { reason: 'nada_que_aprobar' });
      Object.assign(g!, { override_at: ahora, state: 'success', published_at: ahora });
      break;
    case 'revert':
      if (!g?.override_at) falla(409, 'conflict', 'No había ninguna aprobación que deshacer', { reason: 'sin_override' });
      Object.assign(g!, { override_at: null, state: (g!.blocking ?? 0) > 0 ? 'failure' : 'error', published_at: ahora });
      break;
    case 'reopen_pr':
      if (g?.pr_action !== 'closed') falla(409, 'conflict', 'Ese pull request no está cerrado por VanGUARD', { reason: 'no_cerrado' });
      g!.pr_action = 'reopened';
      break;
    case 'republish': {
      // recent va de la más nueva a la más vieja: la primera del mismo PR (o del mismo commit) es la última.
      const ultima = recientes.find((x) => (r!.event === 'pull_request' ? x.event === 'pull_request' && x.pr_number === r!.pr_number : x.head_sha === r!.head_sha));
      if (ultima?.id !== r.id) falla(409, 'conflict', 'Solo se publica de nuevo la revisión más reciente de ese PR o de ese commit', { reason: 'no_es_la_ultima' });
      if (!g) return falla(409, 'conflict', 'Esta revisión es de antes del bloqueo', { reason: 'sin_calculo' });
      const incompleta = r.status === 'failed' || (r.partial && r.error_code !== 'hallazgos_truncados');
      Object.assign(g, { state: g.override_at ? 'success' : (g.blocking ?? 0) > 0 ? 'failure' : incompleta ? 'error' : 'success', error: null, published_at: ahora });
      break;
    }
  }
  return { ok: true, resultado: 'encolado' };
}
// Sin connection_id, la principal (B0): la activa más antigua; si ninguna está activa, la más antigua. Con él, esa
// conexión GitHub de lectura de la org en cualquier estado (ajena o inexistente → undefined).
const githubDe = (org: string, id?: string) => id === undefined
  ? lecturasGh(org).find((c) => c.status === 'active') ?? lecturasGh(org)[0]
  : lecturasGh(org).find((c) => c.id === id);
// 'vgw_' + 32 bytes de getRandomValues en base64url sin relleno = 43 caracteres (CodeReviewSaved; §6.3).
const secretoWebhook = () => 'vgw_' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function verRevision(org: string, q: URLSearchParams): CodeReviewState {
  const p = CodeReviewQuery.safeParse({ connection_id: q.get('connection_id') || undefined });
  if (!p.success) return falla(422, 'invalid_body', 'Revisa la conexión', { field_errors: { connection_id: ['Id no válido'] } });
  const gh = githubDe(org, p.data.connection_id);
  if (!gh) return { available: false, reason: 'sin_conexion', config: null, recent: [] };
  const r = revisionDe(org, gh);
  // La conexión puede cambiar en Conexiones: available y reason se recalculan siempre.
  r.estado.available = gh.status === 'active';
  r.estado.reason = gh.status !== 'active' ? 'conexion_inactiva' : null;
  const c = r.estado.config;
  if (c?.enabled && c.state === 'waiting_ping' && ++r.consultas >= 3) {
    Object.assign(c, { state: 'connected', last_ping_at: new Date().toISOString(), hook_events: ['pull_request', 'push'] });
  }
  const copia = { ...structuredClone(r.estado), config: vistaConfig(org, gh, r.estado.config) };
  if (copia.config && tipoSesionFalsa() === 'anonima') copia.config.webhook_url = null;   // la URL solo la ve un admin
  // Evolución (§6.5): cada revisión con su foto de Codebase, también sobre codeReviewStateBloqueo. El PR #7 y cualquier
  // revisión que no esté en deltasRevision salen con delta null, como un BACK con 0015 sin foto.
  for (const x of copia.recent) x.delta = structuredClone(deMapa<string, CodeReview['delta']>(fx.deltasRevision, x.id, null));
  return copia;
}
function guardarRevision(org: string, body: unknown): CodeReviewSaved {
  exigirAdmin();
  const b = CodeReviewPut.safeParse(body);
  if (!b.success) falla(422, 'invalid_body', 'Revisa los campos marcados');
  const { connection_id, enabled, rotate_secret } = b.data!;
  const gh = githubDe(org, connection_id) ?? falla(404, 'not_found', 'Esa conexión no existe');
  if (gh.status !== 'active') falla(409, 'conflict', 'La conexión de GitHub no está activa', { reason: 'conexion_inactiva' });
  const r = revisionDe(org, gh);
  r.consultas = 0;
  let secreto: string | null = null;
  if (rotate_secret && r.estado.config) {
    // «Generar otro secreto» (E46, como rutas/revision.ts del BACK, 2460162): uno nuevo en la MISMA config (misma URL y
    // mismo id); el ping, los eventos y el error de antes ya no valen, así que vuelve a «Esperando a GitHub» hasta que se
    // pegue el secreto nuevo en el webhook. Sin config, rotate_secret es un alta normal (rama de abajo).
    secreto = secretoWebhook();
    Object.assign(r.estado.config, { enabled, secret_last4: secreto.slice(-4), last_ping_at: null, last_event_at: null, hook_events: [],
      last_error: null, state: enabled ? 'waiting_ping' : 'off' });
  } else if (!r.estado.config) {
    secreto = secretoWebhook();
    const id = crypto.randomUUID();
    const meta = gh.meta as { repo_full_name?: unknown; default_branch?: unknown };
    r.estado.config = { id, connection_id, repo_full_name: typeof meta.repo_full_name === 'string' ? meta.repo_full_name : 'equipo/repo',
      branch: typeof meta.default_branch === 'string' ? meta.default_branch : 'main', enabled, state: enabled ? 'waiting_ping' : 'off',
      webhook_url: `https://officialvanguard.com/webhooks/github/${id}`, secret_last4: secreto.slice(-4), hook_events: [],
      last_ping_at: null, last_event_at: null, last_error: null };
  } else if (enabled && esDemo(org) && gh.id === CONN_REVISION && !r.altaVista) {
    // La demo arranca con la config hecha: la primera vez que se activa desde aquí hace de alta (codeReviewSaved, §6.3)
    // para que se vean el secreto de una vez y «Esperando a GitHub» → «Conectada». El BACK real solo da el secreto al crear.
    r.altaVista = true;
    secreto = secretoWebhook();
    Object.assign(r.estado.config, { ...fx.codeReviewSaved.config, enabled: true, secret_last4: secreto.slice(-4) });
  } else {
    const c = r.estado.config;
    c.enabled = enabled;
    c.state = !enabled ? 'off' : c.last_ping_at ? 'connected' : 'waiting_ping';
  }
  return { config: vistaConfig(org, gh, r.estado.config)!, webhook_secret: secreto };
}

// Preferencias de avisos (E48/E49). whatsapp_ready_contacts sale de los contactos (WhatsApp activado y verificados).
const prefs = new Map<string, AlertPrefsIn & { updated_at: string | null }>();
function verPrefs(org: string): AlertPrefs {
  const p = prefs.get(org) ?? { review_whatsapp_min: fx.alertPrefs.review_whatsapp_min, review_voice_min: fx.alertPrefs.review_voice_min, updated_at: null };
  return { ...p, voice_available: false, whatsapp_ready_contacts: contactosDe(org).filter((c) => c.whatsapp && c.verified_at).length };
}
function guardarPrefs(org: string, body: unknown): AlertPrefs {
  exigirAdmin();
  const b = AlertPrefsIn.safeParse(body);
  if (!b.success) falla(422, 'invalid_body', 'Revisa los campos marcados');
  prefs.set(org, { ...b.data!, updated_at: new Date().toISOString() });
  return verPrefs(org);
}
function guardarContactos(org: string, body: unknown) {
  exigirAdmin();
  const lista = Array.isArray(body) ? body as Omit<ContactoFx, 'id' | 'verified_at'>[] : falla(422, 'invalid_body', 'Lista de contactos no válida');
  if (lista.length > 5) falla(422, 'invalid_body', 'Máximo 5 contactos');
  for (const c of lista) if (!/^\+[1-9]\d{7,14}$/.test(c.phone_e164)) falla(422, 'invalid_body', `Teléfono no válido: ${c.phone_e164}`, { field_errors: { phone_e164: ['Formato E.164'] } });
  if (new Set(lista.map((c) => c.phone_e164)).size !== lista.length) falla(422, 'invalid_body', 'Hay teléfonos repetidos');
  // vg_replace_contacts conserva verified_at por teléfono (S05): un contacto nuevo nace sin verificar.
  const antes = new Map(contactosDe(org).map((c) => [c.phone_e164, c]));
  // La verificación solo existe para contactos sin verificar con WhatsApp: se conserva la que había o se crea una nueva.
  const nuevos = lista.map((c) => {
    const previo = antes.get(c.phone_e164);
    const verified_at = previo?.verified_at ?? null;
    const verificacion = verified_at || !c.whatsapp ? null : previo?.verificacion ?? nuevaVerificacion();
    return { ...c, id: previo?.id ?? crypto.randomUUID(), verified_at, verificacion };
  });
  contactos.set(org, nuevos);
  return structuredClone(nuevos);
}
function probarCanal(org: string, body: unknown) {
  exigirAdmin();
  const canal = (body as { channel?: string } | null)?.channel;
  if (canal !== 'whatsapp' && canal !== 'voice') return falla(422, 'invalid_body', 'Canal no válido');
  const primero = contactosDe(org).filter((c) => (canal === 'whatsapp' ? c.whatsapp : c.voice)).sort((a, b) => a.priority - b.priority)[0];
  if (!primero) return falla(409, 'conflict', `No hay ningún contacto con ${canal === 'whatsapp' ? 'WhatsApp' : 'llamada'} activo`, { reason: 'no_contact' });
  if (!primero.verified_at) return falla(409, 'conflict', 'Ese contacto aún no está verificado', { reason: 'unverified' });
  return { ok: true, provider_id: `fx_${crypto.randomUUID().slice(0, 8)}` };
}

// ── DeepWiki (E40–E44) ───────────────────────────────────────────────────────────────────────────────────────
// E42 devuelve wikiRunRunning en las primeras consultas de cada corrida y luego wikiRunDone, para ver el progreso.
// fx.wikiRuns solo existen en la demo con datos (son del repo de la víctima); cualquier otra generación es una corrida
// nueva de esa org y de su repo. E43 filtra por ?repo= sin distinguir mayúsculas (varias-codebases §4.1).
const consultasWiki = new Map<string, number>();
const wikisNuevas = new Map<string, { org: string; repo: string }>();   // corrida → org y repo
function verWikiRun(org: string, id: string, contar = true): WikiRun {
  const nueva = wikisNuevas.get(id);
  const deDemo = nueva === undefined && !vacia(org);
  if (nueva?.org !== org && !deDemo) return falla(404, 'not_found', 'Esa wiki no existe');
  if (deDemo && id !== fx.wikiRunDone.id) return fx.wikiRuns.find((x) => x.id === id) ?? falla(404, 'not_found', 'Esa wiki no existe');
  const n = (consultasWiki.get(id) ?? 0) + (contar ? 1 : 0);   // sin contar: el doc no adelanta el progreso
  consultasWiki.set(id, n);
  const repo = nueva ? { repo_full_name: nueva.repo } : {};
  return n <= 3 ? { ...fx.wikiRunRunning, id, ...repo } : { ...fx.wikiRunDone, id, ...repo };
}
function listarWikis(org: string, q: URLSearchParams) {
  const repo = q.get('repo');
  if (repo !== null && !RepoFullName.safeParse(repo).success) falla(422, 'invalid_body', 'Repo no válido', { field_errors: { repo: ['owner/repo'] } });
  const nuevas = [...wikisNuevas].filter(([id, w]) => w.org === org && id !== fx.wikiRunDone.id).map(([id]) => verWikiRun(org, id, false)).reverse();   // más recientes primero
  const todas = vacia(org) ? nuevas : [...nuevas, ...fx.wikiRuns];
  return repo === null ? todas : todas.filter((r) => r.repo_full_name.toLowerCase() === repo.toLowerCase());
}
// B8 (§7): un connection_id tiene que ser una conexión GitHub de lectura activa de la org y del MISMO repo; si no, 404.
function conexionWiki(org: string, b: { connection_id?: unknown; repo_full_name?: unknown }) {
  if (b.connection_id === undefined) return;
  const repo = typeof b.repo_full_name === 'string' ? b.repo_full_name.toLowerCase() : '';
  const c = listaDe(org).find((x) => x.id === b.connection_id && x.provider === 'github' && x.kind === 'read' && x.status === 'active');
  if (!c || String(c.meta.repo_full_name ?? '').toLowerCase() !== repo) falla(404, 'not_found', 'Conexión no encontrada');
}
function estimarWiki(org: string, body: unknown) {
  exigirAdmin();
  const b = WikiRepoRef.safeParse(body);
  if (!b.success) return falla(422, 'invalid_body', 'Revisa los campos marcados', camposMalos(b.error));
  conexionWiki(org, b.data);
  return { ...fx.wikiEstimate, repo_full_name: b.data.repo_full_name };   // solo lee GitHub; cached_run_id null
}
function generarWiki(org: string, body: unknown) {
  exigirAdmin();
  const b = (body ?? {}) as { max_usd?: number; repo_full_name?: unknown; connection_id?: unknown };
  if (b.max_usd != null && (b.max_usd <= 0 || b.max_usd > 5)) falla(422, 'invalid_body', 'El tope va de 0 a 5 USD');
  conexionWiki(org, b);
  const repo = typeof b.repo_full_name === 'string' ? b.repo_full_name : fx.wikiRunDone.repo_full_name;
  // En la demo, la del repo de la víctima es la corrida del fixture (con su documento); la de otro repo, una nueva.
  const delFixture = !vacia(org) && repo.toLowerCase() === fx.wikiRunDone.repo_full_name.toLowerCase();
  const id = delFixture ? fx.wikiRunDone.id : crypto.randomUUID();
  if (!delFixture) wikisNuevas.set(id, { org, repo });
  consultasWiki.set(id, 0);                                      // cada generación vuelve a mostrar el progreso
  return { wiki_run_id: id, cached: false };
}

// ── Evolución entre revisiones (E51/E52, asignaciones/evolucion-entre-revisiones.md §6.5) ───────────────────────
// Cadena de fotos por org, como audit_snapshots: la de la demo arranca con la de scanDone (fx.auditDelta). Cada auditoría
// simulada o ZIP de la org que terminó deja la suya, en orden de cierre, la primera vez que se pide E51: resta los ids
// abiertos frente a la foto anterior, como private.vg_restar (sin claves movidas: los fixtures no traen huellas). Sin
// ningún módulo revisado no hay foto (sin_foto). Las listas salen con el estado de AHORA de cada hallazgo.
type DeltaConFoto = Extract<AuditDelta, { available: true }>;
type Foto = { scan_run_id: string; kind: ScanKind; taken_at: string; score: number | null; abiertos: string[]; delta: DeltaConFoto };
const fotos = new Map<string, Foto[]>();
const fotosDe = (org: string) => {
  if (!fotos.has(org)) {
    const d = fx.auditDelta as DeltaConFoto;
    fotos.set(org, vacia(org) ? [] : [{ scan_run_id: d.scan_run_id, kind: 'full_audit', taken_at: d.taken_at, score: d.score,
      abiertos: [...d.new.items, ...d.kept.items].map((i) => i.finding_id), delta: d }]);
  }
  return fotos.get(org)!;
};
// Los dos hallazgos que el sábado ya no están abiertos: la primera vez entran en la lista de la org (como hallazgoRevision).
function conCorregidos(org: string) {
  if (vacia(org)) return;
  const lista = delOrg(org);
  for (const f of fx.hallazgosCorregidos) if (!lista.some((x) => x.id === f.id)) lista.push(structuredClone(f as Finding));
}
const MODULO_PASO: Record<string, Module> = { supabase: 'supabase', cloudflare: 'cloudflare', repo: 'codebase', zip: 'codebase' };
const MODULOS_FX = ['supabase', 'cloudflare', 'codebase', 'performance'] as const satisfies readonly Module[];
const RANGO: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const matrizDe = (fs: readonly Finding[]): MatrizHallazgos => {
  const m = Object.fromEntries(MODULOS_FX.map((k) => [k, Object.fromEntries(SEVERIDADES.map((s) => [s, 0]))])) as MatrizHallazgos;
  for (const f of fs) m[f.module][f.severity] += 1;
  return m;
};
// En el orden de E13: severidad, confirmed, last_seen_at e id.
const listaDe50 = (fs: readonly Finding[]): DeltaLista => ({ total: fs.length, items: [...fs]
  .sort((a, b) => RANGO[a.severity]! - RANGO[b.severity]! || Number(b.confirmed) - Number(a.confirmed)
    || b.last_seen_at.localeCompare(a.last_seen_at) || a.id.localeCompare(b.id))
  .slice(0, 50).map((f) => ({ finding_id: f.id, module: f.module, rule_id: f.rule_id, severity: f.severity, title: f.title,
    resource: f.resource, status: f.status })) });

// verScan recalcula los pasos con las conexiones de ahora: una auditoría que cerró sin mirar nada se recuerda aquí para
// que no gane una foto al conectar algo después.
const sinModulos = new Set<string>();
function fotografiar(org: string) {
  const cadena = fotosDe(org);
  const hechas = new Set([...cadena.map((f) => f.scan_run_id), ...sinModulos]);
  const terminadas = [
    ...[...scans].filter(([id, c]) => c.org === org && !hechas.has(id)).map(([id]) => verScan(org, id)),
    ...[...zips].filter(([id, c]) => c.org === org && !hechas.has(id)).map(([id, c]) => verZip(id, c)),
  ].filter((r) => r.status === 'succeeded' && r.finished_at).sort((a, b) => a.finished_at!.localeCompare(b.finished_at!));
  for (const r of terminadas) {
    const vistos = [...new Set(r.steps.filter((s) => s.status === 'done')
      .map((s) => deMapa<string, Module | null>(MODULO_PASO, s.name, null)))].filter((m): m is Module => m !== null);
    if (!vistos.length) { sinModulos.add(r.id); continue; }               // sin_modulos: nunca una versión sin mirar nada
    const anterior = cadena.at(-1);
    const todos = hallazgosDe(org);
    const porId = new Map(todos.map((f) => [f.id, f]));
    const abiertos = todos.filter((f) => f.status === 'open');
    const antes = new Set(anterior?.abiertos ?? []);
    const nuevos = anterior ? abiertos.filter((f) => !antes.has(f.id)) : [];
    const siguen = anterior ? abiertos.filter((f) => antes.has(f.id)) : [];
    const salieron = [...antes].filter((id) => porId.get(id)?.status !== 'open');
    const fuera = salieron.map((id) => porId.get(id)).filter((f): f is Finding => f !== undefined);
    const corregidos = fuera.filter((f) => f.status === 'fixed' || f.status === 'verified');
    const ignorados = fuera.filter((f) => f.status === 'ignored');
    cadena.push({ scan_run_id: r.id, kind: r.kind, taken_at: r.finished_at!, score: r.score, abiertos: abiertos.map((f) => f.id), delta: {
      available: true, scan_run_id: r.id, taken_at: r.finished_at!, first: !anterior, score: r.score, modules_seen: vistos,
      previous: anterior ? { scan_run_id: anterior.scan_run_id, kind: anterior.kind, finished_at: anterior.taken_at, score: anterior.score } : null,
      counts: { open: matrizDe(abiertos), new: matrizDe(nuevos), kept: matrizDe(siguen), fixed: matrizDe(corregidos), ignored: matrizDe(ignorados) },
      fixed_checked: corregidos.filter((f) => f.status === 'verified' && !esClave(f.rule_id)).length, moved: 0,
      gone: salieron.length - fuera.length,                                // la fila ya no existe: ni corregido ni ignorado
      new: listaDe50(nuevos), kept: listaDe50(siguen), fixed: listaDe50(corregidos), ignored: listaDe50(ignorados),
    } });
    hechas.add(r.id);
  }
}

// E51: la auditoría de la demo (fx.auditDelta), una simulada o un ZIP de esta org; cualquier otra → 404 uniforme.
function deltaScan(org: string, id: string): AuditDelta {
  const propia = scans.get(id)?.org === org || zips.get(id)?.org === org;
  const demo = !scans.has(id) && !zips.has(id) && !vacia(org) && id === fx.scanDone.id;
  if (!propia && !demo) return falla(404, 'not_found', 'Auditoría no encontrada');
  if (demo) conCorregidos(org);
  fotografiar(org);
  const foto = fotosDe(org).find((f) => f.scan_run_id === id);
  if (!foto) {
    const zip = zips.get(id);
    const run = zip ? verZip(id, zip) : verScan(org, id);
    return { available: false, scan_run_id: id, reason: run.status === 'queued' || run.status === 'running' ? 'en_curso' : 'sin_foto' };
  }
  const porId = new Map(hallazgosDe(org).map((f) => [f.id, f]));
  const alDia = (l: DeltaLista): DeltaLista => ({ total: l.total, items: l.items.map((i) => ({ ...i, status: porId.get(i.finding_id)?.status ?? i.status })) });
  const d = structuredClone(foto.delta);
  return { ...d, new: alDia(d.new), kept: alDia(d.kept), fixed: alDia(d.fixed), ignored: alDia(d.ignored) };
}

// E52: la historia de la demo; en una org sin sus datos, la forma vacía. `days` vuelve tal cual (1–90, 30 por defecto);
// los puntos no se recortan y `limit` se ignora.
function evolucion(org: string, q: URLSearchParams): Evolution {
  const d = Number(q.get('days') ?? 30);
  const days = Number.isInteger(d) && d >= 1 && d <= 90 ? d : 30;
  if (!vacia(org)) return { ...structuredClone(fx.evolution as Evolution), days };
  return { days, points: [], truncated: false, totals: { versions: 0, snapshots: 0, score_first: null, new: matrizDe([]),
    fixed: matrizDe([]), fixed_checked: 0, ignored: 0, gone: 0 }, reviews: [], incidents: [],
    mttr: { verified: 0, hours_avg: null, hours_median: null } };
}

// ── Lecturas de la demo (E18, E24, E25, E28, E29b): en una org sin sus datos, lo que da la API con las tablas vacías ──
// El tráfico del ataque simulado en esa org sí se ve: es el de la simulación, no el de la demo.
const traficoDe = (org: string) => !vacia(org) || incidentesDe(org).some((i) => simulados.has(i.id))
  ? fx.traffic : { buckets: [], top_ips: [] };
const usoIa = (org: string) => (vacia(org) ? { ...fx.aiUsage, today_usd: 0 } : fx.aiUsage);
const exportVacio = (org: string) => [
  `# Informe de seguridad de VanGUARD: ${me().orgs.find((o) => o.id === org)?.name ?? ''}`,
  `> Generado por VanGUARD (https://officialvanguard.com) el ${new Date().toISOString()} UTC · esquema vanguard-export 1.0`, '',
  '## Cobertura', 'VanGUARD no pudo revisar: Supabase, Cloudflare, Codebase y Rendimiento.', '',
  '## Hallazgos (0 de 0)', 'Todavía no hay hallazgos abiertos.', '',
  'Fin del informe. VanGUARD no guarda ninguna respuesta que generes con este texto.',
].join('\n');
function exportar(org: string, q: URLSearchParams) {
  const archivo = `vanguard-${orgsNuevas.find((o) => o.id === org)?.slug ?? 'demo'}-20261024`;
  return q.get('format') === 'json'
    ? new Response(JSON.stringify({ schema: 'vanguard-export.v1', findings: hallazgosDe(org).length }, null, 2), {
        headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${archivo}.json"` } })
    : new Response(vacia(org) ? exportVacio(org) : fx.exportMd, {
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${archivo}.md"` } });
}

const ORG = '\\/api\\/orgs\\/([^/]+)';
const r = (s: string) => new RegExp(`^${s}$`);
const rutas: [string, RegExp, H][] = [
  ['GET',  r('\\/api\\/me'),                      () => me()],
  ['POST', r('\\/api\\/demo\\/join'),             () => ({ org_id: ORG_DEMO })],
  ['POST', r('\\/api\\/orgs'),                    (_m, b) => crearOrg(b)],
  ['GET',  r(`${ORG}\\/overview`),                (m) => overviewDe(m[1]!)],
  ['GET',  r(`${ORG}\\/modules\\/(\\w+)\\/state`), (m) => estadoModulo(m[1]!, m[2]!)],
  ['GET',  r(`${ORG}\\/connections`),             (m) => structuredClone(listaDe(m[1]!))],   // copia: TanStack no ve cambios en el mismo array
  ['POST', r(`${ORG}\\/connections`),             (m, b) => conectarFalso(m[1]!, b)],
  ['POST', r(`${ORG}\\/connections\\/([^/]+)\\/test`), (m) => probarFalso(m[1]!, m[2]!)],
  ['DELETE', r(`${ORG}\\/connections\\/([^/]+)`), (m) => quitarFalso(m[1]!, m[2]!)],
  ['POST', r(`${ORG}\\/scans`),                   (m, b) => iniciarScan(m[1]!, b)],
  ['POST', r(`${ORG}\\/scans\\/([^/]+)\\/zip-result`), (m, b) => recibirZip(m[1]!, m[2]!, b)],
  ['GET',  r(`${ORG}\\/findings`),                (m, _b, q) => listarHallazgos(m[1]!, q)],
  ['GET',  r(`${ORG}\\/findings\\/([^/]+)`),      (m) => structuredClone(hallazgo(m[1]!, m[2]!))],
  ['PATCH', r(`${ORG}\\/findings\\/([^/]+)`),     (m, b) => patchHallazgo(m[1]!, m[2]!, b)],
  ['POST', r(`${ORG}\\/findings\\/([^/]+)\\/fix-prompt`), (m) => promptFalso(m[1]!, m[2]!)],
  ['GET',  r(`${ORG}\\/incidents`),               (m, _b, q) => listarIncidentes(m[1]!, q)],
  ['GET',  r(`${ORG}\\/incidents\\/([^/]+)`),     (m) => structuredClone(incidente(m[1]!, m[2]!))],
  ['POST', r(`${ORG}\\/incidents\\/([^/]+)\\/ack`),  (m) => ackFalso(m[1]!, m[2]!)],
  ['POST', r(`${ORG}\\/incidents\\/([^/]+)\\/mute`), (m) => muteFalso(m[1]!, m[2]!)],
  ['GET',  r(`${ORG}\\/incidents\\/([^/]+)\\/under-attack`), (m) => ofertaBajoAtaque(m[1]!, m[2]!)],
  ['POST', r(`${ORG}\\/incidents\\/([^/]+)\\/under-attack\\/propose`), (m) => proponerBajoAtaque(m[1]!, m[2]!)],
  ['POST', r(`${ORG}\\/actions\\/propose`),       (m, b) => proponerFalso(m[1]!, b)],
  ['POST', r(`${ORG}\\/actions\\/([^/]+)\\/confirm`), (m, b) => confirmarFalso(m[1]!, m[2]!, b)],
  ['POST', r(`${ORG}\\/actions\\/([^/]+)\\/undo`),   (m) => deshacerFalso(m[1]!, m[2]!)],
  ['GET',  r(`${ORG}\\/traffic`),                 (m) => traficoDe(m[1]!)],
  ['GET',  r(`${ORG}\\/scans\\/([^/]+)\\/delta`), (m) => deltaScan(m[1]!, m[2]!)],   // antes que scans/:id
  ['GET',  r(`${ORG}\\/scans\\/([^/]+)`),         (m) => verScan(m[1]!, m[2]!)],
  ['GET',  r(`${ORG}\\/evolution`),               (m, _b, q) => evolucion(m[1]!, q)],
  ['POST', r(`${ORG}\\/wiki\\/estimate`),         (m, b) => estimarWiki(m[1]!, b)],
  ['POST', r(`${ORG}\\/wiki\\/runs`),             (m, b) => generarWiki(m[1]!, b)],
  ['GET',  r(`${ORG}\\/wiki\\/runs`),             (m, _b, q) => listarWikis(m[1]!, q)],
  ['GET',  r(`${ORG}\\/wiki\\/runs\\/([^/]+)\\/doc`), (m) => { const w = verWikiRun(m[1]!, m[2]!, false); return { ...fx.wikiDoc, run_id: w.id, repo_full_name: w.repo_full_name }; }],
  ['GET',  r(`${ORG}\\/wiki\\/runs\\/([^/]+)`),   (m) => verWikiRun(m[1]!, m[2]!)],
  ['GET',  r(`${ORG}\\/contacts`),                (m) => listarContactos(m[1]!)],
  ['PUT',  r(`${ORG}\\/contacts`),                (m, b) => guardarContactos(m[1]!, b)],
  ['GET',  r(`${ORG}\\/code-review`),             (m, _b, q) => verRevision(m[1]!, q)],
  ['PUT',  r(`${ORG}\\/code-review`),             (m, b) => guardarRevision(m[1]!, b)],
  ['PUT',  r(`${ORG}\\/code-review\\/gate`),       (m, b) => guardarBloqueo(m[1]!, b)],
  ['POST', r(`${ORG}\\/code-review\\/reviews\\/([^/]+)\\/gate`), (m, b) => accionBloqueo(m[1]!, m[2]!, b)],
  ['GET',  r(`${ORG}\\/alert-prefs`),             (m) => verPrefs(m[1]!)],
  ['PUT',  r(`${ORG}\\/alert-prefs`),             (m, b) => guardarPrefs(m[1]!, b)],
  ['POST', r(`${ORG}\\/notifications\\/test`),    (m, b) => probarCanal(m[1]!, b)],
  ['GET',  r(`${ORG}\\/ai\\/usage`),              (m) => usoIa(m[1]!)],
  ['GET',  r(`${ORG}\\/perf\\/runs`),             (m, _b, q) => perfDe(m[1]!).slice(0, Math.min(30, Number(q.get('limit')) || 30))],
  ['GET',  r(`${ORG}\\/mcp-tokens`),              (m) => structuredClone(tokensMcpDe(m[1]!))],
  ['POST', r(`${ORG}\\/mcp-tokens`),              (m, b) => crearTokenMcp(m[1]!, b)],
  ['DELETE', r(`${ORG}\\/mcp-tokens\\/([^/]+)`), (m) => revocarTokenMcp(m[1]!, m[2]!)],
  // Rutas que el FRONT pide con {crudo:true} devuelven un Response de verdad.
  ['GET',  r(`${ORG}\\/export`),                  (m, _b, q) => exportar(m[1]!, q)],
];

const MIEMBRO = /^\/api\/orgs\/([^/]+)(?:\/|$)/;
const MAX_CUERPO = 1024 * 1024;

export async function fixtureFetch<T>(ruta: string, o: { method?: string; body?: unknown }): Promise<T> {
  await espera(250);
  // bodyLimit de app.ts: en todo /api/* y antes que orgMember.
  if (o.body !== undefined && new TextEncoder().encode(JSON.stringify(o.body)).length > MAX_CUERPO)
    falla(413, 'invalid_body', 'El cuerpo de la petición pasa de 1 MB');
  const [camino = '', consulta = ''] = ruta.split('?');
  const q = new URLSearchParams(consulta);
  // orgMember (§15.3): una org de la que no eres miembro da 404, sin confirmar que existe. POST /api/orgs no lleva org.
  const org = camino.match(MIEMBRO)?.[1];
  if (org !== undefined && !me().orgs.some((x) => x.id === org)) falla(404, 'not_found', 'Organización no encontrada');
  for (const [met, re, h] of rutas) {
    const m = camino.match(re);
    if (m && met === (o.method ?? 'GET')) return h(m, o.body, q) as T;
  }
  console.debug('fixtures: sin ruta', o.method ?? 'GET', camino);
  throw new ApiError(404, 'not_found', 'Ruta inexistente');     // como app.notFound: la UI pinta el mensaje, la ruta no va en él
}
