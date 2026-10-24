import type { LucideIcon } from 'lucide-react';
import type { Severity } from '@vanguard/contracts';
import { SEVERIDAD, TINTE, type Rol } from '@/lib/severidad';
import { cn } from '@/lib/utils';

// Chapa de 24 px con tinte del rol (S14 §14.7). El color nunca es la única señal: siempre texto (+ icono si lo hay).
// `grande` (32 px) para la cabecera del detalle, que se proyecta (§14.16 «ChapaSeveridad grande»).
export function Etiqueta({ texto, rol = 'neutra', icono: Icono, mono, grande, className }:
  { texto: string; rol?: Rol; icono?: LucideIcon; mono?: boolean; grande?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-lg border font-medium', grande ? 'h-8 gap-1.5 px-3 text-sm' : 'h-6 gap-1 px-2 text-[12.5px]',
      TINTE[rol], mono && 'font-mono', className)}>
      {Icono ? <Icono className={grande ? 'size-4' : 'size-3.5'} /> : null}
      {texto}
    </span>
  );
}

export function ChapaSeveridad({ severity, grande }: { severity: Severity; grande?: boolean }) {
  const s = SEVERIDAD[severity];
  return <Etiqueta texto={s.etiqueta} rol={s.rol} icono={s.icono} grande={grande} className={s.fuerte ? 'font-semibold' : undefined} />;
}
