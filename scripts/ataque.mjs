// Simulacro de ataque reproducible contra la VÍCTIMA de la demo (PLAN_MAESTRO §12.11, §02.5 Z1–Z6).
// Genera el tráfico que abre el incidente del guion: escaneo de rutas (/.env, /wp-login.php…), 25 rutas 404
// para `paths_4xx`, /admin sin sesión para `admin_ok` y volumen sostenido para `n`/`total`; dispara, en orden,
// CF_PATH_SCAN/CF_UA_TOOL (high) y, tras `--admin-desde`, CF_ADMIN_EXPOSED (critical). El user-agent fijo y
// repetido alimenta CF_UA_TOOL y, en el pulso, CF_UA_INSISTENT (§12.11).
//
// Reglas duras del equipo:
//   · Solo activos propios: LISTA BLANCA = demo.officialvanguard.com y localhost. Nunca un tercero (§12.11 regla de oro).
//   · Tráfico moderado: tope de ≤ 20 req/s y ≤ 120 s (≤ 2 min). Se recorta si piden más.
//   · fetch de Node, sin binarios (Norton bloquea ejecutables; §15 fila 7).
//
// Contador de borde (§02.5, fragmento Z2): por cada respuesta, si trae `x-vg-victima: 1` llegó a la víctima;
// si no, la cortó Cloudflare y se cuenta por estado. HECHO CUANDO: en 10 ensayos `stats.borde` está VACÍO
// antes de «Bloquear IP» y SOLO tiene 403 después.
//
// Uso:
//   node scripts/ataque.mjs https://demo.officialvanguard.com --rps 20 --segundos 90 --ua "sqlmap/1.8" --admin-desde 25
//   node scripts/ataque.mjs https://demo.officialvanguard.com --seco      (modo seco: enseña el plan, no toca la red)
//   node scripts/ataque.mjs --ayuda
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

// Norton intercepta HTTPS con su propia CA, que está en el almacén de Windows pero no en el de Node: se suma la
// del sistema (equivale a node --use-system-ca; tls.setDefaultCACertificates existe desde Node 24.5), igual que
// scripts/kapso-config.mjs. Sin esto, fetch a demo.officialvanguard.com fallaría con PKIX.
try { tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]); } catch { /* Node viejo: usar --use-system-ca */ }

// LISTA BLANCA de hosts. Solo la víctima de la demo y localhost (con sus alias de loopback para los ensayos
// locales y las pruebas). Cualquier otro host se rechaza: el simulacro nunca puede salir contra un tercero
// ni contra el apex officialvanguard.com de producción.
export const LISTA_BLANCA = new Set(['demo.officialvanguard.com', 'localhost', '127.0.0.1', '::1']);

// Topes de seguridad (regla de oro §12.11: ≤ 20 req/s, ≤ 2 min). Son el techo del CLI y también del motor.
export const TOPE_RPS = 20;
export const TOPE_SEGUNDOS = 120;

// Rutas de sondeo que marcan `probe_hits` (CF_PATH_SCAN salta con una sola). /wp-login.php va por POST
// («las de login de prueba», §12.11); el resto GET.
const SONDAS = [
  { metodo: 'GET', ruta: '/.env' },
  { metodo: 'GET', ruta: '/.git/config' },
  { metodo: 'POST', ruta: '/wp-login.php' },
  { metodo: 'GET', ruta: '/phpmyadmin' },
  { metodo: 'GET', ruta: '/server-status' },
];
// 25 rutas inexistentes NO sensibles: aseguran `paths_4xx ≥ 20` aunque el Managed Ruleset corte las sondas (Z2, plan B).
const RUTAS_404 = Array.from({ length: 25 }, (_, i) => ({ metodo: 'GET', ruta: `/backup-${String(i + 1).padStart(2, '0')}` }));

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const esHost = (destino) => { try { return new URL(destino); } catch { return null; } };

// ¿El destino está en la lista blanca? Solo http/https y un host permitido (se le quitan los corchetes de IPv6).
export function hostPermitido(destino) {
  const u = esHost(destino);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  return LISTA_BLANCA.has(u.hostname.replace(/^\[|\]$/g, '').toLowerCase());
}

// Lee los argumentos y aplica límites. Lanza Error si el host no está permitido o un número es inválido:
// así el CLI sale con código ≠ 0 y las pruebas pueden comprobar el rechazo.
export function parsearArgumentos(argv) {
  const op = { destino: 'https://demo.officialvanguard.com', rps: 20, segundos: 90, ua: 'sqlmap/1.8', adminDesde: 25, seco: false, avisos: [] };
  const num = (nombre, v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${nombre} inválido: ${v}`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seco' || a === '--dry' || a === '--dry-run' || a === '--modo-seco') op.seco = true;
    else if (a === '--ayuda' || a === '--help' || a === '-h') op.ayuda = true;
    else if (a === '--rps') op.rps = num('--rps', argv[++i]);
    else if (a === '--segundos') op.segundos = num('--segundos', argv[++i]);
    else if (a === '--admin-desde') op.adminDesde = num('--admin-desde', argv[++i]);
    else if (a === '--ua') op.ua = String(argv[++i] ?? '');
    else if (a.startsWith('--')) throw new Error(`opción desconocida: ${a}`);
    else op.destino = a; // primer posicional = destino
  }
  if (op.ayuda) return op;
  if (!hostPermitido(op.destino)) {
    throw new Error(`host fuera de la lista blanca: ${op.destino}\n  Solo se permite: ${[...LISTA_BLANCA].join(', ')}. El simulacro jamás ataca un tercero.`);
  }
  if (op.rps > TOPE_RPS) { op.avisos.push(`--rps ${op.rps} supera el tope; se recorta a ${TOPE_RPS}.`); op.rps = TOPE_RPS; }
  if (op.rps <= 0) throw new Error('--rps debe ser > 0');
  if (op.segundos > TOPE_SEGUNDOS) { op.avisos.push(`--segundos ${op.segundos} supera el tope; se recorta a ${TOPE_SEGUNDOS}.`); op.segundos = TOPE_SEGUNDOS; }
  if (op.segundos <= 0) throw new Error('--segundos debe ser > 0');
  return op;
}

// Elige la ruta de la petición i (transcurridoS segundos desde el inicio). Va vaciando la cola de sondas
// (primero las sensibles, luego las 404) intercalada con volumen sostenido a `/`, y mete `/admin` solo cuando
// ya pasó `--admin-desde` para que el incidente nazca high y suba a critical después (narrativa del guion).
function siguienteRuta(i, transcurridoS, estado, adminDesde) {
  if (transcurridoS >= adminDesde && i % 4 === 0) return { metodo: 'GET', ruta: '/admin' }; // 200 sin sesión → admin_ok
  if (estado.cola.length && i % 2 === 1) return estado.cola.shift();                           // sondas + 404
  if (i % 7 === 0) return { metodo: 'POST', ruta: '/login' };                                  // intento de login
  return { metodo: 'GET', ruta: '/' };                                                         // volumen para n/total
}

function nuevasStats(op) {
  return { destino: op.destino, enviadas: 0, victima: 0, borde: {}, porRuta: {}, erroresRed: 0, inicioISO: null, inicioMs: 0, finISO: null, totalPlan: 0 };
}

// Lanza el simulacro. Revalida la lista blanca (defensa en profundidad) y recorta rps/segundos a los topes,
// aunque se llame directo sin pasar por parsearArgumentos. En modo seco no toca la red: solo tabula el plan.
export async function correrAtaque(op, io = {}) {
  const log = io.log ?? console.log;
  const hacerFetch = io.fetch ?? fetch;
  if (!hostPermitido(op.destino)) throw new Error(`host fuera de la lista blanca: ${op.destino}`);
  const rps = Math.min(TOPE_RPS, Math.max(0.001, Number(op.rps) || 1));
  const segundos = Math.min(TOPE_SEGUNDOS, Math.max(0.001, Number(op.segundos) || 1));
  const adminDesde = Math.max(0, Number(op.adminDesde) || 0);
  const ua = op.ua ?? '';
  const base = op.destino.replace(/\/+$/, '');
  const intervaloMs = 1000 / rps;
  const total = Math.max(1, Math.round(rps * segundos));
  const stats = nuevasStats(op);
  stats.totalPlan = total;
  const estado = { cola: [...SONDAS, ...RUTAS_404] };

  // Modo seco: sin red. Recorre el mismo plan y cuenta por ruta para el ensayo.
  if (op.seco) {
    for (let i = 0; i < total; i++) {
      const transcurridoS = (i * intervaloMs) / 1000;
      const { ruta } = siguienteRuta(i, transcurridoS, estado, adminDesde);
      stats.porRuta[ruta] = (stats.porRuta[ruta] ?? 0) + 1;
    }
    log(`[SECO] No se envía nada. Plan: ${total} peticiones a ${base} (${rps} req/s · ${segundos}s · UA «${ua}» · /admin desde ${adminDesde}s).`);
    imprimirResumen(stats, log, true);
    return stats;
  }

  const inicio = Date.now();
  stats.inicioMs = inicio;
  stats.inicioISO = new Date(inicio).toISOString();
  // §12.13: imprime la hora de la primera petición; su diferencia con `attack_start` mide el retraso de la ingesta.
  log(`attack_start (primera petición): ${stats.inicioISO}  [epoch_ms=${inicio}]`);
  let proximoAviso = inicio + 5000;

  for (let i = 0; ; i++) {
    const ahora = Date.now();
    if (ahora - inicio >= segundos * 1000) break;
    const espera = i * intervaloMs - (ahora - inicio); // ritmo constante por reloj de pared
    if (espera > 0) await dormir(espera);
    const transcurridoS = (Date.now() - inicio) / 1000;
    const { metodo, ruta } = siguienteRuta(i, transcurridoS, estado, adminDesde);
    stats.porRuta[ruta] = (stats.porRuta[ruta] ?? 0) + 1;
    await unaPeticion(hacerFetch, base + ruta, metodo, ua, stats);
    if (Date.now() >= proximoAviso) { imprimirProgreso(stats, log); proximoAviso += 5000; }
  }

  stats.finISO = new Date().toISOString();
  imprimirResumen(stats, log, false);
  return stats;
}

// Una petición con user-agent fijo y `redirect: 'manual'` (§02.5): un 3xx del borde NO se sigue y cuenta como corte.
async function unaPeticion(hacerFetch, url, metodo, ua, stats) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const init = { method: metodo, headers: { 'user-agent': ua }, redirect: 'manual', signal: ctrl.signal };
    if (metodo === 'POST') { init.headers['content-type'] = 'application/x-www-form-urlencoded'; init.body = 'usuario=admin&recordar=1'; }
    const r = await hacerFetch(url, init);
    stats.enviadas++;
    if (r.headers.get('x-vg-victima') === '1') stats.victima++;        // llegó a la víctima
    else stats.borde[r.status] = (stats.borde[r.status] ?? 0) + 1;     // 403/429/503 puestos por Cloudflare
    try { await r.arrayBuffer(); } catch { /* drenar el cuerpo para liberar el socket */ }
  } catch {
    stats.enviadas++;
    stats.erroresRed++; // timeout, DNS, conexión rechazada: ni víctima ni borde
  } finally {
    clearTimeout(t);
  }
}

function resumenBorde(borde) {
  const e = Object.entries(borde).sort((a, b) => Number(a[0]) - Number(b[0]));
  return e.length ? e.map(([s, n]) => `${s}×${n}`).join(' ') : '(vacío)';
}

function imprimirProgreso(stats, log) {
  log(`  … enviadas=${stats.enviadas}  víctima=${stats.victima}  borde=${resumenBorde(stats.borde)}  erroresRed=${stats.erroresRed}`);
}

function imprimirResumen(stats, log, seco) {
  log('──────── resumen del simulacro ────────');
  log(`destino:        ${stats.destino}`);
  if (seco) { log(`plan:           ${stats.totalPlan} peticiones (modo seco, sin red)`); }
  else {
    const durMs = stats.inicioMs ? Date.now() - stats.inicioMs : 0;
    log(`enviadas:       ${stats.enviadas} en ${(durMs / 1000).toFixed(1)}s  (~${(stats.enviadas / Math.max(durMs / 1000, 0.001)).toFixed(1)} req/s)`);
    log(`a la víctima:   ${stats.victima}   (respuestas con x-vg-victima:1)`);
    log(`cortadas borde: ${resumenBorde(stats.borde)}`);
    log(`errores de red: ${stats.erroresRed}`);
  }
  const rutas = Object.entries(stats.porRuta).sort((a, b) => b[1] - a[1]);
  log('por ruta:');
  for (const [ruta, n] of rutas) log(`  ${String(n).padStart(4)}  ${ruta}`);
  if (!seco) log('Contador de borde: debe estar VACÍO antes de «Bloquear IP» y quedar SOLO en 403 después (§02.5).');
  log('───────────────────────────────────────');
}

const AYUDA = `Simulacro de ataque de VanGUARD (solo activos propios).

  node scripts/ataque.mjs [destino] [opciones]

  destino            URL de la víctima. Por defecto https://demo.officialvanguard.com
                     Lista blanca: ${[...LISTA_BLANCA].join(', ')} (nunca un tercero).

  --rps <n>          Peticiones por segundo. Defecto 20. Tope ${TOPE_RPS}.
  --segundos <n>     Duración. Defecto 90. Tope ${TOPE_SEGUNDOS}.
  --ua <texto>       User-agent fijo. Defecto "sqlmap/1.8" (plan B: "nikto/2.5.0").
  --admin-desde <s>  Segundo en que empieza /admin. Defecto 25 (incidente high → sube a critical).
  --seco             Modo seco: enseña el plan y NO toca la red.
  --ayuda            Esta ayuda.`;

async function main() {
  let op;
  try {
    op = parsearArgumentos(process.argv.slice(2));
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(2);
  }
  if (op.ayuda) { console.log(AYUDA); return; }
  for (const aviso of op.avisos) console.log('· ' + aviso);
  console.log(`VanGUARD · simulacro de ataque → ${op.destino}  (${op.rps} req/s · ${op.segundos}s · UA «${op.ua}» · /admin desde ${op.adminDesde}s${op.seco ? ' · SECO' : ''})`);
  try {
    await correrAtaque(op, { log: console.log });
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  }
}

// Solo corre si se ejecuta directo (no al importarlo desde las pruebas).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
