// Casos de S15 15.11/15.13, S06 06.5 y S13 13.2 para redact.ts. Todo valor con forma de secreto se construye en tiempo
// de ejecución (S06 06.4, prueba 10): ningún escáner, ni el nuestro ni el del jurado, encuentra literales en el repo.
import { describe, it, expect } from 'vitest';
import { redact, redactString, redactForExport, PATRONES_SECRETO } from './redact.ts';
import { REGLAS_SECRETO, REGLA_GENERICA, valorGenerico } from './secrets/rules.ts';
import { scanArchivo } from './secrets/scan.ts';

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const R = (n: number, base = 'Ab1Cd2Ef3Gh4') => base.repeat(Math.ceil(n / base.length)).slice(0, n);
// La palabra clave pegada a otra minúscula no es clave. Partidos para que ningún escáner los tome por secretos del repo.
const NO_CLAVES = ['tokenizer: "cl100k_' + 'base_tokenizer_v2"', 'tokenizer_path: "/models/cl100k_' + 'base_v2.json"',
  'keyboardLayout: "us-intl-' + '2024-v3-extended"', 'authorId: "user2' + 'abcdef1234567890"',
  'accessibilityLabel: "boton-guardar-' + '2024-v2-final"', 'secretary_name: "Ana-2024-' + 'oficina-3B-norte"'];

// [nombre, secreto en claro, texto que lo contiene, marcador esperado]
const CASOS: Array<[string, string, string]> = [
  ['jwt', b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ role: 'service_role', iss: 'supabase' }) + '.' + R(43), '[REDACTADO:jwt]'],
  ['sb_secret_', 'sb_' + 'secret_' + R(32), '[REDACTADO:supabase]'],
  ['sb_publishable_', 'sb_' + 'publishable_' + R(32), '[REDACTADO:supabase]'],
  ['sbp_', 'sb' + 'p_fc' + R(40, 'a1b2c3'), '[REDACTADO:supabase]'],
  ['github_pat_', 'github_' + 'pat_' + R(60), '[REDACTADO:github]'],
  ['gh[pousr]_', 'gh' + 'p_' + R(36), '[REDACTADO:github]'],
  ['sk-ant-', 'sk-' + 'ant-api03-' + R(80), '[REDACTADO:api_key]'],
  ['sk-proj-', 'sk-' + 'proj-' + R(48), '[REDACTADO:api_key]'],
  ['sk- genérico', 'sk-' + R(48), '[REDACTADO:api_key]'],
  ['sk_live_', 'sk' + '_live_' + R(24), '[REDACTADO:api_key]'],
  ['xox', 'xo' + 'xb-' + R(30, '1234-abcd'), '[REDACTADO:token]'],
  ['vgk_', 'vg' + 'k_' + R(40), '[REDACTADO:token]'],
  ['vgi_', 'vg' + 'i_' + R(43), '[REDACTADO:token]'],
  ['vgs_', 'vg' + 's_' + R(32), '[REDACTADO:token]'],
  ['vgw_', 'vg' + 'w_' + R(43), '[REDACTADO:token]'],                       // secreto del webhook de la revisión de código
  ['cfk_', 'cf' + 'k_' + R(40), '[REDACTADO:cloudflare]'],
  ['cfut_', 'cf' + 'ut_' + R(40), '[REDACTADO:cloudflare]'],
  ['cfat_', 'cf' + 'at_' + R(40), '[REDACTADO:cloudflare]'],
  ['AIza', 'AI' + 'za' + R(35), '[REDACTADO:api_key]'],
  ['AKIA', 'AK' + 'IA' + R(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'), '[REDACTADO:token]'],
  ['ASIA', 'AS' + 'IA' + R(16, 'QRSTUVWXYZ234567'), '[REDACTADO:token]'],
  ['Bearer', 'Bea' + 'rer ' + R(40), 'Bearer [REDACTADO]'],
  ['Authorization', 'Authori' + 'zation: Basic ' + R(40), 'Authorization: [REDACTADO]'],
  ['clave privada', '-----BEGIN ' + 'PRIVATE KEY-----\n' + R(64) + '\n-----END ' + 'PRIVATE KEY-----', '[REDACTADO:clave_privada]'],
];

describe('redactString: cada patrón de 15.11 queda enmascarado', () => {
  for (const [nombre, secreto, marcador] of CASOS)
    it(nombre, () => {
      const out = redactString(`antes ${secreto} después`);
      expect(out).not.toContain(secreto);
      expect(out).toContain(marcador);
      expect(redactString(out)).toBe(out);   // idempotente
    });
  it('key= de la URL de PSI y el parámetro suelto', () => {
    const k = 'AI' + 'za' + R(35);
    const out = redactString(`GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=x&key=${k} y /run?key=otro${R(10)}`);
    expect(out).not.toContain(k);
    expect(out).not.toContain('otro' + R(10));
    expect(out).toContain('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  });
  it('postgres(ql)://usuario:clave@ deja usuario y tapa la clave', () => {
    const clave = 'Cl4ve' + R(12);
    expect(redactString(`postgresql://admin:${clave}@db.example.com:5432/app`)).toBe('postgresql://admin:[REDACTADO]@db.example.com:5432/app');
    expect(redactString(`postgres://u:${clave}@h/db`)).not.toContain(clave);
  });
  it('correos → a***@dominio; teléfonos E.164 → +58•••4567; query strings fuera', () => {
    expect(redactString('escribe a alice.smith@example.com')).toBe('escribe a a***@example.com');
    expect(redactString('llama al +584121234567')).toBe('llama al +58•••4567');
    expect(redactString('ver https://app.example.com/a/b?token=abc123&x=1#frag')).toBe('ver https://app.example.com/a/b#frag');
  });
  it('hay un caso positivo por cada patrón de PATRONES_SECRETO', () => {
    for (const [re] of PATRONES_SECRETO) {
      const sinG = () => new RegExp(re.source, re.flags.replace('g', ''));   // conserva la i de los patrones que la llevan
      const casa = CASOS.some(([, s]) => sinG().test(s))
        || sinG().test('?key=x')
        || sinG().test('postgres://u:p@h');
      expect(casa, re.source).toBe(true);
    }
  });
});

describe('redactString: falsos positivos que NO cambian', () => {
  const intactos = [
    '3f2b8c1e-9d4a-4f6b-8a2e-1c5d7e9f0a3b',                                      // UUID
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',          // SHA-256 hex
    'sb_publishable_',                                                           // sin sufijo
    'lodash@4.17.21',
    '@scope/pkg@1.0.0',
    '@supabase/supabase-js@2.118.0',
    'versión 2.0.0.1 y /api/users',
    // Los de las asignaciones sin prefijo (hallazgo redact.ts:22): identificadores, referencias y nuestros marcadores.
    'max_tokens 2000, input_tokens: 10',
    'const { data } = await supabase.from("pedidos").select("*")',
    'password: z.string().min(8)',
    'secret: process.env.SECRET_DE_PRODUCCION',
    'apiKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY',
    'token = "${CLOUDFLARE_API_TOKEN_DEL_ENTORNO}"',
    'GITHUB_TOKEN=[SECRET:CB_SECRET_GITHUB_PAT]',
    'const a = { token: "[SECRET:CB_SECRET_GENERIC]" };',
    // La palabra clave no puede seguir con otra minúscula (CB_SECRET_GENERIC y ASIGNACION): no son claves.
    ...NO_CLAVES,
    // Código, referencias y placeholders sin dígito, o llamadas: la revisión de la ronda 1 los tapaba y HEAD no.
    'const ai = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 })',
    'export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {',
    'token = body.read_token.trim();',
    "headers: { 'X-API-Key': env.KAPSO_API_KEY!, accept: 'application/json' }",
    'password: TEST_USER_A_PASSWORD_DE_PRUEBA',
    'const secret = crypto.randomBytes(32).toString("hex")',
    'dedupe_key = sha256hex(org_id|edge|ip)',
    '"headers":{"Authorization":"Bearer ${VANGUARD_MCP_TOKEN}"}',
    'CLOUDFLARE_API_TOKEN=YOUR_CLOUDFLARE_API_TOKEN_HERE',
    'const key = env.SUPABASE_SECRET_KEY;',
    'author: Giovanni Martineau del equipo',
    'isAuthenticated: someLongIdentifierValue',
    'bypass=abcdefghijklmnopqrstuvwxyz12',
    'if (token == "abcdefghijklm' + 'nopqrstuvwxyz")',
    'credentials: "same-origin"',
    'auth.uid() = user_id_column_value',
    'Tabla public.api_keys: lectura anónima permitida',
    'const k = item.key_name_value_long',
  ];
  for (const s of intactos) it(s, () => expect(redactString(s)).toBe(s));
});

describe('asignaciones sin prefijo reconocible (hallazgo redact.ts:22): Cloudflare de 40 car., secreto de AWS', () => {
  const CF = R(40, 'Zq3xV9mK2pL7');                 // token de Cloudflare sin prefijo
  const HEX = R(37, '0123456789abcdef');            // X-Auth-Key de la API antigua de Cloudflare
  const AWS = R(40, 'wJalrXUtn/K7');                // secreto de AWS
  // Ninguna ventana de 8 caracteres del secreto sobrevive en la salida.
  const fuga = (out: string, sec: string) => Array.from({ length: sec.length - 7 }, (_, i) => sec.slice(i, i + 8)).some((w) => out.includes(w));
  // [texto, secreto que lleva, salida esperada]
  const ESCENARIOS: Array<[string, string, string]> = [
    [`CLOUDFLARE_API_TOKEN=${CF}`, CF, 'CLOUDFLARE_API_TOKEN=[REDACTADO]'],
    [`export CF_API_TOKEN=${CF}`, CF, 'export CF_API_TOKEN=[REDACTADO]'],
    [`respuesta: {"token":"${CF}"}`, CF, 'respuesta: {"token":"[REDACTADO]"}'],
    [`body={"access_token": "${CF}"}`, CF, 'body={"access_token": "[REDACTADO]"}'],
    [`api_token: ${CF}`, CF, 'api_token: [REDACTADO]'],
    [`token = ${CF}`, CF, 'token = [REDACTADO]'],
    [`token%3D${CF}`, CF, 'token%3D[REDACTADO]'],
    [`X-Auth-Key: ${HEX}`, HEX, 'X-Auth-Key: [REDACTADO]'],
    [`cf-access-client-secret: ${CF}`, CF, 'cf-access-client-secret: [REDACTADO]'],
    [`{"Authorization":"token ${CF}"}`, CF, '{"Authorization":"[REDACTADO]"}'],
    [`{"authorization": "Basic ${CF}"}`, CF, '{"authorization": "[REDACTADO]"}'],
    [`CLOUDFLARE_API_TOKEN=${CF} GITHUB_TOKEN=[SECRET:CB_SECRET_GITHUB_PAT] npm run deploy`, CF,
      'CLOUDFLARE_API_TOKEN=[REDACTADO] GITHUB_TOKEN=[SECRET:CB_SECRET_GITHUB_PAT] npm run deploy'],
    [`export const cfg = {"anthropic_key":"[SECRET:CB_SECRET_ANTHROPIC]","cloudflare_token":"${CF}"};`, CF,
      'export const cfg = {"anthropic_key":"[SECRET:CB_SECRET_ANTHROPIC]","cloudflare_token":"[REDACTADO]"};'],
    [`AWS_SECRET_ACCESS_KEY=${AWS}`, AWS, 'AWS_SECRET_ACCESS_KEY=[REDACTADO]'],
  ];
  ESCENARIOS.forEach(([texto, sec, esperado], i) =>
    it(`escenario ${i + 1}: ${esperado}`, () => {
      const out = redactString(texto);
      expect(fuga(out, sec)).toBe(false);
      expect(out).toBe(esperado);
      expect(redactString(out)).toBe(out);   // idempotente
    }));
  it('redact() de un objeto con el log de deploy tapa los dos valores', () => {
    const j = JSON.stringify(redact({ line: `CF_API_TOKEN=${CF} CF_OTHER_TOKEN=${AWS}`, cfg: `{"cloudflare_token":"${CF}","aws_secret":"${AWS}"}` }));
    expect(fuga(j, CF) || fuga(j, AWS)).toBe(false);
  });
  it('idempotente aunque el correo o el teléfono enmascarados alarguen un valor corto', () => {
    for (const t of ['{"password": "jo@example.org"}', `{"auth_key": "abcdef+${'1234' + '5678'}"}`, `x {token=a@${'bcdefghij'}.com;`]) {
      const una = redactString(t);
      expect(redactString(una), t).toBe(una);
    }
  });
  it('no entran en PATRONES_SECRETO: el filtro de salida no marca un placeholder', () => {
    const placeholder = 'CLOUDFLARE_API_TOKEN=YOUR_CLOUDFLARE_API_TOKEN_HERE';
    expect(PATRONES_SECRETO.some(([re]) => new RegExp(re.source, re.flags.replace('g', '')).test(placeholder))).toBe(false);
    expect(redactString(placeholder)).toBe(placeholder);       // sin dígito, como en la genérica: un placeholder no se tapa
    expect(redactString(`CLOUDFLARE_API_TOKEN=${CF}`)).toBe('CLOUDFLARE_API_TOKEN=[REDACTADO]');
  });
  it('lineal con entradas adversas (384 KB)', () => {
    const t0 = performance.now();
    for (const base of ['token=', 'token :', 'authorization":"', 'api_key%3D"']) redactString(base.repeat(64000));
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

// Revisión del arreglo: la clave con sufijo (SECRET_KEY, CF_API_TOKEN_PROD…) la detecta CB_SECRET_GENERIC pero no se tapaba,
// y en una línea con dos secretos la evidencia de uno llevaba el otro en claro.
describe('asignaciones con sufijo, camelCase y separadores raros (revisión de redact.ts:22)', () => {
  const A = R(40, 'Zq3xV9mK2pL7');
  const fuga = (out: string) => Array.from({ length: A.length - 7 }, (_, i) => A.slice(i, i + 8)).some((w) => out.includes(w));
  // [texto, salida esperada]
  const CON_SUFIJO: Array<[string, string]> = [
    [`SECRET_KEY=${A}`, 'SECRET_KEY=[REDACTADO]'],
    [`DJANGO_SECRET_KEY=${A}`, 'DJANGO_SECRET_KEY=[REDACTADO]'],
    [`ENCRYPTION_KEY=${A}`, 'ENCRYPTION_KEY=[REDACTADO]'],
    [`CF_API_TOKEN_PROD=${A}`, 'CF_API_TOKEN_PROD=[REDACTADO]'],
    [`API_KEY_LIVE=${A}`, 'API_KEY_LIVE=[REDACTADO]'],
    [`credentials=${A}`, 'credentials=[REDACTADO]'],
    [`export CLOUDFLARE_API_TOKEN_STAGING=${A}`, 'export CLOUDFLARE_API_TOKEN_STAGING=[REDACTADO]'],
    [`GITHUB_TOKEN_2=${A}`, 'GITHUB_TOKEN_2=[REDACTADO]'],
    [`JWT_SECRET_KEY: "${A}"`, 'JWT_SECRET_KEY: "[REDACTADO]"'],
    [`API_KEY_FOR_THE_PROD_ENV=${A}`, 'API_KEY_FOR_THE_PROD_ENV=[REDACTADO]'],
    [`app.api.key=${A}`, 'app.api.key=[REDACTADO]'],
    [`aws.secret.key: ${A}`, 'aws.secret.key: [REDACTADO]'],
    [`GITHUB_AUTH=${A}`, 'GITHUB_AUTH=[REDACTADO]'],
    [`//registry.npmjs.org/:_auth=${A}`, '//registry.npmjs.org/:_auth=[REDACTADO]'],
    [`SMTP_PASS=${A}`, 'SMTP_PASS=[REDACTADO]'],
    // camelCase
    [`const cfg = { secretKey: "${A}" }`, 'const cfg = { secretKey: "[REDACTADO]" }'],
    [`encryptionKey = '${A}'`, "encryptionKey = '[REDACTADO]'"],
    [`apiKeyLive=${A}`, 'apiKeyLive=[REDACTADO]'],
    [`githubTokenStaging: ${A}`, 'githubTokenStaging: [REDACTADO]'],
    // separadores
    [`token := "${A}"`, 'token := "[REDACTADO]"'],
    [`token%253D${A}`, 'token%253D[REDACTADO]'],
    [`token&#61;${A}`, 'token&#61;[REDACTADO]'],
    [`{ Authorization: "token ${A}" }`, '{ Authorization: "[REDACTADO]" }'],
    [`headers: { authorization: 'Basic ${A}' }`, "headers: { authorization: '[REDACTADO]' }"],
  ];
  for (const [texto, esperado] of CON_SUFIJO)
    it(esperado, () => {
      const out = redactString(texto);
      expect(fuga(out)).toBe(false);
      expect(out).toBe(esperado);
      expect(redactString(out)).toBe(out);   // idempotente
    });
  it('todo valor que CB_SECRET_GENERIC detecta tras un nombre de secreto queda tapado', () => {
    const generica = REGLAS_SECRETO.find((r) => r.rule_id === 'CB_SECRET_GENERIC')!;
    const nombres = ['AWS_SECRET_ACCESS_KEY', 'STRIPE_SECRET_KEY', 'SENDGRID_API_KEY', 'TWILIO_AUTH_TOKEN', 'SLACK_BOT_TOKEN',
      'NEXTAUTH_SECRET', 'SESSION_SECRET', 'DB_PASSWORD', 'FIREBASE_PRIVATE_KEY', 'GOOGLE_CLIENT_SECRET', 'ALGOLIA_ADMIN_KEY',
      'MAPBOX_ACCESS_TOKEN', 'SENTRY_AUTH_TOKEN', 'RAILS_MASTER_KEY', 'SECRET_KEY_BASE', 'SIGNING_KEY', 'STRIPE_WEBHOOK_SECRET',
      'HF_TOKEN', 'X_API_KEY', 'APIKEY', 'AUTHTOKEN', 'TOKEN_SECRET', 'SERVICE_ACCOUNT_CREDENTIALS', 'GH_CREDS', 'BASIC_AUTH',
      'CLOUDFLARE_API_TOKEN_PROD', 'secretKey', 'clientSecret', 'accessToken', 'signingSecret', 'webhookSecret', 'masterKey',
      'adminPassword', 'privateKey', 'stripe.secret.key',
      // Los que se escapaban en la ronda 1 (sueltos, KEY compuesto, sufijo numérico, plural, OAUTH, ACCESS).
      'key', 'KEY', 'SECRETKEY', 'MASTERKEY', 'SIGNINGKEY', 'ENCRYPTIONKEY', 'secretkey', 'GITHUB_OAUTH', 'oauth', 'ACCESS',
      'TOKEN1', 'API_KEY2', 'DB_PASSWORD2', 'JWT_SECRET2', 'SECRETS', 'TOKENS', 'PASSWORDS', 'API_TOKENS', 'tokens',
      'apiKeyLive', 'githubTokenStaging', 'X-Auth-Key', 'Authorization', 'API_HASH', 'GH_CREDS'];
    for (const n of nombres) for (const linea of [`${n}=${A}`, `${n}: ${A}`, `${n} = "${A}"`, `export ${n}=${A} OTRA=1`]) {
      expect(new RegExp(generica.re.source, generica.re.flags.replace('g', '')).test(linea), linea).toBe(true);   // hallazgo…
      expect(fuga(redactString(linea)), linea).toBe(false);                                                  // …y tapado
    }
  });
  // Con . y - repetidos (el correo era cuadrático con ellos), la prueba por proporción del final.
  it('lineal con claves con sufijo adversas (768 KB)', () => {
    const t0 = performance.now();
    for (const base of ['token_', 'a_key_x_', 'secret_a_b_c', 'aKey', 'tokenA', 'Key_', 'auth_', '_key_', 'pass_', 'creds_x='])
      redactString(base.repeat(Math.ceil(76800 / base.length)));
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

// Ronda 2: redactString aplica la propia CB_SECRET_GENERIC (regex y filtro del valor de secrets/rules.ts), así que todo
// valor que la regla detecta desaparece, en las mismas posiciones. Corpus fijo y aleatorio con semilla; todo idempotente.
describe('redact y CB_SECRET_GENERIC no divergen (propiedad)', () => {
  const A = R(40, 'Zq3xV9mK2pL7'), B = R(40, 'Uv0St9Qr8Op7Mn6Kl5Ij4Gh3Ef2Cd1Ab');
  const H1 = R(20, '9f8e7d6c5b4a3210fedcba'), H2 = R(20, '1a2b3c4d5e6f7a8b9c0d1e');
  const reGen = () => new RegExp(REGLA_GENERICA.re.source, REGLA_GENERICA.re.flags);
  /** Valores que la regla daría como hallazgo en la línea: la misma regex y el mismo filtro que scan.ts. */
  const detectados = (l: string) => [...l.matchAll(reGen())].map((m) => m[REGLA_GENERICA.grupo] ?? '').filter(valorGenerico);
  const veces = (s: string, v: string) => { let n = 0; for (let i = s.indexOf(v); i >= 0; i = s.indexOf(v, i + v.length)) n++; return n; };
  // Cada aparición detectada desaparece (un valor repetido sin clave en la misma línea no lo puede saber redact).
  const comprueba = (l: string) => {
    const out = redactString(l);
    const cuenta = new Map<string, number>();
    for (const v of [...detectados(l), ...scanArchivo('a.ts', l).map((c) => c.valor)]) cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
    for (const [v, n] of cuenta) expect(veces(out, v) <= Math.max(0, veces(l, v) - n), `${l}\n→ ${out}`).toBe(true);
    expect(redactString(out), l).toBe(out);
  };
  const NOMBRES = ['key', 'KEY', 'SECRETKEY', 'MASTERKEY', 'SIGNINGKEY', 'ENCRYPTIONKEY', 'secretkey', 'GITHUB_OAUTH', 'ACCESS',
    'TOKEN1', 'API_KEY2', 'DB_PASSWORD2', 'JWT_SECRET2', 'SECRETS', 'TOKENS', 'PASSWORDS', 'API_TOKENS', 'apiKeyLive',
    'githubTokenStaging', 'X-Auth-Key', 'cf.api.token', 'CF_API_TOKEN_PROD', 'AWS_SECRET_ACCESS_KEY', 'credentials', 'monkey'];
  const FORMAS: Array<(n: string, v: string) => string> = [
    (n, v) => `${n}=${v}`, (n, v) => `${n}: ${v}`, (n, v) => `${n} = "${v}"`, (n, v) => `${n}:\t'${v}'`, (n, v) => `export ${n}=${v}`,
    (n, v) => `{ ${n}: "${v}" }`, (n, v) => `--${n}=${v}`, (n, v) => `${n}=${v};`,
  ];
  const CORPUS = [
    `new Pusher({ appId: "1234567", key: "${H1}", secret: "${H2}", cluster: "us2" });`,
    `const cfg = { key: "${A}", secret: "${B}" };`,
    `export CF_OTHER_TOKEN=${B}       CF_API_TOKEN=${A} && wrangler deploy --env production --name ${'w'.repeat(120)}`,
    `respuesta: {"token":"${A}"} y token=${B}`, `token%3D${A}&key=${B}`, `{"Authorization":"token ${A}"} secret: ${B}`,
    `CLOUDFLARE_API_TOKEN=${A} GITHUB_TOKEN=[SECRET:CB_SECRET_GITHUB_PAT] npm run deploy`,
    `GET /cb?token=${A}&access_token=${B}`, `x {token=a@${'bcdefghij'}.com; secret=${A}`,
    ...NOMBRES.flatMap((n) => FORMAS.map((f) => f(n, A))),
    ...NOMBRES.map((n, i) => `${FORMAS[i % FORMAS.length]!(n, A)} ${FORMAS[(i + 3) % FORMAS.length]!(NOMBRES[(i + 7) % NOMBRES.length]!, B)}`),
  ];
  it(`corpus fijo (${CORPUS.length} líneas): todo valor que la regla detecta desaparece`, () => { for (const l of CORPUS) comprueba(l); });
  it('fuzz con semilla: 3000 líneas de claves, separadores, comillas y valores únicos', () => {
    let x = 0x9e3779b9;
    const azar = (n: number) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
    const ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const valor = () => Array.from({ length: 16 + azar(30) }, () => ALFA[azar(ALFA.length)]).join('');
    const PIEZAS = ['token', 'TOKEN', 'Token', 'key', 'KEY', 'Key', 'secret', 'SECRET', 'api', 'API', 'auth', 'access', 'passwd',
      'password', 'creds', 'credentials', 'izer', 'board', 'or', 's', 'S', '1', '_', '-', '.', 'prod', 'PROD', 'monkey', 'oauth', 'x',
      '=', ':', ' = ', ': ', ':=', '%3D', '"', "'", ' ', '\t', ',', ';', '&', '(', ')', '{', '}', '@', '+', '/', '$',
      'process.env.X', '${X}', 'example', 'YOUR_KEY', '+584121234567', 'eyJhbGciOi.', '•', '[REDACTADO]', '[SECRET:CB_SECRET_GENERIC]'];
    for (let i = 0; i < 3000; i++) {
      let l = '';
      for (let j = 3 + azar(14); j > 0; j--) l += azar(4) === 0 ? valor() : PIEZAS[azar(PIEZAS.length)];
      comprueba(l);
    }
  });
  it('las líneas del fallo quedan con los dos valores tapados', () => {
    expect(redactString(`new Pusher({ appId: "1234567", key: "${H1}", secret: "${H2}", cluster: "us2" });`))
      .toBe('new Pusher({ appId: "1234567", key: "[REDACTADO]", secret: "[REDACTADO]", cluster: "us2" });');
    expect(redactString(`{ key: "${A}" }`)).toBe('{ key: "[REDACTADO]" }');
    expect(redactString(`export SECRETKEY=${A} CF_API_TOKEN=${B}`)).toBe('export SECRETKEY=[REDACTADO] CF_API_TOKEN=[REDACTADO]');
    expect(redactString(`KEY: ${A} TOKEN: ${B}`)).toBe('KEY: [REDACTADO] TOKEN: [REDACTADO]');
    expect(redactString(`export TOKEN1=${A} TOKEN2=${B}`)).toBe('export TOKEN1=[REDACTADO] TOKEN2=[REDACTADO]');
    expect(redactString(`GITHUB_OAUTH=${A} ACCESS=${B}`)).toBe('GITHUB_OAUTH=[REDACTADO] ACCESS=[REDACTADO]');
    expect(redactString(`SECRETS=${A} API_TOKENS=${B}`)).toBe('SECRETS=[REDACTADO] API_TOKENS=[REDACTADO]');
  });
  it('monkey= y tokens: con 16+ car. y dígito se tapan: la genérica ya los daba como hallazgo en HEAD', () => {
    for (const [l, esperado] of [['monkey=abcdefghij' + 'klmnopqrstu1', 'monkey=[REDACTADO]'], ['tokens: abcdefghijklm' + 'nopqrstuvwxyz12', 'tokens: [REDACTADO]']]) {
      expect(detectados(l!), l).toHaveLength(1);
      expect(redactString(l!)).toBe(esperado);
    }
  });
  it('la palabra clave pegada a otra minúscula no es clave: ni hallazgo de la regla ni tapado', () => {
    for (const l of NO_CLAVES) {
      expect(detectados(l), l).toEqual([]);
      expect(redactString(l)).toBe(l);
    }
  });
  it('un valor de más de 150 car.: se tapa la cola entera y sigue tapando lo que la regla ve dentro', () => {
    const largo = R(200, 'Zq3xV9mK2pL7');
    const l = `SESSION_SECRET=${largo}_token: ${B}`;
    expect(detectados(l)).toEqual([largo.slice(0, 150), B]);                                // la regla corta a 150 y sigue
    expect(redactString(l)).toBe('SESSION_SECRET=[REDACTADO] [REDACTADO]');               // `_token:` es de la misma cola
  });
  // Con . y - repetidos (el correo era cuadrático con ellos), la prueba por proporción del final.
  it('lineal con entradas adversas para la capa genérica (≥ 60 KB cada una)', () => {
    const T = 61440, t0 = performance.now();
    for (const s of ['SECRETKEY_'.repeat(T / 10), 'tokentoken'.repeat(T / 10), 'Key'.repeat(T / 3), 'KEY=KEY='.repeat(T / 8),
      'token' + ' '.repeat(T) + ':' + ' '.repeat(T), 'a_key=' + 'Ab1Cd2'.repeat(T / 6), `key=${R(18)} `.repeat(T / 23),
      '[SECRET:CB_SECRET_GENERIC]'.repeat(T / 26), 'API_TOKEN_'.repeat(T / 10) + '=' + R(T, 'Zq3xV9mK2pL7'), 'tOkEn1:\t"'.repeat(T / 9),
      'tokens'.repeat(T / 6), 'aUtHoRiZaTiOn'.repeat(T / 13)])
      redactString(s);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

// Ronda 3: la genérica corta en el primer símbolo y a 150 car. Antes, lo que seguía (`#rest`, `$Hq3!x9@Yb`, el resto de un
// token largo) quedaba en claro y ASIGNACION ya no podía tapar el valor entero. Ahora el tramo sigue por la cola hasta el
// delimitador y las capas miran el mismo texto: el valor ENTERO desaparece, sin que sobreviva ni un carácter.
describe('valores con símbolos o de más de 150 car.: se tapa el valor entero (ronda 3)', () => {
  const BASE = R(16, 'Xk9mP2vL' + '8qR4wZ7t');                       // 16 car. de la clase de la genérica, con dígito y entropía
  const COLAS = ['#rest_of_PW99', '$Hq3!x9@Yb', '!', '@', '~tail', ':x9', '#tail99', '%41^*(z{1}|?', '\\x/y=z+.-_', '!Q$w#e%r^t'];
  const NOMBRES = ['DB_PASSWORD', 'SMTP_PASSWORD', 'password', 'API_TOKEN', 'secret', 'encryptionKey', 'apiKey', 'CF_API_TOKEN_PROD',
    'credentials', 'X-Auth-Key', 'GITHUB_TOKEN_2', 'monkey', 'cf.api.token', 'passwd'];
  // [forma con el valor, la misma con [REDACTADO]]
  const FORMAS: Array<(n: string, v: string) => string> = [
    (n, v) => `${n}=${v}`, (n, v) => `${n}: ${v}`, (n, v) => `${n} = "${v}"`, (n, v) => `{ ${n}: '${v}' }`, (n, v) => `export ${n}=${v} OTRA=1`,
    (n, v) => `--${n}=${v}`, (n, v) => `${n}:\t"${v}"`,
  ];
  const exacto = (n: string, v: string, f: (n: string, v: string) => string) => {
    const l = f(n, v), out = redactString(l);
    expect(out, l).toBe(f(n, '[REDACTADO]'));                         // ni un carácter del valor sobrevive
    expect(redactString(out), l).toBe(out);
  };
  it('las líneas del fallo salen enteras como [REDACTADO]', () => {
    const smtp = 'Q7vLm2Xp' + '9Rt4Wk8Zs';
    expect(redactString(`DB_PASSWORD=${BASE}#rest_of_PW99`)).toBe('DB_PASSWORD=[REDACTADO]');
    expect(redactString(`SMTP_PASSWORD=${smtp}${'$Hq3!x9@Yb'}`)).toBe('SMTP_PASSWORD=[REDACTADO]');
    expect(redactString(`encryptionKey: "${BASE}#tail99"`)).toBe('encryptionKey: "[REDACTADO]"');
    expect(redactString(`password=Abc${'$def!123'}`)).toBe('password=[REDACTADO]');
  });
  it('cada nombre, forma y cola: el valor entero desaparece y la salida es idempotente', () => {
    for (const n of NOMBRES) for (const f of FORMAS) for (const c of COLAS) exacto(n, BASE + c, f);
  });
  it('más allá de los 150 car. (base64 de una cuenta de servicio, token de 192 car.)', () => {
    const b64 = R(256, 'Ab+9Cd/8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0Uv');
    for (const n of NOMBRES) for (const f of FORMAS) for (const v of [b64, b64 + '==', R(192, 'Zq3xV9mK2pL7') + '#x!9']) exacto(n, v, f);
  });
  it('mejor que en orden: un símbolo antes de los 16 car. o una palabra clave dentro de la contraseña', () => {
    const resto = 'P2vL8qR4' + 'wZ7tAb12';
    exacto('DB_PASSWORD', `Xk9m${'$'}${resto}`, (n, v) => `${n}=${v}`);
    exacto('DB_PASSWORD', `Xk9m${'$'}${'tok' + 'en'}=${resto}cd`, (n, v) => `${n}=${v}`);       // la genérica casa dentro
    exacto('SMTP_PASS', `Xk9m${'#'}${'api_' + 'key'}:${resto}!x`, (n, v) => `${n}: ${v}`);
  });
  it('propiedad con semilla: 2000 contraseñas con símbolos tras un tramo de la clase', () => {
    let x = 0x2545f491;
    const azar = (n: number) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
    const ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', SIM = '#!$@~:%^*({}|?\\+/=._-';
    const tramo = (n: number, abc: string) => Array.from({ length: n }, () => abc[azar(abc.length)]).join('');
    for (let i = 0; i < 2000; i++) {
      let v = tramo(16 + azar(20), ALFA) + String(azar(10));          // la genérica confirma el principio (dígito y entropía)
      for (let j = 1 + azar(3); j > 0; j--) v += tramo(1 + azar(3), SIM) + tramo(azar(12), ALFA);
      exacto(NOMBRES[azar(NOMBRES.length)]!, v, FORMAS[azar(FORMAS.length)]!);
    }
  });
  it('la cola se para ante un Bearer o un Authorization: pegados: su token sigue tapado', () => {
    const tok = R(24, 'Lm4Nb7Vc1Xz9');
    expect(redactString(`DB_PASSWORD=${BASE}!Bearer ${tok}`)).toBe('DB_PASSWORD=[REDACTADO]Bearer [REDACTADO]');
    expect(redactString(`DB_PASSWORD=${BASE}!Authorization: Basic ${tok}`)).toBe('DB_PASSWORD=[REDACTADO]Authorization: [REDACTADO]');
  });
  it('lineal con entradas adversas para la cola (≥ 100 KB cada una)', () => {
    const t0 = performance.now();
    for (const s of [`key=${BASE}#`.repeat(5000), `password=${BASE}#` + 'a'.repeat(200000), `token=${BASE}!Bearer `.repeat(4000),
      `xtoken=${BASE}Authorization${' '.repeat(8)}`.repeat(4000), 'DB_PASSWORD=' + `${BASE}!token=`.repeat(4500),
      'Authorization' + ' '.repeat(100000) + ':', `${BASE}#[REDACTADO]`.repeat(4000)])
      redactString(s);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

// Ronda 4: la unión de tramos partía lo que un patrón de después tapa entero. Un valor que es una URL con query perdía su
// `https://` o su `?` dentro del [REDACTADO], la regla que quita las queries ya no casaba y lo que iba tras el primer `&`
// (X-Amz-Signature, code=, sig_v2=) salía en claro; HEAD quitaba la query entera. Igual un token Bearer pisado a medias,
// la contraseña de una cadena de conexión y un valor entre comillas con `; , ) [ <` dentro. Ahora la salida tapa al menos
// lo que tapaba HEAD (tapaClaves lo calcula y lo comprueba).
describe('lo que un patrón tapa entero no se parte (ronda 4)', () => {
  const HEX = R(64, '9f8e7d6c5b4a3210'), BASE = R(16, 'Xk9mP2vL' + '8qR4wZ7t'), TOK = R(24, 'Lm4Nb7Vc1Xz9');
  const idem = (out: string, l: string) => expect(redactString(out), l).toBe(out);
  it('las líneas del fallo: ni un carácter de la query tras el primer & sobrevive', () => {
    const code = '4/0AfJ' + 'ohXmSECRETCODE99';
    const casos: Array<[string, string]> = [
      [`webhook_secret: https://hooks.acme.io/T01234567/B0123?x=1&sig_v2=${HEX}`, 'webhook_secret: [REDACTADO]'],
      [`UPLOAD_TOKEN_URL=https://bucket.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20240101T000000Z`
        + `&X-Amz-Expires=3600&X-Amz-Signature=${HEX}`, 'UPLOAD_TOKEN_URL=[REDACTADO]'],
      [`AUTH_REDIRECT=https://app.acme.io/cb?state=abc123def456ghi&code=${code}`, 'AUTH_REDIRECT=[REDACTADO]'],
      [`curl "https://bucket.s3.amazonaws.com/k?X-Amz-Credential=AK${'IA2EXAMPLE'}%2F20240101&X-Amz-Signature=${HEX}"`,
        'curl "https://bucket.s3.amazonaws.com/k'],                                       // sin clave: la query fuera, como HEAD
    ];
    for (const [l, esperado] of casos) {
      const out = redactString(l);
      for (const par of l.slice(l.indexOf('&') + 1).split('&')) expect(out, l).not.toContain(par.slice(par.indexOf('=') + 1));
      expect(out).toBe(esperado);
      idem(out, l);
    }
  });
  it('propiedad con semilla: 1500 valores URL con query tras un nombre de secreto; ningún parámetro sobrevive', () => {
    let x = 0x7f4a7c15, k = 0;
    const azar = (n: number) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
    const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
    const marca = () => 'Q' + Array.from({ length: 6 }, () => AL[azar(AL.length)]).join('') + (k++ % 10);
    const NOMBRES = ['webhook_secret', 'UPLOAD_TOKEN_URL', 'AUTH_REDIRECT', 'api_key', 'apiKey', 'password', 'credentials',
      'token', 'DB_PASSWORD', 'GITHUB_TOKEN_2', 'x.api.key', 'authToken'];
    const SEPS = ['=', ': ', '="', ": '", ' = ', ':=', '%3D', '":"'];
    const HOSTS = ['https://hooks.acme.io/T01234567/B0123', 'https://bucket.s3.amazonaws.com/k', 'http://app.acme.io/cb',
      'https://h.com/a1b2c3d4e5f6g7h8)x', 'https://h.com/p'];
    const DESPUES = ['', ' OTRA=1', '"', "'", ' }', '#frag', `\tBearer ${TOK}`, ` Authorization: Basic ${TOK}`];
    for (let i = 0; i < 1500; i++) {
      const marcas: string[] = [];
      const pares = Array.from({ length: 1 + azar(4) }, () => {
        const m = marca(); marcas.push(m);
        return ['sig', 'code', 'X-Amz-Signature', 'state', 'x', 'q'][azar(6)]! + '=' + m + String(azar(1e6)) + ['', '/', '-', '.', '%2F'][azar(5)]!;
      });
      const l = ['', 'export ', 'curl -d ', '{ ', 'x '][azar(5)]! + NOMBRES[azar(NOMBRES.length)]! + SEPS[azar(SEPS.length)]!
        + HOSTS[azar(HOSTS.length)]! + '?' + pares.join('&') + DESPUES[azar(DESPUES.length)]!;
      const out = redactString(l);
      for (const m of [...marcas, TOK]) expect(out.includes(m), `${l}\n→ ${out}`).toBe(false);
      idem(out, l);
    }
  });
  it('propiedad con semilla: 4000 líneas con cabezas de patrón pegadas a tramos; nada que tapaban los patrones solos sale', () => {
    // Lo que hacía HEAD: solo los patrones, la quita de queries, el correo y el teléfono, con los mismos patrones.
    const tel = (t: string) => { const d = t.replace(/\D/g, ''); return '+' + d.slice(0, 2) + '•••' + d.slice(-4); };
    const soloPatrones = (t: string) => {
      for (const [re, rep] of PATRONES_SECRETO) t = t.replace(re, rep);
      return t.replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, '$1').replace(/\b([\w.+-])[\w.+-]*@((?:[\w-]+\.)+[A-Za-z]{2,})\b/g, '$1***@$2')
        .replace(/\+\d{8,15}\b/g, tel);
    };
    let x = 0x1234abcd, k = 0;
    const azar = (n: number) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
    const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
    const marca = () => 'Q' + Array.from({ length: 6 }, () => AL[azar(AL.length)]).join('') + (k++ % 10) + String(azar(1000));
    const PIEZAS = ['token=', 'key=', ' key=', '&sig=', 'password=', 'DB_PASSWORD=', 'secret: ', 'api_key: "', 'Bearer ', 'Authorization: ',
      'Authorization: Basic ', 'authorization=', 'postgres://u:', '@h/db', '-----BEGIN ' + 'PRIVATE KEY-----\n', '\n-----END ' + 'PRIVATE KEY-----',
      'https://a.b/c?', 'http://x.io/p', '?q=', '&', '[', ']', '`', '#', ' ', '"', "'", '(', ')', ',', ';', '-', '.', '!', '$', ':', '=',
      BASE, '"Authorization": "', 'a.key='];
    for (let i = 0; i < 4000; i++) {
      let l = '';
      const marcas: string[] = [];
      for (let j = 2 + azar(12); j > 0; j--) if (azar(3) === 0) { const m = marca(); marcas.push(m); l += m; } else l += PIEZAS[azar(PIEZAS.length)]!;
      const out = redactString(l), head = soloPatrones(l);
      for (const m of marcas) expect(out.includes(m) && !head.includes(m), `${l}\n→ ${out}\nHEAD ${head}`).toBe(false);
      idem(out, l);
    }
  });
  it('la quita de queries es la de HEAD, sin su coste cuadrático', () => {
    let x = 0x3c6ef372;
    const azar = (n: number) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
    const PIEZAS = ['http://', 'https://', 'http', 's://', 'h.io', '/p', '?', '?', '#', ' ', '\t', 'x=1', '&', 'a', '.', '"'];
    for (let i = 0; i < 3000; i++) {
      let s = '';
      for (let j = 1 + azar(30); j > 0; j--) s += PIEZAS[azar(PIEZAS.length)];
      expect(redactString(s), s).toBe(s.replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, '$1'));
    }
  });
  // La query (o la cola, o el param= de `token=`) llega a la cabeza de un patrón que sigue tras el blanco (Bearer,
  // Authorization:, -----BEGIN): lo que ese patrón tapa, tapado también. HEAD y la ronda 3 dejaban en claro el token
  // (`token=…-Bearer tok`: el param= se comía la palabra Bearer) o el cuerpo de la clave privada pegada a la cola.
  it('si la unión se come la cabeza de un patrón que sigue tras el blanco, se lleva también lo que él tapa', () => {
    const cuerpo = R(64), privada = '-----BEGIN ' + 'PRIVATE KEY-----\n' + cuerpo + '\n-----END ' + 'PRIVATE KEY-----';
    const casos: Array<[string, string, string]> = [
      [`secret: ${BASE}https://a.b/c?q=-Bearer ${TOK}`, 'secret: [REDACTADO] [REDACTADO]', TOK],
      [`secret: ${BASE}https://a.b/c?h=Authorization: Basic ${TOK}`, 'secret: [REDACTADO] [REDACTADO]', TOK],
      [`secret: ${BASE}https://a.b/c?k=${privada}`, 'secret: [REDACTADO]', cuerpo],
      [`token=${BASE}https://a.b/c?q=-Bearer ${TOK}`, 'token=[REDACTADO] [REDACTADO]', TOK],
      [`token=${BASE}https://a.b/c?h=Authorization: Basic ${TOK}`, 'token=[REDACTADO] Basic [REDACTADO]', TOK],
      [`token=${BASE}https://a.b/c?k=${privada}`, 'token=[REDACTADO]', cuerpo],
      [`x token=${BASE}-Bearer ${TOK}`, 'x token=[REDACTADO] [REDACTADO]', TOK],
      [`DB_PASSWORD=${BASE}#${privada}`, 'DB_PASSWORD=[REDACTADO]', cuerpo],
      [`Bearer key=${'QwEcqt73' + '11808abcdef'}[${'QUVwXq8'}&x`, 'Bearer key=[REDACTADO]&x', 'QUVwXq8'],   // param= dentro del token
    ];
    for (const [l, esperado, secreto] of casos) {
      const out = redactString(l);
      expect(out, l).not.toContain(secreto.slice(0, 12));
      expect(out, l).toBe(esperado);
      idem(out, l);
    }
  });
  it('un token Bearer que un tramo pisa a medias se tapa entero, como en HEAD', () => {
    const v = 'Xy9mQ2pL' + '7vR4tY8wZZ';
    for (const [l, esperado] of [[`Bearer a.key=${v}`, 'Bearer [REDACTADO]'], [`curl -H "Bearer x_token=${v}"`, 'curl -H "Bearer [REDACTADO]"'],
      [`Authorization: Bearer a.key=${v}`, 'Authorization: [REDACTADO]']]) {
      const out = redactString(l!);
      expect(out, l).toBe(esperado);
      idem(out, l!);
    }
  });
  it('la contraseña de una cadena de conexión que un tramo pisa se tapa entera', () => {
    const pw = 'Pw' + R(18, 'q7Z2x9K4');
    for (const l of [`"Authorization": "postgres://u:'${pw}@db.acme.io/app`, `postgres://u:${pw},$auth%3D"=${R(20)}@b.com`,
      `{"token":"mysql://app:${pw}@db"}`]) {
      const out = redactString(l);
      expect(out.includes(pw.slice(0, 8)) || out.includes(pw.slice(-8)), `${l}\n→ ${out}`).toBe(false);
      idem(out, l);
    }
  });
  it('entre comillas el valor llega a la de cierre: `; , ) [ < & ` y blancos dentro no lo parten', () => {
    const FORMAS: Array<(n: string, v: string) => string> = [(n, v) => `${n}: "${v}"`, (n, v) => `{ ${n}: '${v}' }`,
      (n, v) => `${n} = "${v}";`, (n, v) => `export ${n}="${v}" OTRA=1`];
    for (const n of ['api_key', 'DB_PASSWORD', 'secretKey', 'ACCESS_KEY', 'token', 'credentials'])
      for (const cola of [';abcSECRET9', ',x9 y', ')tail99', '[abc<SECRET>', '&q=9', ' con espacios 9', '`b9', ']z]9'])
        for (const f of FORMAS) {
          const l = f(n, BASE + cola), out = redactString(l);
          expect(out, l).toBe(f(n, '[REDACTADO]'));
          idem(out, l);
        }
  });
  // `postgres://u:` repetido sin @ y cabeceras de clave privada sin pie (cuadráticos como regex, también en redactString
  // hasta tapaConexiones y tapaPrivadas), en la prueba por proporción del final. La última entrada pasa por la versión
  // lineal de tapaClaves y por tapaPrivadas (antes, por el patrón de HEAD, que era casi todo su coste: 30 → 3 ms).
  it('lineal con entradas adversas para URLs, Bearer, cadenas de conexión, comillas y lo de HEAD (≥ 100 KB cada una)', () => {
    const t0 = performance.now();
    for (const s of ['http://'.repeat(15000), 'api_key: ' + 'https://a'.repeat(12000), 'https://a?'.repeat(11000),
      `token=${BASE}https://a.b/c?x=1&`.repeat(3000), `key=${BASE}https://a.b/c?q#`.repeat(3500), `a.key=${BASE}ZZ Bearer `.repeat(3500),
      `Bearer a.key=${BASE}ZZ `.repeat(3500), `"Authorization": "postgres://u:'${BASE}@h `.repeat(2500),
      `token=${BASE}postgres://u:p${BASE}@h `.repeat(2500), `key="${BASE};`.repeat(5000), (`password: "${BASE};` + 'y'.repeat(240)).repeat(400),
      `token=${BASE}https://a.b/c?q=-Bearer `.repeat(3000), `token=${BASE}https://a.b/c?h=Authorization: `.repeat(2500),
      `token=${BASE}-Bearer `.repeat(5000), `token=${BASE}Authorization: Basic `.repeat(4000), `token=${BASE}` + 'authorization='.repeat(8000),
      `x token=${BASE}&key=${BASE}#`.repeat(4000), `token=${BASE} ` + ('-----BEGIN ' + 'PRIVATE KEY-----').repeat(4000)])
      redactString(s);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('redact: pasada por clave y por patrón', () => {
  it('claves secretas por segmento → [REDACTADO]; path, input_tokens y max_tokens intactas', () => {
    const out = redact({
      read_token: 'x1', KAPSO_API_KEY: 'x2', secret__token_llamada: 'x3', Authorization: 'x4', sealed: { a: 1 }, wdek: 'x5',
      path: 'src/db.ts', input_tokens: 5, max_tokens: 1024, vacio_token: '',
    });
    expect(out).toEqual({
      read_token: '[REDACTADO]', KAPSO_API_KEY: '[REDACTADO]', secret__token_llamada: '[REDACTADO]', Authorization: '[REDACTADO]',
      sealed: '[REDACTADO]', wdek: '[REDACTADO]', path: 'src/db.ts', input_tokens: 5, max_tokens: 1024, vacio_token: '',
    });
  });
  it('claves de teléfono sin + (Kapso) se enmascaran solo si el valor es un número', () => {
    expect(redact({ from: '584121234567', to: 'in_app', wa_id: '+584129876543' }))
      .toEqual({ from: '+58•••4567', to: 'in_app', wa_id: '+58•••6543' });
  });
  it('recorre arrays y objetos anidados; corta a profundidad 8', () => {
    const s = 'sb_' + 'secret_' + R(32);
    expect(JSON.stringify(redact({ a: [{ b: `log ${s}` }] }))).not.toContain(s);
    let hondo: unknown = 'fin';
    for (let i = 0; i < 10; i++) hondo = { n: hondo };
    expect(JSON.stringify(redact(hondo))).toContain('[demasiado profundo]');
  });
  it('lodash@4.17.21 no se toma por correo dentro de la evidencia', () => {
    expect(redact({ paquete: 'lodash@4.17.21', path: 'package-lock.json' })).toEqual({ paquete: 'lodash@4.17.21', path: 'package-lock.json' });
  });
});

describe('redactForExport (S13 13.2)', () => {
  const s = 'sb_' + 'secret_' + R(32);
  const snap = {
    title: `Clave ${s} en el repo`,
    resource: 'ip:186.92.14.7',
    evidence: {
      path: 'src/lib/db.ts', paths_4xx: ['/.env'], dedupe_key: 'a'.repeat(64), rule_id: 'CB_SECRET_GENERIC', fingerprint_short: 'abcd1234',
      read_token: 'x', password: 'y', api_key: 'z', KAPSO_API_KEY: 'w', correo: 'bob@example.org', version: '2.0.0.1',
      ip: '186.92.14.7', ips: ['186.92.14.7', '2800:3f0::1'], client_ip: '203.0.113.7', top_ips: [{ ip: '198.51.100.23', n: 40 }],
    },
    actions: [{ target: '186.92.14.7' }, { target: 'zona-x' }],
    fix: { text: 'p'.repeat(5000) },
  };
  it('patrones de redact(), clave anclada e IP a /24 solo por posición', () => {
    const out = redactForExport(snap, { ips: 'mask_24' });
    const j = JSON.stringify(out);
    expect(j).not.toContain(s);
    expect(out.title).toBe('Clave [REDACTADO:supabase] en el repo');
    expect(out.resource).toBe('ip:186.92.14.0/24');
    expect(out.evidence).toMatchObject({
      path: 'src/lib/db.ts', paths_4xx: ['/.env'], dedupe_key: 'a'.repeat(64), rule_id: 'CB_SECRET_GENERIC', fingerprint_short: 'abcd1234',
      read_token: '[REDACTADO]', password: '[REDACTADO]', api_key: '[REDACTADO]', KAPSO_API_KEY: '[REDACTADO]',
      correo: 'b***@example.org', version: '2.0.0.1',
      ip: '186.92.14.0/24', ips: ['186.92.14.0/24', '2800:3f0:0::/48'], client_ip: '203.0.113.0/24', top_ips: [{ ip: '198.51.100.0/24', n: 40 }],
    });
    expect(out.actions).toEqual([{ target: '186.92.14.0/24' }, { target: 'zona-x' }]);
    expect(out.fix.text).toHaveLength(5000);                       // fix.text admite hasta 12000
  });
  it('ips:"full" no toca las IP', () => {
    const out = redactForExport(snap, { ips: 'full' });
    expect(out.evidence.ip).toBe('186.92.14.7');
    expect(out.resource).toBe('ip:186.92.14.7');
    expect(out.evidence.read_token).toBe('[REDACTADO]');
  });
  it('idempotente: f(f(x)) === f(x), también con recortes', () => {
    const largo = { title: 't'.repeat(500), resource: 'r'.repeat(400), evidence: { log: 'x'.repeat(3000) }, fix: { text: 'f'.repeat(13000) } };
    for (const v of [snap, largo]) for (const ips of ['mask_24', 'full'] as const) {
      const una = redactForExport(v, { ips });
      expect(JSON.stringify(redactForExport(una, { ips }))).toBe(JSON.stringify(una));
    }
    const out = redactForExport(largo, { ips: 'mask_24' });
    expect(out.title).toHaveLength(300);
    expect(out.title.endsWith('…[truncado]')).toBe(true);
    expect(out.resource).toHaveLength(300);
    expect(out.evidence.log).toHaveLength(2000);
    expect(out.fix.text).toHaveLength(12000);
  });
  it('claves ordenadas y entrada sin mutar', () => {
    const v = { z: 1, a: { y: 2, b: 3 } };
    expect(JSON.stringify(redactForExport(v, { ips: 'mask_24' }))).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(Object.keys(v)).toEqual(['z', 'a']);
  });
});

describe('parámetros y cabeceras con secreto fuera de una URL (prueba de fuga, §15.11)', () => {
  const v = 'LEAK7Q2Xabcdefghij';
  it('?token=, &access_token=, token= suelto y client_secret= quedan tapados', () => {
    expect(redactString(`GET /cb?token=${v}&x=1`)).toBe('GET /cb?token=[REDACTADO]&x=1');
    expect(redactString(`refresh &access_token=${v} ok`)).toBe('refresh &access_token=[REDACTADO] ok');
    expect(redactString(`token=${v}`)).toBe('token=[REDACTADO]');
    expect(redactString(`error: client_secret=${v}; reintento`)).toBe('error: client_secret=[REDACTADO]; reintento');
    expect(redactString(`url ...&key=${v}`)).not.toContain(v);
  });
  it('Authorization: Bearer / Basic / token se tapa entera', () => {
    for (const h of [`Authorization: Bearer ${v}`, `authorization: basic ${v}`, `Authorization=token ${v}`]) {
      expect(redactString(h)).toMatch(/^authorization\s*[:=]\s*\[REDACTADO\]$/i);
    }
    expect(redactString(`bearer ${v}`)).toBe('Bearer [REDACTADO]');
  });
  it('no toca palabras sin =, ni input_tokens, y es idempotente', () => {
    expect(redactString('max_tokens 2000, input_tokens: 10')).toBe('max_tokens 2000, input_tokens: 10');
    const una = redactString(`Authorization: Bearer ${v} y ?token=${v}`);
    expect(redactString(una)).toBe(una);
    expect(una).not.toContain('LEAK7Q2X');
  });
});

// Por proporción y no por tiempo absoluto (como export.test.ts): doblar el texto cuesta ≈ ×2 si es lineal y ×4 si es
// cuadrático, y las dos medidas sufren la misma carga de la suite. Antes, con 24 KB: el correo 250 ms (`+5`, `1.`: un \b
// en cada posición de un tramo largo de [\w.+-]; 25 veces la CPU de un Worker), `postgres://u:` sin @ 20 ms y las
// cabeceras de clave privada sin pie 1 ms (85 ms con 192 KB). De 192 a 384 KB: con menos, el margen tapaba la privada.
describe('lineal por proporción con texto hostil: correo, cadena de conexión y clave privada', () => {
  /** Mejor de 3 corridas, en ms (como export.test.ts): un coste cuadrático tumba la prueba; el ruido, no. */
  const ms = (f: () => unknown) => {
    let mejor = Infinity;
    for (let i = 0; i < 3; i++) { const a = performance.now(); f(); mejor = Math.min(mejor, performance.now() - a); }
    return mejor;
  };
  const largo = (base: string, n: number) => base.repeat(Math.ceil(n / base.length));
  const lineal = (familias: ReadonlyArray<string | ((n: number) => string)>) => {
    for (const f of familias) {
      const gen = typeof f === 'string' ? (n: number) => largo(f, n) : f;
      const uno = ms(() => redact(gen(192_000))), dos = ms(() => redact(gen(384_000)));
      expect(dos, gen(40)).toBeLessThan(uno * 3 + 20);
      expect(uno, gen(40)).toBeLessThan(1500);
    }
  };
  const PRIVADA = '-----BEGIN ' + 'PRIVATE KEY-----';
  it('correos: tramos largos de [\\w.+-] con y sin @ detrás, y muchos correos seguidos', () => lineal(['+5', '1.', 'a.',
    '-a', '_.', '1+', 'a-b.', '..a', '+5.1-a_', '1.@', 'a.b@', '.@', '@a-b.', 'x@a.bc ', 'a@b.cd.', (n) => largo('1.', n) + '@',
    (n) => largo('+5', n) + '@a.b1']));
  it('las mismas familias tras una clave, que pasan también por tapaClaves', () => lineal(['token.', 'a.key.', 'key-',
    'api.key=1.', "'token': '+5", (n) => 'key=' + largo('1.', n), (n) => 'token: ' + largo('+5', n)]));
  it('cadenas de conexión sin @ y cabeceras de clave privada sin pie', () => lineal(['postgres://u:', 'postgresql://a.b:',
    'redis://u:', 'mongodb+srv://a:', PRIVADA, '-----BEGIN RSA ' + 'PRIVATE KEY-----END ',
    (n) => 'key=x ' + largo('postgres://u:', n), (n) => `token=${R(20)} ` + largo(PRIVADA, n)]));
  // Lo que hacían las regex en los casos raros, fijado (contra la versión anterior, corpus y fuzz dieron lo mismo en todo).
  it('mismo resultado que las regex: correo que empieza donde acabó otro, dominio sin letras, pies solapados, sin @', () => {
    expect(redactString('a@b.com.x@y.org')).toBe('a***@b.com.***@y.org');
    expect(redactString('.a@b.com, +5@x.io y 1.2.3@4.5')).toBe('.a***@b.com, +5***@x.io y 1.2.3@4.5');
    expect(redactString('x.x.x.x.x.@a.b1 y x.x.x.x.x.@ab.cd')).toBe('x.x.x.x.x.@a.b1 y x***@ab.cd');
    const k = (s: string) => s + ' ' + 'PRIVATE KEY-----';
    expect(redactString(k('-----BEGIN A') + k('END X') + k('END Y') + ' fin')).toBe('[REDACTADO:clave_privada] fin');
    expect(redactString(k('-----BEGIN A') + 'sin pie ' + k('-----BEGIN B') + 'x-----' + k('END')))
      .toBe('[REDACTADO:clave_privada]');
    expect(redactString('postgres://u:p postgres://u:q@h redis://a:b:c@d mysql://x:y'))
      .toBe('postgres://u:p postgres://u:[REDACTADO]@h redis://a:[REDACTADO]@d mysql://x:y');
  });
});
