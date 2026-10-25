// Falla si algo en apps/web/src importa @vanguard/core: las primitivas de seguridad
// (cifrado, guardas de claves, redacción) nunca deben llegar al bundle del navegador.
// Única excepción (§14.2, F-18): apps/web/src/modulos/codebase/zip/**, el análisis local del ZIP en un Web Worker,
// que reutiliza los escáneres puros de core. Para que core no se filtre al resto del bundle, fuera de esa carpeta
// nadie puede importar sus módulos de forma estática: el worker se carga con new Worker(new URL(...)).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const RAIZ = join(import.meta.dirname, '..', '..', '..');   // apps/web/scripts → raíz del monorepo
const WEB = join(RAIZ, 'apps', 'web', 'src');
const ZIP = join(WEB, 'modulos', 'codebase', 'zip') + sep;
const EXTENSIONES = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// «import 'x'» (de efecto) también cuenta. zip/tipos.ts sí se puede importar desde fuera: solo trae tipos.
const IMPORTA = String.raw`(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)`;
const PROHIBIDO = new RegExp(IMPORTA + String.raw`['"]@vanguard\/core(?:\/[^'"]*)?['"]`);
const IMPORTA_ZIP = new RegExp(IMPORTA + String.raw`['"][^'"]*\/zip\/(?:analizar|leer|zip\.worker)(?:\.[a-z]+)?['"]`);

function* archivos(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) yield* archivos(ruta);
    else if (EXTENSIONES.test(e.name)) yield ruta;
  }
}

if (!existsSync(WEB)) {
  console.log('lint:imports: apps/web/src aún no existe, nada que revisar');
  process.exit(0);
}

const violaciones = [];
for (const f of archivos(WEB)) {
  const enZip = f.startsWith(ZIP);
  readFileSync(f, 'utf8').split('\n').forEach((linea, i) => {
    if (!enZip && PROHIBIDO.test(linea)) violaciones.push(`${relative(RAIZ, f)}:${i + 1}: @vanguard/core fuera de zip/: ${linea.trim()}`);
    if (!enZip && IMPORTA_ZIP.test(linea)) violaciones.push(`${relative(RAIZ, f)}:${i + 1}: import estático de zip/ (usa new Worker(new URL(...))): ${linea.trim()}`);
  });
}

if (violaciones.length) {
  console.error('apps/web no puede importar @vanguard/core (salvo modulos/codebase/zip/):\n' + violaciones.join('\n'));
  process.exit(1);
}
console.log('lint:imports: OK');
