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
  it('orden: la más grave primero', async () => {
    const hs = await uno('a.ts', `const apiKey = "${T.generico}";\nconst k = '${T.sbSecret}'\nconst u = "${pgUrl('db-prod.interno.net')}"`);
    expect(hs.map((h) => h.severity)).toEqual(['critical', 'high', 'medium']);
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
