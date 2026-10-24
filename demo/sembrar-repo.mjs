// Siembra el repo víctima de la demo: copia la plantilla demo/repo-vulnerable/ (que NO guarda ningún valor con
// forma de secreto) a un clon del repo PRIVADO vanguard-demo-victima, inyecta los secretos FALSOS por
// concatenación en tiempo de ejecución, hace los commits en orden y empuja (§09.13 del PLAN_MAESTRO).
//
// Uso: node demo/sembrar-repo.mjs <ruta-del-clon> --ref <project_ref de 20 letras> [--ingest-secret-file <ruta>] [--no-push]
//
// NUNCA imprime los valores: solo dice qué fallas quedaron sembradas. Así ni el monorepo de VanGUARD ni estas
// pruebas contienen literales con forma de secreto, y el propio escáner de VanGUARD no se dispara al auditarnos (§01.6).
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLANTILLA = join(import.meta.dirname, 'repo-vulnerable');

// --- Argumentos -----------------------------------------------------------------------------------------------
function parsearArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-push') opt.noPush = true;
    else if (a === '--ref') opt.ref = argv[++i];
    else if (a === '--ingest-secret-file') opt.ingestFile = argv[++i];
    else if (a.startsWith('--')) { throw new Error(`opción desconocida: ${a}`); }
    else pos.push(a);
  }
  opt.clon = pos[0];
  return opt;
}

// --- Secretos FALSOS armados por concatenación (ningún literal con forma de secreto vive en el fuente) ---------
// JWT service_role falso: cabecera + payload en base64url, firma HMAC-SHA256 con una clave aleatoria que se descarta.
// Casa /ey[a-zA-Z0-9]{17,}\.ey…/ y su payload decodificado trae role === 'service_role' (regla CB_SECRET_SUPABASE_SERVICE_ROLE, §09.9).
function jwtServiceRole(ref) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const cabecera = b64({ alg: 'HS' + '256', typ: 'JWT' });
  const payload = b64({ iss: 'supabase', ref, role: 'service' + '_role', iat: 1729700000, exp: 2045276000 });
  const firma = createHmac('sha256', randomBytes(32)).update(cabecera + '.' + payload).digest('base64url');
  return cabecera + '.' + payload + '.' + firma;
}

// URL de Postgres falsa: contraseña en HEX (sin / ni @, para que case la regex de §09.9) y host db.<ref>.supabase.co
// (host supabase.co => critical). Se arma por trozos para que "postgresql://postgres:" no aparezca entero en el fuente.
function urlPostgres(ref) {
  const clave = randomBytes(16).toString('hex'); // 32 hex
  return 'postgres' + 'ql://' + 'postgres:' + clave + '@db.' + ref + '.supabase.co:5432/' + 'postgres';
}

// Secreto de la conexión de ingesta "señuelo". Si llega por archivo, es el real de la org de demo (dispara CB_KEY_REUSE);
// si no, uno falso por concatenación (entonces CB_KEY_REUSE no casará, es P1).
function secretoIngesta(ingestFile) {
  if (ingestFile) {
    const v = readFileSync(ingestFile, 'utf8').trim();
    if (!v) throw new Error('el --ingest-secret-file está vacío');
    return v;
  }
  return 'vgi' + '_' + randomBytes(24).toString('base64url');
}

// --- Copia y escritura ----------------------------------------------------------------------------------------
function rutasPlantilla() {
  return readdirSync(PLANTILLA, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(PLANTILLA, join(d.parentPath, d.name)).split(sep).join('/'))
    .filter((r) => !r.startsWith('node_modules/') && !r.startsWith('dist/'));
}

function copiarPlantilla(clon, excluir) {
  for (const rel of rutasPlantilla()) {
    if (excluir.has(rel)) continue;
    const destino = join(clon, rel);
    mkdirSync(dirname(destino), { recursive: true });
    cpSync(join(PLANTILLA, rel), destino);
  }
}

function escribir(clon, rel, contenido) {
  const destino = join(clon, rel);
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, contenido);
}

// --- Git ------------------------------------------------------------------------------------------------------
function git(clon, args) {
  // Identidad e firma fijadas por comando: sirve igual en el clon de Gabriel y en un repo recién iniciado (pruebas).
  const base = ['-c', 'user.name=VanGUARD Demo', '-c', 'user.email=demo@officialvanguard.example', '-c', 'commit.gpgsign=false'];
  return execFileSync('git', [...base, ...args], { cwd: clon, stdio: ['ignore', 'pipe', 'pipe'] });
}

function esRepoGit(clon) {
  try { git(clon, ['rev-parse', '--is-inside-work-tree']); return true; } catch { return false; }
}

// --- Principal ------------------------------------------------------------------------------------------------
function sembrar(argv) {
  const { clon, ref, ingestFile, noPush } = parsearArgs(argv);
  if (!clon) throw new Error('falta <ruta-del-clon>');
  if (!ref || !/^[a-z]{20}$/.test(ref)) throw new Error('--ref debe ser 20 letras minúsculas (^[a-z]{20}$)');
  if (!esRepoGit(clon)) throw new Error(`${clon} no es un repositorio git (clónalo antes)`);

  // Salvaguarda contra sembrar el repo equivocado (sobre todo el propio monorepo, cuyo origin es el repo del hackatón):
  // si el clon tiene remoto origin, su URL DEBE nombrar el repo víctima. Sin remoto (el git init local de las pruebas)
  // se permite. Así un `add -A` + commits + push nunca caen por error en un repo real que no sea la víctima.
  let origin = null;
  try { origin = git(clon, ['remote', 'get-url', 'origin']).toString().trim(); } catch { /* sin remoto */ }
  if (origin && !/vanguard-demo-victima/i.test(origin)) {
    throw new Error(`origin (${origin}) no es vanguard-demo-victima: siembra solo el clon del repo víctima`);
  }

  const jwt = jwtServiceRole(ref);
  const url = urlPostgres(ref);
  const urlSupabase = 'https://' + ref + '.supabase.co';
  const ingesta = secretoIngesta(ingestFile);

  // c1 — base: todo menos los dos archivos que llevan secreto inyectado (llegan en c4) y menos los .env (se generan).
  copiarPlantilla(clon, new Set(['src/lib/supabaseAdmin.ts', 'wrangler.jsonc']));
  git(clon, ['add', '-A']);
  git(clon, ['commit', '-m', 'base del panel de pedidos de la tienda demo']);

  // c2 — añade .env.production (queda en el historial => CB_ENV_IN_HISTORY).
  escribir(clon, '.env.production', `SUPABASE_URL=${urlSupabase}\nSUPABASE_SERVICE_ROLE_KEY=${jwt}\n`);
  git(clon, ['add', '-A']);
  git(clon, ['commit', '-m', 'añade configuración de producción']);

  // c3 — borra .env.production del repo (pero sigue en el historial).
  git(clon, ['rm', '--quiet', '.env.production']);
  git(clon, ['commit', '-m', 'quita configuración de producción del repo']);

  // c4 — .env commiteado + cliente admin con el mismo JWT + wrangler con el secreto de ingesta.
  escribir(clon, '.env', `SUPABASE_URL=${urlSupabase}\nSUPABASE_SERVICE_ROLE_KEY=${jwt}\nDATABASE_URL=${url}\n`);
  escribir(clon, 'src/lib/supabaseAdmin.ts',
    readFileSync(join(PLANTILLA, 'src/lib/supabaseAdmin.ts'), 'utf8').replace('__VG_SERVICE_ROLE_JWT__', jwt));
  escribir(clon, 'wrangler.jsonc',
    readFileSync(join(PLANTILLA, 'wrangler.jsonc'), 'utf8').replace('__VG_INGEST_SECRET__', ingesta));
  git(clon, ['add', '-A']);
  git(clon, ['commit', '-m', 'configura el cliente admin y las variables de entorno']);

  // Empuje (solo si hay remoto origin y no se pidió --no-push). Nunca empuja en las pruebas.
  // `origin` ya se leyó y validó arriba (salvaguarda del repo víctima).
  let empuje;
  if (noPush) empuje = 'push omitido (--no-push)';
  else if (!origin) empuje = 'sin remoto origin: push omitido';
  else { git(clon, ['push', 'origin', 'HEAD']); empuje = 'push hecho a origin'; }

  return empuje;
}

// Entrada CLI. Las pruebas importan sembrar() sin tocar esta rama.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const empuje = sembrar(process.argv.slice(2));
    // Sin valores: solo las fallas sembradas.
    console.log('sembrado: CB_ENV_COMMITTED, CB_SECRET_SUPABASE_SERVICE_ROLE, CB_SECRET_POSTGRES_URL, ' +
      'CB_GITIGNORE_NO_ENV, CB_DEP_VULN (jquery/lodash/ignition), CB_ENV_IN_HISTORY, CB_KEY_REUSE, CB_SQL_NO_RLS');
    console.log(empuje);
  } catch (e) {
    console.error('error:', e.message);
    process.exit(1);
  }
}

export { jwtServiceRole, urlPostgres, sembrar };
