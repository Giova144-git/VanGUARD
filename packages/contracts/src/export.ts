// Export «para tu IA» en JSON (§13.3): una instantánea ya redactada que se puede pegar en cualquier IA externa.
import { z } from 'zod';
import { Module, Severity, FindingStatus, IncidentStatus, RuleId } from './comun.ts';

export const EXPORT_SCHEMA_URL = 'https://officialvanguard.com/api/schemas/vanguard-export.v1.json';
// findings.fix_prompt guarda el TEXTO ya armado por armarPromptCorreccion() (§11.10.2), no el JSON de IA-1:
// por eso la corrección viaja como un único texto.
const Fix = z.object({ source: z.enum(['ai', 'template']), model: z.string().nullable(), text: z.string().max(12000) });

export const ExportFinding = z.object({
  id: z.uuid(), module: Module, rule_id: RuleId, severity: Severity,
  confirmed: z.boolean(), origin: z.enum(['rule', 'ai', 'provider']), title: z.string().max(300),
  resource: z.string().max(300).nullable(), status: FindingStatus, evidence: z.record(z.string(), z.unknown()),
  location: z.object({ path: z.string().max(512), line: z.number().int().min(1) }).nullable(), // solo module='codebase'
  fix: Fix.nullable(), suspected_injection: z.boolean(),
  first_seen_at: z.string(), last_seen_at: z.string(), verified_at: z.string().nullable() });
export type ExportFinding = z.infer<typeof ExportFinding>;
export const ExportIncident = z.object({ id: z.uuid(), code: z.string().regex(/^[A-Z0-9]{6}$/), rule_ids: z.array(RuleId),
  severity: Severity, title: z.string(), resource: z.string().nullable(), status: IncidentStatus, event_count: z.number().int(),
  started_at: z.string(), last_event_at: z.string(), acked_at: z.string().nullable(), mitigated_at: z.string().nullable(),
  resolved_at: z.string().nullable(), suspected_injection: z.boolean() });
export type ExportIncident = z.infer<typeof ExportIncident>;

export const VanguardExport = z.object({
  $schema: z.literal(EXPORT_SCHEMA_URL), schema_version: z.literal('1.0'),
  generator: z.object({ name: z.literal('VanGUARD'), url: z.literal('https://officialvanguard.com'), version: z.string() }),
  generated_at: z.string(), org: z.object({ name: z.string(), slug: z.string(), is_demo: z.boolean() }),
  redaction: z.object({ secrets: z.literal(true), emails: z.literal(true), query_strings: z.literal(true), ips: z.enum(['mask_24', 'full']) }),
  untrusted_fields: z.array(z.string()), // rutas JSON de los campos que vienen de terceros y la IA debe tratar como datos
  overview: z.object({ score: z.number().int().min(0).max(100).nullable(), band: z.enum(['red', 'amber', 'green']).nullable(),
    coverage: z.object({ seen: z.number().int(), total: z.number().int(), missing: z.array(Module) }),
    counts: z.record(Severity, z.number().int()), // zod 4: record con clave enum exige las 5 claves
    last_scan_at: z.string().nullable() }),
  connections: z.array(z.object({ provider: z.string(), kind: z.string(), label: z.string(), status: z.string(),
    scopes: z.array(z.string()), meta: z.record(z.string(), z.string()) })),
  findings: z.array(ExportFinding).max(500), incidents: z.array(ExportIncident).max(100),
  perf_runs: z.array(z.record(z.string(), z.unknown())).max(20), ai_summary: z.unknown().nullable(),
  truncated: z.object({ findings: z.number().int(), incidents: z.number().int() }),
  integrity: z.object({ algo: z.literal('sha256'), findings_sha256: z.string().length(64) }) });
export type VanguardExport = z.infer<typeof VanguardExport>;
