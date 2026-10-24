// Pone o quita .dark antes del primer pintado (oscuro por defecto). Va como archivo aparte: la CSP no admite JS en línea.
// vg-tema: 'claro' | 'oscuro' | 'sistema' (sigue a prefers-color-scheme).
try {
  var t = localStorage.getItem('vg-tema');
  var claro = t === 'claro' || (t === 'sistema' && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.classList.toggle('dark', !claro);
} catch (e) {
  document.documentElement.classList.add('dark');
}
