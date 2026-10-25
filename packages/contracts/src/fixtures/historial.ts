// Historial de fallas (E13h y E13t; 0025_historial_hallazgos.sql). La misma historia que evolucion.ts, falla a falla:
// - RLS de public.pedidos: apareció el miércoles, la auditoría del jueves la dio por corregida y el sábado reapareció
//   (la regresión). Igual el .gitignore sin .env. La fila ya no guarda la verificación del jueves (vg_upsert_findings la
//   borra al reabrir): ese ciclo sale de las fotos (fotosFallas).
// - El índice sin usar: tu IA lo arregló (petición corregida), se marcó corregido el viernes y el sábado una auditoría
//   lo verificó. El posible secreto del push del jueves se marcó corregido a mano el sábado por la mañana.
// - La tabla interna sin políticas se ignoró el viernes por la noche.
// - Dos más que la auditoría del viernes verificó (una política y una dependencia alta): no están en `findings` ni en
//   hallazgosCorregidos; el router de fixtures del FRONT los añade a la lista de la org cuando se pide el historial.
// fechasFallas pisa las fechas de los hallazgos de hallazgos.ts (allí todos son del sábado, dato de prueba): el router
// del FRONT las aplica también a su copia de E13, para que el detalle y el historial digan lo mismo.
import type { Finding, FindingHistoryItem } from '../api.ts';
import { eventosDeFalla, ultimoCambio, type FotosFalla } from '../historial.ts';
import { fixRequests } from './correcciones.ts';
import { hallazgosCorregidos } from './evolucion.ts';
import { findings } from './hallazgos.ts';
import {
  CONN_GITHUB, CONN_SUPABASE, F_CB_DEP_IGNITION, F_CB_DEP_JQUERY, F_CB_DEP_LODASH, F_CB_ENV, F_CB_GENERICO, F_CB_GITIGNORE,
  F_CB_POSTGRES, F_CB_SERVICE_ROLE, F_HIST_DEP, F_HIST_POLITICA, F_SB_ADV_CODIGOS, F_SB_ADV_DUP, F_SB_ADV_EVENTOS,
  F_SB_INDICE, F_SB_POLICY, F_SB_RLS, F_SB_RPC, SCAN_EV_VIE, T_EV_JUE, T_EV_MIE, T_EV_VIE, T_PASO_REPO, T_PASO_SUPABASE,
  T_SCAN_FIN,
} from './ids.ts';

export const hallazgosHistoricos = [
  { id: F_HIST_POLITICA, module: 'supabase', rule_id: 'SB_POLICY_ALLOW_ALL', severity: 'medium', confirmed: true,
    origin: 'rule', title: 'La política «lectura_libre» deja leer public.cupones sin sesión', resource: 'public.cupones',
    evidence: { policyname: 'lectura_libre', cmd: 'SELECT', roles: ['anon'] },
    has_fix_prompt: false, fix_model: null, status: 'verified', status_reason: 'no reapareció en la auditoría',
    suspected_injection: false, scan_run_id: SCAN_EV_VIE, connection_id: CONN_SUPABASE, first_seen_at: T_EV_MIE,
    last_seen_at: T_EV_JUE, verified_at: T_EV_VIE },
  { id: F_HIST_DEP, module: 'codebase', rule_id: 'CB_DEP_VULN', severity: 'high', confirmed: true, origin: 'rule',
    title: 'axios 0.21.1 tiene 2 vulnerabilidades; la más grave es alta', resource: 'npm:axios@0.21.1',
    evidence: { fuente: 'github', sha: 'a41c9d2', path: 'package-lock.json', urgencia: 'esta_semana', version_arreglo: '0.30.0',
      n_avisos: 2, paquete: { ecosystem: 'npm', name: 'axios', version: '0.21.1', manifest: 'package-lock.json', direct: true,
        dev: false } },
    has_fix_prompt: false, fix_model: null, status: 'verified', status_reason: 'no reapareció en la auditoría',
    suspected_injection: false, scan_run_id: SCAN_EV_VIE, connection_id: CONN_GITHUB, first_seen_at: T_EV_MIE,
    last_seen_at: T_EV_JUE, verified_at: T_EV_VIE },
] satisfies Finding[];

type Fechas = Partial<Pick<FindingHistoryItem, 'first_seen_at' | 'fixed_at' | 'ignored_at' | 'reopened_at' | 'reopen_count'>>;
// Los «se mantienen» del sábado ya estaban el miércoles o el jueves (como dice evolucion.ts).
export const fechasFallas: Record<string, Fechas> = {
  [F_SB_RLS]: { first_seen_at: T_EV_MIE, reopened_at: T_PASO_SUPABASE, reopen_count: 1 },
  [F_CB_GITIGNORE]: { first_seen_at: T_EV_MIE, reopened_at: T_PASO_REPO, reopen_count: 1 },
  [F_SB_POLICY]: { first_seen_at: T_EV_MIE },
  [F_SB_ADV_EVENTOS]: { first_seen_at: T_EV_MIE },
  [F_SB_ADV_DUP]: { first_seen_at: T_EV_JUE },
  [F_CB_DEP_LODASH]: { first_seen_at: T_EV_MIE },
  [F_CB_DEP_JQUERY]: { first_seen_at: T_EV_JUE },
  [F_SB_ADV_CODIGOS]: { first_seen_at: T_EV_MIE, ignored_at: '2026-10-23T21:10:00.000Z' },
  [F_SB_INDICE]: { fixed_at: T_EV_VIE },
  [F_CB_GENERICO]: { fixed_at: '2026-10-24T13:15:00.000Z' },
};

// Lo que dirían las fotos de audit_snapshots (las del miércoles al sábado): cuándo entró nueva y cuándo salió. La del
// miércoles es la primera foto (sin nuevos). Los demás del sábado entran nuevos en la foto del sábado.
export const fotosFallas: Record<string, FotosFalla> = {
  [F_SB_RLS]: { nuevo: [T_SCAN_FIN], corregido: [T_EV_JUE] },
  [F_CB_GITIGNORE]: { nuevo: [T_SCAN_FIN], corregido: [T_EV_JUE] },
  [F_SB_INDICE]: { nuevo: [], corregido: [T_SCAN_FIN] },
  [F_CB_GENERICO]: { nuevo: [T_EV_VIE], corregido: [T_SCAN_FIN] },
  [F_HIST_POLITICA]: { nuevo: [], corregido: [T_EV_VIE] },
  [F_HIST_DEP]: { nuevo: [], corregido: [T_EV_VIE] },
  ...Object.fromEntries([F_CB_ENV, F_CB_SERVICE_ROLE, F_CB_POSTGRES, F_CB_DEP_IGNITION, F_SB_RPC]
    .map((id) => [id, { nuevo: [T_SCAN_FIN], corregido: [] }])),
};

/** Finding → fila del historial, con las fechas de fechasFallas encima. */
export function aHistorial(f: Finding, extra: Fechas = fechasFallas[f.id] ?? {}): FindingHistoryItem {
  const base = { id: f.id, module: f.module, rule_id: f.rule_id, severity: f.severity, title: f.title, resource: f.resource,
    status: f.status, status_reason: f.status_reason, connection_id: f.connection_id, first_seen_at: f.first_seen_at,
    last_seen_at: f.last_seen_at, fixed_at: null, verified_at: f.verified_at, ignored_at: null, reopened_at: null,
    reopen_count: 0, ...extra };
  return { ...base, changed_at: ultimoCambio(base) };
}

// E13h de la demo: todas, del último cambio al más viejo.
export const historialFallas: FindingHistoryItem[] = [...findings, ...hallazgosCorregidos, ...hallazgosHistoricos]
  .map((f) => aHistorial(f))
  .sort((a, b) => Date.parse(b.changed_at) - Date.parse(a.changed_at) || a.id.localeCompare(b.id));

// E13t del RLS de pedidos (la regresión): detectado, salió el jueves, reapareció el sábado y visto.
const rls = historialFallas.find((f) => f.id === F_SB_RLS)!;
export const lineaTiempoFalla = { item: rls, events: eventosDeFalla(rls, fixRequests, fotosFallas[F_SB_RLS]) };
