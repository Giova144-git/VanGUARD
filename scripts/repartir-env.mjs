// Reparte las variables del .env de la raíz (la lista maestra de Giovanni) a los archivos locales de cada app,
// cada uno con SOLO sus nombres. Nunca imprime un valor: solo dice qué quedó con valor y qué vacío.
// Uso: node scripts/repartir-env.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = join(import.meta.dirname, '..');

function leer(ruta) {
  const valores = new Map();
  if (!existsSync(ruta)) return valores;
  for (const linea of readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) valores.set(m[1], m[2]);
  }
  return valores;
}

function nombresDe(ruta) {
  return [...leer(ruta).keys()];
}

// Valores por defecto que no son secretos y solo valen para desarrollo local.
const DEFECTO = {
  VG_ENV: 'local',
  APP_ORIGIN: 'http://localhost:5173',
  VITE_API_PROXY: 'http://localhost:8787',
};

const DESTINOS = [
  {
    archivo: 'apps/api/.dev.vars',
    // La lista de nombres la manda el ejemplo del BACK; VG_VERSION se deja vacía a propósito (E1 dice "dev").
    nombres: nombresDe(join(RAIZ, 'apps/api/.dev.vars.example')),
  },
  {
    archivo: 'apps/web/.env.development.local',
    nombres: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_API_PROXY'],
  },
];

const maestro = leer(join(RAIZ, '.env'));
if (!maestro.size) {
  console.error('No encontré variables en el .env de la raíz.');
  process.exit(1);
}

for (const d of DESTINOS) {
  if (!d.nombres.length) {
    console.log(`${d.archivo}: sin lista de nombres (falta el archivo de ejemplo), lo salto`);
    continue;
  }
  const ruta = join(RAIZ, d.archivo);
  const previo = leer(ruta);
  const estado = [];
  const lineas = d.nombres.map((n) => {
    // Gana el .env de la raíz; si ahí está vacío, se conserva lo que ya hubiera en el archivo de la app.
    const v = maestro.get(n) || previo.get(n) || DEFECTO[n] || '';
    estado.push(`${v ? '✓' : '·'} ${n}`);
    return `${n}=${v}`;
  });
  writeFileSync(ruta, lineas.join('\n') + '\n');
  const llenas = estado.filter((e) => e.startsWith('✓')).length;
  console.log(`\n${d.archivo}: ${llenas} de ${d.nombres.length} con valor`);
  console.log('  ' + estado.join('\n  '));
}
console.log('\nListo. Ningún valor se imprimió. Los dos archivos están en .gitignore.');
