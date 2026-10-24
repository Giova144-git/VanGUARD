// v1-sana: JS mínimo y diferido. Solo marca el año del pie.
document.addEventListener('DOMContentLoaded', () => {
  const pie = document.querySelector('footer p');
  if (pie) pie.dataset.anio = String(new Date().getFullYear());
});
