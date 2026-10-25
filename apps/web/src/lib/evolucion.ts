// Evolución entre revisiones (asignaciones/evolucion-entre-revisiones.md §6). Funciones puras: cifras, series de las
// gráficas y textos. Las cifras del periodo salen de `totals` (la base las calcula sobre el periodo entero) y nunca de
// sumar `points`, que puede venir recortado. Todo valor del servidor que no sea un número se lee con un mapa cerrado.
import type {
  CodeReview, DeltaItem, Evolution, EvolutionIncidentDay, EvolutionPoint, MatrizHallazgos, Module, PorSeveridad, ScanKind,
  Severity,
} from '@vanguard/contracts';
import { SIN_DATO } from './formato';
import { deMapa, type Rol } from './severidad';

export const SEVERIDADES = ['critical', 'high', 'medium', 'low', 'info'] as const satisfies readonly Severity[];
// Los módulos que entran en las fotos. Rendimiento no: ningún paso de auditoría escribe hallazgos de rendimiento (§11).
export const MODULOS_FOTO = ['supabase', 'cloudflare', 'codebase'] as const satisfies readonly Module[];
const MODULOS = [...MODULOS_FOTO, 'performance'] as const satisfies readonly Module[];
export type FiltroModulo = 'todo' | (typeof MODULOS_FOTO)[number];

export const NOMBRE_MODULO: Record<Module, string> = { supabase: 'Supabase', cloudflare: 'Cloudflare', codebase: 'Codebase', performance: 'Rendimiento' };
export const nombreModulo = (m: unknown) => deMapa(NOMBRE_MODULO, m, SIN_DATO);

const KIND: Record<ScanKind, string> = {
  full_audit: 'Completa', supabase: 'Solo Supabase', cloudflare: 'Solo Cloudflare', repo: 'Solo el repo', zip: 'ZIP',
  lighthouse: 'Rendimiento',
};
export const tipoAuditoria = (k: unknown) => deMapa(KIND, k, 'Auditoría');

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Hallazgos de una fila por severidad (un módulo) o de toda la matriz; `modulo` filtra. Una clave que falte cuenta 0.
export const totalFila = (f: Partial<PorSeveridad> | null | undefined) => SEVERIDADES.reduce((a, s) => a + n(f?.[s]), 0);
export function totalMatriz(m: Partial<MatrizHallazgos> | null | undefined, modulo: FiltroModulo = 'todo') {
  if (!m) return 0;
  return (modulo === 'todo' ? MODULOS : [modulo]).reduce((a, k) => a + totalFila(m[k]), 0);
}
// Por severidad sumando los módulos (o solo uno): la fila de «Abiertos por severidad» y los C/A/M/B de la tabla.
export function porSeveridad(m: Partial<MatrizHallazgos> | null | undefined, modulo: FiltroModulo = 'todo'): Record<Severity, number> {
  const ks = modulo === 'todo' ? MODULOS : [modulo];
  return Object.fromEntries(SEVERIDADES.map((s) => [s, ks.reduce((a, k) => a + n(m?.[k]?.[s]), 0)])) as Record<Severity, number>;
}

// «43 h» → «1 d 19 h». Se redondea a la hora antes de partir: nunca «1 d 24 h».
export function horas(h: number | null | undefined) {
  if (h == null || !Number.isFinite(h) || h < 0) return SIN_DATO;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  const t = Math.round(h);
  if (t < 24) return `${t} h`;
  const d = Math.floor(t / 24), r = t % 24;
  return r ? `${d} d ${r} h` : `${d} d`;
}

// «mié 21 · 14:03» en hora de Caracas: eje de las gráficas y fecha de cada versión. Por partes: hay navegadores que
// escriben «mié.» y otros «mié».
const PARTES = new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function etiquetaVersion(at: string | null | undefined) {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return SIN_DATO;
  const p = Object.fromEntries(PARTES.formatToParts(d).map((x) => [x.type, x.value]));
  return `${(p.weekday ?? '').replace(/\.$/, '')} ${p.day} · ${p.hour}:${p.minute}`;
}

// Clave = la misma regla que private.vg_es_clave: que ya no esté en el código no prueba que se rotó.
export const esClave = (rule: unknown) => typeof rule === 'string' && (rule.startsWith('CB_SECRET_') || rule === 'CB_ENV_COMMITTED');

export type Chip = { texto: string; rol: Rol };
export type ListaDelta = 'new' | 'kept' | 'fixed' | 'ignored';
// Estado de AHORA de un hallazgo de las listas de E51 (§6.3). Mapas cerrados; lo demás, sin etiqueta.
const EN_CORREGIDOS: Record<string, Chip> = {
  fixed: { texto: 'Marcado a mano', rol: 'neutra' },
  open: { texto: 'Volvió a aparecer', rol: 'aviso' },
};
const YA_CORREGIDO: Chip = { texto: 'Ya corregido', rol: 'neutra' };
const EN_NUEVOS: Record<string, Chip> = { fixed: YA_CORREGIDO, verified: YA_CORREGIDO };
export function etiquetaCorregido(item: Pick<DeltaItem, 'status' | 'rule_id'>, lista: ListaDelta = 'fixed'): Chip | null {
  if (lista === 'new') return deMapa<string, Chip | null>(EN_NUEVOS, item.status, null);
  if (lista !== 'fixed') return null;
  if (item.status === 'verified') return esClave(item.rule_id)
    ? { texto: 'Ya no está en el código · rota la clave', rol: 'aviso' } : { texto: 'Comprobado', rol: 'bien' };
  return deMapa<string, Chip | null>(EN_CORREGIDOS, item.status, null);
}

const plural = (k: number, uno: string, varios: string) => `${k} ${k === 1 ? uno : varios}`;

// Línea de la foto de Codebase de un push (§6.2). Solo pushes con `delta`; un PR o un push sin foto, nada. Solo números:
// nada que sanear. `variosRepos`: con dos o más conexiones GitHub la foto es de toda la org (varias-codebases.md).
export function lineaFoto(r: Pick<CodeReview, 'event' | 'counts'> & { delta?: CodeReview['delta'] }, variosRepos = false): string | null {
  const d = r.delta;
  if (r.event !== 'push' || !d) return null;
  const donde = variosRepos ? ' en Codebase (todos los repos)' : '';
  const siguen = `${n(d.kept)} ${n(d.kept) === 1 ? 'sigue abierto' : 'siguen abiertos'}`;
  if (d.first) return `${siguen} en Codebase${variosRepos ? ' (todos los repos)' : ''} · desde el próximo push verás los corregidos`;
  const nuevos = SEVERIDADES.reduce((a, s) => a + n(r.counts?.[s]), 0);
  let t = `${plural(nuevos, 'nuevo', 'nuevos')} · ${siguen}${donde} · ${plural(n(d.fixed), 'corregido', 'corregidos')} desde el push anterior`;
  if (n(d.fixed_checked) > 0) t += ` (${plural(n(d.fixed_checked), 'comprobado', 'comprobados')} por una auditoría)`;
  if (n(d.ignored) > 0) t += ` · ${plural(n(d.ignored), 'ignorado', 'ignorados')}`;
  return t;
}
// Nota única al pie de la tarjeta de la revisión (§1.1).
export const NOTA_FOTO_PUSH = 'Entre dos pushes, "corregido" es lo que alguien marcó o lo que comprobó una auditoría: un push no ve lo que se quita.';

// Cifras de la página (§6.4): del último punto y de `totals`. `modulo` filtra los conteos; puntaje y tiempo son de toda la
// organización.
export function cifras(evo: Evolution, modulo: FiltroModulo = 'todo') {
  const ultimo = evo.points.at(-1);
  const puntaje = ultimo?.score ?? null;
  const primero = evo.totals.score_first;
  const abiertos = ultimo?.snapshot && ultimo.open ? totalMatriz(ultimo.open, modulo) : null;
  return {
    puntaje,
    cambio: puntaje != null && primero != null && evo.points.length > 1 ? puntaje - primero : null,
    abiertos,
    criticos: abiertos == null ? null : porSeveridad(ultimo!.open, modulo).critical,
    nuevos: totalMatriz(evo.totals.new, modulo),
    corregidos: totalMatriz(evo.totals.fixed, modulo),
    comprobados: modulo === 'todo' ? n(evo.totals.fixed_checked) : null,   // la base no lo parte por módulo
    mttr: { media: evo.mttr.hours_avg, mediana: evo.mttr.hours_median, n: n(evo.mttr.verified) },
  };
}
// «+22» · «−37» · «igual».
export const signo = (d: number) => (d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : 'igual');

export type PuntoPuntaje = { id: string; x: string; score: number | null; snapshot: boolean };
// Todos los puntos, también los anteriores al historial (snapshot:false): su puntaje sale exacto de scan_runs (§2.5).
export const seriePuntaje = (points: readonly EvolutionPoint[]): PuntoPuntaje[] =>
  points.map((p) => ({ id: p.scan_run_id, x: etiquetaVersion(p.at), score: p.score, snapshot: p.snapshot }));

// Comparables = con foto y con una anterior con la que restar: los únicos con nuevos y corregidos.
export const comparables = (points: readonly EvolutionPoint[]) => points.filter((p) => p.snapshot && !p.first);

// P1 · «Nuevos y corregidos»: corregidos en negativo para que bajen de cero.
export const serieCambios = (points: readonly EvolutionPoint[], modulo: FiltroModulo = 'todo') =>
  comparables(points).map((p) => ({ id: p.scan_run_id, x: etiquetaVersion(p.at), nuevos: totalMatriz(p.new, modulo),
    corregidos: -totalMatriz(p.fixed, modulo) }));

// P1 · «Abiertos por severidad»: solo los puntos con foto. Baja e info van juntas (mismo color).
export const serieAbiertos = (points: readonly EvolutionPoint[], modulo: FiltroModulo = 'todo') =>
  points.filter((p) => p.snapshot && p.open).map((p) => {
    const s = porSeveridad(p.open, modulo);
    return { id: p.scan_run_id, x: etiquetaVersion(p.at), critical: s.critical, high: s.high, medium: s.medium, low: s.low + s.info };
  });

// P1 · «Incidentes por día»: un día por barra en hora de Caracas (UTC−4, sin horario de verano), del más viejo al de hoy;
// los días sin incidentes van en 0. Baja e info juntas.
const diaCaracas = (ms: number) => new Date(ms - 4 * 3_600_000).toISOString().slice(0, 10);
export function serieIncidentes(incidents: readonly EvolutionIncidentDay[], dias: number, ahora = Date.now()) {
  const por = new Map(incidents.map((i) => [i.day, i.counts]));
  const k = Math.max(1, Math.min(91, Math.round(dias)));
  return Array.from({ length: k }, (_, i) => {
    const dia = diaCaracas(ahora - (k - 1 - i) * 86_400_000);
    const c = por.get(dia);
    return { dia, x: `${dia.slice(8, 10)}-${dia.slice(5, 7)}`, critical: n(c?.critical), high: n(c?.high), medium: n(c?.medium),
      low: n(c?.low) + n(c?.info) };
  });
}
