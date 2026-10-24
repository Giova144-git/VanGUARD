// Tema Claro / Oscuro / Sistema (S14 §14.18): la misma regla que public/tema.js, aplicada en caliente.
export type Tema = 'claro' | 'oscuro' | 'sistema';

export function leerTema(): Tema {
  try { const t = localStorage.getItem('vg-tema'); return t === 'claro' || t === 'sistema' ? t : 'oscuro'; } catch { return 'oscuro'; }
}

export function aplicarTema(t: Tema) {
  try { localStorage.setItem('vg-tema', t); } catch { /* sin almacenamiento */ }
  const claro = t === 'claro' || (t === 'sistema' && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.classList.toggle('dark', !claro);
}
