// /o/:orgId/incidents (S14 §14.16): «Abiertos · Todos», tabla (tarjetas en móvil) y aviso de incidente nuevo.
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronRight } from 'lucide-react';
import type { Incident, IncidentStatus, Severity } from '@vanguard/contracts';
import { BarraModulo } from '@/componentes/vg/BarraModulo';
import { Cronometro } from '@/componentes/vg/Cronometro';
import { ChapaSeveridad, Etiqueta } from '@/componentes/vg/Etiqueta';
import { GuiaModulo } from '@/componentes/vg/GuiaModulo';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { useOrg } from '@/app/guardas';
import { useIncidentes } from '@/lib/consultas';
import { cuando, miles } from '@/lib/formato';
import { entradaNav } from '@/lib/nav';
import { SEVERIDAD, deMapa, type Rol } from '@/lib/severidad';
import { cn } from '@/lib/utils';
import { sinBidi } from '@/lib/bidi';
import { SimularAtaque } from './Simulacion';

export const ESTADO_INC: Record<IncidentStatus, { texto: string; rol: Rol }> = {
  open: { texto: 'Abierto', rol: 'mal' }, ack: { texto: 'Lo están viendo', rol: 'aviso' },
  mitigated: { texto: 'Mitigado', rol: 'bien' }, resolved: { texto: 'Resuelto', rol: 'neutra' },
};
// En producción api() deja pasar un cuerpo fuera de contrato: un estado desconocido (o «__proto__», que `??` no para)
// sale «—» y neutro (L3), no como TypeError.
export const estadoInc = (s: unknown) => deMapa(ESTADO_INC, s, { texto: '—', rol: 'neutra' });
// Texto del aviso aria-live: una severidad fuera de contrato va sin etiqueta.
export const avisoNuevo = (n: Pick<Incident, 'severity' | 'title'>) => {
  const sev = deMapa<Severity, { etiqueta: string } | null>(SEVERIDAD, n.severity, null)?.etiqueta.toLowerCase();
  return `Nuevo incidente${sev ? ` ${sev}` : ''}: ${sinBidi(n.title)}`;
};
const abierto = (i: Incident) => i.status === 'open' || i.status === 'ack';
const origen = (r: string) => r.replace(/^ip:/, '');
// Pistas de la tabla: por ancho del contenedor, no del viewport (riel abierto o modo presentación); por debajo, tarjetas.
const PISTAS = '@min-[66rem]:grid-cols-[6rem_5rem_1fr_9rem_5rem_6rem_8rem_5rem_1rem]';

export default function PaginaIncidentes() {
  const org = useOrg();
  const [params, setParams] = useSearchParams();
  const estado = params.get('estado') === 'all' ? 'all' : 'open';
  const q = useIncidentes(org.id, estado);
  const vistos = useRef<Set<string> | null>(null);
  const [nuevo, setNuevo] = useState<{ id: string; texto: string } | null>(null);
  const e = entradaNav('incidents')!;

  // Un incidente con id no visto se anuncia por aria-live y su fila lleva tinte info 5 s.
  useEffect(() => {
    if (!q.data) return;
    if (!vistos.current) { vistos.current = new Set(q.data.map((i) => i.id)); return; }
    const n = q.data.find((i) => !vistos.current!.has(i.id));
    q.data.forEach((i) => vistos.current!.add(i.id));
    if (!n) return;
    setNuevo({ id: n.id, texto: avisoNuevo(n) });
    const t = setTimeout(() => setNuevo(null), 5000);
    return () => clearTimeout(t);
  }, [q.data]);

  const cambiar = (v: 'open' | 'all') => { const p = new URLSearchParams(params); if (v === 'all') p.set('estado', 'all'); else p.delete('estado'); setParams(p); };
  const lista = q.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <BarraModulo titulo={e.nombre} descripcion={e.descripcion} />
      <SimularAtaque org={org} />
      <div className="inline-flex w-fit rounded-lg bg-muted p-1" role="group" aria-label="Qué incidentes ver">
        {(['open', 'all'] as const).map((v) => (
          <button key={v} type="button" aria-pressed={estado === v} onClick={() => cambiar(v)}
            className={cn('h-11 rounded-md px-4 text-sm font-medium', estado === v ? 'bg-card text-foreground' : 'text-muted-foreground')}>
            {v === 'open' ? `Abiertos${q.data && estado === 'open' ? ` ${q.data.length}` : ''}` : 'Todos'}
          </button>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">{nuevo?.texto ?? ''}</p>
      {q.isError ? <ErrorBloque error={q.error} onReintentar={() => q.refetch()} /> : null}
      {!q.data ? <div className="rounded-xl border bg-card px-4 py-6 text-texto-3">—</div>
        : lista.length === 0 ? <div className="rounded-xl border bg-card px-4 py-6 text-[15px] text-muted-foreground">
            {estado === 'all' ? '0 ✓ Sin incidentes · vigilando' : '0 ✓ Sin incidentes abiertos · vigilando'}
          </div>
        : (
          <ul className="@container overflow-hidden rounded-xl border bg-card" aria-label="Incidentes">
            <li aria-hidden="true" className={cn('hidden items-center gap-x-4 border-b px-4 py-2 text-[12.5px] font-medium text-muted-foreground @min-[66rem]:grid', PISTAS)}>
              <span>Severidad</span><span>Código</span><span>Qué pasa</span><span>Origen</span><span>Eventos</span><span>Empezó</span><span>Estado</span><span>Cronómetro</span><span />
            </li>
            {lista.map((i) => {
              const est = estadoInc(i.status);
              return (
                <li key={i.id} className={cn('border-b last:border-b-0 transition-colors', nuevo?.id === i.id && 'bg-info-relleno outline-2 -outline-offset-2 outline-info')}>
                  {/* Absoluta y codificada: un id «//host/x» relativo saldría como enlace externo. */}
                  <Link to={`/o/${org.id}/incidents/${encodeURIComponent(i.id)}`} className={cn('grid grid-cols-1 items-center gap-x-4 gap-y-1.5 px-4 py-3 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring', PISTAS)}>
                    <ChapaSeveridad severity={i.severity} />
                    <span className="font-mono text-[13px]">{sinBidi(i.code)}</span>
                    <span className="text-[15px] font-medium wrap-anywhere">{sinBidi(i.title)}</span>
                    <span className="truncate font-mono text-[13px] text-muted-foreground"><bdi dir="ltr">{sinBidi(origen(i.resource))}</bdi></span>
                    <span className="text-sm tabular-nums">{miles(i.event_count)} <span className="text-texto-3 @min-[66rem]:sr-only">eventos</span></span>
                    <span className="text-sm text-muted-foreground tabular-nums">{cuando(i.started_at)}</span>
                    <Etiqueta texto={est.texto} rol={est.rol} className="w-fit" />
                    {abierto(i) ? <Cronometro desde={i.started_at} hasta={null} className="text-base" /> : <span className="text-texto-3">—</span>}
                    <ChevronRight className="hidden size-4 text-texto-3 @min-[66rem]:block" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      <GuiaModulo id="incidents" />
    </div>
  );
}
