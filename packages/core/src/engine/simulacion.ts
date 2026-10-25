// «Simular ataque» (E57, asignaciones/llamada-ataque.md §B2): eventos de borde sintéticos con la forma EXACTA de
// EdgeEvent (lo que acepta /ingest) para que la detección real (vg_edge_window → evaluateEdge) decida. Los umbrales salen
// de UMBRALES_EDGE: cada kind queda lo justo por encima del suyo, con marcas de tiempo dentro de la ventana de 60 s.
// La IP es siempre de TEST-NET-3 (203.0.113.0/24): nunca una IP real ni bloqueable. Puro: sin red ni base.
import { UMBRALES_EDGE } from './edge.ts';

export type KindSimulado = 'path_scan' | 'ip_flood' | 'attack_tool';
/** Misma forma que EdgeEvent de @vanguard/contracts (ingest.ts). */
export type EventoBorde = { ts: string; ip: string; method: string; path: string; status: number; ua: string;
  latency_ms: number; auth: boolean };

export const HOST_SIMULADO = 'vanguard-demo-victima.pages.dev';
export const UA_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const UA_HERRAMIENTAS = ['sqlmap/1.8#stable (https://sqlmap.org)', 'Mozilla/5.00 (Nikto/2.5.0) (Evasions:None) (Test:000003)'];
/** Rutas sensibles que prueba un escáner (las primeras casan con probe_hits de vg_edge_window). */
export const RUTAS_SENSIBLES = [
  '/.env', '/.git/config', '/wp-login.php', '/phpmyadmin', '/server-status', '/wp-admin', '/backup.zip', '/admin',
  '/.env.local', '/.env.production', '/config.php', '/.aws/credentials', '/db.sql', '/dump.sql', '/backup.tar.gz',
  '/.htpasswd', '/.DS_Store', '/wp-config.php.bak', '/administrator', '/api/.env', '/.svn/entries', '/web.config',
  '/actuator/env', '/debug.log', '/.npmrc', '/composer.json', '/id_rsa',
];
/** Margen por encima de cada umbral: lo justo para que la regla se dispare, no un número inventado. */
export const MARGEN_SIMULACION = 2;

/** IP de TEST-NET-3 a partir de un entero (1–254). */
export const ipSimulada = (n: number) => `203.0.113.${Math.min(254, Math.max(1, Math.floor(n)))}`;

/** Cuántos eventos genera cada kind (umbral de su regla + MARGEN_SIMULACION). `escala` < 1 sirve a las pruebas para
 *  bajar por debajo del umbral. */
export function cantidadSimulada(kind: KindSimulado, escala = 1): number {
  const U = UMBRALES_EDGE;
  const base = kind === 'path_scan' ? U.paths_4xx : kind === 'ip_flood' ? U.flood_n : U.ua_n;
  return Math.max(0, Math.floor((base + MARGEN_SIMULACION) * escala));
}

/** Eventos del kind desde `ip`, repartidos en los últimos ~20 s antes de `ahora` (dentro de la ventana de 60 s).
 *  path_scan: una ruta sensible DISTINTA por evento con 404 (paths_4xx cuenta rutas distintas) y UA de navegador, así
 *  que solo dispara CF_PATH_SCAN. ip_flood: GET / con 200 desde una sola IP y latencia alta (p95 ≥ flood_p95_ms, que la
 *  regla marca crítica). attack_tool: GET a la portada con UA de herramienta y 200 (sin rutas sensibles). */
export function eventosSimulados(kind: KindSimulado, ip: string, ahora: number, escala = 1): EventoBorde[] {
  const n = cantidadSimulada(kind, escala);
  const out: EventoBorde[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(ahora - 20_000 + Math.floor((i * 19_000) / Math.max(1, n))).toISOString();
    if (kind === 'path_scan') {
      // Más rutas que la lista: se numeran para que sigan siendo distintas.
      const ruta = RUTAS_SENSIBLES[i % RUTAS_SENSIBLES.length]! + (i >= RUTAS_SENSIBLES.length ? `.${i}` : '');
      out.push({ ts, ip, method: 'GET', path: ruta, status: 404, ua: UA_NAVEGADOR, latency_ms: 40 + (i % 30), auth: false });
    } else if (kind === 'ip_flood') {
      out.push({ ts, ip, method: 'GET', path: '/', status: 200, ua: UA_NAVEGADOR,
        latency_ms: UMBRALES_EDGE.flood_p95_ms + 300 + (i % 200), auth: false });
    } else {
      out.push({ ts, ip, method: 'GET', path: i % 2 ? '/' : '/productos', status: 200, ua: UA_HERRAMIENTAS[i % 2 === 0 ? 0 : 1]!,
        latency_ms: 60 + (i % 40), auth: false });
    }
  }
  return out;
}
