// Interruptor (role="switch") de Ajustes y de la revisión de código. `ocupado`: mientras se guarda, no se puede volver a
// pulsar y lo anuncia con aria-busy.
import { cn } from '@/lib/utils';

export function Interruptor({ activo, onCambio, etiqueta, ocupado }: {
  activo: boolean; onCambio: (v: boolean) => void; etiqueta: string; ocupado?: boolean;
}) {
  return (
    <button type="button" role="switch" aria-checked={activo} aria-label={etiqueta} onClick={() => onCambio(!activo)}
      disabled={ocupado} aria-busy={ocupado || undefined}
      className={cn('relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
        activo ? 'border-foreground bg-muted' : 'bg-muted')}>
      <span className={cn('inline-block size-5 rounded-full transition-transform', activo ? 'translate-x-6 bg-info' : 'translate-x-1 bg-borde-fuerte')} />
    </button>
  );
}
