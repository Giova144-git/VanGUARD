// Enrutador falso del modo fixtures (S14 §14.19). Único archivo que conoce los fixtures; solo se carga con
// import dinámico desde api.ts, así que no entra en el bundle de producción. Cero peticiones de red.
import {
  fixtures as fx, ScanCreate, ZipResult, type ActionPublic, type ConnectionCreated, type ConnectionPublic, type EstadoModulo,
  type Finding, type Incident, type IncidentDetail, type Me, type Module, type Org, type PermCheck, type ScanRun, type TimelineItem,
  type WikiRun, type ZipFinding,
} from '@vanguard/contracts';
import { z } from 'zod';
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

// Conexiones por org: la demo arranca con las del fixture; una org nueva (o ?escenario=vacio), vacía.
const conexiones = new Map<string, ConnectionPublic[]>();
const listaDe = (org: string) => {
  if (!conexiones.has(org)) conexiones.set(org, vacia(org) ? [] : structuredClone(fx.connections as unknown as ConnectionPublic[]));  // el literal con satisfies no casa con Record<string, boolean>
  return conexiones.get(org)!;
};
const conectado = (org: string, p: ConnectionPublic['provider']) =>
  listaDe(org).some((c) => c.provider === p && c.kind === 'read' && c.status === 'active');

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
// Cada corrida es de la org que la lanzó (anti-IDOR de §15.3). En una org sin los datos de la demo, el paso de un
// proveedor sin conexión sale skipped y no hay hallazgos, puntaje ni resumen de la demo.
const DURACION = 12_000;
const scans = new Map<string, { org: string; inicio: number }>();
const PROVEEDOR_PASO: Partial<Record<ScanRun['steps'][number]['name'], ConnectionPublic['provider']>> = {
  supabase: 'supabase', cloudflare: 'cloudflare', repo: 'github',
};
function iniciarScan(org: string, body: unknown) {
  if ((body as { kind?: unknown } | null)?.kind === 'zip') return iniciarZip(org, body);
  const id = crypto.randomUUID();
  scans.set(id, { org, inicio: Date.now() });
  return { scan_run_id: id };
}
function verScan(org: string, id: string): ScanRun {
  const zip = zips.get(id);
  if (zip?.org === org) return verZip(id, zip);
  const corrida = scans.get(id);
  if (corrida?.org !== org) {
    if (!corrida && !vacia(org) && id === fx.scanDone.id) return fx.scanDone as ScanRun;   // scanRunning lleva el mismo id
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
  return {
    ...base, id, kind: 'full_audit', status: hecho ? 'succeeded' : 'running', progress: Math.round(t * 100), step: hecho ? null : actual, steps,
    score: puntaje ? base.score : null, coverage: puntaje ? base.coverage : null, summary: hecho && !sinDemo ? base.summary : null,
    created_at: new Date(inicio).toISOString(), started_at: new Date(inicio).toISOString(),
    finished_at: hecho ? new Date(inicio + DURACION).toISOString() : null,
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
    const deEstaOrg = scans.get(id)?.org === org || (!scans.has(id) && !vacia(org) && id === fx.scanDone.id);
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
function exigirAdmin() { if (tipoSesionFalsa() === 'anonima') falla(403, 'forbidden', 'Modo demo: solo lectura'); }
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
// fx.wikiRuns solo existen en la demo con datos; en otra org cada generación es una corrida nueva de esa org.
const consultasWiki = new Map<string, number>();
const wikisNuevas = new Map<string, string>();                  // corrida → org
function verWikiRun(org: string, id: string, contar = true): WikiRun {
  const deOrg = wikisNuevas.get(id);
  const deDemo = deOrg === undefined && !vacia(org);
  if (deOrg !== org && !deDemo) return falla(404, 'not_found', 'Esa wiki no existe');
  if (deDemo && id !== fx.wikiRunDone.id) return fx.wikiRuns.find((x) => x.id === id) ?? falla(404, 'not_found', 'Esa wiki no existe');
  const n = (consultasWiki.get(id) ?? 0) + (contar ? 1 : 0);   // sin contar: el doc no adelanta el progreso
  consultasWiki.set(id, n);
  return n <= 3 ? { ...fx.wikiRunRunning, id } : { ...fx.wikiRunDone, id };
}
const listarWikis = (org: string) => vacia(org)
  ? [...wikisNuevas].filter(([, o]) => o === org).map(([id]) => verWikiRun(org, id, false)).reverse()   // más recientes primero
  : fx.wikiRuns;
function generarWiki(org: string, body: unknown) {
  exigirAdmin();
  const b = (body ?? {}) as { max_usd?: number };
  if (b.max_usd != null && (b.max_usd <= 0 || b.max_usd > 5)) falla(422, 'invalid_body', 'El tope va de 0 a 5 USD');
  const id = vacia(org) ? crypto.randomUUID() : fx.wikiRunDone.id;
  if (vacia(org)) wikisNuevas.set(id, org);
  consultasWiki.set(id, 0);                                      // cada generación vuelve a mostrar el progreso
  return { wiki_run_id: id, cached: false };
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
  ['GET',  r(`${ORG}\\/overview`),                (m) => vacia(m[1]!) ? fx.overviewVacio : fx.overview],
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
  ['POST', r(`${ORG}\\/actions\\/propose`),       (m, b) => proponerFalso(m[1]!, b)],
  ['POST', r(`${ORG}\\/actions\\/([^/]+)\\/confirm`), (m, b) => confirmarFalso(m[1]!, m[2]!, b)],
  ['POST', r(`${ORG}\\/actions\\/([^/]+)\\/undo`),   (m) => deshacerFalso(m[1]!, m[2]!)],
  ['GET',  r(`${ORG}\\/traffic`),                 (m) => traficoDe(m[1]!)],
  ['GET',  r(`${ORG}\\/scans\\/([^/]+)`),         (m) => verScan(m[1]!, m[2]!)],
  ['POST', r(`${ORG}\\/wiki\\/estimate`),         () => { exigirAdmin(); return fx.wikiEstimate; }],   // solo lee GitHub; cached_run_id null
  ['POST', r(`${ORG}\\/wiki\\/runs`),             (m, b) => generarWiki(m[1]!, b)],
  ['GET',  r(`${ORG}\\/wiki\\/runs`),             (m) => listarWikis(m[1]!)],
  ['GET',  r(`${ORG}\\/wiki\\/runs\\/([^/]+)\\/doc`), (m) => ({ ...fx.wikiDoc, run_id: verWikiRun(m[1]!, m[2]!, false).id })],
  ['GET',  r(`${ORG}\\/wiki\\/runs\\/([^/]+)`),   (m) => verWikiRun(m[1]!, m[2]!)],
  ['GET',  r(`${ORG}\\/contacts`),                (m) => listarContactos(m[1]!)],
  ['PUT',  r(`${ORG}\\/contacts`),                (m, b) => guardarContactos(m[1]!, b)],
  ['POST', r(`${ORG}\\/notifications\\/test`),    (m, b) => probarCanal(m[1]!, b)],
  ['GET',  r(`${ORG}\\/ai\\/usage`),              (m) => usoIa(m[1]!)],
  ['GET',  r(`${ORG}\\/perf\\/runs`),             (m) => (vacia(m[1]!) ? [] : fx.perfRuns)],
  ['GET',  r(`${ORG}\\/mcp-tokens`),              (m) => (vacia(m[1]!) ? [] : fx.mcpTokens)],
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
