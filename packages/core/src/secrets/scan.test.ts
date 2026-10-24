// Casos de S15 15.13 para secrets/scan.ts (más los de 09.8–09.9). Todo valor con forma de secreto se arma en tiempo de
// ejecución: ningún escáner, ni el nuestro ni el del jurado, encuentra literales en el repo (como redact.test.ts).
import { describe, it, expect } from 'vitest';
import { escanearSecretos, scanArchivo, reglasEnv, enmascarar, rolJwt, gitignoreCubreEnv, variablesEnv, esEnvSubido,
  type ArchivoTexto } from './scan.ts';
import { entropia } from './entropy.ts';

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const RICO = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv';
const R = (n: number, base = RICO) => base.repeat(Math.ceil(n / base.length)).slice(0, n);
const jwt = (role: string) => b64url({ alg: 'HS256', typ: 'JWT' }) + '.'
  + b64url({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role, iat: 1761300000, exp: 2076876000 }) + '.' + R(43, 'Zx9Yw8Vu7Ts6');
const T = {
  serviceRole: jwt('service_role'),
  anon: jwt('anon'),
  sbSecret: 'sb_' + 'secret_' + R(32),
  aws: 'AK' + 'IA' + R(16, 'QRSTUVWXYZ234567'),
  stripe: 'sk' + '_live_' + R(24),
  stripeTest: 'sk' + '_test_' + R(24),
  anthropic: 'sk-' + 'ant-api03-' + R(93) + 'AA',
  openai: 'sk-' + 'proj-' + R(74) + 'T3Blbk' + 'FJ' + R(74, 'Qr9St0UvAb1Cd2Ef3Gh4Ij5Kl6Mn7Op8'),
  ghp: 'gh' + 'p_' + R(36),
  githubPat: 'github_' + 'pat_' + R(82),
  privada: '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + R(64) + '\n' + R(64, 'Mn7Op8Qr9St0Uv') + '\n-----END ' + 'RSA PRIVATE KEY-----',
  pgClave: 'a1b2c3d4e5f6a7b8c9d0',
  generico: R(32, 'Uv0St9Qr8Op7Mn6Kl5Ij4Gh3Ef2Cd1Ab'),               // distinto del cuerpo de sbSecret
};
const pgUrl = (host: string, clave = T.pgClave, user = 'postgres') => 'postgresql://' + user + ':' + clave + '@' + host + ':5432/postgres';
const uno = async (path: string, content: string) => (await escanearSecretos([{ path, content }])).hallazgos;
const reglas = async (path: string, content: string) => (await uno(path, content)).map((h) => h.rule_id);

describe('JWT de Supabase (15.13)', () => {
  it('service_role falso → critical con preview 4+4 y sin el valor en la salida', async () => {
    const hs = await uno('src/lib/supabaseAdmin.ts', `import x from 'y';\n\n\nconst KEY = "${T.serviceRole}";\n`);
    expect(hs).toHaveLength(1);
    const h = hs[0]!;
    expect(h).toMatchObject({ module: 'codebase', rule_id: 'CB_SECRET_SUPABASE_SERVICE_ROLE', severity: 'critical', confirmed: true,
      origin: 'rule', resource: 'src/lib/supabaseAdmin.ts:4', dedupe_input: 'src/lib/supabaseAdmin.ts:4' });
    expect(h.evidence.preview).toBe(T.serviceRole.slice(0, 4) + '…' + T.serviceRole.slice(-4));
    expect(h.evidence).toMatchObject({ path: 'src/lib/supabaseAdmin.ts', line: 4, ubicaciones: [{ path: 'src/lib/supabaseAdmin.ts', line: 4, origen: 'head' }] });
    expect(h.evidence.snippet).toBe('const KEY = "[SECRET:CB_SECRET_SUPABASE_SERVICE_ROLE]";');
    expect(JSON.stringify(hs)).not.toContain(T.serviceRole.split('.')[1]);
  });
  it('anon → nada (pública por diseño), tampoco como genérica', async () => {
    expect(await uno('.env', `VITE_SUPABASE_ANON_KEY=${T.anon}\n`)).toEqual([]);
  });
  it('rolJwt clasifica sin verificar firma y no lanza con basura', () => {
    expect(rolJwt(T.serviceRole)).toBe('service_role');
    expect(rolJwt('eyJx')).toBeNull();
    expect(rolJwt('a.b.c')).toBeNull();
  });
});

describe('cada regla de 09.9 dispara con su forma y no con la parecida', () => {
  const casos: Array<[string, string, string, string]> = [
    ['CB_SECRET_SB_SECRET', 'critical', 'server/db.ts', `const k = '${T.sbSecret}'`],
    ['CB_SECRET_AWS', 'critical', 'deploy.sh', `export AWS_ID=${T.aws} `],
    ['CB_SECRET_STRIPE_LIVE', 'critical', 'pagos.ts', `stripe(${JSON.stringify(T.stripe)})`],
    ['CB_SECRET_ANTHROPIC', 'critical', 'ia.ts', `new Anthropic({ k: "${T.anthropic}" })`],
    ['CB_SECRET_OPENAI', 'critical', 'ia.py', `client = OpenAI("${T.openai}")`],
    ['CB_SECRET_GITHUB_PAT', 'critical', 'ci.yml', `gh: ${T.ghp}`],
    ['CB_SECRET_GITHUB_PAT', 'critical', 'ci2.yml', `gh: ${T.githubPat}`],
    ['CB_SECRET_PRIVATE_KEY', 'critical', 'deploy/id.txt', T.privada],
    ['CB_SECRET_POSTGRES_URL', 'critical', 'config.ts', `const u = "${pgUrl('db.abcdefghijklmnopqrst.supabase.co')}"`],
    ['CB_SECRET_POSTGRES_URL', 'critical', 'pool.ts', `const u = "${pgUrl('aws-0-us-east-1.pooler.supabase.com', T.pgClave, 'postgres.abcdef')}"`],
    ['CB_SECRET_POSTGRES_URL', 'high', 'app.ts', `const u = "${pgUrl('db-prod.interno.net')}"`],
    ['CB_SECRET_GENERIC', 'medium', 'config.js', `const apiKey = "${T.generico}";`],
  ];
  for (const [rule, sev, path, content] of casos)
    it(`${rule} (${sev}) en ${path}`, async () => {
      const hs = await uno(path, content);
      expect(hs.map((h) => [h.rule_id, h.severity])).toEqual([[rule, sev]]);
      expect(hs[0]!.title.length).toBeLessThanOrEqual(120);
    });
  it('negativos: sk_test_, AKIA en minúsculas, entropía baja, valores de ejemplo y Postgres local', async () => {
    expect(await uno('a.ts', `stripe("${T.stripeTest}")`)).toEqual([]);
    expect(await uno('a.ts', `x = ${T.aws.toLowerCase()} `)).toEqual([]);
    expect(await uno('a.ts', `const token = "${'a'.repeat(24)}"`)).toEqual([]);
    expect(await uno('a.ts', `gh: ${'gh' + 'p_' + 'ab'.repeat(18)}`)).toEqual([]);                     // entropía 1 < 3
    expect(await uno('a.ts', `api_key = "your_api_key_${R(12)}"`)).toEqual([]);
    expect(await uno('a.ts', `secret: "${'example' + R(20)}"`)).toEqual([]);
    expect(await uno('a.ts', `const apiKey = process.env.API_KEY_DE_PRODUCCION`)).toEqual([]);
    for (const host of ['localhost', '127.0.0.1', 'db', 'postgres'])
      expect(await uno('docker-compose.yml', `DATABASE_URL: ${pgUrl(host)}`), host).toEqual([]);
    expect(await uno('a.ts', pgUrl('db.abcdefghijklmnopqrst.supabase.co', 'changeme123'))).toEqual([]);
  });
  it('la genérica no toma identificadores ni salta de línea (falsos positivos de nuestro propio repo)', async () => {
    const texto = [
      'const key = env.SUPABASE_SECRET_KEY;',
      '    token = body.read_token.trim();',
      '  foreignKeyName: "actions_org_id_fkey"',
      'new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 })',
      'TWILIO_API_SECRET=',
      `OTRA_CLAVE_${R(20)}`,
    ].join('\n');
    expect(await uno('apps/api/src/x.ts', texto)).toEqual([]);
    expect(await reglas('.env', `API_SECRET=\nAPI_TOKEN=${T.generico}\n`)).toEqual(['CB_SECRET_GENERIC']);   // la de abajo sí
  });
  it('la genérica no repite lo que ya dio una específica', async () => {
    expect(await reglas('.env', `GITHUB_TOKEN=${T.ghp}\nSUPABASE_SECRET_KEY=${T.sbSecret}\n`)).toEqual(['CB_SECRET_GITHUB_PAT', 'CB_SECRET_SB_SECRET']);
    // El mismo valor en otro sitio: allí también lo casa la específica (un hallazgo con dos ubicaciones, sin genérica).
    const hs = await uno('.env', `GITHUB_TOKEN=${T.ghp}\nA=1\nOTRO_TOKEN=${T.ghp}\n`);
    expect(hs.map((h) => [h.rule_id, h.evidence.ubicaciones?.map((u) => u.line)])).toEqual([['CB_SECRET_GITHUB_PAT', [1, 3]]]);
  });
  // Revisión de ataque (diff de 512 KB): cada genérica se comparaba con TODAS las específicas del archivo (cuadrático);
  // 3 500 + 3 500 en 300 KB costaban ~300 ms frente a ~70 ms por separado.
  it('lineal: miles de específicas y genéricas en un mismo archivo cuestan como por separado', () => {
    const ALF = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const varia = (i: number, n: number) => {
      let s = '', x = Math.imul(i + 1, 2654435761) >>> 0;
      for (let k = 0; k < n; k++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; s += ALF[x % 62]; }
      return s;
    };
    const N = 4000, stripe = 'sk' + '_live_';
    const esp = Array.from({ length: N }, (_, i) => `a = "${stripe}${varia(i, 30)}"`);
    const gen = Array.from({ length: N }, (_, i) => `api_key = "${varia(i + 99_999, 9)}9${varia(i + 5, 20)}"`);
    const mezcla = esp.flatMap((l, i) => [l, gen[i]!]).join('\n');
    expect(scanArchivo('src/x.ts', mezcla)).toHaveLength(2 * N);
    const mejor = (f: () => void) => Math.min(...[0, 1, 2].map(() => { const t0 = performance.now(); f(); return performance.now() - t0; }));
    const junto = mejor(() => scanArchivo('src/x.ts', mezcla));
    const aparte = mejor(() => { scanArchivo('src/a.ts', esp.join('\n')); scanArchivo('src/b.ts', gen.join('\n')); });
    expect(junto).toBeLessThan(2 * aparte + 50);
  });
});

describe('lista de permitidos de nuestros marcadores (A9)', () => {
  it('[SECRET:…], postgres://u:[REDACTADO]@db, ••••, [REDACTADO] y [REDACTADO:x] → nada', async () => {
    const texto = [
      'const a = { token: "[SECRET:CB_SECRET_GITHUB_PAT]" };',
      'api_key = "[SECRET:CB_SECRET_GENERIC]"',
      'const KEY = import.meta.env.VITE_SB_ADMIN ?? "[SECRET:CB_SECRET_SUPABASE_SERVICE_ROLE]"',
      'DATABASE_URL=postgres://u:[REDACTADO]@db',
      'DATABASE_URL=postgres://postgres:[REDACTADO]@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
      'preview: "postgresql://postgres:••••@db.•••.supabase.co"',
      'password = "••••••••"',
      'secret_value: "[REDACTADO:jwt]" y authorization: [REDACTADO]',
    ].join('\n');
    expect(scanArchivo('docs/export-ejemplo.md', texto)).toEqual([]);
    expect(await uno('docs/export-ejemplo.md', texto)).toEqual([]);
  });
  it('el marcador cambia por un espacio y no mueve las líneas', async () => {
    const hs = await uno('a.ts', `x = "[SECRET:CB_SECRET_AWS]"\n••••\nconst k = '${T.sbSecret}'`);
    expect(hs[0]?.resource).toBe('a.ts:3');
  });
});

describe('qué archivos se miran', () => {
  it('binario saltado (NUL o extensión) y lockfiles fuera', async () => {
    expect(await uno('img/logo.bin', `\u0000\u0001PNG ${T.ghp}`)).toEqual([]);
    expect(await uno('img/logo.png', `gh: ${T.ghp}`)).toEqual([]);
    for (const lock of ['package-lock.json', 'web/pnpm-lock.yaml', 'yarn.lock', 'composer.lock', 'Gemfile.lock'])
      expect(await uno(lock, `"x": "${T.ghp}"`), lock).toEqual([]);
  });
  it('rutas de prueba: no se descartan, bajan a low con en_pruebas', async () => {
    const hs = await uno('src/__tests__/api.test.ts', `const t = "${T.ghp}"`);
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ severity: 'low', evidence: { en_pruebas: true } });
    expect(hs[0]!.title.endsWith('(en pruebas)')).toBe(true);
  });
  it('rebajarPruebas: false (revisión de código): las específicas no bajan, la genérica sí; en_pruebas se queda', async () => {
    const a: ArchivoTexto = { path: 'src/pagos.test.ts',
      content: `const k = "${T.stripe}";\nconst apiKey = "${T.generico}";\n` };
    const sin = (await escanearSecretos([a], { rebajarPruebas: false })).hallazgos;
    expect(sin.map((h) => [h.rule_id, h.severity, h.evidence.en_pruebas, h.title.endsWith(' (en pruebas)')]))
      .toEqual([['CB_SECRET_STRIPE_LIVE', 'critical', true, true], ['CB_SECRET_GENERIC', 'low', true, true]]);
    for (const opts of [{}, { rebajarPruebas: true }])                              // la auditoría no cambia
      expect((await escanearSecretos([a], opts)).hallazgos.map((h) => h.severity)).toEqual(['low', 'low']);
  });
});

describe('agrupado, huella y forma del borrador (09.9 paso 6, 09.11)', () => {
  const archivos: ArchivoTexto[] = [
    { path: '.env', content: `# claves\nSUPABASE_SECRET=${T.sbSecret}\n` },
    { path: 'src/lib/admin.ts', content: `a\nb\nc\nconst k = "${T.sbSecret}"\n` },
    { path: 'src/otro.ts', content: `const k = "${T.sbSecret}"; const j = "${T.sbSecret}"` },
  ];
  it('el mismo secreto en .env y en el código es UN hallazgo; la principal es la del código', async () => {
    const { hallazgos } = await escanearSecretos(archivos);
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.resource).toBe('src/lib/admin.ts:4');
    expect(hallazgos[0]!.evidence.ubicaciones).toEqual([
      { path: 'src/lib/admin.ts', line: 4, origen: 'head' }, { path: 'src/otro.ts', line: 1, origen: 'head' }, { path: '.env', line: 2, origen: 'head' }]);
    expect(hallazgos[0]!.evidence.fingerprint_short).toBeUndefined();
  });
  it('con opts.huella: fingerprint_short = 8 hex y la huella completa solo en el mapa de memoria', async () => {
    let llamadas = 0;
    const huella = async (v: string) => {
      llamadas++;
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('org|' + v)));
      return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
    };
    const { hallazgos, huellas } = await escanearSecretos(archivos, { huella });
    expect(llamadas).toBe(1);                                                // una por valor distinto
    const fp = hallazgos[0]!.evidence.fingerprint_short!;
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    const [completa, resource] = [...huellas][0]!;
    expect(completa.startsWith(fp)).toBe(true);
    expect(resource).toBe('src/lib/admin.ts:4');
    expect(JSON.stringify(hallazgos)).not.toContain(completa);
  });
  it('ninguna salida lleva un valor en claro', async () => {
    const todo = Object.values(T).filter((v) => v !== T.anon && v !== T.stripeTest);
    const content = todo.map((v, i) => `v${i} = "${v}"`).join('\n') + `\nconst u = "${pgUrl('db.abcdefghijklmnopqrst.supabase.co')}"`;
    const s = JSON.stringify(await escanearSecretos([{ path: 'todo.ts', content }]));
    for (const v of todo) expect(s).not.toContain(v.length > 40 ? v.slice(8, 40) : v);
    expect(s).not.toContain(T.pgClave);
  });
  it('prefijo de ZIP, recorte de resource a 300 y snippet ≤ 200 alrededor del marcador', async () => {
    const largo = 'd/'.repeat(200) + 'a.ts';
    const { hallazgos } = await escanearSecretos([{ path: largo, content: ' '.repeat(500) + `k = "${T.ghp}" ` + 'x'.repeat(500) }], { prefijo: 'zip:proyecto.zip/' });
    const h = hallazgos[0]!;
    expect(h.resource.length).toBe(300);
    expect(h.resource.startsWith('…')).toBe(true);
    expect(h.resource.endsWith('a.ts:1')).toBe(true);
    expect(h.evidence.path).toBe(largo);
    expect(h.evidence.snippet).toContain('[SECRET:CB_SECRET_GITHUB_PAT]');
    expect(h.evidence.snippet!.length).toBeLessThanOrEqual(200);
    const corto = (await escanearSecretos([{ path: 'src/a.ts', content: `\n\n\nk = "${T.ghp}"` }], { prefijo: 'zip:proyecto.zip/' })).hallazgos[0]!;
    expect(corto.resource).toBe('zip:proyecto.zip/src/a.ts:4');
    expect(corto.evidence.path).toBe('src/a.ts');
  });
  it('el snippet pasa por redact(): otro secreto de la misma línea también queda tapado', async () => {
    const h = (await uno('a.ts', `k = "${T.sbSecret}" // y ${'gh' + 'o_' + R(36)}`))[0]!;
    expect(h.evidence.snippet).toBe('k = "[SECRET:CB_SECRET_SB_SECRET]" // y [REDACTADO:github]');
  });
  it('dos tokens sin prefijo en una línea (Cloudflare de 40 car.): ninguna evidencia lleva ninguno de los dos', async () => {
    const a = R(40), b = R(40, 'Uv0St9Qr8Op7Mn6Kl5Ij4Gh3Ef2Cd1Ab');        // distintos: dos hallazgos, no uno
    const hs = await uno('deploy.sh', `#!/bin/sh\nexport CF_API_TOKEN=${a} CF_OTHER_TOKEN=${b}\nwrangler deploy\n`);
    expect(hs.map((h) => [h.rule_id, h.resource])).toEqual([['CB_SECRET_GENERIC', 'deploy.sh:2'], ['CB_SECRET_GENERIC', 'deploy.sh:2']]);
    for (const h of hs) {
      const ev = JSON.stringify(h.evidence);
      expect(ev).not.toContain(a.slice(4, -4));
      expect(ev).not.toContain(b.slice(4, -4));
    }
    expect(hs.map((h) => h.evidence.snippet).sort()).toEqual([
      'export CF_API_TOKEN=[REDACTADO] CF_OTHER_TOKEN=[SECRET:CB_SECRET_GENERIC]',
      'export CF_API_TOKEN=[SECRET:CB_SECRET_GENERIC] CF_OTHER_TOKEN=[REDACTADO]',
    ]);
  });
  it('dos tokens sin prefijo con claves con sufijo o en camelCase: tampoco se cuelan en la evidencia del otro', async () => {
    const a = R(40), b = R(40, 'Uv0St9Qr8Op7Mn6Kl5Ij4Gh3Ef2Cd1Ab');
    for (const linea of [
      `export CF_API_TOKEN=${a} SECRET_KEY=${b}`,
      `export CF_API_TOKEN_PROD=${a} CF_API_TOKEN=${b}`,
      `export ENCRYPTION_KEY=${a} API_KEY=${b}`,
      `export CLOUDFLARE_API_TOKEN_PROD=${a} CLOUDFLARE_API_TOKEN_STAGING=${b}`,
      `GITHUB_TOKEN_2=${a} JWT_SECRET_KEY=${b}`,
      `const cfg = { secretKey: "${a}", encryptionKey: "${b}" };`,
    ]) {
      const hs = await uno('deploy.sh', `#!/bin/sh\n${linea}\n`);
      expect(hs.map((h) => h.rule_id), linea).toEqual(['CB_SECRET_GENERIC', 'CB_SECRET_GENERIC']);
      for (const h of hs) {
        const ev = JSON.stringify(h.evidence);
        expect(ev, linea).not.toContain(a.slice(4, -4));
        expect(ev, linea).not.toContain(b.slice(4, -4));
      }
    }
  });
  // El snippet se redacta con la línea entera y se recorta DESPUÉS: antes, el recorte a 160 car. partía la clave del otro
  // secreto (CF_OTHER_TOKEN= → OKEN= o nada) y su valor salía entero.
  it('línea de más de 160 car. con dos tokens: el recorte del snippet no deja el otro valor en claro', async () => {
    const a = R(40), b = R(40, 'Uv0St9Qr8Op7Mn6Kl5Ij4Gh3Ef2Cd1Ab');
    const pad = ' && wrangler deploy --env production --name ' + 'w'.repeat(120);
    const hs = await uno('deploy.sh', `export CF_OTHER_TOKEN=${b}${' '.repeat(7)}CF_API_TOKEN=${a}${pad}\n`);
    expect(hs).toHaveLength(2);
    for (const h of hs) {
      const ev = JSON.stringify(h.evidence);
      expect(ev).not.toContain(a.slice(4, -4));
      expect(ev).not.toContain(b.slice(4, -4));
      expect(h.evidence.snippet).toContain('[SECRET:CB_SECRET_GENERIC]');
      expect(h.evidence.snippet!.length).toBeLessThanOrEqual(160);
    }
  });
  it('pares del fallo (Pusher, KEY suelto o compuesto, sufijo numérico, plural, OAUTH, ACCESS): ninguna evidencia lleva el otro', async () => {
    const a = R(40), b = R(40, 'Uv0St9Qr8Op7Mn6Kl5Ij4Gh3Ef2Cd1Ab');
    const h1 = R(20, '9f8e7d6c5b4a3210fedcba'), h2 = R(20, '1a2b3c4d5e6f7a8b9c0d1e');
    const pares: Array<[string, string, string]> = [
      [`new Pusher({ appId: "1234567", key: "${h1}", secret: "${h2}", cluster: "us2" });`, h1, h2],
      ...[`export SECRETKEY=${a} CF_API_TOKEN=${b}`, `export MASTERKEY=${a} SECRET=${b}`, `export SIGNINGKEY=${a} CF_API_TOKEN=${b}`,
        `export secretkey=${a} token=${b}`, `KEY: ${a} TOKEN: ${b}`, `export GITHUB_OAUTH=${a} CF_API_TOKEN=${b}`,
        `export ACCESS=${a} CF_API_TOKEN=${b}`, `export API_TOKENS=${a} CF_API_TOKEN=${b}`, `export TOKEN1=${a} TOKEN2=${b}`,
        `export API_KEY2=${a} CF_API_TOKEN=${b}`, `DB_PASSWORD2=${a} CF_API_TOKEN=${b}`, `JWT_SECRET2=${a} PASSWORDS=${b}`,
        `export ENCRYPTIONKEY=${a} API_KEY=${b}`, `SECRETS=${a} TOKEN=${b}`, `const cfg = { key: "${a}", secret: "${b}" };`]
        .map((l): [string, string, string] => [l, a, b]),
    ];
    for (const [linea, x, y] of pares) {
      const hs = await uno('deploy.js', `${linea}\n`);
      expect(hs.map((h) => h.rule_id), linea).toEqual(['CB_SECRET_GENERIC', 'CB_SECRET_GENERIC']);
      for (const h of hs) {
        const ev = JSON.stringify(h.evidence);
        expect(ev, linea).not.toContain(x.slice(4, -4));
        expect(ev, linea).not.toContain(y.slice(4, -4));
      }
    }
  });
  it('el valor de un hallazgo repetido sin clave en la línea de otro tampoco sale en su evidencia', async () => {
    const a = R(40), b = R(40, 'Uv0St9Qr8Op7Mn6Kl5Ij4Gh3Ef2Cd1Ab');
    const hs = await uno('deploy.sh', `TOKEN=${a}\ncurl -H "X-Key ${a}" --data secret=${b}\n`);
    expect(hs).toHaveLength(2);
    for (const h of hs) expect(JSON.stringify(h.evidence)).not.toContain(a.slice(4, -4));
  });
  it('si redact se come el marcador (`TOKEN=` suelto), el snippet de una línea larga sigue alrededor del valor', async () => {
    const hs = await uno('deploy.sh', `${'x'.repeat(600)} TOKEN=${R(40)} ${'y'.repeat(600)}\n`);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.evidence.snippet).toContain('TOKEN=[REDACTADO]');
    expect(hs[0]!.evidence.snippet!.length).toBeLessThanOrEqual(160);
  });
  it('orden: la más grave primero', async () => {
    const hs = await uno('a.ts', `const apiKey = "${T.generico}";\nconst k = '${T.sbSecret}'\nconst u = "${pgUrl('db-prod.interno.net')}"`);
    expect(hs.map((h) => h.severity)).toEqual(['critical', 'high', 'medium']);
  });
});

describe('genérica compartida con redact (ronda 2)', () => {
  it('la palabra clave pegada a otra minúscula no es clave; KEY compuesto, plural, sufijo, OAUTH, ACCESS y creds sí', async () => {
    // Partidos para que ningún escáner los tome por secretos del repo.
    for (const l of ['tokenizer: "cl100k_' + 'base_tokenizer_v2"', 'keyboardLayout: "us-intl-' + '2024-v3-extended"',
      'authorId: "user2' + 'abcdef1234567890"', 'accessibilityLabel: "boton-guardar-' + '2024-v2-final"', 'secretary_name: "Ana-2024-' + 'oficina-3B-norte"'])
      expect(await reglas('src/a.ts', `${l}\n`), l).toEqual([]);
    for (const n of ['MASTERKEY', 'secretkey', 'TOKENS', 'API_KEY2', 'GITHUB_OAUTH', 'ACCESS', 'GH_CREDS', 'API_HASH', 'githubTokenStaging', 'key'])
      expect(await reglas('src/a.ts', `${n}=${T.generico}\n`), n).toEqual(['CB_SECRET_GENERIC']);
  });
  it('nuestro marcador delante de un valor no lo convierte en el valor de la clave (como en redactString)', async () => {
    expect(await uno('docs/x.md', `TOKEN=[REDACTADO] ${T.generico}\nsecret: "[SECRET:CB_SECRET_GENERIC]" ${T.generico}\n`)).toEqual([]);
  });
  it('ni un NUL en el snippet aunque la línea traiga un marcador nuestro', async () => {
    const h = (await uno('a.ts', `x = "[SECRET:CB_SECRET_AWS]"; const k = '${T.sbSecret}'`))[0]!;
    expect(h.evidence.snippet).toBe(`x = " "; const k = '[SECRET:CB_SECRET_SB_SECRET]'`);
  });
  it('propiedad: 400 líneas con 2 o 3 secretos y nombres y formas de todo tipo: ninguna evidencia lleva un valor detectado', () => {
    let x = 20261024, total = 0;
    const azar = (n: number) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
    const ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const valor = () => Array.from({ length: 20 + azar(30) }, () => ALFA[azar(ALFA.length)]).join('');
    const NOMBRES = ['key', 'KEY', 'SECRETKEY', 'secretkey', 'GITHUB_OAUTH', 'ACCESS', 'TOKEN1', 'API_KEY2', 'SECRETS', 'API_TOKENS',
      'apiKeyLive', 'X-Auth-Key', 'CF_API_TOKEN_PROD', 'secretKey', 'password', 'creds', 'cf.api.token', 'Authorization'];
    const FORMAS: Array<(n: string, v: string) => string> = [(n, v) => `${n}=${v}`, (n, v) => `${n}: ${v}`, (n, v) => `${n} = "${v}"`,
      (n, v) => `{ ${n}: '${v}' }`, (n, v) => `--${n}=${v}`];
    const RELLENO = [' ', ' && ', '; ', ', ', ' | ', ' '.repeat(200), ` wrangler deploy --name ${'w'.repeat(150)} `, ` ${'z'.repeat(500)} `];
    for (let i = 0; i < 400; i++) {
      const vs = Array.from({ length: 2 + azar(2) }, valor);
      if (azar(3) === 0) vs.push(vs[0]!);                                    // a veces repetido con otra clave
      const linea = vs.map((v) => FORMAS[azar(FORMAS.length)]!(NOMBRES[azar(NOMBRES.length)]!, v)).join(RELLENO[azar(RELLENO.length)]!);
      const cs = scanArchivo('deploy.sh', `#!/bin/sh\n${linea}\n`);
      const det = [...new Set(cs.map((c) => c.valor))];
      total += cs.length;
      for (const c of cs) {
        expect(c.snippet.length).toBeLessThanOrEqual(160);
        for (const v of det) expect(c.snippet.includes(v.slice(4, -4)), `${linea}\n→ ${c.snippet}`).toBe(false);
      }
    }
    expect(total).toBeGreaterThan(800);                                      // casi todos los valores dan hallazgo
  });
  it('lineal: una línea minificada de 80 KB llena de asignaciones y entradas adversas de 60 KB', () => {
    const t0 = performance.now();
    const denso = Array.from({ length: 2400 }, (_, i) => `k${i}_TOKEN=${R(20, RICO.slice(i % 7) + RICO)} `).join('');
    expect(scanArchivo('dist/app.min.js', denso).length).toBeGreaterThan(2000);
    for (const s of ['SECRETKEY_token: '.repeat(3600), 'KEY=KEY='.repeat(7680), `token=[REDACTADO] ${R(20)} `.repeat(1600),
      'token' + ' '.repeat(61440) + ':' + ' '.repeat(61440), 'aUtHoRiZaTiOn'.repeat(4800)])
      scanArchivo('a.js', s);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

// Ronda 3: el marcador cubría solo el valor de la regla (cortado a 150 car. y en el primer símbolo), y el resto del secreto
// quedaba en claro detrás de [SECRET:…]. Ahora el marcador sustituye el valor entero, cola incluida, como lo tapa redact.
describe('el marcador del snippet cubre el valor entero (ronda 3)', () => {
  const ventanas = (v: string, n: number) => Array.from({ length: Math.max(0, v.length - n + 1) }, (_, i) => v.slice(i, i + n));
  const sinTrozos = (snippet: string, v: string, n = 12) => ventanas(v, n).every((w) => !snippet.includes(w));
  let x = 0x51ed270b;
  const azar = (n: number) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const largo = (n: number) => Array.from({ length: n }, () => B64[azar(64)]).join('');
  it('un secreto de más de 150 car. no deja ni 12 car. seguidos detrás del marcador', () => {
    const v = largo(256), tok = largo(192);
    for (const linea of [`API_TOKEN=${v}`, `const cfg = { apiToken: "${v}" }`, `GCP_SA_KEY_B64=${v}==`, `ATLASSIAN_TOKEN: ${tok}`,
      `export SA_KEY=${v} && deploy --name ${'w'.repeat(300)}`]) {
      const cs = scanArchivo('a.ts', linea);
      expect(cs.map((c) => c.rule_id), linea).toEqual(['CB_SECRET_GENERIC']);
      expect(cs[0]!.snippet, linea).toContain('[SECRET:CB_SECRET_GENERIC]');
      expect(sinTrozos(cs[0]!.snippet, linea.includes(tok) ? tok : v), cs[0]!.snippet).toBe(true);
    }
  });
  it('una contraseña con símbolos tras 16 car. de la clase: el marcador se lleva la cola', () => {
    const base = 'Xk9mP2vL' + '8qR4wZ7t';
    const casos: Array<[string, string]> = [
      [`DB_PASSWORD=${base}#rest_of_PW99`, 'DB_PASSWORD=[SECRET:CB_SECRET_GENERIC]'],
      [`SMTP_PASSWORD=${base}${'$Hq3!x9@Yb'}`, 'SMTP_PASSWORD=[SECRET:CB_SECRET_GENERIC]'],
      [`encryptionKey: "${base}#tail99"`, 'encryptionKey: "[SECRET:CB_SECRET_GENERIC]"'],
      [`export STRIPE_API_KEY=${base}~a:b%c^d*e{f}g|h?i OTRA=1`, 'export STRIPE_API_KEY=[SECRET:CB_SECRET_GENERIC] OTRA=1'],
      [`export API_KEY=${base}~a:b%c^d*e{f}g|h?i OTRA=1`, 'export API_KEY=[REDACTADO] OTRA=1'],   // ` api_key=` lo tapa entero
    ];
    for (const [linea, esperado] of casos) {
      const cs = scanArchivo('a.env', linea);
      expect(cs.map((c) => c.snippet), linea).toEqual([esperado]);
    }
  });
  it('propiedad: 300 líneas con valores largos o con símbolos: ningún snippet lleva 8 car. seguidos de un valor', () => {
    const ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', SIM = '#!$@~:%^*({}|?\\+/=._-';
    const tramo = (n: number, abc: string) => Array.from({ length: n }, () => abc[azar(abc.length)]).join('');
    const valor = () => {
      if (azar(3) === 0) return largo(151 + azar(200));
      let v = tramo(16 + azar(14), ALFA) + String(azar(10));
      for (let j = 1 + azar(3); j > 0; j--) v += tramo(1 + azar(3), SIM) + tramo(1 + azar(10), ALFA);
      return v;
    };
    const NOMBRES = ['DB_PASSWORD', 'API_TOKEN', 'secretKey', 'CF_API_TOKEN_PROD', 'X-Auth-Key', 'credentials', 'key', 'TOKEN1'];
    const FORMAS: Array<(n: string, v: string) => string> = [(n, v) => `${n}=${v}`, (n, v) => `${n}: ${v}`, (n, v) => `${n} = "${v}"`,
      (n, v) => `{ ${n}: '${v}' }`];
    const RELLENO = [' ', ' && ', '; ', ` ${'z'.repeat(500)} `];
    let total = 0;
    for (let i = 0; i < 300; i++) {
      const vs = Array.from({ length: 1 + azar(3) }, valor);
      const linea = vs.map((v) => FORMAS[azar(FORMAS.length)]!(NOMBRES[azar(NOMBRES.length)]!, v)).join(RELLENO[azar(RELLENO.length)]!);
      const cs = scanArchivo('deploy.sh', `#!/bin/sh\n${linea}\n`);
      total += cs.length;
      const detectados = vs.filter((v) => cs.some((c) => v.startsWith(c.valor)));     // la regla da el principio del valor
      for (const c of cs) {
        expect(c.snippet.length).toBeLessThanOrEqual(160);
        for (const v of detectados) expect(sinTrozos(c.snippet, v, 8), `${linea}\n→ ${c.snippet}`).toBe(true);
      }
    }
    expect(total).toBeGreaterThan(400);
  });
  it('nuestro marcador dentro de una URL de Postgres no hace de contraseña (como en HEAD)', async () => {
    expect(await uno('docs/x.md', 'postgres://app:abc[REDACTADO]def@db.prod.example.com/app\n')).toEqual([]);
  });
  it('lineal: colas largas y anidadas en una línea de ≥ 100 KB y 400 secretos de 300 car.', () => {
    const t0 = performance.now();
    const base = 'Xk9mP2vL' + '8qR4wZ7t';
    for (const s of [`key=${base}#`.repeat(5000), 'DB_PASSWORD=' + `${base}!token=`.repeat(4500), `token=${base}!Bearer `.repeat(4000),
      Array.from({ length: 400 }, () => `API_TOKEN=${largo(300)}`).join('\n'), `password=${base}#` + 'a'.repeat(200000)])
      scanArchivo('a.js', s);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

// Ronda 4: entre comillas, la cola se paraba en `; , ) [ <` o en un blanco y lo de detrás (la misma contraseña) salía en
// claro detrás del marcador. Ahora llega a la comilla de cierre, como en redactString. Y la redacción del snippet tapa al
// menos lo que tapaba HEAD: una URL con query en la línea de un hallazgo no deja ningún parámetro.
describe('comillas y queries en el snippet (ronda 4)', () => {
  const base = 'Xk9mP2vL' + '8qR4wZ7t';
  let x = 0x6a09e667;
  const azar = (n: number) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
  it('el marcador llega a la comilla de cierre aunque dentro haya delimitadores o blancos', () => {
    const casos: Array<[string, string]> = [
      [`api_key: "${base};abcSECRET9"`, 'api_key: "[SECRET:CB_SECRET_GENERIC]"'],
      [`export ACCESS_KEY: '${base}[abc<SECRET>'`, "export ACCESS_KEY: '[SECRET:CB_SECRET_GENERIC]'"],
      [`const cfg = { secretKey: "${base}) tail 99" };`, 'const cfg = { secretKey: "[SECRET:CB_SECRET_GENERIC]" };'],
      [`DB_PASSWORD="${base}&q=1,x y"`, 'DB_PASSWORD="[SECRET:CB_SECRET_GENERIC]"'],
    ];
    for (const [linea, esperado] of casos) expect(scanArchivo('a.ts', linea).map((c) => c.snippet), linea).toEqual([esperado]);
  });
  it('sin cierre en la línea (o a más de 256 car.), la cola se para donde siempre', () => {
    expect(scanArchivo('a.ts', `api_key: "${base};abc\nx"`).map((c) => c.snippet)).toEqual(['api_key: "[SECRET:CB_SECRET_GENERIC];abc']);
    const lejos = scanArchivo('a.ts', `api_key: "${base};${'y'.repeat(300)}"`)[0]!.snippet;
    expect(lejos.startsWith('api_key: "[SECRET:CB_SECRET_GENERIC];yyy')).toBe(true);
  });
  it('propiedad: 300 valores entre comillas con delimitadores dentro: ningún snippet lleva 8 car. seguidos del valor', () => {
    const ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', DELIM = ';,)[]<>& `';
    const tramo = (n: number, abc: string) => Array.from({ length: n }, () => abc[azar(abc.length)]).join('');
    const NOMBRES = ['DB_PASSWORD', 'API_TOKEN', 'secretKey', 'CF_API_TOKEN_PROD', 'X-Auth-Key', 'credentials', 'key', 'TOKEN1'];
    const FORMAS: Array<(n: string, v: string) => string> = [(n, v) => `${n}: "${v}"`, (n, v) => `{ ${n}: '${v}' }`, (n, v) => `${n} = "${v}";`];
    let total = 0;
    for (let i = 0; i < 300; i++) {
      let v = tramo(16 + azar(14), ALFA) + String(azar(10));
      for (let j = 1 + azar(3); j > 0; j--) v += tramo(1 + azar(2), DELIM) + tramo(1 + azar(10), ALFA);
      const linea = FORMAS[azar(FORMAS.length)]!(NOMBRES[azar(NOMBRES.length)]!, v);
      const cs = scanArchivo('a.ts', `${linea}\n`);
      total += cs.length;
      for (const c of cs) for (let p = 0; p + 8 <= v.length; p++) expect(c.snippet.includes(v.slice(p, p + 8)), `${linea}\n→ ${c.snippet}`).toBe(false);
    }
    expect(total).toBeGreaterThan(250);
  });
  it('una URL con query en la línea de un hallazgo: ningún parámetro sale en el snippet', () => {
    const hex = R(64, '9f8e7d6c5b4a3210'), estado = 'st' + R(14, 'Qw3Er5Ty');
    for (const linea of [`API_KEY=${base} CALLBACK=https://app.acme.io/cb?state=${estado}&code=${hex}`,
      `UPLOAD_TOKEN_URL=https://b.s3.amazonaws.com/k?X-Amz-Date=1&X-Amz-Signature=${hex} SECRET_KEY=${base}`]) {
      const cs = scanArchivo('a.sh', `${linea}\n`);
      expect(cs.length, linea).toBeGreaterThan(0);
      for (const c of cs) { expect(c.snippet, linea).not.toContain(hex.slice(0, 12)); expect(c.snippet, linea).not.toContain(estado); }
    }
  });
});

describe('enmascarar y entropía (09.9 literal)', () => {
  it('4+4, corto, clave privada y Postgres ≤ 48', () => {
    expect(enmascarar(T.ghp, 'CB_SECRET_GITHUB_PAT')).toBe(T.ghp.slice(0, 4) + '…' + T.ghp.slice(-4));
    expect(enmascarar('abcdefghijklmn', 'CB_SECRET_GENERIC')).toBe('abcd…');
    expect(enmascarar('abcdefgh', 'CB_SECRET_GENERIC')).toBe('…');
    expect(enmascarar(T.privada, 'CB_SECRET_PRIVATE_KEY')).toBe('-----BEGIN … PRIVATE KEY-----');
    const pg = enmascarar(pgUrl('db.abcdefghijklmnopqrst.supabase.co'), 'CB_SECRET_POSTGRES_URL');
    expect(pg).toBe('postgresql://postgres:••••@db.•••.supabase.co');
    expect(pg.length).toBeLessThanOrEqual(48);
  });
  it('entropía de Shannon por carácter', () => {
    expect(entropia('aaaa')).toBe(0);
    expect(entropia('abcd')).toBe(2);
    expect(entropia(R(32))).toBe(5);
  });
});

describe('.env subido y .gitignore (09.8, 15.13)', () => {
  it('.env → CB_ENV_COMMITTED critical con nombres de variables; .env.example no', () => {
    const hs = reglasEnv(['.env', '.env.example', 'src/a.ts', '.gitignore'], [
      { path: '.env', content: `# comentario\nSUPABASE_URL=https://x.supabase.co\nexport SUPABASE_SERVICE_ROLE_KEY=${T.serviceRole}\n  DB_PASS = x\n` },
      { path: '.gitignore', content: 'node_modules\n.env\n' },
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ rule_id: 'CB_ENV_COMMITTED', severity: 'critical', confirmed: true, resource: '.env',
      evidence: { path: '.env', gitignore_lo_lista: true, variables: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DB_PASS'] } });
    expect(JSON.stringify(hs)).not.toContain(T.serviceRole);
  });
  it('sin .env en .gitignore → CB_GITIGNORE_NO_ENV; sin .gitignore → existe_gitignore false', () => {
    const conGi = reglasEnv(['.gitignore', 'src/a.ts'], [{ path: '.gitignore', content: 'node_modules\n# .env\n!.env\ndist\n' }]);
    expect(conGi).toEqual([expect.objectContaining({ rule_id: 'CB_GITIGNORE_NO_ENV', severity: 'medium', confirmed: true, resource: '.gitignore',
      evidence: { path: '.gitignore', existe_gitignore: true } })]);
    const sinGi = reglasEnv(['src/a.ts', 'backend/.env.production'], []);
    expect(sinGi.map((h) => h.rule_id)).toEqual(['CB_ENV_COMMITTED', 'CB_GITIGNORE_NO_ENV']);
    expect(sinGi[0]!.evidence).toEqual({ path: 'backend/.env.production', gitignore_lo_lista: false });
    expect(sinGi[1]!.evidence).toEqual({ path: '.gitignore', existe_gitignore: false });
  });
  it('prefijo de ZIP en el resource', () => {
    const hs = reglasEnv(['.env'], [], { prefijo: 'zip:p.zip/' });
    expect(hs.map((h) => h.resource)).toEqual(['zip:p.zip/.env', 'zip:p.zip/.gitignore']);
  });
  it('condiciones canónicas: rutas, líneas del .gitignore y variables', () => {
    for (const p of ['.env', 'api/.env', '.env.local', '.env.production']) expect(esEnvSubido(p), p).toBe(true);
    for (const p of ['.env.example', 'a/.env.sample', '.env.template', 'env.ts', '.envrc.d/x', 'src/.environment']) expect(esEnvSubido(p), p).toBe(false);
    expect(gitignoreCubreEnv('/.env*\n')).toBe(true);
    expect(gitignoreCubreEnv('.env.local\n')).toBe(true);                   // falso negativo aceptado en P0 (09.8)
    expect(gitignoreCubreEnv('*.env\n# .env\n!.env\n')).toBe(false);
    expect(variablesEnv(Array.from({ length: 40 }, (_, i) => `V${i}=1`).join('\n'))).toHaveLength(30);
  });
});
