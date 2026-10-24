// Filtros locales del árbol de GitHub: deciden, sin modelo y sin leer contenido, qué rutas llegan al triage.
// Unión de las exclusiones del CLI deepwiki de Andrés (SKIP_DIR, SKIP_FILE, 60 KB) y de api/config/repo.json de
// DeepWiki-Open (MIT, (c) 2024 Sheing Ng). Todo con Set y startsWith/endsWith, sin regex gigantes con alternancias.
// Medido: unas 6.000 rutas costaban 13-16 ms con el orden completo, más que los 10 ms de CPU de Workers Free; por eso
// github.ts no parsea árboles de más de ~450 KB (unas 2.000 rutas) y elegirCandidatos usa cubetas de prioridad.
import type { Area, EntradaArbol, Limites } from './tipos.ts';

export const MAX_BYTES_ARCHIVO = 60_000;
// WikiPagina.archivos acepta rutas de hasta 300 caracteres: lo más largo no se puede citar, así que no se lee.
export const MAX_LARGO_RUTA = 300;
export const AREA_RAIZ = '(raiz)';
export const AREA_OTROS = '(otros)';

// Carpetas que se saltan en cualquier nivel (comparación en minúsculas).
const CARPETAS_EXCLUIDAS = new Set([
  // Andrés
  'node_modules', '.git', 'dist', 'build', '.next', 'vendor', '__pycache__', 'coverage',
  // DeepWiki-Open (excluded_dirs y las carpetas de excluded_files)
  '.venv', 'venv', 'env', 'virtualenv', 'bower_components', 'jspm_packages', '.svn', '.hg', '.bzr',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.coverage', 'out', 'target', 'bin', 'obj',
  '_docs', 'site-docs', '_site', '.idea', '.vscode', '.vs', '.eclipse', '.settings', 'logs', 'log', 'tmp', 'temp',
  'lib-cov', 'htmlcov', '.nyc_output', '.tox', 'bld', '.output', '.eggs',
  // Cachés y salidas de herramientas actuales; docs generados (no los escritos a mano en docs/)
  '.turbo', '.nuxt', '.svelte-kit', '.vercel', '.netlify', '.wrangler', '.cache', '.parcel-cache', '.angular',
  '.expo', '.gradle', '.dart_tool', '.terraform', '.serverless', '.aws-sam', '.yarn', '.pnpm-store', 'pods',
  'deriveddata', 'storybook-static', '.docusaurus', '_build', 'apidocs', 'javadoc', 'typedoc',
  '__snapshots__', '__generated__', 'test-results', 'playwright-report',
]);
const SUFIJOS_CARPETA_EXCLUIDA = ['.egg-info', '.dist-info', '.dsym'];

// Nombres exactos (minúsculas). DeepWiki-Open también excluye pyproject.toml, pero aquí se conserva: es manifiesto
// y Andrés lo prioriza porque explica de qué va el proyecto.
const ARCHIVOS_EXCLUIDOS = new Set([
  // lockfiles
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'deno.lock',
  'poetry.lock', 'pipfile.lock', 'requirements.txt.lock', 'uv.lock', 'cargo.lock', 'composer.lock', 'gemfile.lock',
  'go.sum', 'pubspec.lock', 'mix.lock', 'flake.lock', 'podfile.lock', 'packages.lock.json', 'gradle.lockfile',
  // basura del sistema
  '.ds_store', 'thumbs.db', 'desktop.ini',
  // configuración de herramientas sin valor para explicar el producto (DeepWiki-Open)
  '.gitignore', '.gitattributes', '.gitmodules', '.gitlab-ci.yml', '.prettierrc', '.prettierignore', '.eslintrc',
  '.eslintignore', '.stylelintrc', '.editorconfig', '.jshintrc', '.pylintrc', '.flake8', 'mypy.ini', '.flaskenv',
  '.npmignore', '.dockerignore', '.nvmrc', '.node-version', '.python-version', '.tool-versions', '.browserslistrc',
  'tsconfig.json', 'webpack.config.js', 'babel.config.js', 'rollup.config.js', 'jest.config.js', 'karma.conf.js',
  'vite.config.js', 'next.config.js',
  // archivos que suelen guardar credenciales (wp-config.php trae la clave de la base y las sales de WordPress)
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.netrc', '.htpasswd', '.git-credentials', '.pgpass', '.dockercfg',
  '.s3cfg', '.boto', 'kubeconfig', 'credentials', 'secrets.json', 'secrets.yml', 'secrets.yaml', 'secrets.toml',
  'wp-config.php',
]);

// Prefijos de nombre que delatan un secreto: .env*, .dev.vars de wrangler, llaves SSH y secrets.* / .secrets*.
const PREFIJOS_SECRETO = ['.env', '.dev.vars', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'secrets.', '.secrets'];
// JSON de credenciales de nube (Google, GCP) que no tienen extensión delatora.
const PREFIJOS_JSON_SECRETO = ['credentials', 'service-account', 'service_account', 'serviceaccount', 'client_secret'];

// Extensiones (sin punto, minúsculas): llaves, binarios, multimedia, comprimidos, datos y artefactos de build.
const EXTENSIONES_EXCLUIDAS = new Set([
  'env', 'pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'der', 'crt', 'cer', 'csr', 'p7b', 'asc', 'gpg', 'pgp',
  'kdbx', 'ovpn', 'tfstate', 'tfvars', 'cfg', 'ini', 'lnk', 'lock', 'map', 'log', 'swp', 'snap',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'psd', 'ai', 'sketch',
  'fig', 'xcf', 'eps', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'webm', 'mov', 'avi', 'mkv', 'wmv', 'flv',
  'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'iso', 'dmg', 'img',
  'msix', 'appx', 'appxbundle', 'xap', 'ipa', 'apk', 'aab', 'deb', 'rpm', 'msi', 'exe', 'dll', 'so', 'dylib',
  'o', 'obj', 'a', 'lib', 'lo', 'la', 'slo', 'class', 'jar', 'war', 'ear', 'jsm', 'pyc', 'pyd', 'pyo', 'wasm',
  'bin', 'node', 'egg', 'whl',
  'db', 'sqlite', 'sqlite3', 'mdb', 'parquet', 'avro', 'orc', 'feather', 'pkl', 'pickle', 'npy', 'npz', 'h5',
  'hdf5', 'onnx', 'pt', 'pth', 'ckpt', 'safetensors', 'tflite', 'pb',
]);
// Minificados, empaquetados y generados (la extensión sola no los delata).
const SUFIJOS_EXCLUIDOS = ['.min.js', '.min.mjs', '.min.css', '.bundle.js', '.bundle.css', '.chunk.js',
  '.tfstate.backup', '_pb2.py', '_pb2_grpc.py', '.pb.go', '.g.dart', '.freezed.dart', '.designer.cs'];

// README y manifiestos van primero: dicen qué es el proyecto con poco texto (heurística de Andrés, ampliada).
const MANIFIESTOS = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'cargo.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'gemfile', 'composer.json', 'pubspec.yaml', 'mix.exs', 'deno.json',
  'deno.jsonc', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'pnpm-workspace.yaml', 'turbo.json', 'serverless.yml',
  'procfile', 'makefile', 'cmakelists.txt',
]);
// Pruebas, ejemplos y mocks: útiles, pero lo último que necesita un directivo (Set por segmento: sin regex por ruta).
const CARPETAS_SECUNDARIAS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', '__mocks__', '__fixtures__',
  'fixtures', 'e2e', 'example', 'examples', 'sample', 'samples', 'benchmark', 'benchmarks', '.github']);
const RE_ARCHIVO_PRUEBA = /[._](test|spec)s?\.[a-z0-9]+$|^test_|\.stories\.[a-z0-9]+$/;

// Contenedores de monorepo: el área es el segundo nivel (apps/api, packages/contracts, src/componentes).
const CONTENEDORES_MONOREPO = new Set(['apps', 'packages', 'services', 'libs', 'src', 'cmd', 'internal']);

// Controles C0 y C1, marcas bidi y de ancho cero (permiten falsear nombres en pantalla), la barra invertida y los
// caracteres que solo sirven para inyectar HTML o romper un atributo o un código en línea («< > " `»). Corchetes y
// paréntesis NO: son rutas reales de Next.js (app/[slug], app/(grupo)); por eso area, titulo y archivos se tratan
// siempre como texto plano (ver LEEME) y documentoMarkdown los escapa.
const RE_CARACTER_INVALIDO = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿\\<>"`]/;

export function carpetaExcluida(nombre: string): boolean {
  const n = nombre.toLowerCase();
  if (CARPETAS_EXCLUIDAS.has(n)) return true;
  for (const s of SUFIJOS_CARPETA_EXCLUIDA) if (n.endsWith(s)) return true;
  return false;
}

// `nombre` ya en minúsculas. Primero las búsquedas en Set (lo más frecuente: extensión de imagen, lockfile), luego los
// bucles de prefijos y sufijos.
function archivoExcluido(nombre: string): boolean {
  if (ARCHIVOS_EXCLUIDOS.has(nombre)) return true;
  const punto = nombre.lastIndexOf('.');
  const ext = punto < 0 ? '' : nombre.slice(punto + 1);
  if (ext && EXTENSIONES_EXCLUIDAS.has(ext)) return true;
  for (const p of PREFIJOS_SECRETO) if (nombre.startsWith(p)) return true;
  if (!ext) return false;
  for (const s of SUFIJOS_EXCLUIDOS) if (nombre.endsWith(s)) return true;
  if (ext === 'json') for (const p of PREFIJOS_JSON_SECRETO) if (nombre.startsWith(p)) return true;
  return false;
}

// Nombre de archivo que suele guardar credenciales (todos los descartan los filtros; esto solo cuenta para avisar).
const RE_ARCHIVO_CLAVES = /^(?:\.env|\.dev\.vars|\.secrets|id_(?:rsa|dsa|ecdsa|ed25519))|\.(?:pem|key|p12|pfx|jks|keystore|kdbx|tfvars|tfstate)$|^(?:credentials|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.pgpass|wp-config\.php|secrets\.[a-z0-9]{1,10})$/i;
export const pareceArchivoDeClaves = (path: string): boolean =>
  RE_ARCHIVO_CLAVES.test(path.slice(path.lastIndexOf('/') + 1));

// Ruta que no debe pedirse ni citarse: vacía, larga, con segmentos raros (., .., //) o caracteres de control.
export function rutaInsegura(path: string): boolean {
  if (path.length === 0 || path.length > MAX_LARGO_RUTA || RE_CARACTER_INVALIDO.test(path)) return true;
  let inicio = 0;
  for (;;) {
    const fin = path.indexOf('/', inicio);
    const seg = fin < 0 ? path.slice(inicio) : path.slice(inicio, fin);
    if (seg === '' || seg === '.' || seg === '..') return true;
    if (fin < 0) return false;
    inicio = fin + 1;
  }
}

// true si la ruta cae en una carpeta o archivo excluido. No mira tamaño ni tipo.
export function rutaExcluida(path: string): boolean {
  if (rutaInsegura(path)) return true;
  const p = path.toLowerCase();
  let inicio = 0;
  for (;;) {
    const fin = p.indexOf('/', inicio);
    if (fin < 0) return archivoExcluido(p.slice(inicio));
    if (carpetaExcluida(p.slice(inicio, fin))) return true;
    inicio = fin + 1;
  }
}

// Candidato = archivo (blob) con contenido, que no pase de maxBytesArchivo y fuera de toda exclusión.
// Sin tamaño conocido se acepta: leerArchivos vuelve a acotar los bytes al descargar.
export function esCandidato(entrada: EntradaArbol, limites: Pick<Limites, 'maxBytesArchivo'>): boolean {
  if (entrada.type !== 'blob') return false;
  const size = entrada.size;
  if (size !== undefined && (size <= 0 || size > limites.maxBytesArchivo)) return false;
  return !rutaExcluida(entrada.path);
}

// Menor = antes. clase*100 + profundidad (< 300): README/manifiestos (0), código y docs (1), pruebas y ejemplos (2).
export function prioridad(path: string): number {
  const p = path.toLowerCase();
  let profundidad = 1, secundaria = false, inicio = 0;
  for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', inicio)) {
    profundidad++;
    if (!secundaria && CARPETAS_SECUNDARIAS.has(p.slice(inicio, i))) secundaria = true;
    inicio = i + 1;
  }
  const nombre = p.slice(inicio);
  let clase = 1;
  if (nombre.startsWith('readme') || MANIFIESTOS.has(nombre) || nombre.endsWith('.csproj')) clase = 0;
  else if (secundaria || RE_ARCHIVO_PRUEBA.test(nombre)) clase = 2;
  return clase * 100 + Math.min(profundidad, 99);
}

const porRuta = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// Ordena por prioridad y, a igualdad, por ruta (determinista para la caché). No muta la entrada.
export function ordenarCandidatos<T extends { path: string }>(entradas: readonly T[]): T[] {
  const decoradas = entradas.map((e) => ({ e, p: prioridad(e.path) }));
  decoradas.sort((a, b) => a.p - b.p || porRuta(a.e, b.e));
  return decoradas.map((d) => d.e);
}

export type Candidato = { path: string; size: number };
export type SeleccionCandidatos = { candidatos: Candidato[]; total: number; conClaves: number };

// Una sola pasada para el paso `arbol`: filtra, reparte en cubetas por prioridad (un entero < 300) guardando en cada
// una solo las primeras maxCandidatos rutas en el orden del árbol, y ordena por ruta solo las que se quedan. Es
// determinista para el mismo commit (GitHub devuelve el árbol siempre en el mismo orden). `total` cuenta todos los
// candidatos y `conClaves` los archivos con forma de credencial, sin otra vuelta sobre el árbol.
export function elegirCandidatos(entradas: readonly EntradaArbol[],
  limites: Pick<Limites, 'maxBytesArchivo' | 'maxCandidatos'>): SeleccionCandidatos {
  const max = Math.max(0, Math.floor(limites.maxCandidatos));
  const cubetas: Candidato[][] = [];
  let total = 0, conClaves = 0;
  for (const e of entradas) {
    if (!esCandidato(e, limites)) {
      if (e.type === 'blob' && pareceArchivoDeClaves(e.path)) conClaves++;
      continue;
    }
    total++;
    const c = (cubetas[prioridad(e.path)] ??= []);
    if (c.length < max) c.push({ path: e.path, size: e.size ?? 0 });
  }
  const candidatos: Candidato[] = [];
  for (const c of cubetas) {
    if (candidatos.length >= max) break;
    if (!c) continue;   // cubeta vacía: el arreglo es disperso
    c.sort(porRuta);
    for (const x of c) { if (candidatos.length >= max) break; candidatos.push(x); }
  }
  return { candidatos, total, conClaves };
}

// Todos los candidatos ordenados, sin tope (pruebas y herramientas; el paso `arbol` usa elegirCandidatos).
export function seleccionarCandidatos(entradas: readonly EntradaArbol[],
  limites: Pick<Limites, 'maxBytesArchivo'>): Candidato[] {
  return elegirCandidatos(entradas, { ...limites, maxCandidatos: Number.MAX_SAFE_INTEGER }).candidatos;
}

// Rutas de un área que de verdad caben en su prompt: se suma lo que ocuparía cada una (su tamaño hasta
// charsPorArchivo, más las etiquetas) hasta llenar charsPorArea, y unas pocas de reserva por si alguna no se puede
// leer. Así no se gastan subpeticiones ni CPU de redacción en archivos que armarArea iba a dejar fuera.
export const RESERVA_PRESELECCION = 3;
export function preseleccionar(paths: readonly string[], tam: ReadonlyMap<string, number>,
  limites: Pick<Limites, 'charsPorArchivo' | 'charsPorArea' | 'maxArchivosPorArea'>): string[] {
  const out: string[] = [];
  let usado = 0, reserva = 0;
  for (const p of paths) {
    if (out.length >= limites.maxArchivosPorArea) break;
    if (usado >= limites.charsPorArea) {
      if (reserva >= RESERVA_PRESELECCION) break;
      reserva++;
    } else {
      const t = tam.get(p);   // bytes >= caracteres; 0 o sin dato: se supone el máximo
      usado += Math.min(t && t > 0 ? t : limites.charsPorArchivo, limites.charsPorArchivo) + p.length + 60;
    }
    out.push(p);
  }
  return out;
}

// Área de una ruta: «(raiz)» para archivos sueltos, carpeta de primer nivel, o dos niveles en contenedores de monorepo.
export function nombreArea(path: string): string {
  const i = path.indexOf('/');
  if (i < 0) return AREA_RAIZ;
  const primero = path.slice(0, i);
  if (CONTENEDORES_MONOREPO.has(primero.toLowerCase())) {
    const j = path.indexOf('/', i + 1);
    if (j > i + 1) return path.slice(0, j);
  }
  return primero;
}

// Título de respaldo de una página cuando el modelo no propuso uno (y detalle del progreso, que se muestra antes de
// resumir el área). Solo letras, números, espacios y «._-»: el nombre de una carpeta lo controla el dueño del repo.
const NOMBRES_LEGIBLES: Record<string, string> = {
  src: 'Código principal', app: 'Aplicación', apps: 'Aplicaciones', api: 'API del servidor', web: 'Sitio web',
  server: 'Servidor', backend: 'Servidor', client: 'Cliente', frontend: 'Interfaz', ui: 'Interfaz',
  public: 'Archivos públicos', static: 'Archivos estáticos', docs: 'Documentación', doc: 'Documentación',
  scripts: 'Scripts de apoyo', lib: 'Librerías internas', libs: 'Librerías internas', packages: 'Paquetes',
  components: 'Componentes de la interfaz', componentes: 'Componentes de la interfaz', pages: 'Páginas',
  routes: 'Rutas', rutas: 'Rutas', config: 'Configuración', infra: 'Infraestructura', deploy: 'Despliegue',
  migrations: 'Migraciones de datos', supabase: 'Base de datos Supabase', db: 'Base de datos', database: 'Base de datos',
  tests: 'Pruebas', test: 'Pruebas', '.github': 'Automatización en GitHub', cmd: 'Comandos', internal: 'Lógica interna',
  core: 'Núcleo', utils: 'Utilidades', models: 'Modelos de datos', services: 'Servicios', legacy: 'Código antiguo',
  hooks: 'Funciones de apoyo de la interfaz', features: 'Funcionalidades', shared: 'Piezas compartidas',
  common: 'Piezas comunes', handlers: 'Atención de peticiones', controllers: 'Atención de peticiones',
  views: 'Pantallas', store: 'Estado de la aplicación', jobs: 'Tareas programadas', workers: 'Procesos en segundo plano',
  contracts: 'Contratos entre partes del sistema', middleware: 'Filtros de peticiones', modulos: 'Módulos',
  modules: 'Módulos',
};
export const textoPlano = (s: string): string => s.replace(/[^\p{L}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim();

export function tituloDeArea(nombre: string): string {
  if (nombre === AREA_RAIZ) return 'Raíz del proyecto';
  if (nombre === AREA_OTROS) return 'Otras partes del proyecto';
  const ultimo = nombre.slice(nombre.lastIndexOf('/') + 1);
  const legible = NOMBRES_LEGIBLES[ultimo.toLowerCase()];
  if (legible) return legible;
  const crudo = textoPlano(ultimo.replace(/[-_.]+/g, ' '));
  return (crudo ? crudo.charAt(0).toUpperCase() + crudo.slice(1) : 'Parte del proyecto').slice(0, 120);
}

// Área de una ruta, con el mismo criterio para el motor (hallazgos en la síntesis) y el FRONT (paginaDeRuta):
// 1) el área que leyó ese archivo; 2) el área más larga que sea prefijo de la ruta con «/»; 3) la que leyó otro
// archivo de la misma carpeta (cubre «(otros)»); 4) «(raiz)» si la ruta no tiene carpeta (p. ej. un .env, que nunca
// se lee); si no, null. Admite «ruta:línea» por si llega el resource del hallazgo en vez de evidence.path.
export function areaDeRutaEn<T extends { area: string; archivos: readonly string[] }>(ruta: string,
  items: readonly T[]): T | null {
  const r = ruta.replace(/:\d{1,7}(?::\d{1,7})?$/, '');
  for (const it of items) if (it.archivos.includes(r)) return it;
  let mejor: T | null = null;
  for (const it of items) {
    if (it.area !== AREA_RAIZ && it.area !== AREA_OTROS && r.startsWith(`${it.area}/`)
      && (!mejor || it.area.length > mejor.area.length)) mejor = it;
  }
  if (mejor) return mejor;
  const barra = r.lastIndexOf('/');
  if (barra < 0) return items.find((it) => it.area === AREA_RAIZ) ?? null;
  const carpeta = r.slice(0, barra + 1);
  for (const it of items) if (it.archivos.some((a) => a.startsWith(carpeta))) return it;
  return null;
}

// Agrupa rutas en áreas. Si hay más de maxAreas se quedan «(raiz)» y las más grandes; el resto se fusiona en
// «(otros)» (máximo maxAreas + 1 áreas, como WikiDoc.paginas). Orden: «(raiz)», por tamaño, «(otros)» al final.
// Dentro de cada área las rutas conservan el orden de entrada (ya viene por prioridad).
export function agruparEnAreas(paths: readonly string[], maxAreas: number): Area[] {
  const tope = Math.max(1, Math.floor(maxAreas));
  const grupos = new Map<string, string[]>();
  for (const p of paths) {
    const n = nombreArea(p);
    const g = grupos.get(n);
    if (g) g.push(p); else grupos.set(n, [p]);
  }
  const porTamano = (a: Area, b: Area) =>
    b.archivos.length - a.archivos.length || (a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : 0);
  const raiz = grupos.get(AREA_RAIZ);
  const resto: Area[] = [];
  for (const [nombre, archivos] of grupos) if (nombre !== AREA_RAIZ) resto.push({ nombre, archivos });
  resto.sort(porTamano);

  const cabenResto = raiz ? tope - 1 : tope;
  const conservadas = resto.slice(0, cabenResto);
  const sobrantes = resto.slice(cabenResto);
  const areas: Area[] = [];
  if (raiz) areas.push({ nombre: AREA_RAIZ, archivos: raiz });
  areas.push(...conservadas);
  if (sobrantes.length > 0) {
    // Se recorre la entrada otra vez para que «(otros)» respete el orden por prioridad.
    const fusionadas = new Set(sobrantes.map((a) => a.nombre));
    areas.push({ nombre: AREA_OTROS, archivos: paths.filter((p) => fusionadas.has(nombreArea(p))) });
  }
  return areas;
}
