import { cn } from '@/lib/utils';
import type { Rol } from '@/lib/severidad';

const RELLENO: Partial<Record<Rol, string>> = { mal: 'bg-mal/80', aviso: 'bg-aviso/70', cola: 'bg-aviso/35', neutra: 'bg-borde-fuerte' };

// Barra de 8 px + leyenda «Crítica 2 · Alta 3» (S14 §14.7). El tramo crítico lleva borde mal-borde.
// n = null (aún cargando) → «—» en la leyenda y barra vacía, con el mismo alto (L4, L7).
export function BarraSegmentada({ tramos, 'data-info': info }: { tramos: { etiqueta: string; n: number | null; rol: Rol; fuerte?: boolean }[]; 'data-info'?: string }) {
  const total = tramos.reduce((s, t) => s + (t.n ?? 0), 0);
  return (
    <div className="flex flex-col gap-2" data-info={info}>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img"
        aria-label={tramos.map((t) => `${t.etiqueta} ${t.n ?? 'sin dato'}`).join(' · ')}>
        {total > 0 ? tramos.filter((t) => (t.n ?? 0) > 0).map((t) => (
          <span key={t.etiqueta} className={cn('h-full', RELLENO[t.rol], t.fuerte && 'outline outline-1 -outline-offset-1 outline-mal-borde')}
            style={{ width: `${((t.n ?? 0) / total) * 100}%` }} />
        )) : null}
      </div>
      <p className="text-[12.5px] text-muted-foreground tabular-nums">
        {tramos.map((t, i) => <span key={t.etiqueta}>{i ? ' · ' : ''}{t.etiqueta} <span className={cn('font-semibold', t.n == null ? 'text-texto-3' : 'text-foreground')}>{t.n ?? '—'}</span></span>)}
      </p>
    </div>
  );
}
