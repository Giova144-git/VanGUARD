// Línea de tiempo de una falla (E13t): detectada, enviada a tu IA, corregida, verificada, ignorada, reapareció y vista
// por última vez, de la más vieja a la más nueva. Va en la fila expandida del historial y en el detalle del hallazgo. Las
// fechas salen formateadas (cuando de lib/formato.ts) y van como texto; si E13t da 404 (aún sin desplegar o la falla ya se borró), un aviso.
import type { FindingEvent } from '@vanguard/contracts';
import { PuntoEstado } from '@/componentes/vg/PuntoEstado';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { useLineaTiempoFalla } from '@/lib/consultas';
import { esApiError } from '@/lib/errores';
import { cuando } from '@/lib/formato';
import { EVENTO_FALLA, detalleEvento } from '@/lib/historial';
import { deMapa } from '@/lib/severidad';
import { cn } from '@/lib/utils';

const SIN_EVENTO = { texto: 'Cambio', rol: 'neutra' as const };

export function ListaEventos({ eventos, reaperturas }: { eventos: FindingEvent[]; reaperturas: number }) {
  return (
    <div className="flex flex-col gap-2" data-info="historial-linea-tiempo">
      <ol className="flex flex-col" aria-label="Línea de tiempo de la falla">
        {eventos.map((e, i) => {
          const t = deMapa(EVENTO_FALLA, e.kind, SIN_EVENTO);
          const detalle = detalleEvento(e);
          const ultimo = i === eventos.length - 1;
          return (
            <li key={`${e.kind}-${e.at}-${i}`} className="flex gap-3" data-evento={e.kind}>
              <div className="flex flex-col items-center">
                <span className="flex h-7 items-center"><PuntoEstado rol={t.rol} hueco={e.kind === 'visto'} /></span>
                {ultimo ? null : <span className="w-px flex-1 bg-border" />}
              </div>
              <div className={cn('flex min-h-9 flex-1 flex-wrap items-baseline gap-x-3 pb-2', ultimo ? '' : 'mb-1')}>
                <span className={cn('min-w-0 flex-1 text-[15px]', e.kind === 'visto' ? 'text-muted-foreground' : 'font-medium')}>
                  {t.texto}{detalle ? <span className="font-normal text-muted-foreground"> · {detalle}</span> : null}
                </span>
                <time dateTime={Number.isNaN(Date.parse(e.at)) ? undefined : new Date(e.at).toISOString()}
                  className="font-mono text-[13px] text-texto-3 tabular-nums">{cuando(e.at)}</time>
              </div>
            </li>
          );
        })}
      </ol>
      {reaperturas > 1 ? <p className="text-[13px] text-muted-foreground">Ha reaparecido {reaperturas} veces después de corregirse.</p> : null}
    </div>
  );
}

export function LineaTiempoFalla({ org, id }: { org: string; id: string }) {
  const q = useLineaTiempoFalla(org, id);
  if (q.isError && !q.data) {
    return esApiError(q.error) && q.error.status === 404
      ? <p className="text-[15px] text-muted-foreground">Aún no hay línea de tiempo para esta falla.</p>
      : <ErrorBloque error={q.error} onReintentar={() => q.refetch()} />;
  }
  if (!q.data) return <p className="text-texto-3" aria-busy="true">—</p>;
  return <ListaEventos eventos={q.data.events} reaperturas={q.data.item.reopen_count} />;
}
