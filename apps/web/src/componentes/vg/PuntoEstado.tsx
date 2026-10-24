import { cn } from '@/lib/utils';
import type { Rol } from '@/lib/severidad';

// El punto se pinta con currentColor: no es un relleno de superficie (L3 prohíbe el rojo sólido en superficies).
const COLOR: Record<Rol, string> = { mal: 'bg-current text-mal', aviso: 'bg-current text-aviso', cola: 'bg-aviso/60', bien: 'bg-bien', neutra: 'bg-borde-fuerte', info: 'bg-info' };
const BORDE: Record<Rol, string> = { mal: 'border-mal', aviso: 'border-aviso', cola: 'border-aviso', bien: 'border-bien', neutra: 'border-borde-fuerte', info: 'border-info' };

// Punto de 8 px (S14 §14.7): hueco = pendiente o sin mirar; girando = en curso.
export function PuntoEstado({ rol, hueco, girando, etiqueta }: { rol: Rol; hueco?: boolean; girando?: boolean; etiqueta?: string }) {
  return (
    <span role={etiqueta ? 'img' : undefined} aria-label={etiqueta} aria-hidden={etiqueta ? undefined : true}
      className={cn('inline-block size-2 shrink-0 rounded-full', hueco ? cn('border-2 bg-transparent', BORDE[rol]) : COLOR[rol], girando && 'animate-pulse')} />
  );
}
