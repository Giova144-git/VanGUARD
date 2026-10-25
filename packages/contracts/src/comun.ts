// Enums y tipos base compartidos por todo el contrato (S15 §15.5).
import { z } from 'zod';

export const Id = z.uuid();
export type Id = z.infer<typeof Id>;
export const Ts = z.string(); // ISO 8601 UTC; Postgres lo da con +00:00, por eso no es z.iso.datetime()
export type Ts = z.infer<typeof Ts>;

export const Severity = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof Severity>;
export const Module = z.enum(['supabase', 'cloudflare', 'codebase', 'performance']);
export type Module = z.infer<typeof Module>;
export const Role = z.enum(['owner', 'admin', 'viewer']);
export type Role = z.infer<typeof Role>;
export const Provider = z.enum(['supabase', 'cloudflare', 'github', 'ingest']);
export type Provider = z.infer<typeof Provider>;
export const ConnectionKind = z.enum(['read', 'action']);
export type ConnectionKind = z.infer<typeof ConnectionKind>;
export const ConnectionStatus = z.enum(['active', 'error', 'revoked', 'expired']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;
export const ScanKind = z.enum(['full_audit', 'supabase', 'cloudflare', 'repo', 'zip', 'lighthouse']);
export type ScanKind = z.infer<typeof ScanKind>;
export const ScanStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type ScanStatus = z.infer<typeof ScanStatus>;
export const FindingStatus = z.enum(['open', 'fixed', 'verified', 'ignored']);
export type FindingStatus = z.infer<typeof FindingStatus>;
export const IncidentStatus = z.enum(['open', 'ack', 'mitigated', 'resolved']);
export type IncidentStatus = z.infer<typeof IncidentStatus>;
export const Channel = z.enum(['in_app', 'whatsapp', 'voice']);
export type Channel = z.infer<typeof Channel>;
// skipped: no salió porque la org es una sandbox de «Ver demo» (0026); la fila lleva en preview el texto que habría llegado.
export const NotificationStatus = z.enum(['queued', 'sent', 'delivered', 'read', 'failed', 'skipped_cap', 'skipped']);
export type NotificationStatus = z.infer<typeof NotificationStatus>;
// Igual al check de §05; P0 solo implementa block_ip/unblock_ip (los demás → 422).
export const ActionKind = z.enum(['block_ip', 'unblock_ip', 'under_attack_on', 'under_attack_off', 'rate_limit']);
export type ActionKind = z.infer<typeof ActionKind>;
export const ActionStatus = z.enum(['proposed', 'executed', 'undone', 'failed']);
export type ActionStatus = z.infer<typeof ActionStatus>;
export const RuleId = z.string().regex(/^(SB|CF|CB|PF)_[A-Z0-9_]+$/);
export type RuleId = z.infer<typeof RuleId>;

export const ErrorCode = z.enum(['unauthorized', 'forbidden', 'not_found', 'conflict', 'invalid_body', 'key_rejected',
  'provider_rejected', 'rate_limited', 'budget_exceeded', 'ai_disabled', 'provider_unavailable', 'internal']);
export type ErrorCode = z.infer<typeof ErrorCode>;
// Choca de nombre con las clases ApiError del BACK y del FRONT: se importa como
// `import { ApiError as ApiErrorBody } from '@vanguard/contracts'`.
export const ApiError = z.object({ error: z.object({ code: ErrorCode, message: z.string().max(300), request_id: z.string(),
  details: z.record(z.string(), z.unknown()).optional() }) });
export type ApiError = z.infer<typeof ApiError>;
