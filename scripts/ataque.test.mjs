// Pruebas del simulacro de ataque. Se corren desde la raíz:
//   pnpm exec vitest run scripts/ataque.test.mjs
// Cubren: lista blanca (nunca un tercero), modo seco (cero peticiones a la red) y el contador de borde (403).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { hostPermitido, parsearArgumentos, correrAtaque, LISTA_BLANCA, TOPE_RPS, TOPE_SEGUNDOS } from './ataque.mjs';

// Víctima de mentira: cuenta cada petición recibida y simula el borde de Cloudflare.
// Las rutas de sondeo y las 404 se devuelven como un corte del borde (403 SIN la cabecera x-vg-victima);
// `/`, `/login` y `/admin` sí traen x-vg-victima:1 (llegaron a la víctima).
function crearVictima() {
  const recibidas = [];
  const esCorte = (ruta) => /^\/(\.|wp-login|phpmyadmin|server-status|backup-)/.test(ruta) || ruta === '/.env';
  const servidor = http.createServer((req, res) => {
    recibidas.push({ metodo: req.method, ruta: req.url });
    req.resume(); // drenar el cuerpo de los POST
    if (esCorte(req.url)) { res.statusCode = 403; res.end('bloqueado por el borde'); return; }
    res.setHeader('x-vg-victima', '1');
    res.statusCode = 200; res.end('ok');
  });
  return { servidor, recibidas };
}

function escuchar(servidor) {
  return new Promise((resolve) => servidor.listen(0, '127.0.0.1', () => resolve(servidor.address().port)));
}

describe('lista blanca', () => {
  it('solo permite demo.officialvanguard.com y localhost', () => {
    expect(hostPermitido('https://demo.officialvanguard.com')).toBe(true);
    expect(hostPermitido('http://localhost:8787')).toBe(true);
    expect(hostPermitido('http://127.0.0.1:3000/x')).toBe(true);
    expect(LISTA_BLANCA.has('demo.officialvanguard.com')).toBe(true);
  });

  it('rechaza cualquier otro host, incluido el apex de producción', () => {
    expect(hostPermitido('https://example.com')).toBe(false);
    expect(hostPermitido('https://officialvanguard.com')).toBe(false);          // apex ≠ víctima
    expect(hostPermitido('https://evil.demo.officialvanguard.com.attacker.net')).toBe(false);
    expect(hostPermitido('ftp://demo.officialvanguard.com')).toBe(false);       // solo http/https
    expect(hostPermitido('no-es-una-url')).toBe(false);
  });

  it('parsearArgumentos lanza si el destino no está en la lista blanca', () => {
    expect(() => parsearArgumentos(['https://example.com'])).toThrow(/lista blanca/);
  });

  it('correrAtaque también rechaza un host fuera de la lista (defensa en profundidad)', async () => {
    await expect(correrAtaque({ destino: 'https://example.com', rps: 1, segundos: 1 }, { log() {} })).rejects.toThrow(/lista blanca/);
  });

  it('recorta rps y segundos a los topes y lo avisa', () => {
    const op = parsearArgumentos(['https://demo.officialvanguard.com', '--rps', '999', '--segundos', '9999']);
    expect(op.rps).toBe(TOPE_RPS);
    expect(op.segundos).toBe(TOPE_SEGUNDOS);
    expect(op.avisos.length).toBe(2);
  });

  it('lee la invocación canónica del guion', () => {
    const op = parsearArgumentos(['https://demo.officialvanguard.com', '--rps', '20', '--segundos', '90', '--ua', 'sqlmap/1.8', '--admin-desde', '25']);
    expect(op).toMatchObject({ destino: 'https://demo.officialvanguard.com', rps: 20, segundos: 90, ua: 'sqlmap/1.8', adminDesde: 25, seco: false });
  });
});

describe('modo seco', () => {
  it('no envía ninguna petición a la red', async () => {
    const { servidor, recibidas } = crearVictima();
    const port = await escuchar(servidor);
    try {
      const stats = await correrAtaque({ destino: `http://localhost:${port}`, rps: 20, segundos: 2, seco: true }, { log() {} });
      expect(recibidas.length).toBe(0);          // nada tocó la red
      expect(stats.enviadas).toBe(0);
      expect(stats.totalPlan).toBeGreaterThan(0); // pero sí tabuló un plan
      expect(Object.keys(stats.porRuta).length).toBeGreaterThan(0);
    } finally {
      servidor.close();
    }
  });
});

describe('contador de borde', () => {
  it('cuenta los 403 del borde aparte de lo que llega a la víctima', async () => {
    const { servidor, recibidas } = crearVictima();
    const port = await escuchar(servidor);
    try {
      const stats = await correrAtaque({ destino: `http://localhost:${port}`, rps: 20, segundos: 1, ua: 'sqlmap/1.8', adminDesde: 0 }, { log() {} });
      expect(recibidas.length).toBeGreaterThan(0);
      expect(stats.enviadas).toBe(recibidas.length);              // una respuesta por petición
      expect(stats.borde[403]).toBeGreaterThan(0);                // las sondas/404 las cortó el "borde"
      expect(stats.victima).toBeGreaterThan(0);                   // /, /login y /admin llegaron a la víctima
      expect(stats.victima + Object.values(stats.borde).reduce((a, b) => a + b, 0) + stats.erroresRed).toBe(stats.enviadas);
      // tocó al menos una ruta de sondeo y la ruta raíz de volumen
      expect(recibidas.some((r) => r.ruta === '/.env')).toBe(true);
      expect(recibidas.some((r) => r.ruta === '/')).toBe(true);
    } finally {
      servidor.close();
    }
  });

  it('con la víctima «bloqueada» (todo 403) el contador queda SOLO en 403, sin tocar a la víctima', async () => {
    // Simula el estado DESPUÉS de «Bloquear IP»: el borde corta todo con 403 y nada trae x-vg-victima.
    const recibidas = [];
    const servidor = http.createServer((req, res) => { recibidas.push(req.url); req.resume(); res.statusCode = 403; res.end('bloqueado'); });
    const port = await escuchar(servidor);
    try {
      const stats = await correrAtaque({ destino: `http://127.0.0.1:${port}`, rps: 20, segundos: 1, adminDesde: 0 }, { log() {} });
      expect(stats.victima).toBe(0);
      expect(Object.keys(stats.borde)).toEqual(['403']);          // SOLO 403
      expect(stats.borde[403]).toBe(stats.enviadas);
    } finally {
      servidor.close();
    }
  });
});
