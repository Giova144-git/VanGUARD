import type * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { TEXTO_ROL, type Rol } from '@/lib/severidad';
import { cn } from '@/lib/utils';

type Props = Omit<React.ComponentProps<'button'>, 'children'> & {
  variante?: 'marca' | 'principal' | 'secundaria' | 'peligro';
  tam?: 'fila' | 'grande';
  icono?: LucideIcon;
  ocupado?: boolean;
  resultado?: { texto: string; rol: Rol } | null;   // tras actuar, el resultado se pinta en su sitio (L6)
  ayuda?: string;                                    // motivo visible cuando está deshabilitado
  children: React.ReactNode;
};

// S14 §14.7. Ocupado ≠ deshabilitado: aria-busy y mismos colores, con Spinner delante.
export function BotonAccion({ variante = 'secundaria', tam = 'fila', icono: Icono, ocupado, resultado, ayuda, children, className, disabled, ...props }: Props) {
  if (resultado) return <span className={cn('inline-flex items-center text-sm font-medium', tam === 'grande' ? 'h-14' : 'h-11', TEXTO_ROL[resultado.rol])}>{resultado.texto}</span>;
  return (
    <span className="inline-flex flex-col gap-1">
      <Button variant={variante} size={tam} aria-busy={ocupado || undefined} disabled={disabled} className={className}
        onClick={ocupado ? (e) => e.preventDefault() : undefined} {...props}>
        {ocupado ? <Spinner /> : Icono ? <Icono /> : null}
        {children}
      </Button>
      {disabled && ayuda ? <span className="text-[12.5px] text-texto-3">{ayuda}</span> : null}
    </span>
  );
}
