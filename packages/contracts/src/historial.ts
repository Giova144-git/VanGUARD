// Línea de tiempo de una falla (E13t), la misma en el Worker y en los fixtures del FRONT: sale de las fechas de la fila
// (0025_historial_hallazgos.sql), de su cola «Enviar a mi IA» (fix_requests) y de las fotos de audit_snapshots que la
// nombran (0015). Las fotos solo dicen «una auditoría la vio nueva» o «ya no la vio»; con ellas se recuperan las
// reapariciones y los ciclos anteriores que la fila ya no guarda (vg_upsert_findings borra verified_at al reabrir).
import type { FindingEvent, FindingEventKind, FindingHistoryItem, FixRequest } from './api.ts';

/** Fotos de audit_snapshots que nombran la falla: cuándo entró como nueva (new_ids) y cuándo salió (fixed_ids). */
export type FotosFalla = { nuevo: readonly string[]; corregido: readonly string[] };

// La foto se toma en el paso puntaje, unos minutos después de que vg_upsert_findings reabre o verifica la fila: una
// foto hasta 3 h después de la fecha de la fila es el mismo cambio, no otro.
export const MISMO_CAMBIO_MS = 3 * 3_600_000;
const ORDEN: Readonly<Record<FindingEventKind, number>> = {
  detectado: 0, reaparecido: 1, enviado_ia: 2, arreglando: 3, envio_cancelado: 4, corregido: 5, salio: 6, verificado: 7,
  ignorado: 8, visto: 9,
};
export const MAX_EVENTOS = 80;

const ms = (t: string | null | undefined) => (t ? Date.parse(t) : Number.NaN);
const valida = (t: string | null | undefined): t is string => Number.isFinite(ms(t));

/** Hitos de una falla, de la más vieja a la más nueva (como mucho MAX_EVENTOS: los más recientes). */
export function eventosDeFalla(f: FindingHistoryItem, envios: readonly FixRequest[], fotos: FotosFalla = { nuevo: [], corregido: [] }): FindingEvent[] {
  const ev: FindingEvent[] = [];
  const poner = (kind: FindingEventKind, at: string | null | undefined, client: FindingEvent['client'] = null) => {
    if (valida(at)) ev.push({ kind, at, client });
  };
  poner('detectado', f.first_seen_at);
  for (const e of envios) {
    if (e.finding_id !== f.id) continue;
    poner('enviado_ia', e.created_at, e.client);
    poner('arreglando', e.started_at);
    if (e.status === 'cancelado') poner('envio_cancelado', e.closed_at);
  }
  poner('corregido', f.fixed_at);
  poner('verificado', f.verified_at);
  poner('ignorado', f.ignored_at);

  // Reapariciones: una foto la vio nueva después de otra que ya no la vio. reopened_at (la última, con su hora exacta)
  // sustituye a la foto de ese mismo cambio o, si no hay foto (una revisión de push la reabrió), se añade.
  const salidas = fotos.corregido.filter(valida).map(ms).sort((a, b) => a - b);
  const reapariciones = fotos.nuevo.filter(valida).map(ms).filter((t) => salidas.some((s) => s < t)).sort((a, b) => a - b);
  const reabierta = ms(f.reopened_at);
  if (Number.isFinite(reabierta)) {
    const i = reapariciones.findIndex((t) => t >= reabierta && t - reabierta <= MISMO_CAMBIO_MS);
    if (i >= 0) reapariciones[i] = reabierta; else reapariciones.push(reabierta);
    reapariciones.sort((a, b) => a - b);
  }
  // Cada ciclo que acabó en una reaparición sin fecha de corregido, verificado o ignorado: la última foto que ya no la vio.
  const cierres = ev.filter((e) => e.kind === 'corregido' || e.kind === 'verificado' || e.kind === 'ignorado').map((e) => ms(e.at));
  let desde = -Infinity;
  for (const r of reapariciones) {
    if (!cierres.some((c) => c > desde && c < r)) {
      const s = salidas.filter((t) => t > desde && t < r).at(-1);
      if (s !== undefined) ev.push({ kind: 'salio', at: new Date(s).toISOString(), client: null });
    }
    ev.push({ kind: 'reaparecido', at: new Date(r).toISOString(), client: null });
    desde = r;
  }
  poner('visto', f.last_seen_at);
  ev.sort((a, b) => ms(a.at) - ms(b.at) || ORDEN[a.kind] - ORDEN[b.kind]);
  return ev.slice(-MAX_EVENTOS);
}

/** El último cambio de estado (lo que ordena el historial): la fecha más reciente de la fila. */
export function ultimoCambio(f: Pick<FindingHistoryItem, 'first_seen_at' | 'fixed_at' | 'verified_at' | 'ignored_at' | 'reopened_at'>): string {
  const ts = [f.first_seen_at, f.fixed_at, f.verified_at, f.ignored_at, f.reopened_at].filter(valida);
  return ts.reduce((a, b) => (ms(b) > ms(a) ? b : a), f.first_seen_at);
}
