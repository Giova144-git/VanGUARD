// v2-regresion (deliberada, S10 10.11): un «widget» que ocupa el hilo principal ~250 ms al cargar (hilo_principal).
(function () {
  var fin = Date.now() + 250, n = 0;
  while (Date.now() < fin) n += Math.sqrt(n + 1);
  var caja = document.createElement('div');
  caja.textContent = 'Ofertas de la semana';
  caja.setAttribute('data-n', String(n | 0));
  document.body.insertBefore(caja, document.body.firstChild);   // empuja el contenido: más layout_inestable
})();
