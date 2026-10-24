// Bandeja «Ahora» de un módulo (S14 §14.12): grupos → filas → acciones que trae el servidor (L1).
import { Link, useLocation } from 'react-router';
import { ChevronRight } from 'lucide-react';
import type { AccionDato, FilaDato, GrupoDato } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { useOrg } from '@/app/guardas';
import { rutaDe } from '@/lib/destino';
import { SEP, cuando } from '@/lib/formato';
import { TEXTO_ROL, type Rol } from '@/lib/severidad';
import { cn } from '@/lib/utils';
import { BotonCopiar } from './BotonCopiar';
import { ChapaSeveridad, Etiqueta } from './Etiqueta';
import { PuntoEstado } from './PuntoEstado';

// L3: rojo o ámbar solo con una acción al lado; sin acción se pinta neutro.
export const rolVisible = (rol: Rol, acciones: unknown[]): Rol => (rol === 'mal' || rol === 'aviso') && acciones.length === 0 ? 'neutra' : rol;

const enlace = 'inline-flex h-11 items-center gap-1 rounded-lg border px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function AccionFila({ accion, puedeEscribir }: { accion: AccionDato; puedeEscribir: boolean }) {
  const org = useOrg();
  const loc = useLocation();
  const estilo = accion.principal ? 'border-info bg-info-relleno text-info hover:bg-info/15' : 'bg-card hover:bg-muted';
  switch (accion.clase) {
    case 'prompt': {
      const id = typeof accion.args?.finding_id === 'string' ? accion.args.finding_id : null;
      return id ? <Link to={`${loc.pathname}?finding=${encodeURIComponent(id)}`} className={cn(enlace, estilo)}>{accion.verbo}<ChevronRight className="size-4" /></Link> : null;
    }
    case 'copiar':
      return accion.copiar ? <BotonCopiar valor={accion.copiar} texto={accion.verbo} /> : null;
    case 'navegar':
      return accion.destino ? <Link to={rutaDe(org.id, accion.destino, loc.pathname)} className={cn(enlace, estilo)}>{accion.verbo}<ChevronRight className="size-4" /></Link> : null;
    case 'confirmar': {
      // block_ip con simulación y código llega con Incidentes (hito 5); mientras tanto se lleva al incidente.
      const inc = typeof accion.args?.incident_id === 'string' ? accion.args.incident_id : null;
      if (accion.args?.kind === 'block_ip' && inc)
        return puedeEscribir
          ? <Link to={`/o/${org.id}/incidents/${encodeURIComponent(inc)}`} className={cn(enlace, 'border-mal-borde bg-mal-relleno text-mal hover:bg-mal/15')}>{accion.verbo}<ChevronRight className="size-4" /></Link>
          : <Button variant="peligro" disabled title="Modo demo: solo lectura">{accion.verbo}</Button>;
      return <Button disabled title="Acción no disponible">Acción no disponible</Button>;
    }
    default:
      return <Button disabled title="Acción no disponible">Acción no disponible</Button>;
  }
}

export function FilaProblema({ fila, puedeEscribir }: { fila: FilaDato; puedeEscribir: boolean }) {
  const rol = rolVisible(fila.rol, fila.acciones);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3 last:border-b-0">
      <PuntoEstado rol={rol} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('text-[15px] font-medium', rol === 'neutra' ? '' : TEXTO_ROL[rol])}>{fila.etiqueta}</span>
          {fila.severidad_cve ? <ChapaSeveridad severity={fila.severidad_cve} /> : null}
          {fila.chips?.map((c) => <Etiqueta key={c} texto={c} />)}
        </div>
        {fila.objeto ? <span className="truncate font-mono text-[13px] text-muted-foreground">{fila.objeto}</span> : null}
        {fila.sub ? <span className="text-[12.5px] text-texto-3">{fila.sub}</span> : null}
        {fila.fraccion != null ? (
          <span className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted" role="img" aria-label={`${Math.round(fila.fraccion * 100)} %`}>
            <span className={cn('block h-full', rol === 'mal' ? 'bg-mal/80' : rol === 'aviso' ? 'bg-aviso/70' : 'bg-borde-fuerte')} style={{ width: `${fila.fraccion * 100}%` }} />
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {fila.acciones.map((a, i) => <AccionFila key={a.id ?? `${a.clase}-${i}`} accion={a} puedeEscribir={puedeEscribir} />)}
      </div>
    </li>
  );
}

export function Bandeja({ grupos, puedeEscribir, filtro, hora }: { grupos: GrupoDato[] | null; puedeEscribir: boolean; filtro?: string | null; hora?: string | null }) {
  if (!grupos) return <div className="rounded-xl border bg-card px-4 py-6 text-texto-3">—</div>;
  const f = filtro?.toLowerCase();
  const casa = (x: FilaDato) => !f || [x.objeto, x.etiqueta, x.sub].some((t) => t?.toLowerCase().includes(f));
  const visibles = [...grupos].sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
    .map((g) => ({ ...g, filas: g.filas.filter(casa) })).filter((g) => g.filas.length > 0);
  if (visibles.length === 0)
    return <div className="rounded-xl border bg-card px-4 py-6 text-[15px] text-muted-foreground">0 ✓ Nada que atender{hora ? `${SEP}revisado ${cuando(hora)}` : ''}</div>;
  return (
    <div className="flex flex-col gap-4">
      {visibles.map((g) => {
        const rol = rolVisible(g.rol, g.filas.flatMap((x) => x.acciones));
        return (
          <section key={g.grupo} className="overflow-hidden rounded-xl border bg-card" aria-label={g.etiqueta}>
            <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
              <PuntoEstado rol={rol} />
              <h4 className="flex-1 text-sm font-semibold">{g.etiqueta}</h4>
              {g.chapas?.map((c) => <Etiqueta key={c} texto={c} />)}
              <span className={cn('text-sm font-semibold tabular-nums', rol === 'neutra' ? 'text-muted-foreground' : TEXTO_ROL[rol])}>{g.n}</span>
            </header>
            <ul>{g.filas.map((x) => <FilaProblema key={x.clave} fila={x} puedeEscribir={puedeEscribir} />)}</ul>
          </section>
        );
      })}
    </div>
  );
}
