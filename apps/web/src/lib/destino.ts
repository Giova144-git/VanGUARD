// Destino del servidor → ruta (S14 §14.12): /o/{org}/{modulo} + ?filtro= + #ancla; incidents y findings con filtro = id.
import type { Destino } from '@vanguard/contracts';

export function rutaDe(org: string, d: Destino, aqui?: string): string {
  const filtro = typeof d.filtro === 'string' ? d.filtro : undefined;      // si llega como objeto, se ignora
  const ancla = d.ancla ? `#${encodeURIComponent(d.ancla)}` : '';
  if (d.modulo === 'incidents' && filtro) return `/o/${org}/incidents/${encodeURIComponent(filtro)}`;
  if (d.modulo === 'findings' && filtro) return `${aqui ?? `/o/${org}/overview`}?finding=${encodeURIComponent(filtro)}`;
  return `/o/${org}/${encodeURIComponent(d.modulo)}${filtro ? `?filtro=${encodeURIComponent(filtro)}` : ''}${ancla}`;
}
