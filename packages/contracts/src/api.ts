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
export const ConnectionCreate = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('supabase'), project_ref: z.string().trim().max(120), pat: Token, // ref o URL; el BACK normaliza
    publishable_key: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{10,}$/).optional() }), // P1, sondeo activo de RLS (§07.6)
  z.object({ provider: z.literal('cloudflare'), zone_id: z.string().trim().regex(/^[a-f0-9]{32}$/), read_token: Token,
    action_token: Token.optional() }),
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
export const Coverage = z.object({ seen: z.number().int().min(0).max(4), total: z.number().int(), missing: z.array(Module) });
export type Coverage = z.infer<typeof Coverage>;
export const AuditSummary = z.object({ resumen: z.string().max(2000),
  top: z.array(z.object({ finding_id: Id, por_que: z.string().max(500) })).max(5),
  relaciones: z.array(z.object({ finding_ids: z.array(Id).min(2), explicacion: z.string().max(500) })).max(5),
  suspected_injection: z.boolean().optional(), // el filtro marcó la salida de IA-2
  model: z.string() });
export type AuditSummary = z.infer<typeof AuditSummary>;
export const ScanRun = z.object({ id: Id, kind: ScanKind, status: ScanStatus, progress: z.number().int().min(0).max(100),
  step: z.string().nullable(), steps: z.array(ScanStep), score: z.number().int().min(0).max(100).nullable(),
  coverage: Coverage.nullable(), summary: AuditSummary.nullable(), error: z.string().nullable(), created_at: Ts,
  started_at: Ts.nullable(), finished_at: Ts.nullable(),
  band: z.enum(['red', 'amber', 'green']).nullable().optional() }); // opcional: color del puntaje en corridas viejas (§14.14)
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
  title: z.string(), resource: z.string() });
export type AhoraItem = z.infer<typeof AhoraItem>;
export const Overview = z.object({ score: z.number().int().min(0).max(100).nullable(), band: z.enum(['red', 'amber', 'green']).nullable(),
  coverage: Coverage,
  counts: z.record(Severity, z.number().int()), // zod 4: un record con enum exige las 5 claves (aunque valgan 0)
  open_incidents: z.number().int(),
  last_scan: z.object({ id: Id, status: ScanStatus, finished_at: Ts.nullable() }).nullable(),
  ai: z.object({ enabled: z.boolean(), level: AiUsage.shape.level }).optional(), ahora: z.array(AhoraItem).max(10) });
export type Overview = z.infer<typeof Overview>;
