// Evolución entre revisiones (E51, E52 y la foto de Codebase de cada push en E45). La historia: «Tienda Demo» audita
// cada día. La del martes es anterior a 0015 (solo puntaje, sin foto); la del miércoles es la primera foto. El jueves y
// el viernes corrigió cosas (puntaje 20 → 42 → 57) y el sábado una regresión (RLS apagada en pedidos, un .env subido con
// dos claves y una dependencia crítica) lo bajó a 20. El delta del sábado (auditDelta, la auditoría de auditoria.ts) sale
// de hallazgos.ts: 7 nuevos, 5 se mantienen, 2 corregidos (uno comprobado por la auditoría y otro marcado a mano) y 1
// ignorado. Los comprobados del jueves y del viernes no son claves (una clave que desaparece no cuenta como comprobada).
// Pushes: el del jueves subió el posible secreto (primera foto de push); los dos del sábado son los de revision.ts y
// deltasRevision es su foto (el router de fixtures del FRONT la pone como `delta` en cada revisión de E45).
// hallazgosCorregidos va aparte de `findings` (como hallazgoRevision) para no mover el Resumen, el export ni la wiki; el
// router de fixtures del FRONT lo añade a la lista de la org para que ?finding= los abra.
// Dato de prueba: en hallazgos.ts todos tienen first_seen_at del sábado; aquí los «se mantienen» ya estaban el viernes.
// No se toca hallazgos.ts (lo usan el export y la wiki).
import type {
  AuditDelta, CodeReviewDelta, DeltaItem, Evolution, EvolutionIncidentDay, EvolutionPoint, EvolutionReview, Finding,
  MatrizHallazgos,
} from '../api.ts';
import type { Module, Severity } from '../comun.ts';
import { scanDone } from './auditoria.ts';
import { findings } from './hallazgos.ts';
import {
  CONN_SUPABASE, CR_REV_JUEVES, CR_REV_LIMPIA, CR_REV_SECRETO, F_CB_DEP_IGNITION, F_CB_DEP_JQUERY, F_CB_DEP_LODASH,
  F_CB_ENV, F_CB_GENERICO, F_CB_GITIGNORE, F_CB_POSTGRES, F_CB_SERVICE_ROLE, F_SB_ADV_CODIGOS, F_SB_ADV_DUP,
  F_SB_ADV_EVENTOS, F_SB_INDICE, F_SB_POLICY, F_SB_RLS, F_SB_RPC, SCAN_EV_JUE, SCAN_EV_MAR, SCAN_EV_MIE, SCAN_EV_VIE,
  T_CR_JUEVES, T_EV_JUE, T_EV_MAR, T_EV_MIE, T_EV_VIE, T_SCAN_FIN, T_SNAP_JUEVES, T_SNAP_LIMPIA,
} from './ids.ts';
import { incidents } from './incidentes.ts';
import { codeReviewState } from './revision.ts';

const VISTOS: Module[] = ['supabase', 'cloudflare', 'codebase'];   // los pasos de «Auditar todo» (Rendimiento no entra)

export const hallazgosCorregidos = [
  { id: F_SB_INDICE, module: 'supabase', rule_id: 'SB_ADVISOR_UNUSED_INDEX', severity: 'low', confirmed: false,
    origin: 'provider', title: 'Índice sin usar en public.pedidos_tmp', resource: 'public.pedidos_tmp_creado_idx',
    evidence: { lint: 'unused_index', nivel: 'INFO', categorias: ['PERFORMANCE'], esquema: 'public', tabla: 'pedidos_tmp' },
    has_fix_prompt: false, fix_model: null, status: 'verified', status_reason: 'no reapareció en la auditoría',
    suspected_injection: false, scan_run_id: SCAN_EV_VIE, connection_id: CONN_SUPABASE, first_seen_at: T_EV_MIE,
    last_seen_at: T_EV_VIE, verified_at: T_SCAN_FIN },
  { id: F_CB_GENERICO, module: 'codebase', rule_id: 'CB_SECRET_GENERIC', severity: 'medium', confirmed: false,
    origin: 'rule', title: 'Posible secreto en el código', resource: 'src/config/correo.ts:7',
    evidence: { fuente: 'github', sha: 'a41c9d2', path: 'src/config/correo.ts', line: 7, preview: 'smtp…',
      fingerprint_short: '5d0e7a13', ubicaciones: [{ path: 'src/config/correo.ts', line: 7, origen: 'head' }] },
    has_fix_prompt: false, fix_model: null, status: 'fixed', status_reason: 'Rotada la clave del correo',
    suspected_injection: false, scan_run_id: null, connection_id: null, first_seen_at: T_CR_JUEVES,
    last_seen_at: T_CR_JUEVES, verified_at: null },
] satisfies Finding[];

const SEV = ['critical', 'high', 'medium', 'low', 'info'] as const satisfies readonly Severity[];
const MODULOS = ['supabase', 'cloudflare', 'codebase', 'performance'] as const satisfies readonly Module[];
type Fila5 = [number, number, number, number, number];   // critical, high, medium, low, info
const fila = (v: Fila5) => Object.fromEntries(SEV.map((s, i) => [s, v[i]!])) as Record<Severity, number>;
const matriz = (m: Partial<Record<Module, Fila5>>): MatrizHallazgos =>
  Object.fromEntries(MODULOS.map((k) => [k, fila(m[k] ?? [0, 0, 0, 0, 0])])) as MatrizHallazgos;
const contar = (xs: readonly { module: Module; severity: Severity }[]): MatrizHallazgos => {
  const m = matriz({});
  for (const x of xs) m[x.module][x.severity] += 1;
  return m;
};
const sumar = (ms: readonly MatrizHallazgos[]): MatrizHallazgos => {
  const m = matriz({});
  for (const x of ms) for (const k of MODULOS) for (const s of SEV) m[k][s] += x[k][s];
  return m;
};
const enModulo = (m: MatrizHallazgos, k: Module) => SEV.reduce((a, s) => a + m[k][s], 0);

const porId = new Map<string, Finding>([...findings, ...hallazgosCorregidos].map((f) => [f.id, f]));
const item = (id: string): DeltaItem => {
  const f = porId.get(id)!;
  return { finding_id: f.id, module: f.module, rule_id: f.rule_id, severity: f.severity, title: f.title,
    resource: f.resource, status: f.status };
};
const lista = (ids: string[]) => ({ total: ids.length, items: ids.map(item) });

// En el orden de E51 (el de E13): severidad, confirmed, last_seen_at y id.
const NUEVOS = [F_CB_ENV, F_CB_SERVICE_ROLE, F_CB_POSTGRES, F_CB_DEP_IGNITION, F_SB_RLS, F_SB_RPC, F_CB_GITIGNORE];
const SE_MANTIENEN = [F_CB_DEP_LODASH, F_SB_POLICY, F_CB_DEP_JQUERY, F_SB_ADV_EVENTOS, F_SB_ADV_DUP];
const CORREGIDOS = [F_CB_GENERICO, F_SB_INDICE];
const IGNORADOS = [F_SB_ADV_CODIGOS];

export const auditDelta = {
  available: true, scan_run_id: scanDone.id, taken_at: T_SCAN_FIN, first: false, score: scanDone.score,
  modules_seen: VISTOS,
  previous: { scan_run_id: SCAN_EV_VIE, kind: 'full_audit', finished_at: T_EV_VIE, score: 57 },
  counts: {
    open: contar([...NUEVOS, ...SE_MANTIENEN].map(item)), new: contar(NUEVOS.map(item)),
    kept: contar(SE_MANTIENEN.map(item)), fixed: contar(CORREGIDOS.map(item)), ignored: contar(IGNORADOS.map(item)),
  },
  fixed_checked: 1, moved: 0, gone: 0,
  new: lista(NUEVOS), kept: lista(SE_MANTIENEN), fixed: lista(CORREGIDOS), ignored: lista(IGNORADOS),
} satisfies AuditDelta;

// Versiones de martes a sábado. Las que tienen foto cuadran en total: open[k] = open[k-1] + new[k] − fixed[k] −
// ignored[k] − gone[k]. Puntajes con score() de core: 20 (crítico confirmado) → 42 → 57 → 20. Comprobados (ninguno es
// una clave): el jueves el crítico de Supabase y un .gitignore; el viernes una política y una dependencia alta.
const punto = (scan_run_id: string, at: string, score: number, open: MatrizHallazgos, extra?: Partial<EvolutionPoint>) =>
  ({ scan_run_id, kind: 'full_audit', at, score, modules_seen: VISTOS, snapshot: true, first: false, open,
    new: matriz({}), fixed: matriz({}), ignored: 0, gone: 0, fixed_checked: 0, ...extra }) satisfies EvolutionPoint;

const JUEVES = matriz({ supabase: [0, 1, 1, 3, 1], codebase: [0, 2, 1, 0, 0] });
const puntos: EvolutionPoint[] = [
  // Anterior a 0015: el puntaje sale de scan_runs; sin foto no hay conteos.
  { scan_run_id: SCAN_EV_MAR, kind: 'full_audit', at: T_EV_MAR, score: 20, modules_seen: VISTOS, snapshot: false,
    first: false, open: null, new: null, fixed: null, ignored: 0, gone: 0, fixed_checked: 0 },
  punto(SCAN_EV_MIE, T_EV_MIE, 20, matriz({ supabase: [1, 1, 1, 3, 1], codebase: [0, 2, 2, 0, 0] }), { first: true }),
  punto(SCAN_EV_JUE, T_EV_JUE, 42, JUEVES,
    { fixed: matriz({ supabase: [1, 0, 0, 0, 0], codebase: [0, 0, 1, 0, 0] }), fixed_checked: 2 }),
  punto(SCAN_EV_VIE, T_EV_VIE, 57, matriz({ supabase: [0, 1, 0, 3, 1], codebase: [0, 1, 2, 0, 0] }),
    { new: matriz({ codebase: [0, 0, 1, 0, 0] }), fixed: matriz({ supabase: [0, 0, 1, 0, 0], codebase: [0, 1, 0, 0, 0] }),
      fixed_checked: 2 }),
  punto(scanDone.id, T_SCAN_FIN, 20, auditDelta.counts.open,
    { new: auditDelta.counts.new, fixed: auditDelta.counts.fixed, ignored: IGNORADOS.length, fixed_checked: 1 }),
];

// Foto de Codebase de cada push (toda la org). Jueves: los 3 de Codebase de la auditoría del jueves más el posible
// secreto que trajo el push (primera foto). Sábado 18:31Z (limpio): los 7 de Codebase de hallazgos.ts siguen; desde el
// jueves se corrigieron 2 (la dependencia alta, comprobada el viernes, y el posible secreto, marcado a mano el sábado).
// Sábado 19:20Z: la clave de Stripe (hallazgoRevision) es nueva y los 7 siguen.
const abiertosCodebase = findings.filter((f) => f.status === 'open' && f.module === 'codebase').length;
const deltaJueves = { first: true, previous_review_id: null, previous_at: null, open: enModulo(JUEVES, 'codebase') + 1,
  kept: enModulo(JUEVES, 'codebase'), fixed: 0, fixed_checked: 0, ignored: 0 } satisfies CodeReviewDelta;
export const deltasRevision: Record<string, CodeReviewDelta> = {
  [CR_REV_LIMPIA]: { first: false, previous_review_id: CR_REV_JUEVES, previous_at: T_SNAP_JUEVES,
    open: abiertosCodebase, kept: abiertosCodebase, fixed: 2, fixed_checked: 1, ignored: 0 },
  [CR_REV_SECRETO]: { first: false, previous_review_id: CR_REV_LIMPIA, previous_at: T_SNAP_LIMPIA,
    open: abiertosCodebase + 1, kept: abiertosCodebase, fixed: 0, fixed_checked: 0, ignored: 0 },
};

const revisiones: EvolutionReview[] = [
  { review_id: CR_REV_JUEVES, event: 'push', pr_number: null, at: T_CR_JUEVES, head_sha7: 'a41c9d2',
    new: fila([0, 0, 1, 0, 0]), partial: false, delta: deltaJueves },
  ...[...codeReviewState.recent].reverse().map((r) => ({ review_id: r.id, event: 'push' as const, pr_number: null,
    at: r.created_at, head_sha7: r.head_sha.slice(0, 7), new: r.counts, partial: r.partial,
    delta: deltasRevision[r.id] ?? null })),
];

// Incidentes por día de Caracas (UTC−4, sin horario de verano) en que empezaron: los dos de incidentes.ts, del sábado.
const diaCaracas = (t: string) => new Date(Date.parse(t) - 4 * 3_600_000).toISOString().slice(0, 10);
const porDia = new Map<string, Record<Severity, number>>();
for (const i of incidents) {
  const d = diaCaracas(i.started_at);
  const c = porDia.get(d) ?? fila([0, 0, 0, 0, 0]);
  c[i.severity] += 1;
  porDia.set(d, c);
}
const incidentesPorDia: EvolutionIncidentDay[] = [...porDia].sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([day, counts]) => ({ day, counts }));

const comparables = puntos.filter((p) => p.snapshot && !p.first);
export const evolution = {
  days: 30,
  points: puntos,
  truncated: false,
  // Sin recorte, las sumas de las fotos de points (la base las calcula sobre todo el periodo).
  totals: {
    versions: puntos.length, snapshots: puntos.filter((p) => p.snapshot).length, score_first: puntos[0]!.score,
    new: sumar(comparables.map((p) => p.new!)), fixed: sumar(comparables.map((p) => p.fixed!)),
    fixed_checked: comparables.reduce((a, p) => a + p.fixed_checked, 0),
    ignored: comparables.reduce((a, p) => a + p.ignored, 0), gone: comparables.reduce((a, p) => a + p.gone, 0),
  },
  reviews: revisiones,
  incidents: incidentesPorDia,
  // 5 comprobados en el periodo (ninguno es una clave): 2 el jueves (~24 h), 2 el viernes (~48 h) y el índice el sábado
  // (~72 h).
  mttr: { verified: 5, hours_avg: 43.2, hours_median: 48 },
} satisfies Evolution;
