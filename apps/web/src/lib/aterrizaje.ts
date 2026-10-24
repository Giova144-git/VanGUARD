// A dónde va el usuario tras entrar (S14 §14.4): next → última org usada → primera org propia → /start.
import type { Me } from '@vanguard/contracts';

export const ULTIMA_ORG = 'vg-ultima-org';           // comodidad por navegador, no es un dato sensible

// Lo que supabase-js deja en la URL si falla un canje PKCE: el ?code= no puede acabar copiado en next ni en el historial.
const PARAMS_AUTH = ['code', 'error', 'error_code', 'error_description', 'flow_id'];

export function nextDe(pathname: string, search: string): string {
  const q = new URLSearchParams(search);
  PARAMS_AUTH.forEach((p) => q.delete(p));
  const resto = q.toString();
  return resto ? `${pathname}?${resto}` : pathname;
}

// Origen ficticio con el que se resuelve next. El host da igual: solo cuenta si la URL resultante sale de él, y con
// https o http (producción o dev) el parser lee la ruta igual.
const BASE = 'https://vanguard.invalid';

// next como ruta interna ya normalizada, o null. Decide el propio parser de URL, igual que el navegador: borra tab, LF y CR
// ('/\t/host' es //host), lee '\' como '/' y resuelve los '..' ('/..//host' deja la ruta //host, que react-router da por
// externa). Por eso se descartan los controles y '\', y la ruta normalizada tampoco puede empezar por //.
function rutaInterna(next: string): string | null {
  if (!next.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(next)) return null;
  try {
    const u = new URL(next, BASE);
    const ruta = u.pathname + u.search + u.hash;
    return u.origin === BASE && !ruta.startsWith('//') ? ruta : null;
  } catch {
    return null;
  }
}

export function destinoTrasEntrar(me: Me, next: string | null): string {
  const interna = next ? rutaInterna(next) : null;
  if (interna) return interna;
  let ultima: string | null = null;
  try { ultima = localStorage.getItem(ULTIMA_ORG); } catch { /* sin almacenamiento */ }
  if (ultima && me.orgs.some((o) => o.id === ultima)) return `/o/${ultima}`;
  const propia = me.orgs.find((o) => !o.is_demo)
    ?? me.orgs.find((o) => o.role !== 'viewer');                              // dueño o admin de la org de demo (equipo)
  return propia ? `/o/${propia.id}` : '/start';
}
