import type { Contador } from '@vanguard/contracts';
import { cn } from '@/lib/utils';

// Marcas del riel (S14 §14.5): rojo > 0 → píldora tinte rojo; aviso + cola > 0 → número ámbar; todo 0 → «0»; null → «—».
export function MarcasContador({ contador, grande }: { contador: Contador | null | undefined; grande?: boolean }) {
  const t = grande ? 'text-sm' : 'text-[12.5px]';
  if (!contador || (contador.rojo == null && contador.aviso == null && contador.cola == null))
    return <span className={cn(t, 'text-texto-3 tabular-nums')} aria-label="Sin dato">—</span>;
  const rojo = contador.rojo ?? 0, ambar = (contador.aviso ?? 0) + (contador.cola ?? 0);
  const etiqueta = `Rojo ${rojo} · Ámbar ${ambar}`;
  if (rojo > 0)
    return <span aria-label={etiqueta} className={cn(t, 'inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-mal-borde bg-mal-relleno px-1.5 font-semibold text-mal tabular-nums')}>{rojo}</span>;
  if (ambar > 0) return <span aria-label={etiqueta} className={cn(t, 'font-semibold text-aviso tabular-nums')}>{ambar}</span>;
  return <span aria-label={etiqueta} className={cn(t, 'text-texto-3 tabular-nums')}>0</span>;
}

// Variante para un número suelto (Incidentes abiertos, Conexiones que faltan).
export function MarcaNumero({ n, rojo }: { n: number | null | undefined; rojo?: boolean }) {
  if (n == null) return <span className="text-[12.5px] text-texto-3">—</span>;
  if (rojo && n > 0)
    return <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-mal-borde bg-mal-relleno px-1.5 text-[12.5px] font-semibold text-mal tabular-nums">{n}</span>;
  return <span className="text-[12.5px] text-texto-3 tabular-nums">{n}</span>;
}
