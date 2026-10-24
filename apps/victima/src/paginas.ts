import type { PerfVersion } from './perf-version.ts';

// HTML de la tienda de demo. Todo es ficticio y se dice en la propia página (canónicas §11).
export const PRODUCTOS = [
  { id: 1, nombre: 'Café de altura 500 g', precio_usd: 12.5, stock: 40 },
  { id: 2, nombre: 'Taza de cerámica', precio_usd: 8, stock: 120 },
  { id: 3, nombre: 'Molinillo manual', precio_usd: 34.9, stock: 15 },
  { id: 4, nombre: 'Filtros de papel x100', precio_usd: 4.25, stock: 300 },
] as const;

const AVISO = 'Tienda ficticia de la demo de VanGUARD: productos, datos y fallas son simulados.';

// CSS crítico en línea (v1): pocas reglas, sin fuentes externas.
const CSS_CRITICO = 'body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1c2321;background:#f7f6f2}'
  + 'header,main,footer{max-width:960px;margin:0 auto;padding:16px}h1{font-size:1.8rem;margin:.5rem 0}'
  + '.hero{width:100%;height:auto;border-radius:12px;display:block}ul.p{list-style:none;padding:0;display:grid;'
  + 'grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}ul.p li{background:#fff;border-radius:8px;padding:12px}'
  + '.aviso{font-size:.85rem;color:#5b625f}a{color:#0b6b4f}table{border-collapse:collapse}td,th{padding:4px 10px;border-bottom:1px solid #ddd}';

function doc(titulo: string, head: string, cuerpo: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${titulo}</title><meta name="description" content="Tienda de café de demostración.">`
    + `<link rel="icon" href="data:,">${head}</head><body>${cuerpo}`
    + `<footer><p class="aviso">${AVISO}</p></footer></body></html>`;
}

const cabecera = '<header><a href="/">Café Demo</a> · <a href="/login">Entrar</a></header>';
const lista = `<ul class="p">${PRODUCTOS.map((p) => `<li><strong>${p.nombre}</strong><br>US$ ${p.precio_usd.toFixed(2)}</li>`).join('')}</ul>`;

// GET / según la versión de S10 10.11: v1 sana (imagen dimensionada y prioritaria, CSS en línea, JS diferido, sin
// terceros); v2 con la regresión deliberada (CSS y polyfills bloqueantes en <head>, imagen enorme perezosa sin
// width/height y un widget que ocupa el hilo principal ~250 ms).
export function paginaInicio(v: PerfVersion): string {
  if (v === 'v2-regresion') {
    return doc('Café Demo',
      `<link rel="stylesheet" href="/css/tema-pesado.css"><script src="/js/polyfills-legacy.js"></script><style>${CSS_CRITICO}</style>`,
      `${cabecera}<main><h1>Café recién tostado</h1><img class="hero" src="/img/hero-original.jpg" loading="lazy" alt="Granos de café">`
      + `${lista}</main><script src="/js/widget-pesado.js"></script>`);
  }
  return doc('Café Demo', `<style>${CSS_CRITICO}</style><script src="/js/app.js" defer></script>`,
    `${cabecera}<main><h1>Café recién tostado</h1>`
    + `<img class="hero" src="/img/hero-1200.webp" width="1200" height="600" fetchpriority="high" alt="Granos de café">`
    + `${lista}</main>`);
}

export function paginaLogin(error = false): string {
  return doc('Entrar · Café Demo', `<style>${CSS_CRITICO}</style>`,
    `${cabecera}<main><h1>Entrar</h1>${error ? '<p role="alert">Usuario o contraseña incorrectos.</p>' : ''}`
    + '<form method="post" action="/login"><p><label>Usuario <input name="usuario" autocomplete="username"></label></p>'
    + '<p><label>Contraseña <input name="clave" type="password" autocomplete="current-password"></label></p>'
    + '<p><button>Entrar</button></p></form></main>');
}

// Falla simulada a propósito: /admin responde 200 sin sesión (CF_ADMIN_EXPOSED, canónico §9.1). Solo datos falsos.
export function paginaAdmin(): string {
  const filas = [['cliente-001', 3, 'US$ 41,00'], ['cliente-002', 1, 'US$ 8,00'], ['cliente-003', 7, 'US$ 120,40']]
    .map(([c, n, t]) => `<tr><td>${c}</td><td>${n}</td><td>${t}</td></tr>`).join('');
  return doc('Administración · Café Demo', `<style>${CSS_CRITICO}</style>`,
    `${cabecera}<main><h1>Panel de administración</h1><p class="aviso">Falla simulada: este panel no pide sesión.</p>`
    + `<table><thead><tr><th>Cliente</th><th>Pedidos</th><th>Total</th></tr></thead><tbody>${filas}</tbody></table></main>`);
}
