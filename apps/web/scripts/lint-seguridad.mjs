// Lint de seguridad del FRONT (S14 §14.6). Node puro, sin dependencias: corre igual en Windows que en Workers Builds.
// Va dentro del script `build`, así que una violación impide el despliegue.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const WEB = join(import.meta.dirname, '..');
const SRC = join(WEB, 'src');
const EXCEPCION_HTML = join('src', 'componentes', 'ui', 'chart.tsx'); // ChartStyle de `shadcn add chart` (S06 J06)

const REGLAS = [
  { re: /\bbg-(mal|aviso)(?![-\w/])/, motivo: 'rojo o ámbar sólido: usa bg-mal-relleno / bg-aviso-relleno (L3)' },
  { re: /dangerouslySetInnerHTML/, motivo: 'HTML sin escapar: pinta el dato como texto (L9)', excepto: EXCEPCION_HTML },
  { re: /(local|session)Storage\.setItem\([^)]*\b(token|pat|secret)/i, motivo: 'token en el almacenamiento del navegador (L10)' },
  { re: /console\.\w+\([^)]*\b(read_token|action_token|pat|ingest_secret)\b/, motivo: 'token en la consola (L10)' },
];

function* archivos(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) yield* archivos(ruta);
    else if (/\.(ts|tsx)$/.test(e.name)) yield ruta;
  }
}

const violaciones = [];
for (const f of archivos(SRC)) {
  const rel = relative(WEB, f);
  readFileSync(f, 'utf8').split('\n').forEach((linea, i) => {
    for (const r of REGLAS) {
      if (r.excepto && rel === r.excepto) continue;
      if (r.re.test(linea)) violaciones.push(`${rel.split(sep).join('/')}:${i + 1}: ${r.motivo}\n    ${linea.trim()}`);
    }
  });
}

if (violaciones.length) {
  console.error('lint:seguridad falló:\n' + violaciones.join('\n'));
  process.exit(1);
}
console.log('lint:seguridad: OK');
