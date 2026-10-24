// Revisión de código (E45, E46, E48). La historia: el repo de la víctima ya tiene el webhook (ping 18:20Z); a las
// 19:20Z el push de demo/empujar-revision.mjs sube una clave live de Stripe FALSA a src/lib/pagos.ts y el WhatsApp sale
// y se lee. El push anterior fue limpio. hallazgoRevision es el hallazgo que crea esa revisión: va aparte de `findings`
// (hallazgos.ts) para no mover el Resumen, el export ni la wiki; el router de fixtures del FRONT lo añade a la lista de
// la org para que ?finding= lo abra. webhook_secret va null: un valor con forma de secreto en un fixture lo pararía el
// cable trampa; el router lo genera al vuelo.
import type { AlertPrefs, CodeReviewConfig, CodeReviewSaved, CodeReviewState, Finding } from '../api.ts';
import { CONN_GITHUB, CR_CONFIG, CR_REV_LIMPIA, CR_REV_SECRETO, F_CB_STRIPE_PUSH, REPO, T_CR_PING, T_CR_PUSH } from './ids.ts';

const HEAD = '9f1c2e7a4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a';
const PREVIO = '3b18e1a9c0d24f6e8a7b5c4d3e2f1a0b9c8d7e6f';

export const hallazgoRevision = {
  id: F_CB_STRIPE_PUSH, module: 'codebase', rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical', confirmed: true,
  origin: 'rule', title: 'Clave live de Stripe en el código', resource: 'src/lib/pagos.ts:3',
  evidence: { fuente: 'github', sha: HEAD.slice(0, 7), path: 'src/lib/pagos.ts', line: 3, preview: 'sk_l…7Qx2',
    fingerprint_short: 'c41d9e07', ubicaciones: [{ path: 'src/lib/pagos.ts', line: 3, origen: 'head' }] },
  has_fix_prompt: false, fix_model: null, status: 'open', status_reason: null, suspected_injection: false,
  scan_run_id: null, connection_id: null, first_seen_at: T_CR_PUSH, last_seen_at: T_CR_PUSH, verified_at: null,
} satisfies Finding;

const config = {
  id: CR_CONFIG, connection_id: CONN_GITHUB, repo_full_name: REPO, branch: 'main', enabled: true, state: 'connected',
  webhook_url: `https://officialvanguard.com/webhooks/github/${CR_CONFIG}`, secret_last4: 'Q7xk',
  hook_events: ['pull_request', 'push'], last_ping_at: T_CR_PING, last_event_at: T_CR_PUSH, last_error: null,
} satisfies CodeReviewConfig;

export const codeReviewState = {
  available: true, reason: null, config,
  recent: [
    { id: CR_REV_SECRETO, event: 'push', branch: 'main', pr_number: null, base_sha: PREVIO, head_sha: HEAD,
      status: 'done', error_code: null, partial: false, files_changed: 1, lines_added: 12,
      counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, max_severity: 'critical',
      findings: [{ finding_id: F_CB_STRIPE_PUSH, rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical',
        title: 'Clave live de Stripe en el código', resource: 'src/lib/pagos.ts:3' }],
      alert: { state: 'sent', reason: null, delivery: 'read', delivery_error: null, voice_pending: true,
        notified_at: '2026-10-24T19:20:17.400Z', seconds: 6.4 },
      created_at: T_CR_PUSH, finished_at: '2026-10-24T19:20:14.900Z' },
    { id: CR_REV_LIMPIA, event: 'push', branch: 'main', pr_number: null,
      base_sha: '7c0d2e4f6a8b1c3d5e7f9a0b2c4d6e8f1a3b5c7d', head_sha: PREVIO,
      status: 'done', error_code: null, partial: false, files_changed: 1, lines_added: 3,
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, max_severity: null, findings: [],
      alert: { state: 'none', reason: null, delivery: null, delivery_error: null, voice_pending: false, notified_at: null,
        seconds: null },
      created_at: '2026-10-24T18:31:40.000Z', finished_at: '2026-10-24T18:31:42.100Z' },
  ],
} satisfies CodeReviewState;

export const codeReviewSaved = {
  config: { ...config, state: 'waiting_ping', hook_events: [], last_ping_at: null, last_event_at: null },
  webhook_secret: null,
} satisfies CodeReviewSaved;

// whatsapp_ready_contacts = 1: en ajustes.ts Ana está verificada y Luis no.
export const alertPrefs = { review_whatsapp_min: 'high', review_voice_min: 'critical', voice_available: false,
  whatsapp_ready_contacts: 1, updated_at: null } satisfies AlertPrefs;
