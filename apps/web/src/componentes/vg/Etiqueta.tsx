import type { LucideIcon } from 'lucide-react';
import type { Severity } from '@vanguard/contracts';
import { sinBidi } from '@/lib/bidi';
import { TINTE, deMapa, severidad, type Rol } from '@/lib/severidad';
import { cn } from '@/lib/utils';

// Chapa de 24 px con tinte del rol (S14 §14.7). El color nunca es la única señal: siempre texto (+ icono si lo hay).
// `grande` (32 px) para la cabecera del detalle, que se proyecta (§14.16 «ChapaSeveridad grande»).
// Identidad (brand/README.md): etiqueta en Geist Mono mayúsculas con espaciado; 12,5 px como mínimo (F-15, proyector).
// Los controles bidi del texto se ven aquí dentro (lib/bidi.ts): chips y chapas del servidor pasan por esta chapa.
// `ltr`: un nombre técnico al final del texto (la rama de «✗ Ya está en {rama}»): en <bdi dir="ltr">, sin mayúsculas y
// partiendo donde haga falta, como ChipRepo.
export function Etiqueta({ texto, rol = 'neutra', icono: Icono, grande, className, ltr }:
  { texto: string; rol?: Rol; icono?: LucideIcon; mono?: boolean /* ya siempre mono; se acepta por compatibilidad */; grande?: boolean; className?: string; ltr?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-lg border font-mono font-medium uppercase tracking-[0.08em]', grande ? 'h-8 gap-1.5 px-3 text-sm' : 'h-6 gap-1 px-2 text-[12.5px]',
      deMapa(TINTE, rol, TINTE.neutra), className)}>
      {Icono ? <Icono className={grande ? 'size-4' : 'size-3.5'} /> : null}
      {typeof ltr === 'string'
        ? <span>{sinBidi(texto)} <bdi dir="ltr" className="normal-case break-all">{sinBidi(ltr)}</bdi></span>
        : typeof texto === 'string' ? sinBidi(texto) : texto}
    </span>
  );
}

// Una severidad fuera de contrato sale «—», neutra y sin icono (L3).
export function ChapaSeveridad({ severity, grande }: { severity: Severity; grande?: boolean }) {
  const s = severidad(severity);
  return <Etiqueta texto={s.etiqueta} rol={s.rol} icono={s.icono} grande={grande} className={s.fuerte ? 'font-semibold' : undefined} />;
}
