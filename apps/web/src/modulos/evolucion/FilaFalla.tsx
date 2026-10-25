// Una falla del historial (E13h): gravedad, título, recurso, estado y sus fechas; «Línea de tiempo» la expande (E13t) y
// «Ver» abre el detalle. Lleva data-hallazgo (marcaHallazgo, con sus fechas): con clic derecho, Vigía cuenta qué era y
// cuándo se detectó, se corrigió o se verificó. Título y recurso son del cliente: los controles bidi se ven (lib/bidi.ts).
import { useId } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { FindingHistoryItem } from '@vanguard/contracts';
import { ChapaSeveridad, Etiqueta } from '@/componentes/vg/Etiqueta';
import { marcaHallazgo } from '@/componentes/vigia/info-hallazgos';
import { sinBidi } from '@/lib/bidi';
import { nombreModulo } from '@/lib/evolucion';
import { cuando } from '@/lib/formato';
import { ESTADO_FALLA } from '@/lib/historial';
import { deMapa } from '@/lib/severidad';
import { cn } from '@/lib/utils';
import { LineaTiempoFalla } from './LineaTiempoFalla';

/** «Detectada 21-10 14:03 · Corregida 24-10 09:15 · …»: solo las fechas que hay. */
export function fechasFila(f: FindingHistoryItem): string {
  const p: [string, string | null][] = [['Detectada', f.first_seen_at], ['Reapareció', f.reopened_at], ['Corregida', f.fixed_at],
    ['Verificada', f.verified_at], ['Ignorada', f.ignored_at]];
  const partes = p.filter(([, t]) => t && !Number.isNaN(Date.parse(t))).map(([k, t]) => `${k} ${cuando(t)}`);
  if (f.status === 'open') partes.push(`Vista ${cuando(f.last_seen_at)}`);
  return partes.join(' · ');
}

export function FilaFalla({ org, f, abierta, onAlternar, verEn = 'panel' }:
  { org: string; f: FindingHistoryItem; abierta: boolean; onAlternar: () => void; verEn?: 'panel' | 'pagina' }) {
  const panel = useId();
  const estado = deMapa(ESTADO_FALLA, f.status, { texto: '—', rol: 'neutra' });
  const destino = verEn === 'panel' ? `?finding=${encodeURIComponent(f.id)}` : `/o/${org}/findings/${encodeURIComponent(f.id)}`;
  return (
    <li className="flex flex-col gap-2 border-b py-3 last:border-b-0" data-estado={f.status}
      {...marcaHallazgo({ ...f })}>
      <div className="flex flex-wrap items-center gap-3">
        <ChapaSeveridad severity={f.severity} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] font-medium wrap-anywhere">{sinBidi(f.title)}</span>
          <span className="flex min-w-0 flex-wrap gap-x-2 text-[13px] text-muted-foreground">
            <span className="min-w-0 truncate font-mono"><bdi dir="ltr">{sinBidi(f.resource)}</bdi></span>
            <span>· {nombreModulo(f.module)}</span>
          </span>
        </div>
        <Etiqueta texto={estado.texto} rol={estado.rol} />
        {f.reopen_count > 0 ? <Etiqueta texto={f.reopen_count === 1 ? 'Reapareció' : `Reapareció ×${f.reopen_count}`} rol="aviso" /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-[13px] text-texto-3 tabular-nums">{fechasFila(f)}</p>
        <button type="button" onClick={onAlternar} aria-expanded={abierta} aria-controls={panel}
          className="inline-flex h-11 items-center gap-1 text-sm font-medium text-foreground underline underline-offset-4">
          Línea de tiempo<ChevronDown className={cn('size-4 transition-transform', abierta && 'rotate-180')} /></button>
        <Link to={destino} className="inline-flex h-11 items-center gap-1 rounded-full border border-foreground px-4 font-mono text-[13px] font-medium uppercase tracking-[0.06em] text-foreground hover:bg-muted">
          Ver<ChevronRight className="size-4" /></Link>
      </div>
      <div id={panel} hidden={!abierta} className="rounded-lg border bg-background px-3 py-2">
        {abierta ? <LineaTiempoFalla org={org} id={f.id} /> : null}
      </div>
    </li>
  );
}
