// Resumen de la org (E5). Se arma desde los mismos hallazgos e incidentes para que los conteos cuadren siempre:
// counts = hallazgos `open` por severidad, open_incidents = incidentes `open` + `ack`, «Ahora» = incidentes abiertos y
// luego hallazgos por severidad, confirmed y last_seen_at (máx. 10).
import type { AhoraItem, Overview } from '../api.ts';
import type { IncidentStatus, Severity } from '../comun.ts';
import { scanDone } from './auditoria.ts';
import { findings } from './hallazgos.ts';
import { incidenteAtaque, incidents } from './incidentes.ts';

const SEVERIDADES = ['critical', 'high', 'medium', 'low', 'info'] as const satisfies readonly Severity[];
const ESTADOS_ABIERTOS: IncidentStatus[] = ['open', 'ack'];
const abiertos = findings.filter((f) => f.status === 'open');
const counts = Object.fromEntries(SEVERIDADES.map((s) => [s, abiertos.filter((f) => f.severity === s).length])) as Record<Severity, number>;

const ahoraHallazgos: AhoraItem[] = abiertos.slice(0, 9).map((f) => ({
  kind: 'finding', id: f.id, module: f.module, rule_id: f.rule_id, severity: f.severity, title: f.title, resource: f.resource,
}));

export const overview = {
  score: 20, band: 'red',
  coverage: { seen: 4, total: 4, missing: [] },
  counts, // { critical: 6, high: 2, medium: 2, low: 1, info: 1 }
  open_incidents: incidents.filter((i) => ESTADOS_ABIERTOS.includes(i.status)).length, // 1
  last_scan: { id: scanDone.id, status: 'succeeded', finished_at: scanDone.finished_at },
  ai: { enabled: true, level: 'normal' },
  ahora: [
    { kind: 'incident', id: incidenteAtaque.id, module: 'cloudflare', rule_id: 'CF_ADMIN_EXPOSED', severity: 'critical',
      title: incidenteAtaque.title, resource: incidenteAtaque.resource },
    ...ahoraHallazgos,
  ],
} satisfies Overview;

// Org recién creada, sin conexiones ni auditorías (escenario «vacio» del enrutador falso, S14 §14.19).
export const overviewVacio = {
  score: null, band: null,
  coverage: { seen: 0, total: 4, missing: ['supabase', 'cloudflare', 'codebase', 'performance'] },
  counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  open_incidents: 0, last_scan: null, ai: { enabled: true, level: 'normal' }, ahora: [],
} satisfies Overview;
