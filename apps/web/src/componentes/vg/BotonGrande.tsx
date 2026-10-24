import { ChevronRight, type LucideIcon } from 'lucide-react';
import { Spinner } from '@/componentes/ui/spinner';
import { TEXTO_ROL, type Rol } from '@/lib/severidad';
import { cn } from '@/lib/utils';

type Props = {
  titulo: string;
  descripcion?: string;
  icono: LucideIcon;
  estado?: { texto: string; rol: Rol };
  ocupado?: boolean;
  deshabilitado?: string;        // motivo, se ve en la ayuda
  onClick?: () => void;
  className?: string;
};

// Tarjeta-botón de 64 px (S14 §14.7, L8).
export function BotonGrande({ titulo, descripcion, icono: Icono, estado, ocupado, deshabilitado, onClick, className }: Props) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <button type="button" onClick={onClick} disabled={!!deshabilitado} aria-busy={ocupado || undefined}
        className="flex min-h-16 w-full items-center gap-4 rounded-xl border bg-card px-4 py-3 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:hover:bg-card">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-info-relleno text-info">
          {ocupado ? <Spinner className="size-5" /> : <Icono className="size-6" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-semibold">{titulo}</span>
          {descripcion ? <span className="text-sm text-muted-foreground">{descripcion}</span> : null}
        </span>
        {estado ? <span className={cn('text-sm font-medium', TEXTO_ROL[estado.rol])}>{estado.texto}</span> : null}
        <ChevronRight className="size-5 shrink-0 text-texto-3" />
      </button>
      {deshabilitado ? <span className="text-[12.5px] text-texto-3">{deshabilitado}</span> : null}
    </div>
  );
}
