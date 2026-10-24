// Resumen de respaldo de IA-2 (S11 11.12 paso 5, S15 15.10 y 15.14 recorte #4): si la IA cae, está apagada, sin
// presupuesto o devuelve `top` vacío, scan_runs.summary sale de aquí con model:'template' y el resumen dice
// «Resumen automático · sin IA». Determinista: mismas entradas → mismo texto. Valida contra AuditSummary.
import type { AuditSummary, Module, Severity } from '@vanguard/contracts';
import { SEVERIDAD_ES, unaLinea } from './titles.ts';

export const MODELO_PLANTILLA = 'template';
export const ETIQUETA_RESUMEN_SIN_IA = 'Resumen automático · sin IA';

/** Fila de la entrada de IA-2 (los 30 hallazgos `open` más graves, sin evidencia; finding_id = findings.id). */
export type HallazgoResumen = { finding_id: string; module: Module | string; rule_id: string; severity: Severity;
  confirmed: boolean; title: string; resource: string };
export type EntradaResumen = {
  score: number | null; band: 'red' | 'amber' | 'green' | null;
  coverage: { seen: number; total: number; missing: readonly (Module | string)[] } | null;
  hallazgos: readonly HallazgoResumen[];
  /** `r.reasons` de llamarIA: si la IA cayó por el filtro de salida, el resumen lleva suspected_injection. */
  motivos?: readonly string[];
};

const BANDA_ES = { red: 'rojo', amber: 'ámbar', green: 'verde' } as const;
const MODULO_ES: Readonly<Record<string, string>> = { supabase: 'Supabase', cloudflare: 'Cloudflare', codebase: 'Codebase',
  performance: 'Rendimiento' };
const RANGO: Readonly<Record<string, number>> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const MAX_TOP = 5, MAX_POR_QUE = 300, MAX_RESUMEN = 2000;
const lista = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);
const mayuscula = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function plantillaResumen(e: EntradaResumen): AuditSummary {
  // Orden de la entrada de IA-2 (severity_rank desc, confirmed desc); sort estable: respeta last_seen_at de la consulta.
  const hs = [...e.hallazgos].filter((h) => typeof h.finding_id === 'string' && h.finding_id !== '')
    .sort((a, b) => (RANGO[b.severity] ?? 0) - (RANGO[a.severity] ?? 0) || Number(b.confirmed) - Number(a.confirmed));
  const partes = [`${ETIQUETA_RESUMEN_SIN_IA}.`];
  partes.push(e.score === null ? 'Puntaje de blindaje sin calcular.'
    : `Puntaje de blindaje ${e.score}/100${e.band ? ` (${BANDA_ES[e.band]})` : ''}.`);
  if (e.coverage) {
    const faltan = e.coverage.missing.map((m) => MODULO_ES[m] ?? unaLinea(String(m), 40));
    partes.push(`Revisamos ${e.coverage.seen} de ${e.coverage.total} fuentes${faltan.length ? `; no pudimos revisar ${lista(faltan)}` : ''}.`);
  }
  const primero = hs[0];
  if (primero) {
    const nc = hs.filter((h) => h.severity === 'critical').length, nh = hs.filter((h) => h.severity === 'high').length;
    partes.push(`Tienes ${nc} ${nc === 1 ? 'hallazgo crítico' : 'hallazgos críticos'} y ${nh} ${nh === 1 ? 'alto' : 'altos'} abiertos.`);
    partes.push(`Empieza por: ${unaLinea(primero.title, 200).replace(/\.+$/, '')}.`);
  } else partes.push('No tienes hallazgos abiertos.');

  const vistos = new Set<string>();
  const top = hs.filter((h) => !vistos.has(h.finding_id) && vistos.add(h.finding_id)).slice(0, MAX_TOP).map((h) => ({
    finding_id: h.finding_id,
    por_que: unaLinea(`${mayuscula(SEVERIDAD_ES[h.severity] ?? String(h.severity))}${h.confirmed ? ', confirmado por regla' : ''}: ${h.title}`, MAX_POR_QUE),
  }));
  return {
    resumen: unaLinea(partes.join(' '), MAX_RESUMEN), top, relaciones: [],
    ...(e.motivos && e.motivos.length > 0 ? { suspected_injection: true } : {}),
    model: MODELO_PLANTILLA,
  };
}
/** Alias con el nombre de S11 11.12 (`resumenPlantilla`); el canónico es el de S15 15.14 (`plantillaResumen`). */
export const resumenPlantilla = plantillaResumen;
