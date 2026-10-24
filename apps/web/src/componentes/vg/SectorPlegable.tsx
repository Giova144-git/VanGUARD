import { useState, type ReactNode } from 'react';
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// Sector que se pliega (S14 §14.7): plegado no renderiza el cuerpo. `recuerdo` guarda el estado en localStorage.
export function SectorPlegable({ titulo, icono: Icono, defaultOpen = false, recuerdo, children }:
  { titulo: string; icono?: LucideIcon; defaultOpen?: boolean; recuerdo?: string; children: ReactNode }) {
  const [abierto, setAbierto] = useState(() => {
    if (!recuerdo) return defaultOpen;
    try { const v = localStorage.getItem(recuerdo); return v == null ? defaultOpen : v === '1'; } catch { return defaultOpen; }
  });
  const cambiar = (v: boolean) => {
    setAbierto(v);
    if (recuerdo) try { localStorage.setItem(recuerdo, v ? '1' : '0'); } catch { /* sin almacenamiento */ }
  };
  return (
    <CollapsiblePrimitive.Root open={abierto} onOpenChange={cambiar} className="rounded-xl border bg-card">
      <CollapsiblePrimitive.Trigger className="flex min-h-14 w-full items-center gap-3 px-5 text-left text-[17px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {Icono ? <Icono className="size-5 text-info" /> : null}
        <span className="flex-1">{titulo}</span>
        <ChevronDown className={cn('size-5 text-texto-3 transition-transform', abierto && 'rotate-180')} />
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="px-5 pb-5">{abierto ? children : null}</CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
