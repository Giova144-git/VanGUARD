import type { LucideIcon } from 'lucide-react';
import type { Severity } from '@vanguard/contracts';
import { SEVERIDAD, TINTE, type Rol } from '@/lib/severidad';
import { cn } from '@/lib/utils';

// Chapa de 24 px con tinte del rol (S14 §14.7). El color nunca es la única señal: siempre texto (+ icono si lo hay).
export function Etiqueta({ texto, rol = 'neutra', icono: Icono, mono, className }:
  { texto: string; rol?: Rol; icono?: LucideIcon; mono?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex h-6 shrink-0 items-center gap-1 rounded-lg border px-2 text-[12.5px] font-medium', TINTE[rol], mono && 'font-mono', className)}>
      {Icono ? <Icono className="size-3.5" /> : null}
      {texto}
    </span>
  );
}

export function ChapaSeveridad({ severity }: { severity: Severity }) {
  const s = SEVERIDAD[severity];
  return <Etiqueta texto={s.etiqueta} rol={s.rol} icono={s.icono} className={s.fuerte ? 'font-semibold' : undefined} />;
}
