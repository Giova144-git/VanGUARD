// Falla si algo en apps/web/src importa @vanguard/core: las primitivas de seguridad
// (cifrado, guardas de claves, redacción) nunca deben llegar al bundle del navegador.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const RAIZ = join(import.meta.dirname, '..');
const WEB = join(RAIZ, 'apps', 'web', 'src');
const EXTENSIONES = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PROHIBIDO = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]@vanguard\/core(?:\/[^'"]*)?['"]/;

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
  readFileSync(f, 'utf8').split('\n').forEach((linea, i) => {
    if (PROHIBIDO.test(linea)) violaciones.push(`${relative(RAIZ, f)}:${i + 1}: ${linea.trim()}`);
  });
}

if (violaciones.length) {
  console.error('apps/web no puede importar @vanguard/core:\n' + violaciones.join('\n'));
  process.exit(1);
}
console.log('lint:imports: OK');
