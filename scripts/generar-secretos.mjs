// Llena en el .env de la raíz los secretos que no salen de ningún panel: se inventan con un generador aleatorio.
// Solo escribe en líneas VACÍAS: nunca pisa un valor que ya exista (perder una pimienta deja sin descifrar las
// credenciales guardadas). Nunca imprime un valor: solo dice qué nombre llenó y cuál ya tenía valor.
// Uso: node scripts/generar-secretos.mjs
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RUTA = join(import.meta.dirname, '..', '.env');

// Contraseña de usuario de prueba: 20 caracteres alfanuméricos con al menos una letra y un dígito
// (la política de Auth del plan pide mínimo 10 con letras y dígitos).
function contrasena() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  for (;;) {
    const s = Array.from({ length: 20 }, () => abc[randomInt(abc.length)]).join('');
    if (/[A-Za-z]/.test(s) && /\d/.test(s)) return s;
  }
}

const GENERADORES = {
  // 32 bytes en base64 canónico (44 caracteres terminados en «=»), como pide packages/core/src/crypto.ts.
  VG_KEK_PEPPER: () => randomBytes(32).toString('base64'),
  VG_FP_PEPPER: () => randomBytes(32).toString('base64'),
  VG_HUMO_TOKEN: () => randomBytes(32).toString('base64url'),
  TEST_USER_A_PASSWORD: contrasena,
  TEST_USER_B_PASSWORD: contrasena,
};

if (!existsSync(RUTA)) {
  console.error('No existe el .env de la raíz.');
  process.exit(1);
}
const texto = readFileSync(RUTA, 'utf8');
const salto = texto.includes('\r\n') ? '\r\n' : '\n';
const vistos = new Set();
const lineas = texto.split(/\r?\n/).map((linea) => {
  const m = linea.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (!m || !(m[1] in GENERADORES)) return linea;
  vistos.add(m[1]);
  if (m[2].trim()) {
    console.log(`· ${m[1]}: ya tenía valor, no lo toqué`);
    return linea;
  }
  console.log(`✓ ${m[1]}: generado`);
  return `${m[1]}=${GENERADORES[m[1]]()}`;
});
for (const n of Object.keys(GENERADORES)) if (!vistos.has(n)) console.log(`✗ ${n}: no está en el .env (agrega la línea ${n}= y vuelve a correr)`);
writeFileSync(RUTA, lineas.join(salto));
console.log('\nListo. Ningún valor se imprimió. Guarda VG_KEK_PEPPER y VG_FP_PEPPER también en tu gestor de contraseñas.');
