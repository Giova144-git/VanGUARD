// A dónde va el usuario tras entrar (S14 §14.4): next → última org usada → primera org propia → /start.
import type { Me } from '@vanguard/contracts';

export const ULTIMA_ORG = 'vg-ultima-org';           // comodidad por navegador, no es un dato sensible

export function destinoTrasEntrar(me: Me, next: string | null): string {
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;   // solo rutas internas: nada de open redirect
  let ultima: string | null = null;
  try { ultima = localStorage.getItem(ULTIMA_ORG); } catch { /* sin almacenamiento */ }
  if (ultima && me.orgs.some((o) => o.id === ultima)) return `/o/${ultima}`;
  const propia = me.orgs.find((o) => !o.is_demo)
    ?? me.orgs.find((o) => o.role !== 'viewer');                              // dueño o admin de la org de demo (equipo)
  return propia ? `/o/${propia.id}` : '/start';
}
