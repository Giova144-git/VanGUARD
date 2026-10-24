// Línea de tiempo del incidente (S14 §14.16): los hitos fijos con su «+N s» medido por el servidor y, plegado, el resto
// de timeline[] tal como llega. El hito de WhatsApp es el que vende la demo (A8): va destacado.
import type { TimelineItem } from '@vanguard/contracts';
import type { Hito } from '@/modulos/incidentes/hitos';
import { cuando } from '@/lib/formato';
import { cn } from '@/lib/utils';
import { PuntoEstado } from './PuntoEstado';
import { SectorPlegable } from './SectorPlegable';

const VIA: Record<string, string> = { whatsapp: 'por WhatsApp', in_app: 'desde la app', voice: 'por llamada' };
// Respaldo si un hito llega sin `label`: nunca el id en inglés en pantalla.
const TIPO: Record<TimelineItem['kind'], string> = {
  attack_start: 'Empieza el ataque', detected: 'Ataque detectado', severity_up: 'Sube a crítica', whatsapp_sent: 'WhatsApp enviado',
  whatsapp_delivered: 'WhatsApp entregado', whatsapp_read: 'WhatsApp leído', call_started: 'Llamada', call_failed: 'Llamada fallida',
  ack: 'Lo están viendo', muted: 'Silenciado', action_proposed: 'Bloqueo propuesto', action_executed: 'IP bloqueada',
  action_undone: 'Bloqueo deshecho', edge_confirmed: 'Cloudflare confirmó el bloqueo', mitigated: 'Mitigado', resolved: 'Resuelto',
};

export function LineaTiempo({ hitos, resto }: { hitos: Hito[]; resto: TimelineItem[] }) {
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col" aria-label="Línea de tiempo">
        {hitos.map((h, i) => {
          const ocurrio = !!h.en;
          const destacado = h.clave === 'whatsapp' && ocurrio;
          return (
            <li key={h.clave} className="flex gap-4">
              <div className="flex flex-col items-center">
                <span className="flex h-7 items-center"><PuntoEstado rol={ocurrio ? (h.clave === 'blocked' ? 'bien' : 'info') : 'neutra'} hueco={!ocurrio} /></span>
                {i < hitos.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
              </div>
              <div className={cn('mb-3 flex min-h-11 flex-1 flex-wrap items-center gap-x-3 rounded-lg px-3 py-2', destacado && 'border border-info bg-info-relleno')}>
                <span className={cn('min-w-0 flex-1 text-[15px]', ocurrio ? 'font-medium' : 'text-muted-foreground')}>
                  {h.etiqueta}{h.via && VIA[h.via] ? <span className="text-muted-foreground"> · {VIA[h.via]}</span> : null}
                </span>
                {h.en ? <span className="text-[12.5px] text-texto-3 tabular-nums">{cuando(h.en)}</span> : null}
                <span className={cn('font-mono text-[17px] font-semibold tabular-nums', destacado ? 'text-info' : ocurrio ? '' : 'text-texto-3')}>{h.mas}</span>
              </div>
            </li>
          );
        })}
      </ol>
      {resto.length ? (
        <SectorPlegable titulo={`Más detalle (${resto.length})`}>
          <ul className="flex flex-col gap-2">
            {resto.map((t, i) => (
              <li key={`${t.kind}-${i}`} className="flex flex-wrap items-center gap-x-3 text-sm">
                <span className={cn('flex-1', t.kind === 'call_failed' ? 'text-aviso' : '')}>{t.label ?? TIPO[t.kind] ?? t.kind}</span>
                <span className="font-mono text-[13px] text-texto-3 tabular-nums">+{(t.ms / 1000).toFixed(1).replace('.', ',')} s</span>
              </li>
            ))}
          </ul>
        </SectorPlegable>
      ) : null}
    </div>
  );
}
