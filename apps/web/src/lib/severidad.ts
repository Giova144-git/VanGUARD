// Severidad → rol, etiqueta e icono (S14 §14.6). Solo donde la API manda `severity` y no `rol`.
import { CircleAlert, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Severity } from '@vanguard/contracts';

export type Rol = 'mal' | 'aviso' | 'cola' | 'bien' | 'neutra' | 'info';

export const SEVERIDAD: Record<Severity, { etiqueta: string; rol: Rol; icono: LucideIcon; fuerte?: boolean }> = {
  critical: { etiqueta: 'Crítica', rol: 'mal', icono: OctagonAlert, fuerte: true },
  high: { etiqueta: 'Alta', rol: 'mal', icono: TriangleAlert },
  medium: { etiqueta: 'Media', rol: 'aviso', icono: CircleAlert },
  low: { etiqueta: 'Baja', rol: 'cola', icono: Info },
  info: { etiqueta: 'Info', rol: 'neutra', icono: Info },
};

// api() en producción deja pasar cuerpos fuera de contrato: un enum desconocido (o «__proto__») cae al respaldo, nunca a
// undefined ni al prototipo. El respaldo de cada sitio es neutro: «—» y sin rojo ni ámbar (L3).
export const deMapa = <K extends string, V>(m: Record<K, V>, k: unknown, respaldo: NoInfer<V>): V =>
  typeof k === 'string' && Object.hasOwn(m, k) ? m[k as K] : respaldo;
export type DatosSeveridad = { etiqueta: string; rol: Rol; icono?: LucideIcon; fuerte?: boolean };
export const severidad = (s: unknown) => deMapa<Severity, DatosSeveridad>(SEVERIDAD, s, { etiqueta: '—', rol: 'neutra' });

// Clases de tinte por rol: el rojo nunca es relleno sólido (L3).
export const TINTE: Record<Rol, string> = {
  mal: 'bg-mal-relleno text-mal border-mal-borde',
  aviso: 'bg-aviso-relleno text-aviso border-aviso-borde',
  cola: 'bg-transparent text-aviso border-border',
  bien: 'bg-bien-relleno text-bien border-border',
  neutra: 'bg-muted text-muted-foreground border-border',
  info: 'bg-info-relleno text-info border-border',
};

export const esRol = (r: unknown): r is Rol => typeof r === 'string' && Object.hasOwn(TINTE, r);

export const TEXTO_ROL: Record<Rol, string> = {
  mal: 'text-mal', aviso: 'text-aviso', cola: 'text-aviso', bien: 'text-bien', neutra: 'text-muted-foreground', info: 'text-info',
};
