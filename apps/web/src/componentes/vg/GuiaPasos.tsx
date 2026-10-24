import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

// Pasos numerados (S14 §14.10). Un paso es «hecho» solo si el servidor lo confirma (L4: verde solo lo comprobado).
export function GuiaPasos({ pasos }: { pasos: { texto: string; hecho: boolean }[] }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="Pasos para empezar">
      {pasos.map((p, i) => (
        <li key={p.texto} className={cn('flex min-h-14 items-center gap-3 rounded-xl border bg-card px-4', p.hecho && 'border-border')}>
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums',
            p.hecho ? 'bg-bien-relleno text-bien' : 'bg-muted text-foreground')}>
            {p.hecho ? <Check className="size-4" aria-label="Hecho" /> : i + 1}
          </span>
          <span className={cn('text-[15px] font-medium', p.hecho && 'text-muted-foreground')}>{p.texto}</span>
        </li>
      ))}
    </ol>
  );
}
