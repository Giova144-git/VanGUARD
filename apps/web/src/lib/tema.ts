// Tema Claro / Oscuro / Sistema (S14 §14.18): la misma regla que public/tema.js, aplicada en caliente.
export type Tema = 'claro' | 'oscuro' | 'sistema';

export function leerTema(): Tema {
  try { const t = localStorage.getItem('vg-tema'); return t === 'claro' || t === 'sistema' ? t : 'oscuro'; } catch { return 'oscuro'; }
}

// Modo presentación (P1 de §14.5): html { font-size: 112.5% } para el proyector; todo está en rem.
export function leerPresentacion(): boolean {
  try { return localStorage.getItem('vg-presentacion') === '1'; } catch { return false; }
}
export function aplicarPresentacion(si: boolean) {
  try { localStorage.setItem('vg-presentacion', si ? '1' : '0'); } catch { /* sin almacenamiento */ }
  document.documentElement.classList.toggle('presentacion', si);
}

export function aplicarTema(t: Tema) {
  try { localStorage.setItem('vg-tema', t); } catch { /* sin almacenamiento */ }
  const claro = t === 'claro' || (t === 'sistema' && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.classList.toggle('dark', !claro);
}
