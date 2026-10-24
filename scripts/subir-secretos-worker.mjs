// Sube secretos del .env de la raíz al Worker `vanguard` por la API de Cloudflare, igual que `wrangler secret put`:
// la versión nueva parte de la versión desplegada. NO usar el panel para secretos: el panel publica una versión
// hecha con el código que la página tenía cargado y puede devolver producción a un commit viejo (pasó el sáb 11:05Z).
// Uso: node scripts/subir-secretos-worker.mjs KAPSO_API_KEY KAPSO_PHONE_NUMBER_ID KAPSO_WEBHOOK_SECRET
// Usa la sesión de la CLI `cf` (la refresca antes). Nunca imprime un valor.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CUENTA = 'eda2c45921f84ec5add25f379bbdbfb5';
const WORKER = 'vanguard';
// En el Worker van con otro valor que en local: nunca se copian desde el .env.
const DISTINTAS = new Set(['SUPABASE_SECRET_KEY']);
// Solo de desarrollo: no van al Worker.
const SOLO_LOCAL = new Set(['TEST_USER_A_PASSWORD', 'TEST_USER_B_PASSWORD', 'SUPABASE_HUMO_PAT', 'VITE_API_PROXY', 'VG_ENV', 'APP_ORIGIN', 'VG_VERSION']);

const nombres = process.argv.slice(2);
if (!nombres.length) {
  console.error('Uso: node scripts/subir-secretos-worker.mjs NOMBRE [NOMBRE…]');
  process.exit(1);
}

const env = new Map();
for (const l of readFileSync(join(import.meta.dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m) env.set(m[1], m[2].trim());
}

try { execSync('cf auth whoami', { stdio: 'ignore' }); } catch { /* si falla, el token de abajo dirá si sirve */ }
const cfg = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'xdg.config', 'cloudflare', 'config', 'default.json');
const token = JSON.parse(readFileSync(cfg, 'utf8')).oauth_token;
const api = (ruta, init = {}) => fetch(`https://api.cloudflare.com/client/v4/accounts/${CUENTA}/workers/scripts/${WORKER}${ruta}`,
  { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });

let fallos = 0;
for (const n of nombres) {
  if (DISTINTAS.has(n)) { console.log(`✗ ${n}: en el Worker lleva otro valor que en local; ese se carga aparte`); fallos++; continue; }
  if (SOLO_LOCAL.has(n)) { console.log(`✗ ${n}: es solo de desarrollo, no va al Worker`); fallos++; continue; }
  const v = env.get(n);
  if (!v) { console.log(`✗ ${n}: vacía o inexistente en el .env`); fallos++; continue; }
  const r = await api('/secrets', { method: 'PUT', body: JSON.stringify({ name: n, text: v, type: 'secret_text' }) });
  const j = await r.json().catch(() => ({}));
  if (j.success) console.log(`✓ ${n}: subida`);
  else { console.log(`✗ ${n}: Cloudflare respondió ${r.status} ${JSON.stringify(j.errors ?? '').slice(0, 160)}`); fallos++; }
}

const s = await (await api('/settings')).json().catch(() => ({}));
const sec = (s.result?.bindings ?? []).filter((b) => b.type === 'secret_text').map((b) => b.name).sort();
console.log(`\nSecretos del Worker ahora (${sec.length}): ${sec.join(', ')}`);
process.exit(fallos ? 1 : 0);
