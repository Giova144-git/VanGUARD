import { Check } from 'lucide-react';
import type { CheckDato } from '@vanguard/contracts';
import { miles } from '@/lib/formato';

// «Revisado» (S14 §14.7, L4): verde con ✓ solo si `comprobado`; si no, neutro con «—» o el número.
export function ChecksEnCero({ checks }: { checks: CheckDato[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {checks.map((c) => (
        <li key={c.codigo} className="flex min-h-12 items-center gap-3 rounded-lg border bg-card px-3" title={c.codigo}>
          {c.comprobado
            ? <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-bien-relleno text-bien"><Check className="size-4" aria-label="Comprobado" /></span>
            : <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[12.5px] text-texto-3">—</span>}
          <span className="flex-1 text-sm">{c.nombre}</span>
          <span className="text-sm tabular-nums text-muted-foreground">{c.n == null ? '—' : c.de != null ? `${miles(c.n)} de ${miles(c.de)}` : miles(c.n)}</span>
        </li>
      ))}
    </ul>
  );
}
