// Cuerpos de petición y respuesta de la API (S15 §15.4 y §15.5). Desde el sábado 11:00
// solo se agregan campos opcionales; quitar o renombrar exige al orquestador.
import { z } from 'zod';
import {
  ActionKind, ActionStatus, Channel, ConnectionKind, ConnectionStatus, FindingStatus, Id, IncidentStatus, Module,
  NotificationStatus, Provider, Role, RuleId, ScanKind, ScanStatus, Severity, Ts,
} from './comun.ts';

export const Health = z.object({ ok: z.literal(true), version: z.string(), time: Ts });
export type Health = z.infer<typeof Health>;
export const OrgCreate = z.object({ name: z.string().trim().min(2).max(80) });
export type OrgCreate = z.infer<typeof OrgCreate>;
export const Org = z.object({ id: Id, name: z.string(), slug: z.string(), is_demo: z.boolean(), created_at: Ts });
export type Org = z.infer<typeof Org>;
export const Me = z.object({ user: z.object({ id: Id, email: z.string().nullable(), is_anonymous: z.boolean() }),
  orgs: z.array(z.object({ id: Id, name: z.string(), role: Role, is_demo: z.boolean() })) });
export type Me = z.infer<typeof Me>;
export const DemoJoin = z.object({ org_id: Id });
export type DemoJoin = z.infer<typeof DemoJoin>;

// ── Conexiones ────────────────────────────────────────────────────────────────
const Token = z.string().trim().min(20).max(400);
// Cloudflare: mode 'zone' (zona propia, zone_id + token de lectura, como siempre) o 'url' (un sitio de Pages o Workers
// sin zona: *.pages.dev, *.workers.dev o su dominio personalizado). En 'url' el token es opcional: sin él solo se revisa
// el sitio por HTTP; con un token de CUENTA (Account · Cloudflare Pages · Read y Account · Workers Scripts · Read),
// también la configuración del proyecto. action_token solo en 'zone' (bloquear IP y bajo ataque necesitan una zona).
const CloudflareSiteUrl = z.url().refine((u) => u.startsWith('https://'), 'solo https')
  .refine((u) => { const h = new URL(u).hostname; return h.includes('.') && !/^[\d.]+$/.test(h) && !h.includes(':'); },
    'un dominio público, no una IP');
export const ConnectionCreate = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('supabase'), project_ref: z.string().trim().max(120), pat: Token, // ref o URL; el BACK normaliza
    publishable_key: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{10,}$/).optional() }), // P1, sondeo activo de RLS (§07.6)
  z.object({ provider: z.literal('cloudflare'), mode: z.enum(['zone', 'url']).default('zone'),
    zone_id: z.string().trim().regex(/^[a-f0-9]{32}$/).optional(), url: CloudflareSiteUrl.optional(),
    read_token: Token.optional(), action_token: Token.optional() })
    .superRefine((v, ctx) => {
      if (v.mode === 'zone' && (!v.zone_id || !v.read_token))
        ctx.addIssue({ code: 'custom', message: 'zone_id y read_token son obligatorios en modo zona', path: ['zone_id'] });
      if (v.mode === 'url' && !v.url) ctx.addIssue({ code: 'custom', message: 'url es obligatoria en modo sitio', path: ['url'] });
      if (v.mode === 'url' && v.action_token) ctx.addIssue({ code: 'custom', message: 'action_token solo en modo zona', path: ['action_token'] });
    }),
  z.object({ provider: z.literal('github'), // regex de §06.3: sin "." ni ".." como repo (acme/.. → 422)
    repo_full_name: z.string().regex(/^[A-Za-z0-9-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/), pat: Token }),
  z.object({ provider: z.literal('ingest'), label: z.string().trim().min(2).max(40),
    purpose: z.enum(['ingest', 'cf_webhook']).optional() }), // cf_webhook: secreto del webhook de Cloudflare (E36, P1)
]);
export type ConnectionCreate = z.infer<typeof ConnectionCreate>;
export const ProviderErrorCode = z.enum(['unauthorized', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'timeout', 'invalid']);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCode>;
export const PermCheck = z.object({ permission: z.string(), ok: z.boolean(), required: z.boolean().optional(),
  error_code: ProviderErrorCode.optional() });
export type PermCheck = z.infer<typeof PermCheck>;
export const ConnectionPublic = z.object({ id: Id, provider: Provider, kind: ConnectionKind, label: z.string(), status: ConnectionStatus,
  last4: z.string().max(4).nullable(), scopes: z.array(z.string()), meta: z.record(z.string(), z.unknown()),
  capabilities: z.record(z.string(), z.boolean()), // solo booleanos; lo demás va en meta
  expires_at: Ts.nullable(), last_checked_at: Ts.nullable(), last_error: z.string().nullable() });
export type ConnectionPublic = z.infer<typeof ConnectionPublic>;
export const ConnectionCreated = z.object({ connection: ConnectionPublic, action_connection: ConnectionPublic.nullable(),
  checks: z.array(PermCheck), ingest_secret: z.string().startsWith('vgi_').nullable() });
export type ConnectionCreated = z.infer<typeof ConnectionCreated>;
export const ConnectionTest = z.object({ ok: z.boolean(), checks: z.array(PermCheck), checked_at: Ts });
export type ConnectionTest = z.infer<typeof ConnectionTest>;

// ── Auditorías ────────────────────────────────────────────────────────────────
export const ScanCreate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('full_audit') }),
  z.object({ kind: z.literal('supabase'), connection_id: Id.optional() }),
  z.object({ kind: z.literal('cloudflare'), connection_id: Id.optional() }),
  z.object({ kind: z.literal('repo'), connection_id: Id.optional() }),
  z.object({ kind: z.literal('zip'), filename: z.string().regex(/^[\w .()-]{1,120}\.zip$/i),
    size_bytes: z.number().int().min(22).max(25 * 1024 * 1024) }),
  z.object({ kind: z.literal('lighthouse'), url: z.url().refine((u) => u.startsWith('https://'), 'solo https'), // P1, §10.9
    strategy: z.enum(['mobile', 'desktop']).default('mobile'),
    version_label: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/).optional() }),
]);
export type ScanCreate = z.infer<typeof ScanCreate>;
export const ScanAccepted = z.object({ scan_run_id: Id });
export type ScanAccepted = z.infer<typeof ScanAccepted>;
export const ScanStep = z.object({ name: z.enum(['supabase', 'cloudflare', 'repo', 'zip', 'psi', 'resumen_ia']),
  status: z.enum(['pending', 'running', 'done', 'skipped', 'failed']), findings: z.number().int().optional(),
  error_code: z.string().optional() });
export type ScanStep = z.infer<typeof ScanStep>;
// detail: lo que cada paso dejó en scan_runs.coverage.detail (codebase.miradas, cloudflare {modo, miradas}…); forma libre por módulo.
export const Coverage = z.object({ seen: z.number().int().min(0).max(4), total: z.number().int(), missing: z.array(Module),
  detail: z.record(z.string(), z.unknown()).optional() });
export type Coverage = z.infer<typeof Coverage>;
export const AuditSummary = z.object({ resumen: z.string().max(2000),
  top: z.array(z.object({ finding_id: Id, por_que: z.string().max(500) })).max(5),
  relaciones: z.array(z.object({ finding_ids: z.array(Id).min(2), explicacion: z.string().max(500) })).max(5),
  suspected_injection: z.boolean().optional(), // el filtro marcó la salida de IA-2
  model: z.string() });
export type AuditSummary = z.infer<typeof AuditSummary>;
// ── Varias codebases por org (asignaciones/varias-codebases.md) ───────────────────────────────────────────────────
// Tope de repos GitHub por org: nombres de repo distintos entre las conexiones GitHub de LECTURA, en cualquier estado.
// E8 responde 409 (details.reason 'tope_repos'). La conexión de estados del bloqueo de merge (kind 'action') no cuenta.
export const MAX_REPOS_GITHUB = 5;
// Cómo le fue a cada repo en una auditoría con paso repo (full_audit, o repo sin connection_id). Sale de
// scan_runs.coverage.detail.codebase.repos, en el orden en que se revisan (la conexión más antigua primero).
// findings: filas escritas para ESE repo; error_code: el del repo (unauthorized, no_connection, tripwire…).
export const ScanRepo = z.object({ connection_id: Id, repo_full_name: z.string().max(140), status: ScanStep.shape.status,
  findings: z.number().int().min(0).optional(), error_code: z.string().max(40).optional() });
export type ScanRepo = z.infer<typeof ScanRepo>;
export const ScanRun = z.object({ id: Id, kind: ScanKind, status: ScanStatus, progress: z.number().int().min(0).max(100),
  step: z.string().nullable(), steps: z.array(ScanStep), score: z.number().int().min(0).max(100).nullable(),
  coverage: Coverage.nullable(), summary: AuditSummary.nullable(), error: z.string().nullable(), created_at: Ts,
  started_at: Ts.nullable(), finished_at: Ts.nullable(),
  band: z.enum(['red', 'amber', 'green']).nullable().optional(), // opcional: color del puntaje en corridas viejas (§14.14)
  repos: z.array(ScanRepo).max(MAX_REPOS_GITHUB).optional() }); // solo si el paso repo miró conexiones (varias-codebases)
export type ScanRun = z.infer<typeof ScanRun>;

// ── Hallazgos ─────────────────────────────────────────────────────────────────
export const Finding = z.object({ id: Id, module: Module, rule_id: RuleId, severity: Severity, confirmed: z.boolean(),
  origin: z.enum(['rule', 'ai', 'provider']), title: z.string().max(200), resource: z.string().max(300),
  evidence: z.record(z.string(), z.unknown()), has_fix_prompt: z.boolean(), fix_model: z.string().nullable(), status: FindingStatus,
  status_reason: z.string().nullable(), suspected_injection: z.boolean(), scan_run_id: Id.nullable(), connection_id: Id.nullable(),
  first_seen_at: Ts, last_seen_at: Ts, verified_at: Ts.nullable() });
export type Finding = z.infer<typeof Finding>;
export const FindingPatch = z.object({ status: z.enum(['open', 'fixed', 'ignored']), reason: z.string().trim().min(3).max(300).optional() })
  .refine((b) => b.status !== 'ignored' || !!b.reason, { message: 'Explica por qué lo ignoras', path: ['reason'] });
export type FindingPatch = z.infer<typeof FindingPatch>;
export const FixPromptRequest = z.object({ flavor: z.enum(['generic', 'claude_code', 'cursor']).default('generic') });
export type FixPromptRequest = z.infer<typeof FixPromptRequest>;
export const FixPromptResponse = z.object({ prompt: z.string().max(12000), model: z.string(), cached: z.boolean(),
  injection_flags: z.array(z.string()) });
export type FixPromptResponse = z.infer<typeof FixPromptResponse>;

// ── «Enviar a mi IA» (E58 POST/DELETE …/findings/:id/fix-requests, E58b GET …/fix-requests) ──────────────────────
// Cola de correcciones: la web la llena; la IA del usuario la lee por MCP (list_fix_requests, solo lectura) y, al pedir
// la corrección, pasa a «arreglando» (telemetría de estado del Worker). «corregido» lo pone la base cuando el hallazgo
// deja de estar abierto; «cancelado», el usuario (DELETE) o un hallazgo ignorado. Como mucho una abierta por hallazgo.
export const FixRequestStatus = z.enum(['enviado', 'arreglando', 'corregido', 'cancelado']);
export type FixRequestStatus = z.infer<typeof FixRequestStatus>;
export const FIX_REQUEST_ABIERTA: readonly FixRequestStatus[] = ['enviado', 'arreglando'];
export const FixRequestClient = z.enum(['claude_code', 'vscode', 'copiar']);
export type FixRequestClient = z.infer<typeof FixRequestClient>;
export const FixRequestCreate = z.object({ client: FixRequestClient.optional() });
export type FixRequestCreate = z.infer<typeof FixRequestCreate>;
export const FixRequest = z.object({ id: Id, finding_id: Id, status: FixRequestStatus, client: FixRequestClient.nullable(),
  created_at: Ts, started_at: Ts.nullable(), closed_at: Ts.nullable() });
export type FixRequest = z.infer<typeof FixRequest>;

// ── Incidentes, avisos y acciones ─────────────────────────────────────────────
export const Incident = z.object({ id: Id, code: z.string().regex(/^[A-Z0-9]{6}$/), module: Module, rule_ids: z.array(RuleId).min(1),
  severity: Severity, title: z.string().max(200), resource: z.string().max(200), status: IncidentStatus, event_count: z.number().int(),
  details: z.record(z.string(), z.unknown()), started_at: Ts, last_event_at: Ts, notified_at: Ts.nullable(), acked_at: Ts.nullable(),
  acked_via: z.enum(['in_app', 'whatsapp', 'voice']).nullable(), muted_until: Ts.nullable(), mitigated_at: Ts.nullable(),
  resolved_at: Ts.nullable(), suspected_injection: z.boolean() });
export type Incident = z.infer<typeof Incident>;
export const NotificationPublic = z.object({ id: Id, channel: Channel, recipient_masked: z.string(), template: z.string(),
  status: NotificationStatus, error: z.string().nullable(), created_at: Ts, sent_at: Ts.nullable(), delivered_at: Ts.nullable(),
  read_at: Ts.nullable() });
export type NotificationPublic = z.infer<typeof NotificationPublic>;
export const ActionPublic = z.object({ id: Id, kind: ActionKind, target: z.string(), status: ActionStatus, created_at: Ts,
  undone_at: Ts.nullable(), expires_at: Ts.nullable(),
  approval_id: Id.nullable().optional() }); // saber si se aprobó por WhatsApp (H9 de §14)
export type ActionPublic = z.infer<typeof ActionPublic>;
export const TimelineItem = z.object({ t: Ts, ms: z.number().int(), label: z.string().optional(),
  kind: z.enum(['attack_start', 'detected', 'severity_up', 'whatsapp_sent', 'whatsapp_delivered', 'whatsapp_read', 'call_started',
    'call_failed', 'ack', 'muted', 'action_proposed', 'action_executed', 'action_undone',
    'edge_confirmed', // P1: «Cloudflare confirmó N bloqueos», derivado de cf_fw_event (§08)
    'mitigated', 'resolved']) });
export type TimelineItem = z.infer<typeof TimelineItem>;
export const IncidentDetail = Incident.extend({ notifications: z.array(NotificationPublic), actions: z.array(ActionPublic),
  timeline: z.array(TimelineItem) });
export type IncidentDetail = z.infer<typeof IncidentDetail>;
export const MuteBody = z.object({ minutes: z.number().int().min(15).max(1440).default(60) });
export type MuteBody = z.infer<typeof MuteBody>;
export const Traffic = z.object({ buckets: z.array(z.object({ t: Ts, n: z.number().int(), n4xx: z.number().int(), n5xx: z.number().int() })),
  top_ips: z.array(z.object({ ip: z.string(), n: z.number().int(), ua_top: z.string().nullable() })).max(10) });
export type Traffic = z.infer<typeof Traffic>;

export const ProposeAction = z.object({ incident_id: Id, kind: ActionKind, target: z.string().max(45), // tipos sin implementar → 422
  connection_id: Id.optional(), mode: z.enum(['block', 'managed_challenge']).default('block') }); // managed_challenge P1
export type ProposeAction = z.infer<typeof ProposeAction>;
export const ProposeResponse = z.object({ approval_id: Id, efecto: z.string(), avisos: z.array(z.string()), expires_at: Ts,
  delivery: z.enum(['whatsapp', 'in_app']), code: z.string().regex(/^\d{6}$/).nullable() });
export type ProposeResponse = z.infer<typeof ProposeResponse>;
export const ConfirmBody = z.object({ code: z.string().regex(/^\d{6}$/) });
export type ConfirmBody = z.infer<typeof ConfirmBody>;
export const RespuestaEscritura = z.object({ ok: z.boolean(), resultado: z.string().optional(), en: Ts.optional(),
  action_id: Id.optional(), error: z.string().optional(), aviso: z.string().optional(), efecto: z.string().optional(),
  avisos: z.array(z.string()).optional() });
export type RespuestaEscritura = z.infer<typeof RespuestaEscritura>;

// ── Contactos, IA, MCP y rendimiento ──────────────────────────────────────────
export const ContactIn = z.object({ name: z.string().trim().min(2).max(60), phone_e164: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  whatsapp: z.boolean(), voice: z.boolean(), priority: z.number().int().min(1).max(5) });
export type ContactIn = z.infer<typeof ContactIn>;
export const ContactsPut = z.array(ContactIn).max(5)
  .refine((a) => new Set(a.map((c) => c.priority)).size === a.length, 'prioridades repetidas')
  .refine((a) => new Set(a.map((c) => c.phone_e164)).size === a.length, 'teléfonos repetidos'); // único (org_id, phone_e164) en §05
export type ContactsPut = z.infer<typeof ContactsPut>;
// verificacion: solo en contactos sin verificar con whatsapp=true y si hay número real de VanGUARD. El contacto abre
// `enlace` (wa.me/<número de VanGUARD>?text=VERIFICAR%20<codigo>) y envía el texto; E31 compara el remitente con
// phone_e164 y el código (6 primeros hex de HMAC(FPK, 'contact|' + id)) y pone verified_at. Así nadie registra un
// teléfono ajeno: verifica quien tiene el teléfono, y su primer mensaje abre la ventana de 24 h de WhatsApp.
export const VerificacionContacto = z.object({ codigo: z.string().regex(/^[0-9A-F]{6}$/), enlace: z.url().refine((u) => u.startsWith('https://wa.me/'), 'solo wa.me') });
export type VerificacionContacto = z.infer<typeof VerificacionContacto>;
export const Contact = ContactIn.extend({ id: Id, verified_at: Ts.nullable(), verificacion: VerificacionContacto.nullable().optional() });
export type Contact = z.infer<typeof Contact>;
export const NotificationTest = z.object({ channel: z.enum(['whatsapp', 'voice']) });
export type NotificationTest = z.infer<typeof NotificationTest>;
export const NotificationTestResult = z.object({ ok: z.boolean(), provider_id: z.string().nullable() });
export type NotificationTestResult = z.infer<typeof NotificationTestResult>;
export const AiUsage = z.object({ today_usd: z.number(), cap_usd: z.number(), enabled: z.boolean(),
  level: z.enum(['normal', 'reduced', 'minimal', 'off']) });
export type AiUsage = z.infer<typeof AiUsage>;
export const McpTokenCreate = z.object({ name: z.string().trim().min(2).max(60), expires_in_days: z.number().int().min(1).max(90).default(30) });
export type McpTokenCreate = z.infer<typeof McpTokenCreate>;
export const McpTokenCreated = z.object({ id: Id, token: z.string().startsWith('vgk_'), name: z.string().optional(),
  scopes: z.array(z.string()).optional(), last4: z.string().optional(), expires_at: Ts.nullable().optional() });
export type McpTokenCreated = z.infer<typeof McpTokenCreated>;
export const McpTokenPublic = z.object({ id: Id, name: z.string(), scopes: z.array(z.string()), last4: z.string().nullable(),
  created_at: Ts, last_used_at: Ts.nullable(), expires_at: Ts.nullable(), revoked_at: Ts.nullable() });
export type McpTokenPublic = z.infer<typeof McpTokenPublic>;
export const PerfRun = z.object({ id: Id, url: z.string(), strategy: z.enum(['mobile', 'desktop']), source: z.literal('psi'),
  lighthouse_version: z.string().nullable(), scores: z.record(z.string(), z.number().nullable()),
  metrics: z.object({ lcp_ms: z.number().nullable(), tbt_ms: z.number().nullable(), cls: z.number().nullable(),
    fcp_ms: z.number().nullable(), si_ms: z.number().nullable(), ttfb_ms: z.number().nullable() }), created_at: Ts });
export type PerfRun = z.infer<typeof PerfRun>;

// ── ZIP analizado en el navegador (E23 POST …/scans/:scan_run_id/zip-result) ─────────
// El ZIP nunca llega al servidor: el navegador lo abre y manda solo dependencias y hallazgos enmascarados.
export const ZipDep = z.object({ ecosystem: z.enum(['npm', 'Packagist']), name: z.string().min(1).max(214),
  version: z.string().min(1).max(64), dev: z.boolean().optional() });
export type ZipDep = z.infer<typeof ZipDep>;
export const ZipFinding = z.object({ rule_id: z.string().regex(/^CB_(ENV_COMMITTED|GITIGNORE_NO_ENV|SECRET_[A-Z0-9_]+)$/),
  severity: Severity, title: z.string().max(200), resource: z.string().max(300),
  evidence: z.strictObject({ path: z.string().max(300), line: z.number().int().min(1).optional(),
    preview: z.string().max(12).optional() }) }); // estricto: un campo de más (p. ej. el secreto entero) → 422
export type ZipFinding = z.infer<typeof ZipFinding>;
export const ZipResult = z.object({ files_seen: z.number().int().min(0).max(20000), deps: z.array(ZipDep).max(2000),
  findings: z.array(ZipFinding).max(200), analyzer: z.string().max(40).optional() });
export type ZipResult = z.infer<typeof ZipResult>;

// ── Resumen ───────────────────────────────────────────────────────────────────
export const AhoraItem = z.object({ kind: z.enum(['finding', 'incident']), id: Id, module: Module, rule_id: RuleId, severity: Severity,
  title: z.string(), resource: z.string(),
  connection_id: Id.nullable().optional() }); // hallazgo: su conexión (el FRONT pinta el repo si la org tiene ≥ 2); incidente: sin campo
export type AhoraItem = z.infer<typeof AhoraItem>;
export const Overview = z.object({ score: z.number().int().min(0).max(100).nullable(), band: z.enum(['red', 'amber', 'green']).nullable(),
  coverage: Coverage,
  counts: z.record(Severity, z.number().int()), // zod 4: un record con enum exige las 5 claves (aunque valgan 0)
  open_incidents: z.number().int(),
  last_scan: z.object({ id: Id, status: ScanStatus, finished_at: Ts.nullable() }).nullable(),
  ai: z.object({ enabled: z.boolean(), level: AiUsage.shape.level }).optional(), ahora: z.array(AhoraItem).max(10),
  // Revisión de UX (ux-revision-develop.md). Opcionales hasta que el BACK los mande; sin ellos la web no promete nada.
  // last_ok_scan: la última full_audit SUCCEEDED («Última auditoría» enlaza a esta; last_scan puede ser una fallida).
  last_ok_scan: z.object({ id: Id, finished_at: Ts }).nullable().optional(),
  // module_checks: si cada módulo se miró en last_ok_scan (done), no se miró (sin_revisar: sin conexión, skipped o sin
  // auditoría terminada) o su paso falló (fallido). Ningún módulo pinta «✓ Nada que atender» si no está en done.
  module_checks: z.partialRecord(Module, z.enum(['done', 'sin_revisar', 'fallido'])).optional(),
  // last_ingest_at: el último evento de ingesta de la org (null si nunca hubo). «Vigilando» solo con tráfico reciente.
  last_ingest_at: Ts.nullable().optional(),
  // preview: true en una vista previa de Workers (VG_ENV=preview): no hay cola y E11 responde 503 preview_unsupported.
  preview: z.boolean().optional() });
export type Overview = z.infer<typeof Overview>;

// ── Revisión de código en cada push (E45–E50; asignaciones/revision-codigo.md) ─────────────────────────────────────
// Umbral por canal: severidad mínima de un hallazgo NUEVO para avisar por ese canal; 'off' = nunca por ese canal.
export const UmbralAviso = z.enum(['critical', 'high', 'medium', 'low', 'off']);
export type UmbralAviso = z.infer<typeof UmbralAviso>;
export const AlertPrefsIn = z.object({ review_whatsapp_min: UmbralAviso, review_voice_min: UmbralAviso });
export type AlertPrefsIn = z.infer<typeof AlertPrefsIn>;
// voice_available: false mientras no haya llamadas; entonces lo que pase el umbral de llamada también sale por WhatsApp.
// whatsapp_ready_contacts: contactos con WhatsApp activado y verificados (los únicos que reciben algo).
export const AlertPrefs = AlertPrefsIn.extend({ voice_available: z.boolean(),
  whatsapp_ready_contacts: z.number().int().min(0), updated_at: Ts.nullable() });
export type AlertPrefs = z.infer<typeof AlertPrefs>;

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);
export const CodeReviewEvent = z.enum(['push', 'pull_request', 'manual']); // pull_request y manual: P1
export type CodeReviewEvent = z.infer<typeof CodeReviewEvent>;
// off: interruptor apagado · waiting_ping: activa y GitHub aún no llamó · connected · error: ver last_error.
export const CodeReviewHookState = z.enum(['off', 'waiting_ping', 'connected', 'error']);
export type CodeReviewHookState = z.infer<typeof CodeReviewHookState>;
// firma (P1): llegó con otro secreto · otro_repo: el webhook es de otro repositorio · sin_push: el ping no trae
// «Pushes» · token: el PAT de la conexión dio 401 o 403 en la última revisión.
export const CodeReviewHookError = z.enum(['firma', 'otro_repo', 'sin_push', 'token']);
export type CodeReviewHookError = z.infer<typeof CodeReviewHookError>;
// ── Bloqueo de merge con críticos (E53–E54; asignaciones/bloqueo-merge-criticos.md) ─────────────────────────────────
// VanGUARD publica un estado de commit (Commit statuses API) con este contexto EXACTO en cada revisión de push y de PR.
// Es el nombre que el dueño marca como obligatorio en la protección de rama de GitHub (GitHub no distingue mayúsculas).
export const GATE_CONTEXT = 'VanGUARD';
// Severidad mínima de lo AÑADIDO que bloquea. El pedido es «crítico»; 'high' es opcional.
export const MergeGateMin = z.enum(['critical', 'high']);
export type MergeGateMin = z.infer<typeof MergeGateMin>;
// Estados de la Commit statuses API (POST /repos/{owner}/{repo}/statuses/{sha}).
export const CommitStatusState = z.enum(['pending', 'success', 'failure', 'error']);
export type CommitStatusState = z.infer<typeof CommitStatusState>;
// P1. Protección de la rama vigilada, leída por E53 con el token de LECTURA (Get a branch + Get rules for a branch).
// required: yes = GitHub exige «VanGUARD» de cualquier fuente · other_source = lo exige fijado a una GitHub App (nuestro
//   estado no cuenta) · no = no lo exige · unknown = no se pudo leer.
// admins: enforced = la regla clásica vale también para admins · bypass = los admins se la saltan · unknown = ruleset (su
//   lista de excepciones no se ve con un token de lectura) o sin regla.
// pr_required: yes = un ruleset exige PR · no = la rama no tiene protección · unknown = protección clásica (no se ve sin
//   Administration: read).
export const MergeGateProtection = z.object({ required: z.enum(['yes', 'no', 'other_source', 'unknown']),
  admins: z.enum(['enforced', 'bypass', 'unknown']), pr_required: z.enum(['yes', 'no', 'unknown']), checked_at: Ts });
export type MergeGateProtection = z.infer<typeof MergeGateProtection>;
// off: apagado · needs_token: encendido sin token de estados activo · unchecked: publica, pero no sabemos si GitHub exige
// el check (P0 no lee la protección; en P1, lectura fallida) · needs_protection (P1): publica y GitHub aún no exige el
// check (no bloquea nada) · active (P1): publica y GitHub lo exige · error: el token falló al publicar (ver last_error).
export const MergeGateState = z.enum(['off', 'needs_token', 'unchecked', 'needs_protection', 'active', 'error']);
export type MergeGateState = z.infer<typeof MergeGateState>;
// Problemas del TOKEN al publicar (un 422 es de un solo commit y va solo en CodeReview.gate.error):
// token: 401 (caducado o revocado) · forbidden: 403 (sin Commit statuses: write, o pendiente de aprobar en la
// organización) · not_found: 404 (el token no ve el repo).
export const MergeGateError = z.enum(['token', 'forbidden', 'not_found']);
export type MergeGateError = z.infer<typeof MergeGateError>;
// La conexión GitHub kind 'action' (solo Commit statuses). Nunca el token.
export const MergeGateConnection = z.object({ id: Id, status: ConnectionStatus, last4: z.string().max(4).nullable(),
  expires_at: Ts.nullable() });
export type MergeGateConnection = z.infer<typeof MergeGateConnection>;
// protection: null en P0 (no se lee) o si nunca se comprobó.
export const MergeGateConfig = z.object({ enabled: z.boolean(), min_severity: MergeGateMin, state: MergeGateState,
  context: z.literal(GATE_CONTEXT), statuses_connection: MergeGateConnection.nullable(),
  protection: MergeGateProtection.nullable(), last_error: MergeGateError.nullable(),
  // Anexo bloqueo-merge-cierre-pr.md: close_pr = interruptor «Cerrar los PR con críticos»; can_close_pr = el token de
  // escritura tiene «Pull requests: Read and write».
  close_pr: z.boolean().optional(), can_close_pr: z.boolean().optional() });
export type MergeGateConfig = z.infer<typeof MergeGateConfig>;
export const CodeReviewConfig = z.object({ id: Id, connection_id: Id, repo_full_name: z.string(), branch: z.string(),
  enabled: z.boolean(), state: CodeReviewHookState,
  // null si el rol no es owner/admin o fuera de producción (en local APP_ORIGIN es la SPA en http://localhost:5173).
  webhook_url: z.url().refine((u) => u.startsWith('https://'), 'solo https').nullable(),
  secret_last4: z.string().max(4).nullable(),
  hook_events: z.array(z.string().max(40)).max(30), // los que GitHub declaró en el último ping
  last_ping_at: Ts.nullable(), last_event_at: Ts.nullable(), last_error: CodeReviewHookError.nullable(),
  muted_until: Ts.nullable().optional(), // botón «Silenciar repo 1 h» (anexo de botones): sin avisos de revisión hasta entonces
  gate: MergeGateConfig.optional() }); // E45 con 0016; falta en un BACK de antes y en los repos sin bloqueo (varias §2.6)
export type CodeReviewConfig = z.infer<typeof CodeReviewConfig>;
// finding_id null en un PR (P1: no se escribe en findings) o si el hallazgo ya se borró.
export const CodeReviewFinding = z.object({ finding_id: Id.nullable(), rule_id: RuleId, severity: Severity,
  title: z.string().max(200), resource: z.string().max(300) });
export type CodeReviewFinding = z.infer<typeof CodeReviewFinding>;
export const CodeReviewAlert = z.object({
  state: z.enum(['none', 'pending', 'sent', 'not_sent']),
  // none: bajo_umbral o null · not_sent: sin_contactos | unverified | window_closed | cap | fuera_de_ventana_demo |
  // dry_run | sin_config | envio | dlq. La UI los traduce con un mapa cerrado y un texto por defecto.
  reason: z.string().max(40).nullable(),
  delivery: NotificationStatus.nullable(),   // el mejor estado de sus WhatsApp (read > delivered > sent > queued …)
  // notifications.error cuando delivery = 'failed' (p. ej. 131047 = ventana de 24 h cerrada, llega después del envío).
  delivery_error: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/).nullable(),
  voice_pending: z.boolean(),                // pasó el umbral de llamada; sin llamadas, el aviso salió por WhatsApp
  notified_at: Ts.nullable(),
  seconds: z.number().min(0).nullable(),     // notified_at − created_at de la revisión
  // Anexo avisos-whatsapp-botones.md: lo último que se hizo con un botón del WhatsApp de esta revisión. Una acción que
  // este contrato aún no conoce sale null (.catch) en vez de tumbar CodeReviewState entero: la tarjeta se sigue pintando.
  whatsapp_action: z.enum(['fix_sent', 'issue_created', 'muted', 'pr_reopened']).nullable().optional().catch(null),
  whatsapp_action_at: Ts.nullable().optional() });
export type CodeReviewAlert = z.infer<typeof CodeReviewAlert>;
// Bloqueo por revisión (CodeReview.gate). blocking: hallazgos de lo AÑADIDO con severidad ≥ min_severity y sin «Ignorar»
// (null = no se calculó: bloqueo apagado al revisar, o revisión fallida). NO es counts: counts son los NUEVOS y, en un
// PR, excluyen lo ya visto en el push anterior al mismo PR; blocking cuenta todo lo que el cambio añade.
// findings: hasta 20 de esos (finding_id siempre null). state: lo último que GitHub aceptó (null = nada todavía).
// error: por qué no se publicó: sin_token | dry_run | sin_calculo | otro_repo | unauthorized | forbidden | not_found |
// limite | red | dlq (la UI los traduce con un mapa cerrado y un texto por defecto). override_at: «Dar por bueno» (E54).
export const MergeGateReview = z.object({ blocking: z.number().int().min(0).nullable(),
  findings: z.array(CodeReviewFinding).max(20), state: CommitStatusState.nullable(),
  error: z.string().regex(/^[a-z_]{2,40}$/).nullable(), published_at: Ts.nullable(), override_at: Ts.nullable(),
  // Anexo de cierre de PR: closed (VanGUARD lo cerró) · reopened_by_human (alguien lo reabrió sin commits nuevos; no se
  // vuelve a cerrar) · reopened (lo reabrió VanGUARD por «Reabrir el PR», E54 o WhatsApp) · close_failed (ver
  // pr_close_error). null = no aplica (push, PR sin críticos o interruptor apagado). Un valor desconocido sale null
  // (.catch) y el resto del bloqueo se sigue viendo. error y pr_close_error siguen estrictos: un texto libre no pasa.
  pr_action: z.enum(['closed', 'reopened_by_human', 'reopened', 'close_failed']).nullable().optional().catch(null),
  pr_close_error: z.string().regex(/^[a-z_]{2,40}$/).nullable().optional() });
export type MergeGateReview = z.infer<typeof MergeGateReview>;
// Foto de Codebase al cerrar una revisión de push (0015; asignaciones/evolucion-entre-revisiones.md §2.2). open =
// abiertos de Codebase de TODA la org al cerrar; kept = open menos los nuevos de este push; fixed = abiertos en la foto
// del push anterior de la org que ya no lo están (fixed o verified; ignored aparte); fixed_checked = de esos, los que
// comprobó una auditoría, sin claves (que una clave ya no esté en el código no prueba que se rotó). first:true = primer
// push con foto: no hay con qué comparar y fixed, fixed_checked e ignored van en 0.
export const CodeReviewDelta = z.object({ first: z.boolean(), previous_review_id: Id.nullable(), previous_at: Ts.nullable(),
  open: z.number().int().min(0), kept: z.number().int().min(0), fixed: z.number().int().min(0),
  fixed_checked: z.number().int().min(0), ignored: z.number().int().min(0) });
export type CodeReviewDelta = z.infer<typeof CodeReviewDelta>;
export const CodeReview = z.object({ id: Id, event: CodeReviewEvent, branch: z.string(),
  pr_number: z.number().int().positive().nullable(), base_sha: Sha40, head_sha: Sha40,
  // failed con error_code 'interrumpida': E45 lo pone a una revisión queued/running de más de 15 min (sin escribir).
  status: z.enum(['queued', 'running', 'done', 'failed']), error_code: z.string().nullable(), partial: z.boolean(),
  files_changed: z.number().int().min(0), lines_added: z.number().int().min(0),
  counts: z.record(Severity, z.number().int()), // de los hallazgos NUEVOS; zod 4 exige las 5 claves
  max_severity: Severity.nullable(), findings: z.array(CodeReviewFinding).max(50), alert: CodeReviewAlert,
  created_at: Ts, finished_at: Ts.nullable(),
  gate: MergeGateReview.optional(), // falta en revisiones de antes de 0016
  delta: CodeReviewDelta.nullable().optional() }); // E45 con 0015; null en un PR, en un push de antes de 0015 o sin foto
export type CodeReview = z.infer<typeof CodeReview>;
export const CodeReviewState = z.object({ available: z.boolean(),
  reason: z.enum(['sin_conexion', 'conexion_inactiva']).nullable(),
  config: CodeReviewConfig.nullable(), recent: z.array(CodeReview).max(10) });
export type CodeReviewState = z.infer<typeof CodeReviewState>;
// E45 · ?connection_id= (varias-codebases): el estado de ESE repo. Sin él, la conexión GitHub de lectura principal
// (la activa más antigua).
export const CodeReviewQuery = z.object({ connection_id: Id.optional() });
export type CodeReviewQuery = z.infer<typeof CodeReviewQuery>;
// rotate_secret: P1 (en P0, true → 400).
export const CodeReviewPut = z.object({ connection_id: Id, enabled: z.boolean(), rotate_secret: z.boolean().optional() });
export type CodeReviewPut = z.infer<typeof CodeReviewPut>;
// webhook_secret solo al crear la configuración (y al rotarlo, P1); nunca en E45. 'vgw_' + 32 bytes en base64url.
export const CodeReviewSaved = z.object({ config: CodeReviewConfig,
  webhook_secret: z.string().regex(/^vgw_[A-Za-z0-9_-]{43}$/).nullable() });
export type CodeReviewSaved = z.infer<typeof CodeReviewSaved>;
export const CodeReviewRunBody = z.object({ connection_id: Id.optional() }); // E50, P1
export type CodeReviewRunBody = z.infer<typeof CodeReviewRunBody>;

// E53 · PUT /api/orgs/:org/code-review/gate. statuses_pat: token fine-grained NUEVO, de un solo repo, con solo «Commit
// statuses: Read and write»; al guardarlo VanGUARD publica en el último commit de la rama vigilada el estado que ya
// conoce de ese commit (✗ si una revisión vio un crítico; ✓ solo si una revisión con el bloqueo lo dio por bueno; si no,
// pending «este commit no se revisó»). Sin statuses_pat: cambia enabled y min_severity.
export const MergeGatePut = z.object({ enabled: z.boolean(), min_severity: MergeGateMin, statuses_pat: Token.optional(),
  close_pr: z.boolean().optional() }); // anexo de cierre de PR
export type MergeGatePut = z.infer<typeof MergeGatePut>;
// probe_sha / probe_state: commit y estado de la prueba (solo al guardar un token; si no, null los dos).
export const MergeGateSaved = z.object({ gate: MergeGateConfig, checks: z.array(PermCheck), probe_sha: Sha40.nullable(),
  probe_state: CommitStatusState.nullable() });
export type MergeGateSaved = z.infer<typeof MergeGateSaved>;
// E54 · POST /api/orgs/:org/code-review/reviews/:id/gate → RespuestaEscritura. override: «Dar por bueno» (success
// «Aprobado a mano en VanGUARD») · revert: «Deshacer» (vuelve el estado de la regla) · republish (P1): publica de nuevo.
export const MergeGateAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('republish') }),
  z.object({ op: z.literal('override'), reason: z.string().trim().min(3).max(200) }),
  z.object({ op: z.literal('revert') }),
  z.object({ op: z.literal('reopen_pr') }), // anexo de cierre de PR: «Reabrir el PR» (state: open; el ✗ se queda)
]);
export type MergeGateAction = z.infer<typeof MergeGateAction>;

// ── Evolución entre revisiones (E51–E52; asignaciones/evolucion-entre-revisiones.md) ───────────────────────────────
// Hallazgos por severidad (zod 4: las 5 claves) y por módulo × severidad (las 4 × 5 claves).
export const PorSeveridad = z.record(Severity, z.number().int().min(0));
export type PorSeveridad = z.infer<typeof PorSeveridad>;
export const MatrizHallazgos = z.record(Module, PorSeveridad);
export type MatrizHallazgos = z.infer<typeof MatrizHallazgos>;
// Un hallazgo de una lista del delta con su estado de AHORA (los conteos son los de la foto): un corregido que volvió a
// salir trae status 'open'; un nuevo que ya se arregló, 'fixed' o 'verified'.
export const DeltaItem = z.object({ finding_id: Id, module: Module, rule_id: RuleId, severity: Severity,
  title: z.string().max(200), resource: z.string().max(300), status: FindingStatus });
export type DeltaItem = z.infer<typeof DeltaItem>;
// total = cuántos hay; items = los 50 primeros en el orden de E13 (un hallazgo ya borrado cuenta en total y no sale).
export const DeltaLista = z.object({ total: z.number().int().min(0), items: z.array(DeltaItem).max(50) });
export type DeltaLista = z.infer<typeof DeltaLista>;
// La auditoría con la que se compara. null si es la primera foto o si la anterior ya se borró (retención de 90 días).
// finished_at null si la anterior aún no había cerrado (la foto se toma en el paso puntaje, antes de resumen_ia).
export const DeltaAnterior = z.object({ scan_run_id: Id, kind: ScanKind, finished_at: Ts.nullable(),
  score: z.number().int().min(0).max(100).nullable() });
export type DeltaAnterior = z.infer<typeof DeltaAnterior>;
// E51 · GET /api/orgs/:org/scans/:id/delta · user. available:false → 'en_curso' (aún sin foto) o 'sin_foto' (auditoría
// anterior a 0015, o que no pudo revisar ningún módulo). first:true → primera foto de la org: no hay con qué comparar;
// solo cuenta open y lo demás va en 0 y vacío. moved = claves (regla + huella) que solo cambiaron de línea: cuentan en
// kept, nunca en new ni en fixed. gone = abiertos en la anterior cuya fila ya no existe (retención de 0008): no cuentan
// como corregidos ni como ignorados. En total: open = open anterior + new − fixed − ignored − gone.
export const AuditDelta = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), scan_run_id: Id, reason: z.enum(['en_curso', 'sin_foto']) }),
  z.object({ available: z.literal(true), scan_run_id: Id, taken_at: Ts, first: z.boolean(),
    score: z.number().int().min(0).max(100).nullable(),
    modules_seen: z.array(Module).max(4),    // módulos cuyo paso terminó bien en ESTA auditoría
    previous: DeltaAnterior.nullable(),
    counts: z.object({ open: MatrizHallazgos, new: MatrizHallazgos, kept: MatrizHallazgos, fixed: MatrizHallazgos,
      ignored: MatrizHallazgos }),
    fixed_checked: z.number().int().min(0),  // corregidos que una auditoría comprobó (verified), sin contar claves
    moved: z.number().int().min(0), gone: z.number().int().min(0),
    new: DeltaLista, kept: DeltaLista, fixed: DeltaLista, ignored: DeltaLista }),
]);
export type AuditDelta = z.infer<typeof AuditDelta>;
// Una versión = una auditoría con foto (sea cual sea su status) o una terminada con puntaje anterior a 0015
// (snapshot:false: open, new y fixed van null y el punto solo entra en la gráfica del puntaje). at = cuándo se tomó la
// foto (sin foto, cuándo terminó): es el orden de la cadena. score sale de scan_runs.
export const EvolutionPoint = z.object({ scan_run_id: Id, kind: ScanKind, at: Ts,
  score: z.number().int().min(0).max(100).nullable(), modules_seen: z.array(Module).max(4),
  snapshot: z.boolean(), first: z.boolean(),
  open: MatrizHallazgos.nullable(), new: MatrizHallazgos.nullable(), fixed: MatrizHallazgos.nullable(),
  ignored: z.number().int().min(0), gone: z.number().int().min(0), fixed_checked: z.number().int().min(0) });
export type EvolutionPoint = z.infer<typeof EvolutionPoint>;
// Revisión de código terminada (push a la rama vigilada o pull request): new = sus hallazgos NUEVOS por severidad;
// delta = la foto de Codebase del push (null en un PR, en un push anterior a 0015 o si la foto falló).
export const EvolutionReview = z.object({ review_id: Id, event: z.enum(['push', 'pull_request']),
  pr_number: z.number().int().positive().nullable(), at: Ts, head_sha7: z.string().regex(/^[0-9a-f]{7}$/),
  new: PorSeveridad, partial: z.boolean(), delta: CodeReviewDelta.nullable() });
export type EvolutionReview = z.infer<typeof EvolutionReview>;
// Incidentes (ataques) por día de Caracas en que empezaron y por severidad. Solo los días con alguno.
export const EvolutionIncidentDay = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), counts: PorSeveridad });
export type EvolutionIncidentDay = z.infer<typeof EvolutionIncidentDay>;
// Totales de TODO el periodo, calculados en la base aunque points venga recortado: versions = versiones del periodo;
// snapshots = de ellas, las que tienen foto; score_first = puntaje de la más vieja; new, fixed, fixed_checked, ignored y
// gone = sumas de las fotos del periodo con first:false.
export const EvolutionTotals = z.object({ versions: z.number().int().min(0), snapshots: z.number().int().min(0),
  score_first: z.number().int().min(0).max(100).nullable(), new: MatrizHallazgos, fixed: MatrizHallazgos,
  fixed_checked: z.number().int().min(0), ignored: z.number().int().min(0), gone: z.number().int().min(0) });
export type EvolutionTotals = z.infer<typeof EvolutionTotals>;
// E52 · GET /api/orgs/:org/evolution?days=30&limit=30 · user. points y reviews de la más vieja a la más nueva (las
// `limit` versiones y las 50 revisiones más recientes del periodo); truncated: el periodo tiene más versiones que
// `limit` (la UI usa totals y dice «últimas N auditorías» en las gráficas). mttr: hallazgos que una auditoría dio por
// corregidos (verified) en el periodo, horas de first_seen_at a verified_at; no cuentan los marcados a mano (sin hora)
// ni las claves (que ya no estén en el código no prueba que se rotaron).
export const Evolution = z.object({ days: z.number().int().min(1).max(90),
  points: z.array(EvolutionPoint).max(60), truncated: z.boolean(), totals: EvolutionTotals,
  reviews: z.array(EvolutionReview).max(50), incidents: z.array(EvolutionIncidentDay).max(91),
  mttr: z.object({ verified: z.number().int().min(0), hours_avg: z.number().min(0).nullable(),
    hours_median: z.number().min(0).nullable() }) });
export type Evolution = z.infer<typeof Evolution>;

// ── Modo bajo ataque (E55–E56; asignaciones/modo-bajo-ataque.md) ───────────────────────────────────────────────────
// host: una Configuration Rule (set_config, security_level under_attack) solo para el host del incidente, con la
// caducidad dentro de la expresión. zone: el ajuste security_level de toda la zona (P1; nunca en la zona del producto).
// Confirmar y deshacer: E21 y E22 de siempre.
export const UnderAttackScope = z.enum(['host', 'zone']);
export type UnderAttackScope = z.infer<typeof UnderAttackScope>;
// Por qué no se puede activar ahora (null = se puede). no_aplica: el incidente no es de inundación (CF_IP_FLOOD) ·
// una_ip: solo una IP inunda ese host (basta Bloquear IP) · cerrado: incidente resuelto · sin_host: el nombre de la
// conexión de ingesta no es un host · host_protegido: es un host de VanGUARD · fuera_de_zona: el host no es de la zona
// de la conexión · sin_conexion: falta el Modo blindaje · sin_permiso: la sonda vio un 403 de Config Rules · Edit ·
// en_curso: otra activación de ese host se está aplicando.
export const UnderAttackMotivo = z.enum(['no_aplica', 'una_ip', 'cerrado', 'sin_host', 'host_protegido', 'fuera_de_zona',
  'sin_conexion', 'sin_permiso', 'en_curso']);
export type UnderAttackMotivo = z.infer<typeof UnderAttackMotivo>;
const HostOZona = z.string().min(3).max(120); // actions.target admite ≤ 120 (0005)
// retirada_fallida: housekeeping no pudo borrar la regla (fila failed con previous.deshacer_error). Con la caducidad en
// la expresión ya no actúa desde expires_at, pero sigue ocupando una regla del plan: la UI pide borrarla a mano.
export const UnderAttackActivo = z.object({ action_id: Id, scope: UnderAttackScope, target: HostOZona, created_at: Ts,
  expires_at: Ts.nullable(), retirada_fallida: z.boolean() });
export type UnderAttackActivo = z.infer<typeof UnderAttackActivo>;
// E55 (solo lee la base). ofrece: lo decide la regla (≥ 2 incidentes CF_IP_FLOOD no resueltos con el mismo host en la
// org, es decir, varias IPs inundan ese host). ips: cuántos hay, este incluido. permiso: lo que vio la última sonda del
// token de acciones (falta: un 403 del dry_run; sin_probar: sin sonda de este permiso, lo valida E56).
// copiar: pasos para hacerlo a mano en el panel de Cloudflare (sin_conexion, sin_permiso o retirada_fallida), sin secretos.
export const UnderAttackOffer = z.object({ ofrece: z.boolean(), motivo: UnderAttackMotivo.nullable(),
  hostname: HostOZona.nullable(), zone_name: z.string().max(253).nullable(), connection_id: Id.nullable(),
  ips: z.number().int().min(0).max(1000), scopes: z.array(UnderAttackScope).max(2),
  permiso: z.enum(['ok', 'falta', 'sin_probar']).nullable(), ttl_s: z.number().int().min(300).max(3600),
  activo: UnderAttackActivo.nullable(), copiar: z.string().max(1500).nullable() });
export type UnderAttackOffer = z.infer<typeof UnderAttackOffer>;
// E56. El host sale del incidente (details.host, que es el nombre de la conexión de ingesta), nunca del cuerpo.
export const UnderAttackPropose = z.object({ scope: UnderAttackScope.default('host'), connection_id: Id.optional() });
export type UnderAttackPropose = z.infer<typeof UnderAttackPropose>;
// validado: Cloudflare respondió 2xx con result null a la regla enviada con dry_run=true (permiso, cupo y expresión) y
// no publicó nada; false: no se pudo comprobar (red, o alcance zone, que no tiene dry_run) y se comprueba al confirmar.
export const UnderAttackProposal = ProposeResponse.extend({ scope: UnderAttackScope, target: HostOZona,
  zone_name: z.string().max(253), ttl_s: z.number().int().min(300).max(3600), validado: z.boolean() });
export type UnderAttackProposal = z.infer<typeof UnderAttackProposal>;

// ── Simular ataque y llamada de voz (E57; asignaciones/llamada-ataque.md) ───────────────────────────────────────────
// E57 POST /api/orgs/:org/incidents/simulate · solo admin/owner y solo en la org de demo (403 si no). Crea un incidente
// crítico REAL por el motor de siempre (vg_upsert_incident) con details.simulated = true y una IP de TEST-NET
// (203.0.113.0/24), y lo avisa con el despachador de siempre: WhatsApp con botones y, si hay contacto verificado con
// voz, la llamada de Guardia. 429 si ya hubo una simulación en los últimos 2 min.
export const SimulateAttackKind = z.enum(['path_scan', 'ip_flood', 'attack_tool']);
export type SimulateAttackKind = z.infer<typeof SimulateAttackKind>;
// Por defecto ip_flood: con las reglas reales es la única que sale critical, y solo un critical ofrece «Llamar a Guardia».
export const SimulateAttackIn = z.object({ kind: SimulateAttackKind.default('ip_flood') });
export type SimulateAttackIn = z.infer<typeof SimulateAttackIn>;
// whatsapp/voice: lo que hizo el despachador con cada canal (queued = la fila notifications quedó en cola o enviada;
// skipped = no aplica o sin contacto; failed = el envío falló al primer intento; el estado final se ve en E8).
export const SimulateAttackChannel = z.enum(['queued', 'skipped', 'failed']);
export const SimulateAttackOut = z.object({ incident_id: Id, code: z.string().regex(/^[A-Z0-9]{6}$/),
  whatsapp: SimulateAttackChannel, voice: SimulateAttackChannel });
export type SimulateAttackOut = z.infer<typeof SimulateAttackOut>;
