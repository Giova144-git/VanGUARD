// Configura Kapso desde el .env de la raíz, sin imprimir nunca la API key ni el secreto del webhook.
//   node scripts/kapso-config.mjs            → busca el número sandbox, escribe KAPSO_PHONE_NUMBER_ID y genera
//                                              KAPSO_WEBHOOK_SECRET (solo si esas líneas están vacías)
//   node scripts/kapso-config.mjs --webhook  → además crea el webhook hacia /webhooks/kapso (solo cuando el BACK
//                                              ya tenga esa ruta en producción; si no, Kapso pausa el webhook)
//   node scripts/kapso-config.mjs --real --webhook → cambia al número real (no sandbox), escribe KAPSO_WABA_ID y
//                                              crea el webhook de ese número
// API verificada: GET /platform/v1/whatsapp/phone_numbers (meta_app_id es null en los números sandbox) y
// POST /platform/v1/whatsapp/phone_numbers/{id}/webhooks con { whatsapp_webhook: { kind, url, events, secret_key } }.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import tls from 'node:tls';

// Norton intercepta HTTPS con su propia CA, que está en el almacén de Windows pero no en el de Node: se suma la del
// sistema (equivale a node --use-system-ca; tls.setDefaultCACertificates existe desde Node 24.5).
try { tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]); } catch { /* Node viejo: usar --use-system-ca */ }

const RUTA = join(import.meta.dirname, '..', '.env');
const BASE = 'https://api.kapso.ai/platform/v1';
const URL_WEBHOOK = 'https://officialvanguard.com/webhooks/kapso';
const EVENTOS = ['whatsapp.message.received', 'whatsapp.message.delivered', 'whatsapp.message.read', 'whatsapp.message.failed'];

const texto = readFileSync(RUTA, 'utf8');
const salto = texto.includes('\r\n') ? '\r\n' : '\n';
const lineas = texto.split(/\r?\n/);
const leer = (n) => (lineas.find((l) => l.startsWith(n + '=')) ?? '').slice(n.length + 1).trim();
function escribir(n, v) {
  const i = lineas.findIndex((l) => l.startsWith(n + '='));
  if (i === -1) lineas.push(`${n}=${v}`);
  else lineas[i] = `${n}=${v}`;
  writeFileSync(RUTA, lineas.join(salto));
}

const clave = leer('KAPSO_API_KEY');
if (!clave) {
  console.error('Falta KAPSO_API_KEY en el .env de la raíz (Kapso → tu proyecto → API keys).');
  process.exit(1);
}
const kapso = (ruta, init = {}) =>
  fetch(BASE + ruta, { ...init, headers: { 'X-API-Key': clave, 'content-type': 'application/json', ...init.headers } });

// 1) Número sandbox
const r = await kapso('/whatsapp/phone_numbers?per_page=50');
if (!r.ok) {
  console.error(`Kapso respondió ${r.status} al listar números: revisa que la API key sea del proyecto correcto.`);
  process.exit(1);
}
const numeros = (await r.json()).data ?? [];
const sandbox = numeros.filter((n) => n.meta_app_id == null);
console.log(`Números en el proyecto: ${numeros.length} (sandbox: ${sandbox.length})`);
for (const n of numeros) console.log(`  · ${n.display_phone_number ?? '?'} ${n.name ? `«${n.name}»` : ''}${n.meta_app_id == null ? ' [sandbox]' : ''}`);

// --real: pasa al número de producción (el que no es sandbox) y escribe también KAPSO_WABA_ID. Pisa el id del
// sandbox a propósito: desde ahí el Worker envía por el número real.
const reales = numeros.filter((n) => n.meta_app_id != null);
let idNumero = leer('KAPSO_PHONE_NUMBER_ID');
if (process.argv.includes('--real')) {
  if (reales.length !== 1) {
    console.error(reales.length === 0
      ? '✗ No hay número real conectado: termina «Connected numbers → Connect new number → Instant setup» en Kapso.'
      : '✗ Hay más de un número real: pega a mano en el .env el id del que corresponda.');
    process.exit(1);
  }
  const n = reales[0];
  idNumero = n.phone_number_id ?? n.id;
  escribir('KAPSO_PHONE_NUMBER_ID', idNumero);
  console.log(`✓ KAPSO_PHONE_NUMBER_ID: escrito (número real ${n.display_phone_number ?? '?'})`);
  const waba = n.business_account_id ?? n.waba_id ?? '';
  if (waba) { escribir('KAPSO_WABA_ID', waba); console.log('✓ KAPSO_WABA_ID: escrito'); }
  else console.log('· KAPSO_WABA_ID: Kapso no lo devolvió; cópialo del panel si hace falta para las plantillas');
} else if (idNumero) {
  console.log(numeros.some((n) => (n.phone_number_id ?? n.id) === idNumero)
    ? '· KAPSO_PHONE_NUMBER_ID ya tenía valor y existe en el proyecto'
    : '✗ KAPSO_PHONE_NUMBER_ID ya tenía valor pero NO está en este proyecto: bórralo del .env y vuelve a correr');
} else if (sandbox.length === 1) {
  idNumero = sandbox[0].phone_number_id ?? sandbox[0].id;
  escribir('KAPSO_PHONE_NUMBER_ID', idNumero);
  console.log('✓ KAPSO_PHONE_NUMBER_ID: escrito (número sandbox)');
} else {
  console.error(sandbox.length === 0
    ? '✗ No hay número sandbox: activa WhatsApp → Sandbox en Kapso y vuelve a correr.'
    : '✗ Hay más de un número sandbox: pega a mano en el .env el id del que corresponda.');
  process.exit(1);
}

// 2) Secreto del webhook (lo elegimos nosotros; Kapso firma cada entrega con él)
let secreto = leer('KAPSO_WEBHOOK_SECRET');
if (secreto) console.log('· KAPSO_WEBHOOK_SECRET ya tenía valor, no lo toqué');
else {
  secreto = randomBytes(32).toString('hex');
  escribir('KAPSO_WEBHOOK_SECRET', secreto);
  console.log('✓ KAPSO_WEBHOOK_SECRET: generado');
}

// 3) Webhook, solo con --webhook
if (process.argv.includes('--webhook')) {
  const prev = await kapso(`/whatsapp/phone_numbers/${encodeURIComponent(idNumero)}/webhooks`);
  if (prev.ok) {
    const lista = (await prev.json()).data ?? [];
    if (lista.some((w) => w.url === URL_WEBHOOK)) {
      console.log('· Ya existe un webhook hacia /webhooks/kapso: no creo otro. Si cambiaste el secreto, bórralo en Kapso y vuelve a correr.');
      process.exit(0);
    }
  }
  const c = await kapso(`/whatsapp/phone_numbers/${encodeURIComponent(idNumero)}/webhooks`, {
    method: 'POST',
    body: JSON.stringify({ whatsapp_webhook: { kind: 'kapso', url: URL_WEBHOOK, events: EVENTOS, secret_key: secreto } }),
  });
  const cuerpo = await c.json().catch(() => ({}));
  console.log(c.ok
    ? `✓ Webhook creado (id ${cuerpo.data?.id ?? cuerpo.id ?? '?'}) hacia ${URL_WEBHOOK}, sin buffering`
    : `✗ Kapso respondió ${c.status} al crear el webhook: ${JSON.stringify(cuerpo.error ?? cuerpo.errors ?? '').slice(0, 200)}`);
}
console.log('\nListo. Ni la API key ni el secreto se imprimieron. Lleva las 3 líneas KAPSO_* también al Worker como Secret.');
