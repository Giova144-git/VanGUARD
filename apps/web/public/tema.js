// Pone o quita .dark antes del primer pintado (oscuro por defecto). Va como archivo aparte: la CSP no admite JS en línea.
try {
  if (localStorage.getItem('vg-tema') === 'claro') document.documentElement.classList.remove('dark');
  else document.documentElement.classList.add('dark');
} catch (e) {
  document.documentElement.classList.add('dark');
}
