// Identificadores y fechas compartidos por todos los fixtures (S14 §14.19). UUID v4 válidos para z.uuid() de zod 4
// (dígito de versión 4 y variante 8/9/a/b), deterministas y en minúsculas. Fechas ISO 8601 UTC del sábado de la demo.

// ── Org y usuarios ─────────────────────────────────────────────────────────────
export const ORG_DEMO = '00000000-0000-4000-a000-00000000de00'; // id fijo de la org de demo (S05 §05.11)
export const USER_ADMIN = '7b1e0000-0000-4000-8000-0000000000a1';
export const USER_ANON = '7b1e0000-0000-4000-8000-0000000000a2';

// ── Conexiones ─────────────────────────────────────────────────────────────────
export const CONN_SUPABASE = 'c0000000-0000-4000-8000-000000000001';
export const CONN_CF_READ = 'c0000000-0000-4000-8000-000000000002';
export const CONN_CF_ACTION = 'c0000000-0000-4000-8000-000000000003';
export const CONN_GITHUB = 'c0000000-0000-4000-8000-000000000004';
export const CONN_INGEST = 'c0000000-0000-4000-8000-000000000005';

// ── Auditoría ──────────────────────────────────────────────────────────────────
export const SCAN_AUDITORIA = '5a1c0000-0000-4000-8000-000000000001';

// ── Hallazgos ──────────────────────────────────────────────────────────────────
export const F_SB_RLS = 'f0000000-0000-4000-8000-000000000001';
export const F_SB_RPC = 'f0000000-0000-4000-8000-000000000002';
export const F_SB_POLICY = 'f0000000-0000-4000-8000-000000000003';
export const F_SB_ADV_EVENTOS = 'f0000000-0000-4000-8000-000000000004';
export const F_SB_ADV_CODIGOS = 'f0000000-0000-4000-8000-000000000005';
export const F_SB_ADV_DUP = 'f0000000-0000-4000-8000-000000000006';
export const F_CB_ENV = 'f0000000-0000-4000-8000-000000000007';
export const F_CB_SERVICE_ROLE = 'f0000000-0000-4000-8000-000000000008';
export const F_CB_POSTGRES = 'f0000000-0000-4000-8000-000000000009';
export const F_CB_DEP_IGNITION = 'f0000000-0000-4000-8000-00000000000a';
export const F_CB_DEP_LODASH = 'f0000000-0000-4000-8000-00000000000b';
export const F_CB_DEP_JQUERY = 'f0000000-0000-4000-8000-00000000000c';
export const F_CB_GITIGNORE = 'f0000000-0000-4000-8000-00000000000d';

// ── Incidentes, avisos, aprobaciones y acciones ───────────────────────────────
export const INC_ATAQUE = '9e0b0000-0000-4000-8000-000000000001';
export const INC_ENSAYO = '9e0b0000-0000-4000-8000-000000000002';
export const NOTIF_WA_1 = 'a0000000-0000-4000-8000-000000000001';
export const NOTIF_WA_2 = 'a0000000-0000-4000-8000-000000000002';
export const NOTIF_WA_UP_1 = 'a0000000-0000-4000-8000-000000000003';
export const NOTIF_WA_UP_2 = 'a0000000-0000-4000-8000-000000000004';
export const NOTIF_VOZ = 'a0000000-0000-4000-8000-000000000005';
export const APPROVAL_BLOQUEO = 'ab000000-0000-4000-8000-000000000001';
export const APPROVAL_BAJO_ATAQUE = 'ab000000-0000-4000-8000-000000000002';
export const ACTION_BAJO_ATAQUE = 'ac000000-0000-4000-8000-000000000001';

// ── Ajustes, rendimiento y MCP ─────────────────────────────────────────────────
export const CONTACT_1 = 'cc000000-0000-4000-8000-000000000001';
export const CONTACT_2 = 'cc000000-0000-4000-8000-000000000002';
export const MCP_TOKEN_1 = 'd0000000-0000-4000-8000-000000000001';
export const MCP_TOKEN_2 = 'd0000000-0000-4000-8000-000000000002';
export const PERF_RUN_BASE = 'b0000000-0000-4000-8000-0000000000'; // + 2 hex por corrida (ver rendimiento.ts)
export const PERF_GROUP_BASE = 'b1000000-0000-4000-8000-00000000000'; // + 1 hex por tanda y estrategia (ver rendimiento.ts)

// ── Textos compartidos ─────────────────────────────────────────────────────────
export const ORG_NOMBRE = 'Tienda Demo';
export const ZONA = 'officialvanguard.com';
export const HOST_VICTIMA = 'demo.officialvanguard.com';
export const PROJECT_REF = 'tiendademovictimavgx'; // ref ficticio de 20 letras del proyecto vanguard-demo
export const REPO = 'equipo22-demo/vanguard-demo-victima';
export const IP_ATACANTE = '203.0.113.7'; // rango de documentación: solo válido en fixtures (la API real lo rechaza, E20)
export const IP_ENSAYO = '198.51.100.23';
export const MODELO_FIX = 'claude-sonnet-5-5'; // IA-1 (S11 §11.1)
export const MODELO_RESUMEN = 'claude-opus-5-5'; // IA-2 (S11 §11.1)

// ── Fechas (sábado 2026-10-24, UTC) ───────────────────────────────────────────
// El FRONT pinta las horas en America/Caracas (UTC−4 fijo, S14 §14.6): todo texto con hora (`sub`) usa horaCaracas().
export const horaCaracas = (iso: string) => new Date(Date.parse(iso) - 4 * 3_600_000).toISOString().slice(11, 16);
export const T_PERF_V1 = '2026-10-24T18:00:00.000Z'; // tanda de Lighthouse de v1-sana (antes de la auditoría: Rendimiento cuenta como visto)
export const T_CONEXIONES_PROBADAS = '2026-10-24T18:00:41.000Z';
export const T_SCAN_CREADO = '2026-10-24T18:01:30.000Z';
export const T_SCAN_INICIO = '2026-10-24T18:01:32.000Z';
export const T_PASO_SUPABASE = '2026-10-24T18:02:05.000Z';
export const T_PASO_REPO = '2026-10-24T18:02:48.000Z';
export const T_SCAN_FIN = '2026-10-24T18:04:11.000Z';
export const T_FIX_PROMPT = '2026-10-24T18:06:12.000Z'; // prompts de IA-1 guardados en findings.fix_prompt (S11 §11.4)
export const T_FIX_PROMPT_ENV = '2026-10-24T18:06:40.000Z';
export const T_FIX_PROMPT_SERVICE_ROLE = '2026-10-24T18:07:05.000Z';
export const T_FIX_PROMPT_LODASH = '2026-10-24T18:07:31.000Z';
export const T_IGNORADO = '2026-10-24T18:12:30.000Z';
export const T_PERF_V2 = '2026-10-24T18:40:00.000Z'; // tanda de v2-regresion, ya desplegada (la víctima se queda en v2, S10 §10.11)
export const T_ATAQUE = '2026-10-24T19:01:00.000Z'; // attack_start = incidents.started_at
export const T_ULTIMO_EVENTO = '2026-10-24T19:01:59.000Z'; // ≤ 20 req/s: la cubeta de las 19:01:50 llena sus 10 s
export const T_PROPUESTA = '2026-10-24T19:02:05.000Z';
export const T_ESTADO = '2026-10-24T19:02:00.000Z'; // hora de los EstadoModulo
export const T_EXPORT = '2026-10-24T19:05:00.000Z';
export const EXPIRA_TOKENS = '2026-11-23T18:00:00.000Z'; // PAT y tokens con caducidad de 30 días

// ── Revisión de código ───────────────────────────────────────────────────────
export const CR_CONFIG = 'c4000000-0000-4000-8000-000000000001';
export const CR_REV_SECRETO = 'c4000000-0000-4000-8000-000000000011';
export const CR_REV_LIMPIA = 'c4000000-0000-4000-8000-000000000012';
export const F_CB_STRIPE_PUSH = 'f0000000-0000-4000-8000-00000000000e'; // lo crea la revisión; no está en `findings`
export const T_CR_PING = '2026-10-24T18:20:03.000Z';
export const T_CR_PUSH = '2026-10-24T19:20:11.000Z';

// ── Varias codebases (asignaciones/varias-codebases.md) ─────────────────────────────────────────────────────────
// Segundo repo de la org: pequeño, público y limpio (no mueve el puntaje ni el orden de «Ahora»). …0006 es
// CONN_GITHUB_ESTADOS (bloqueo-merge-criticos.md).
export const CONN_GITHUB_2 = 'c0000000-0000-4000-8000-000000000007';
export const REPO_2 = 'equipo22-demo/vanguard-demo-landing';
export const T_CONEXION_REPO_2 = '2026-10-24T18:00:52.000Z';

// ── Bloqueo de merge con críticos (asignaciones/bloqueo-merge-criticos.md) ──────
export const CONN_GITHUB_ESTADOS = 'c0000000-0000-4000-8000-000000000006'; // GitHub kind 'action' (solo Commit statuses)
export const CR_REV_PR_BLOQUEADO = 'c4000000-0000-4000-8000-000000000022';
export const T_GATE_GUARDADO = '2026-10-24T19:40:05.000Z';
export const T_CR_PR = '2026-10-24T19:45:08.000Z';

// ── Evolución entre revisiones ────────────────────────────────────────────────
// Auditorías completas de martes a viernes (la del sábado es SCAN_AUDITORIA; la del martes es anterior a 0015 y solo
// tiene puntaje), el push del jueves que subió un posible secreto y los dos hallazgos que el sábado ya no están
// abiertos (uno comprobado por la auditoría y otro marcado a mano). CR_REV_JUEVES no es …022: ese id es
// CR_REV_PR_BLOQUEADO (bloqueo-merge-criticos.md).
export const SCAN_EV_MAR = '5a1c0000-0000-4000-8000-000000000005';
export const SCAN_EV_MIE = '5a1c0000-0000-4000-8000-000000000002';
export const SCAN_EV_JUE = '5a1c0000-0000-4000-8000-000000000003';
export const SCAN_EV_VIE = '5a1c0000-0000-4000-8000-000000000004';
export const CR_REV_JUEVES = 'c4000000-0000-4000-8000-000000000021';
export const F_SB_INDICE = 'f0000000-0000-4000-8000-00000000000f';
export const F_CB_GENERICO = 'f0000000-0000-4000-8000-000000000010';
// Historial de fallas (0025): dos que una auditoría verificó el viernes y que ya no salen en `findings`.
export const F_HIST_POLITICA = 'f0000000-0000-4000-8000-000000000011';
export const F_HIST_DEP = 'f0000000-0000-4000-8000-000000000012';
// Hora de cada versión = la de su foto (paso puntaje). En el fixture coincide con el cierre de la auditoría; en
// producción va unos segundos antes (resumen_ia). La del martes, sin foto, es su cierre.
export const T_EV_MAR = '2026-10-20T18:02:30.000Z';
export const T_EV_MIE = '2026-10-21T18:03:20.000Z';
export const T_EV_JUE = '2026-10-22T18:02:50.000Z';
export const T_CR_JUEVES = '2026-10-22T19:10:00.000Z';
export const T_EV_VIE = '2026-10-23T18:04:05.000Z';
// Hora de la foto de Codebase de cada push (vg_review_snapshot, al cerrar el diff).
export const T_SNAP_JUEVES = '2026-10-22T19:10:02.600Z';
export const T_SNAP_LIMPIA = '2026-10-24T18:31:42.300Z';

// ── «Enviar a mi IA» (cola fix_requests, 0023) ────────────────────────────────
export const FIX_REQ_ENVIADO = 'f1c00000-0000-4000-8000-000000000001';
export const FIX_REQ_ARREGLANDO = 'f1c00000-0000-4000-8000-000000000002';
export const FIX_REQ_CORREGIDO = 'f1c00000-0000-4000-8000-000000000003';
export const T_FIX_REQ_ENVIADO = '2026-10-24T19:30:00.000Z';
export const T_FIX_REQ_ARREGLANDO = '2026-10-24T19:31:10.000Z';
