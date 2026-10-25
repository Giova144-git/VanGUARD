// Una línea para el Resumen (asignaciones/evolucion-entre-revisiones.md §9.3, F12): lo que cambió en la última auditoría
// frente a la anterior, con E51. Sin foto, en la primera foto, con 404 o con error: nada.
import { Link } from 'react-router';
import type { Overview } from '@vanguard/contracts';
import { useDeltaAuditoria } from '@/lib/consultas';
import { totalMatriz } from '@/lib/evolucion';

export function DesdeAnterior({ org, ultima }: { org: string; ultima: Overview['last_scan'] }) {
  const q = useDeltaAuditoria(org, ultima?.id, ultima?.status === 'succeeded');
  const d = q.data;
  if (!ultima || !d?.available || d.first) return null;
  const n = totalMatriz(d.counts.new), m = totalMatriz(d.counts.fixed);
  return (
    <span className="text-[12.5px] text-texto-3">
      Desde la auditoría anterior: {n} {n === 1 ? 'nuevo' : 'nuevos'} · {m} {m === 1 ? 'corregido' : 'corregidos'} ·{' '}
      <Link to={`/o/${org}/evolution`} className="font-medium text-foreground underline underline-offset-4">Ver evolución</Link>
    </span>
  );
}
