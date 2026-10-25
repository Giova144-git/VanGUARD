// Bandeja «Ahora» de un módulo (S14 §14.12): grupos → filas → acciones que trae el servidor (L1).
import { Link, useLocation } from 'react-router';
import { ChevronRight } from 'lucide-react';
import type { AccionDato, FilaDato, GrupoDato } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { rutaDe } from '@/lib/destino';
import { TEXTO_ROL, esRol, type Rol } from '@/lib/severidad';
import { cn } from '@/lib/utils';
import { BotonAccion } from './BotonAccion';
import { BotonCopiar } from './BotonCopiar';
import { ChapaSeveridad, Etiqueta } from './Etiqueta';
import { PuntoEstado } from './PuntoEstado';

// L3: rojo o ámbar solo con una acción al lado; sin acción, o con un rol fuera de contrato, se pinta neutro.
export const rolVisible = (rol: Rol, acciones: unknown[]): Rol =>
  !esRol(rol) || ((rol === 'mal' || rol === 'aviso') && acciones.length === 0) ? 'neutra' : rol;
// El color nunca es la única señal (S14 §14.6): el punto lleva nombre para el lector.
const nombreRol = (rol: Rol) => (rol === 'mal' ? 'Urgente' : rol === 'aviso' ? 'Aviso' : undefined);

// Mismo lenguaje que button.tsx (brand/README.md): píldora, mono en mayúsculas y, el principal, en monocromo.
const enlace = 'inline-flex h-11 items-center gap-1 rounded-full border px-4 font-mono text-[13px] font-medium uppercase tracking-[0.06em] outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function AccionFila({ accion, puedeEscribir }: { accion: AccionDato; puedeEscribir: boolean }) {
  const org = useOrg();
  const loc = useLocation();
  const estilo = accion.principal ? 'border-foreground bg-transparent text-foreground hover:bg-muted' : 'bg-card hover:bg-muted';
  // El verbo lo manda el servidor: sus controles bidi se ven (lib/bidi.ts). Lo que se copia se queda tal cual llega.
  const verbo = typeof accion.verbo === 'string' ? sinBidi(accion.verbo) : undefined;
  switch (accion.clase) {
    case 'prompt': {
      const id = typeof accion.args?.finding_id === 'string' ? accion.args.finding_id : null;
      return id ? <Link to={`${loc.pathname}?finding=${encodeURIComponent(id)}`} className={cn(enlace, estilo)}>{verbo}<ChevronRight className="size-4" /></Link> : null;
    }
    case 'copiar':
      return accion.copiar ? <BotonCopiar valor={accion.copiar} texto={verbo} /> : null;
    case 'navegar':
      return accion.destino ? <Link to={rutaDe(org.id, accion.destino, loc.pathname)} className={cn(enlace, estilo)}>{verbo}<ChevronRight className="size-4" /></Link> : null;
    case 'confirmar': {
      // block_ip con simulación y código llega con Incidentes (hito 5); mientras tanto se lleva al incidente.
      const inc = typeof accion.args?.incident_id === 'string' ? accion.args.incident_id : null;
      if (accion.args?.kind === 'block_ip' && inc)
        return puedeEscribir
          ? <Link to={`/o/${org.id}/incidents/${encodeURIComponent(inc)}`} className={cn(enlace, 'border-mal-borde bg-mal-relleno text-mal hover:bg-mal/15')}>{verbo}<ChevronRight className="size-4" /></Link>
          : <BotonAccion variante="peligro" disabled ayuda={SOLO_LECTURA}>{verbo}</BotonAccion>;
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
      <PuntoEstado rol={rol} etiqueta={nombreRol(rol)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('text-[15px] font-medium wrap-anywhere', rol === 'neutra' ? '' : TEXTO_ROL[rol])}>{sinBidi(fila.etiqueta)}</span>
          {fila.severidad_cve ? <ChapaSeveridad severity={fila.severidad_cve} /> : null}
          {fila.chips?.map((c) => <Etiqueta key={c} texto={c} />)}
        </div>
        {fila.objeto ? <span className="truncate font-mono text-[13px] text-muted-foreground"><bdi dir="ltr">{sinBidi(fila.objeto)}</bdi></span> : null}
        {fila.sub ? <span className="text-[12.5px] text-texto-3 wrap-anywhere">{sinBidi(fila.sub)}</span> : null}
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

// Vacía: «✓ Nada que atender» solo si el módulo se miró; si ningún chequeo se comprobó en una auditoría terminada,
// «Sin revisar» en gris (nunca verde sin mirar), con «Revisar ahora». La hora va una sola vez, en la barra del módulo.
export function Bandeja({ grupos, puedeEscribir, filtro, sinRevisar, enlaceRevisar }: {
  grupos: GrupoDato[] | null; puedeEscribir: boolean; filtro?: string | null; sinRevisar?: boolean; enlaceRevisar?: string;
}) {
  if (!grupos) return <div className="rounded-xl border bg-card px-4 py-6 text-texto-3">—</div>;
  const f = filtro?.toLowerCase();
  const casa = (x: FilaDato) => !f || [x.objeto, x.etiqueta, x.sub].some((t) => t?.toLowerCase().includes(f));
  // Los grupos se pintan en el orden en que llegan: el servidor ya los ordena (L1).
  const visibles = grupos.map((g) => ({ ...g, filas: g.filas.filter(casa) })).filter((g) => g.filas.length > 0);
  if (visibles.length === 0 && sinRevisar && !f) return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-5 text-[15px] text-muted-foreground">
      <span className="flex-1 basis-64">Sin revisar: ninguna auditoría terminada ha mirado este módulo todavía.</span>
      {enlaceRevisar ? <Link to={enlaceRevisar} className={cn(enlace, 'border-foreground text-foreground hover:bg-muted')}>Revisar ahora<ChevronRight className="size-4" /></Link> : null}
    </div>
  );
  if (visibles.length === 0)
    return <div className="rounded-xl border bg-card px-4 py-6 text-[15px] text-muted-foreground">0 ✓ Nada que atender</div>;
  return (
    <div className="flex flex-col gap-4">
      {visibles.map((g) => {
        const rol = rolVisible(g.rol, g.filas.flatMap((x) => x.acciones));
        return (
          <section key={g.grupo} className="overflow-hidden rounded-xl border bg-card" aria-label={sinBidi(g.etiqueta)}>
            <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
              <PuntoEstado rol={rol} etiqueta={nombreRol(rol)} />
              <h4 className="flex-1 text-sm font-semibold wrap-anywhere">{sinBidi(g.etiqueta)}</h4>
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
