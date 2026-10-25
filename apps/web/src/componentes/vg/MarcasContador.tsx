import type { Contador } from '@vanguard/contracts';
import { cn } from '@/lib/utils';

// Marcas del riel (S14 §14.5): rojo > 0 → píldora tinte rojo; aviso + cola > 0 → número ámbar; todo 0 → «0»; null → «—».
// role=img: sin rol, el aria-label de un <span> no se lee y el riel diría solo el número. El rojo cuenta críticos y altos,
// no todos los abiertos: lo dice el tooltip (UX P1-7). `sinRevisar` (módulo sin conectar o sin mirar): «—», nunca «0» (P1-8).
export function MarcasContador({ contador, grande, sinRevisar }: { contador: Contador | null | undefined; grande?: boolean; sinRevisar?: boolean }) {
  const t = grande ? 'text-sm' : 'text-[12.5px]';
  const rojo = contador?.rojo ?? 0, ambar = (contador?.aviso ?? 0) + (contador?.cola ?? 0);
  if (!contador || (contador.rojo == null && contador.aviso == null && contador.cola == null) || (sinRevisar && rojo === 0 && ambar === 0))
    return <span role="img" title={sinRevisar ? 'Sin revisar' : undefined} className={cn(t, 'text-texto-3 tabular-nums')} aria-label={sinRevisar ? 'Sin revisar' : 'Sin dato'}>—</span>;
  const etiqueta = `${rojo} ${rojo === 1 ? 'crítico o alto' : 'críticos y altos'} · ${ambar} ${ambar === 1 ? 'medio o bajo' : 'medios y bajos'}`;
  if (rojo > 0)
    return <span role="img" aria-label={etiqueta} title={etiqueta} className={cn(t, 'inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-mal-borde bg-mal-relleno px-1.5 font-semibold text-mal tabular-nums')}>{rojo}</span>;
  if (ambar > 0) return <span role="img" aria-label={etiqueta} title={etiqueta} className={cn(t, 'font-semibold text-aviso tabular-nums')}>{ambar}</span>;
  return <span role="img" aria-label={etiqueta} className={cn(t, 'text-texto-3 tabular-nums')}>0</span>;
}

// Variante para un número suelto (Incidentes abiertos, Conexiones que faltan).
export function MarcaNumero({ n, rojo }: { n: number | null | undefined; rojo?: boolean }) {
  if (n == null) return <span className="text-[12.5px] text-texto-3">—</span>;
  if (rojo && n > 0)
    return <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-mal-borde bg-mal-relleno px-1.5 text-[12.5px] font-semibold text-mal tabular-nums">{n}</span>;
  return <span className="text-[12.5px] text-texto-3 tabular-nums">{n}</span>;
}
