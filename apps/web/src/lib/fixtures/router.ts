// Enrutador falso del modo fixtures (S14 §14.19). Único archivo que conoce los fixtures; solo se carga con
// import dinámico desde api.ts, así que no entra en el bundle de producción. Cero peticiones de red.
import {
  fixtures as fx, type ActionPublic, type ConnectionCreated, type ConnectionPublic, type Finding, type Incident, type IncidentDetail, type Me,
  type Org, type PermCheck, type ScanRun, type TimelineItem,
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

// Aprobaciones pendientes: approval_id → incidente, IP e intentos. Código válido en fixtures: 123456.
const aprobaciones = new Map<string, { org: string; incident_id: string; target: string; intentos: number; vence: number; usada: boolean }>();
function proponerFalso(org: string, body: unknown) {
  const b = (body ?? {}) as { incident_id?: string; target?: string };
  const i = incidente(org, b.incident_id ?? '');
  const ip = b.target ?? i.resource.replace(/^ip:/, '');
  if (!/^[\d.]+$|^[\da-f:]+$/i.test(ip)) falla(422, 'invalid_body', 'Solo bloqueamos una IP suelta (/32 o /128)', { reason: 'not_an_ip' });
  const approval_id = crypto.randomUUID();
  const vence = Date.now() + 600_000;          // el fixture trae una expires_at fija (sábado): se recalcula aquí (A9)
  aprobaciones.set(approval_id, { org, incident_id: i.id, target: ip, intentos: 3, vence, usada: false });
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
  const accion = ejecutarBloqueo(org, a.incident_id, a.target, approvalId);
  return { ok: true, resultado: 'IP bloqueada 1 h', en: accion.created_at, action_id: accion.id };
}
function deshacerFalso(org: string, actionId: string) {
  for (const i of incidentesDe(org)) {
    const a = i.actions.find((x) => x.id === actionId);
    if (!a) continue;
    if (a.status === 'undone') falla(409, 'conflict', 'Ese bloqueo ya se deshizo', { reason: 'already_undone' });
    a.status = 'undone'; a.undone_at = iso(Date.now());
    i.status = i.acked_at ? 'ack' : 'open'; i.mitigated_at = null;
    marca(i, 'action_undone', `IP ${a.target} desbloqueada`);
    return { ok: true, resultado: 'Desbloqueada', en: a.undone_at };
  }
  return falla(404, 'not_found', 'Esa acción no existe');
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
type ContactoFx = { id: string; name: string; phone_e164: string; whatsapp: boolean; voice: boolean; priority: number; verified_at: string | null };
const contactos = new Map<string, ContactoFx[]>();
const contactosDe = (org: string) => {
  if (!contactos.has(org)) contactos.set(org, vacia(org) ? [] : structuredClone(fx.contacts as unknown as ContactoFx[]));
  return contactos.get(org)!;
};
function exigirAdmin() { if (tipoSesionFalsa() === 'anonima') falla(403, 'forbidden', 'Modo demo: solo lectura'); }
function guardarContactos(org: string, body: unknown) {
  exigirAdmin();
  const lista = Array.isArray(body) ? body as Omit<ContactoFx, 'id' | 'verified_at'>[] : falla(422, 'invalid_body', 'Lista de contactos no válida');
  if (lista.length > 5) falla(422, 'invalid_body', 'Máximo 5 contactos');
  for (const c of lista) if (!/^\+[1-9]\d{7,14}$/.test(c.phone_e164)) falla(422, 'invalid_body', `Teléfono no válido: ${c.phone_e164}`, { field_errors: { phone_e164: ['Formato E.164'] } });
  if (new Set(lista.map((c) => c.phone_e164)).size !== lista.length) falla(422, 'invalid_body', 'Hay teléfonos repetidos');
  // vg_replace_contacts conserva verified_at por teléfono (S05): un contacto nuevo nace sin verificar.
  const antes = new Map(contactosDe(org).map((c) => [c.phone_e164, c]));
  const nuevos = lista.map((c) => ({ ...c, id: antes.get(c.phone_e164)?.id ?? crypto.randomUUID(), verified_at: antes.get(c.phone_e164)?.verified_at ?? null }));
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
const consultasWiki = new Map<string, number>();
function verWikiRun(id: string) {
  if (id !== fx.wikiRunDone.id) {
    const r = fx.wikiRuns.find((x) => x.id === id);
    return r ?? falla(404, 'not_found', 'Esa wiki no existe');
  }
  const n = (consultasWiki.get(id) ?? 0) + 1;
  consultasWiki.set(id, n);
  return n <= 3 ? { ...fx.wikiRunRunning, id } : fx.wikiRunDone;
}
function generarWiki(body: unknown) {
  exigirAdmin();
  const b = (body ?? {}) as { max_usd?: number };
  if (b.max_usd != null && (b.max_usd <= 0 || b.max_usd > 5)) falla(422, 'invalid_body', 'El tope va de 0 a 5 USD');
  consultasWiki.set(fx.wikiRunDone.id, 0);                       // cada generación vuelve a mostrar el progreso
  return { wiki_run_id: fx.wikiRunDone.id, cached: false };
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
  ['GET',  r(`${ORG}\\/incidents`),               (m, _b, q) => listarIncidentes(m[1]!, q)],
  ['GET',  r(`${ORG}\\/incidents\\/([^/]+)`),     (m) => structuredClone(incidente(m[1]!, m[2]!))],
  ['POST', r(`${ORG}\\/incidents\\/([^/]+)\\/ack`),  (m) => ackFalso(m[1]!, m[2]!)],
  ['POST', r(`${ORG}\\/incidents\\/([^/]+)\\/mute`), (m) => muteFalso(m[1]!, m[2]!)],
  ['POST', r(`${ORG}\\/actions\\/propose`),       (m, b) => proponerFalso(m[1]!, b)],
  ['POST', r(`${ORG}\\/actions\\/([^/]+)\\/confirm`), (m, b) => confirmarFalso(m[1]!, m[2]!, b)],
  ['POST', r(`${ORG}\\/actions\\/([^/]+)\\/undo`),   (m) => deshacerFalso(m[1]!, m[2]!)],
  ['GET',  r(`${ORG}\\/traffic`),                 () => fx.traffic],
  ['GET',  r(`${ORG}\\/scans\\/([^/]+)`),         (m) => verScan(m[2]!)],
  ['POST', r(`${ORG}\\/wiki\\/estimate`),         () => { exigirAdmin(); return fx.wikiEstimate; }],
  ['POST', r(`${ORG}\\/wiki\\/runs`),             (_m, b) => generarWiki(b)],
  ['GET',  r(`${ORG}\\/wiki\\/runs`),             () => fx.wikiRuns],
  ['GET',  r(`${ORG}\\/wiki\\/runs\\/([^/]+)\\/doc`), () => fx.wikiDoc],
  ['GET',  r(`${ORG}\\/wiki\\/runs\\/([^/]+)`),   (m) => verWikiRun(m[2]!)],
  ['GET',  r(`${ORG}\\/contacts`),                (m) => { exigirAdmin(); return structuredClone(contactosDe(m[1]!)); }],
  ['PUT',  r(`${ORG}\\/contacts`),                (m, b) => guardarContactos(m[1]!, b)],
  ['POST', r(`${ORG}\\/notifications\\/test`),    (m, b) => probarCanal(m[1]!, b)],
  ['GET',  r(`${ORG}\\/ai\\/usage`),              () => fx.aiUsage],
  ['GET',  r(`${ORG}\\/perf\\/runs`),             () => fx.perfRuns],
  ['GET',  r(`${ORG}\\/mcp-tokens`),              () => fx.mcpTokens],
  // Rutas que el FRONT pide con {crudo:true} devuelven un Response de verdad.
  ['GET',  r(`${ORG}\\/export`),                  (_m, _b, q) => q.get('format') === 'json'
    ? new Response(JSON.stringify({ schema: 'vanguard-export.v1', findings: hallazgosDe(ORG_DEMO).length }, null, 2), {
        headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="vanguard-demo-20261024.json"' } })
    : new Response(fx.exportMd, {
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
