// Atajos de teclado (S14 §14.5, P1): «g» + letra navega y Ctrl+K (Cmd+K en Mac) abre la paleta. Nunca dentro de un campo
// de texto ni con modificadores (F5, Ctrl+F y Ctrl+1…9 son del navegador).
import type { IdNav } from './nav';

export const SECUENCIA_G: Record<string, IdNav> = {
  r: 'overview', s: 'supabase', c: 'cloudflare', o: 'codebase', w: 'wiki', p: 'performance', a: 'audit', i: 'incidents',
};
export const ESPERA_G_MS = 1500;   // tiempo para la segunda tecla tras «g»

export function esEditable(t: EventTarget | null): boolean {
  const el = t as Partial<HTMLElement> | null;
  if (!el || typeof el.tagName !== 'string') return false;                   // window o document: no es un campo
  return !!el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
    || !!el.closest?.('[contenteditable="true"],[role="textbox"],[role="combobox"]');
}

type Tecla = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target'>;
export type Accion = { tipo: 'paleta' } | { tipo: 'ir'; destino: IdNav } | { tipo: 'esperar' } | null;

// Máquina mínima: devuelve qué hacer con la tecla y si queda una «g» pendiente.
export function leerTecla(e: Tecla, gPendiente: boolean): { accion: Accion; gPendiente: boolean } {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') return { accion: { tipo: 'paleta' }, gPendiente: false };
  if (e.ctrlKey || e.metaKey || e.altKey || esEditable(e.target)) return { accion: null, gPendiente: false };
  const k = e.key.toLowerCase();
  if (gPendiente) {
    const destino = SECUENCIA_G[k];
    return { accion: destino && !e.shiftKey ? { tipo: 'ir', destino } : null, gPendiente: false };
  }
  if (k === 'g' && !e.shiftKey) return { accion: { tipo: 'esperar' }, gPendiente: true };
  return { accion: null, gPendiente: false };
}
