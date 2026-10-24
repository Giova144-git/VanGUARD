// Push de la demo de «Revisión de código» (asignaciones/revision-codigo.md §8.5, O5): en un clon del repo víctima crea
// src/lib/pagos.ts con una clave live de Stripe FALSA, distinta en cada ejecución, hace commit y push a la rama por
// defecto. El webhook de GitHub dispara la revisión y el WhatsApp. Con --deshacer quita el archivo (commit y push).
//
// Uso: node demo/empujar-revision.mjs <ruta-del-clon> [--deshacer] [--plan-b] [--no-push] [--origen-contiene <texto>]
//   --plan-b   si la protección de push de GitHub bloquea la clave de Stripe: sube .env.staging con una URL de Postgres
//              falsa (CB_ENV_COMMITTED + CB_SECRET_POSTGRES_URL, los dos críticos). --deshacer también lo quita.
//   --no-push  hace el commit sin empujar (pruebas y ensayo en seco).
//   --origen-contiene  si el repo de la demo cambia de nombre (decisión D3), el texto que debe contener su origin.
//
// NUNCA imprime la clave: como sembrar-repo.mjs, se arma por concatenación en tiempo de ejecución, así que ni el
// monorepo ni sus pruebas contienen literales con forma de secreto (§01.6). Antes de empujar comprueba con el escáner
// de core que la regla esperada dispara; si no, no empuja.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { urlPostgres } from './sembrar-repo.mjs';

export const ARCHIVO = 'src/lib/pagos.ts';
export const ARCHIVO_PLAN_B = '.env.staging';
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function parsearArgs(argv) {
  const opt = { pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--deshacer') opt.deshacer = true;
    else if (a === '--plan-b') opt.planB = true;
    else if (a === '--no-push') opt.noPush = true;
    else if (a === '--origen-contiene') opt.origen = argv[++i];
    else if (a.startsWith('--')) throw new Error(`opción desconocida: ${a}`);
    else opt.pos.push(a);
  }
  opt.clon = opt.pos[0];
  return opt;
}

// Clave live de Stripe FALSA: prefijo por trozos + 24 caracteres base62 aleatorios (casa CB_SECRET_STRIPE_LIVE).
export function claveStripeFalsa() {
  let cola = '';
  for (let i = 0; i < 24; i++) cola += BASE62[randomInt(BASE62.length)];
  return 'sk' + '_live_' + cola;
}

// La clave va en la línea 3 (resource esperado src/lib/pagos.ts:3, como el fixture hallazgoRevision).
export function contenidoPagos(clave) {
  return [
    '// Cobro con tarjeta de la tienda.',
    '// TODO: mover la clave a una variable de entorno antes de producción.',
    `const STRIPE_KEY = "${clave}";`,
    '',
    'export async function cobrar(montoCentavos: number, token: string) {',
    "  const r = await fetch('https://api.stripe.com/v1/charges', {",
    "    method: 'POST',",
    "    headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },",
    "    body: new URLSearchParams({ amount: String(montoCentavos), currency: 'usd', source: token }),",
    '  });',
    "  if (!r.ok) throw new Error('No se pudo cobrar');",
    '  return r.json();',
    '}',
    '',
  ].join('\n');
}

export function contenidoPlanB() {
  const ref = Array.from({ length: 20 }, () => 'abcdefghijklmnopqrstuvwxyz'[randomInt(26)]).join('');
  return `DATABASE_URL=${urlPostgres(ref)}\nNODE_ENV=staging\n`;
}

function git(clon, args) {
  const base = ['-c', 'user.name=VanGUARD Demo', '-c', 'user.email=demo@officialvanguard.example', '-c', 'commit.gpgsign=false'];
  return execFileSync('git', [...base, ...args], { cwd: clon, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function ramaPorDefecto(clon, hayOrigen) {
  if (hayOrigen) {
    try { return git(clon, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch { /* sin HEAD remoto */ }
  }
  return git(clon, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

// Comprueba con el escáner real de core que el archivo dispara la regla esperada (sin imprimir el valor).
async function comprobarRegla(path, texto, reglas) {
  const { scanArchivo } = await import('../packages/core/src/secrets/scan.ts');
  const vistas = new Set(scanArchivo(path, texto).map((c) => c.rule_id));
  const faltan = reglas.filter((r) => !vistas.has(r));
  if (faltan.length) throw new Error(`el escáner de core no detecta ${faltan.join(', ')} en ${path}: no empujo`);
}

export async function empujar(argv) {
  const { clon, deshacer, planB, noPush, origen: origenPermitido } = parsearArgs(argv);
  if (!clon) throw new Error('falta <ruta-del-clon>');
  try { git(clon, ['rev-parse', '--is-inside-work-tree']); } catch { throw new Error(`${clon} no es un repositorio git`); }

  // Salvaguarda: solo el repo de la demo. Sin remoto (las pruebas) se permite, pero nunca empuja.
  let origin = null;
  try { origin = git(clon, ['remote', 'get-url', 'origin']); } catch { /* sin remoto */ }
  const patron = origenPermitido ? origenPermitido.toLowerCase() : 'vanguard-demo-victima';
  if (origin && !origin.toLowerCase().includes(patron)) {
    throw new Error(`origin (${origin}) no contiene «${patron}»: solo empujo al repo de la demo`);
  }
  if (git(clon, ['status', '--porcelain'])) throw new Error('el clon tiene cambios sin commitear: déjalo limpio antes');

  const rama = ramaPorDefecto(clon, Boolean(origin));
  if (origin && !noPush) {
    git(clon, ['fetch', '--quiet', 'origin', rama]);
    git(clon, ['checkout', '--quiet', rama]);
    git(clon, ['merge', '--quiet', '--ff-only', `origin/${rama}`]);
  }

  let mensaje;
  if (deshacer) {
    const quitar = [ARCHIVO, ARCHIVO_PLAN_B].filter((r) => existsSync(join(clon, r)));
    if (!quitar.length) return { hecho: 'nada que deshacer', rama, sha: null };
    git(clon, ['rm', '--quiet', ...quitar]);
    mensaje = 'revert: quita el cobro con tarjeta';
  } else {
    const rel = planB ? ARCHIVO_PLAN_B : ARCHIVO;
    const texto = planB ? contenidoPlanB() : contenidoPagos(claveStripeFalsa());
    await comprobarRegla(rel, texto, planB ? ['CB_SECRET_POSTGRES_URL'] : ['CB_SECRET_STRIPE_LIVE']);
    mkdirSync(dirname(join(clon, rel)), { recursive: true });
    writeFileSync(join(clon, rel), texto);
    git(clon, ['add', '--', rel]);
    mensaje = planB ? 'chore: configuración de staging' : 'feat: cobro con tarjeta';
  }
  git(clon, ['commit', '--quiet', '-m', mensaje]);
  const sha = git(clon, ['rev-parse', '--short', 'HEAD']);

  if (noPush || !origin) return { hecho: `commit ${sha} sin push`, rama, sha };
  const antes = new Date();
  git(clon, ['push', '--quiet', 'origin', `HEAD:${rama}`]);
  return { hecho: `push ${sha} a ${rama}`, rama, sha, empujado_en: antes.toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await empujar(process.argv.slice(2));
    // Sin valores: qué se hizo y cuándo, para cronometrar {t_revision} contra el WhatsApp.
    console.log(r.hecho);
    if (r.empujado_en) console.log(`hora del push: ${r.empujado_en} (cronometra hasta que llegue el WhatsApp)`);
  } catch (e) {
    console.error('error:', e.message);
    process.exit(1);
  }
}
