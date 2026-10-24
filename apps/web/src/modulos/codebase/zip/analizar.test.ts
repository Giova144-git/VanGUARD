// analizarZip sobre un Map armado a mano (no hace falta ZIP). Todo valor con forma de secreto se arma en tiempo de
// ejecución, como en packages/core/src/secrets/scan.test.ts: ningún escáner encuentra literales en el repo.
import { describe, expect, it } from 'vitest';
import { ZipResult } from '@vanguard/contracts';
import { escanearSecretos, reglasEnv, type BorradorCodebase } from '@vanguard/core';
import { analizarZip, proyectarHallazgos } from './analizar';
import type { Inventario } from './tipos';

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const RICO = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv';
const R = (n: number, base = RICO) => base.repeat(Math.ceil(n / base.length)).slice(0, n);
const jwt = (role: string) => b64url({ alg: 'HS256', typ: 'JWT' }) + '.'
  + b64url({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role, iat: 1761300000, exp: 2076876000 }) + '.' + R(43, 'Zx9Yw8Vu7Ts6');
const T = {
  serviceRole: jwt('service_role'),
  openai: 'sk-' + 'proj-' + R(74) + 'T3Blbk' + 'FJ' + R(74, 'Qr9St0UvAb1Cd2Ef3Gh4Ij5Kl6Mn7Op8'),
  privada: '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + R(64) + '\n' + R(64, 'Mn7Op8Qr9St0Uv') + '\n-----END ' + 'RSA PRIVATE KEY-----',
  generico: R(32, 'Uv0St9Qr8Op7Mn6Kl5Ij4Gh3Ef2Cd1Ab'),
};
const pgUrl = (host: string) => 'postgresql://' + 'postgres' + ':' + 'a1b2c3d4e5f6a7b8c9d0' + '@' + host + ':5432/postgres';
const cuatroMasCuatro = (v: string) => v.slice(0, 4) + '…' + v.slice(-4);
const GITIGNORE = '.env\nnode_modules/\n';

const inventarioDe = (archivos: ReadonlyMap<string, string>, sinLeer: readonly string[] = [], tiene_git = false): Inventario => {
  const rutas = [...archivos.keys(), ...sinLeer].map((p) => ({ p, s: archivos.get(p)?.length ?? 2_000_000 }));
  return { entradas: rutas.length, leidos: archivos.size, omitidos: sinLeer.length, tiene_git, rutas };
};
const analizar = (obj: Record<string, string>, sinLeer: readonly string[] = [], tiene_git = false) => {
  const m = new Map(Object.entries(obj));
  return analizarZip(m, inventarioDe(m, sinLeer, tiene_git));
};
const lockV3 = (pkgs: Record<string, unknown>) =>
  JSON.stringify({ name: 'app', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', dependencies: {} }, ...pkgs } });
const aviso = (a: { avisos: { codigo: string; texto: string }[] }, codigo: string) => a.avisos.find((x) => x.codigo === codigo);

describe('.env con secretos', () => {
  const env = `SUPABASE_SERVICE_ROLE_KEY=${T.serviceRole}\nOPENAI_API_KEY=${T.openai}\n`;

  it('CB_ENV_COMMITTED y CB_SECRET_* con preview 4+4', async () => {
    const a = await analizar({ '.env': env, '.gitignore': GITIGNORE });
    const fs = a.resultado.findings;
    expect(fs.map((f) => f.rule_id).sort()).toEqual(['CB_ENV_COMMITTED', 'CB_SECRET_OPENAI', 'CB_SECRET_SUPABASE_SERVICE_ROLE']);
    expect(fs.find((f) => f.rule_id === 'CB_SECRET_SUPABASE_SERVICE_ROLE')).toMatchObject({ severity: 'critical', resource: '.env:1',
      evidence: { path: '.env', line: 1, preview: cuatroMasCuatro(T.serviceRole) } });
    expect(fs.find((f) => f.rule_id === 'CB_SECRET_OPENAI')!.evidence).toEqual({ path: '.env', line: 2, preview: cuatroMasCuatro(T.openai) });
    expect(fs.find((f) => f.rule_id === 'CB_ENV_COMMITTED')!.evidence).toEqual({ path: '.env' });
    expect(a.resumen).toEqual({ archivos: 2, deps: 0, lockfiles: 0, secretos: 2, env: 1 });
    expect(ZipResult.parse(a.resultado)).toEqual(a.resultado);
  });

  it('ni los valores ni los nombres de las variables salen en el análisis', async () => {
    const s = JSON.stringify(await analizar({ '.env': env }));
    for (const fuga of [T.serviceRole, T.serviceRole.split('.')[1]!, T.openai, T.openai.slice(4, -4), 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY'])
      expect(s).not.toContain(fuga);
    expect(s).not.toMatch(/snippet|ubicaciones|variables|gitignore_lo_lista|existe_gitignore|fingerprint/);
  });

  it('sin .gitignore → CB_GITIGNORE_NO_ENV; con uno listado pero sin leer, no se afirma', async () => {
    expect((await analizar({ '.env': env })).resultado.findings.map((f) => f.rule_id)).toContain('CB_GITIGNORE_NO_ENV');
    expect((await analizar({ '.env': env }, ['.gitignore'])).resultado.findings.map((f) => f.rule_id)).not.toContain('CB_GITIGNORE_NO_ENV');
  });

  it('un .env dentro de node_modules no es del proyecto', async () => {
    const a = await analizar({ '.gitignore': GITIGNORE }, ['node_modules/pkg/.env', 'vendor/x/.env']);
    expect(a.resultado.findings).toEqual([]);
  });
});

describe('secretos sin preview', () => {
  it('postgres URL y clave privada: hallazgo con path y línea pero sin preview', async () => {
    const a = await analizar({ '.gitignore': GITIGNORE, 'src/db.ts': `\nconst u = "${pgUrl('db.abcdefghijklmnopqrst.supabase.co')}";\n`,
      'deploy/key.pem': T.privada });
    const pg = a.resultado.findings.find((f) => f.rule_id === 'CB_SECRET_POSTGRES_URL')!;
    const pk = a.resultado.findings.find((f) => f.rule_id === 'CB_SECRET_PRIVATE_KEY')!;
    expect(pg).toMatchObject({ severity: 'critical', resource: 'src/db.ts:2' });
    expect(pg.evidence).toEqual({ path: 'src/db.ts', line: 2 });
    expect(pk.evidence).toEqual({ path: 'deploy/key.pem', line: 1 });
    expect(JSON.stringify(a)).not.toContain('a1b2c3d4e5f6');
    expect(ZipResult.parse(a.resultado)).toEqual(a.resultado);
  });
});

describe('dependencias', () => {
  it('package-lock.json v3 → npm, deduplicado, sin file: ni versiones de más de 64', async () => {
    const lock = lockV3({
      'node_modules/lodash': { version: '4.17.15' },
      'node_modules/vitest': { version: '4.1.12', dev: true },
      'node_modules/local': { version: 'file:../local' },
      'node_modules/largo': { version: '1.0.0-' + 'x'.repeat(70) },
      'node_modules/raro': { version: 7 },
    });
    const otro = lockV3({ 'node_modules/lodash': { version: '4.17.15' } });
    const a = await analizar({ '.gitignore': GITIGNORE, 'package-lock.json': lock, 'apps/web/package-lock.json': otro,
      'node_modules/pkg/package-lock.json': lockV3({ 'node_modules/ajeno': { version: '1.0.0' } }) });
    expect(a.resultado.deps).toEqual([
      { ecosystem: 'npm', name: 'lodash', version: '4.17.15', dev: false },
      { ecosystem: 'npm', name: 'vitest', version: '4.1.12', dev: true },
    ]);
    expect(a.resumen).toMatchObject({ deps: 2, lockfiles: 2 });
    expect(aviso(a, 'CB_NO_LOCKFILE')).toBeUndefined();
    expect(ZipResult.parse(a.resultado)).toEqual(a.resultado);
  });

  it('composer.lock → Packagist, sin la v ni ramas dev-*', async () => {
    const lock = JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v10.48.4' }, { name: 'acme/x', version: 'dev-main' }],
      'packages-dev': [{ name: 'phpunit/phpunit', version: '10.5.0' }] });
    const a = await analizar({ '.gitignore': GITIGNORE, 'api/composer.lock': lock, 'api/composer.json': '{ roto' });
    expect(a.resultado.deps).toEqual([
      { ecosystem: 'Packagist', name: 'laravel/framework', version: '10.48.4', dev: false },
      { ecosystem: 'Packagist', name: 'phpunit/phpunit', version: '10.5.0', dev: true },
    ]);
    expect(a.resumen.lockfiles).toBe(1);
  });

  it('lockfile inválido: no lanza y avisa', async () => {
    const a = await analizar({ '.gitignore': GITIGNORE, 'package-lock.json': '{ esto no es json', 'composer.lock': 'null' });
    expect(a.resultado.deps).toEqual([]);
    expect(a.resumen.lockfiles).toBe(0);
    expect(aviso(a, 'CB_NO_LOCKFILE')?.texto).toMatch(/^2 lockfiles no se pudieron leer/);
    expect(ZipResult.parse(a.resultado)).toEqual(a.resultado);
  });

  it('sin lockfile → CB_NO_LOCKFILE y sigue con secretos y .env', async () => {
    const a = await analizar({ '.env': 'A=1\n', 'package.json': '{}' });
    expect(aviso(a, 'CB_NO_LOCKFILE')?.texto).toBe('Sin lockfile no podemos revisar dependencias.');
    expect(a.resultado.findings.map((f) => f.rule_id)).toContain('CB_ENV_COMMITTED');
  });

  it('pnpm-lock.yaml solo → CB_NO_LOCKFILE con el formato que aún no leemos', async () => {
    const a = await analizar({ '.gitignore': GITIGNORE, 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
    expect(aviso(a, 'CB_NO_LOCKFILE')?.texto).toBe('Aún no leemos pnpm-lock.yaml: sin package-lock.json no podemos revisar esas dependencias.');
    const b = await analizar({ '.gitignore': GITIGNORE, 'pnpm-lock.yaml': 'x', 'web/yarn.lock': 'x' });
    expect(aviso(b, 'CB_NO_LOCKFILE')?.texto).toMatch(/^Aún no leemos pnpm-lock\.yaml ni yarn\.lock:/);
    const c = await analizar({ '.gitignore': GITIGNORE, 'pnpm-lock.yaml': 'x', 'package-lock.json': lockV3({}) });
    expect(aviso(c, 'CB_NO_LOCKFILE')).toBeUndefined();
  });

  it('un package-lock.json listado pero sin leer (más de 1 MB) → aviso', async () => {
    const a = await analizar({ '.gitignore': GITIGNORE }, ['package-lock.json']);
    expect(aviso(a, 'CB_NO_LOCKFILE')?.texto).toMatch(/^Un lockfile no se pudo leer/);
  });
});

describe('avisos locales', () => {
  it('tiene_git → aviso CB_ZIP_HAS_GIT y ningún hallazgo', async () => {
    const a = await analizar({ '.gitignore': GITIGNORE, 'package-lock.json': lockV3({}) }, ['.git/config', '.git/HEAD'], true);
    expect(aviso(a, 'CB_ZIP_HAS_GIT')?.texto).toContain('.git');
    expect(a.resultado.findings).toEqual([]);
    expect(ZipResult.parse(a.resultado)).toEqual(a.resultado);
  });

  it('proyectar: fuera de la lista blanca se descarta o pasa a aviso; evidencia reducida a path, line y preview', () => {
    const b = (rule_id: string, evidence: BorradorCodebase['evidence'], extra: Partial<BorradorCodebase> = {}): BorradorCodebase =>
      ({ module: 'codebase', rule_id, severity: 'high', confirmed: true, origin: 'rule', title: 't', resource: 'r', evidence, dedupe_input: 'r', ...extra });
    const r = proyectarHallazgos([
      b('CB_SENSITIVE_FILE', { path: 'id_rsa' }), b('CB_ZIP_HAS_GIT', {}), b('CB_DEP_VULN', { path: 'package-lock.json' }),
      b('CB_SECRET_GENERIC', { path: 'a/' + 'b'.repeat(400), line: 3, preview: 'abcd…wxyz', snippet: 'x', ubicaciones: [], fingerprint_short: '0123abcd' },
        { title: 'T'.repeat(250), resource: 'z'.repeat(350) }),
      b('CB_SECRET_AWS', { path: 'a.ts', line: 0, preview: 'una-preview-demasiado-larga' }),
      b('CB_ENV_COMMITTED', { path: '.env', variables: ['A'], gitignore_lo_lista: true }),
    ]);
    expect(r.avisos).toEqual(['CB_SENSITIVE_FILE', 'CB_ZIP_HAS_GIT']);
    expect(r.findings.map((f) => f.rule_id)).toEqual(['CB_SECRET_GENERIC', 'CB_SECRET_AWS', 'CB_ENV_COMMITTED']);
    const [g, aws, env] = r.findings;
    expect(Object.keys(g!.evidence).sort()).toEqual(['line', 'path', 'preview']);
    expect(g!.evidence.path).toHaveLength(300);
    expect(g!.evidence.path.startsWith('…') && g!.evidence.path.endsWith('b')).toBe(true);
    expect(g!.resource).toHaveLength(300);
    expect(g!.resource.startsWith('…')).toBe(true);
    expect(g!.title).toHaveLength(200);
    expect(aws!.evidence).toEqual({ path: 'a.ts' });
    expect(env!.evidence).toEqual({ path: '.env' });
  });
});

describe('topes', () => {
  it('más de 200 hallazgos → los 200 más graves y aviso RECORTADO', async () => {
    const obj: Record<string, string> = { '.gitignore': GITIGNORE, 'package-lock.json': lockV3({}) };
    for (let i = 0; i < 230; i++) obj[`src/c${String(i).padStart(3, '0')}.js`] = `const apiKey = "${R(28)}${String(i).padStart(4, '0')}";\n`;
    obj['src/zz/admin.ts'] = `const KEY = "${T.serviceRole}";\n`;
    const a = await analizar(obj);
    const fs = a.resultado.findings;
    expect(fs).toHaveLength(200);
    expect(fs[0]).toMatchObject({ rule_id: 'CB_SECRET_SUPABASE_SERVICE_ROLE', severity: 'critical' });
    expect(fs.slice(1).every((f) => f.severity === 'medium')).toBe(true);
    expect(aviso(a, 'RECORTADO')?.texto).toBe('Encontramos 231 hallazgos: enviamos los 200 más graves.');
    expect(a.resumen.secretos).toBe(200);
    expect(ZipResult.parse(a.resultado)).toEqual(a.resultado);
  });

  it('más de 2000 dependencias → 2000 y aviso RECORTADO; files_seen acotado a 20 000', async () => {
    const pkgs: Record<string, unknown> = {};
    for (let i = 0; i < 2100; i++) pkgs[`node_modules/p${i}`] = { version: '1.0.0' };
    const m = new Map([['.gitignore', GITIGNORE], ['package-lock.json', lockV3(pkgs)]]);
    const a = await analizarZip(m, { ...inventarioDe(m), entradas: 25_000 });
    expect(a.resultado.deps).toHaveLength(2000);
    expect(a.resultado.files_seen).toBe(20_000);
    expect(a.resultado.analyzer).toMatch(/^core@/);
    expect(aviso(a, 'RECORTADO')?.texto).toBe('Hay 2100 dependencias: enviamos las primeras 2000.');
    expect(ZipResult.parse(a.resultado)).toEqual(a.resultado);
  });
});

describe('mismo código, mismos hallazgos', () => {
  it('rule_id, severidad, path y resource iguales a escanearSecretos + reglasEnv como en repo-paso (sin huella)', async () => {
    const obj: Record<string, string> = {
      '.env': `SUPABASE_SERVICE_ROLE_KEY=${T.serviceRole}\n`, '.env.example': 'SUPABASE_SERVICE_ROLE_KEY=\n', 'apps/api/.env.local': 'A=1\n',
      'src/db.ts': `const u = "${pgUrl('db-prod.interno.net')}";\n`, 'deploy/key.pem': T.privada,
      'src/config.js': `const apiKey = "${T.generico}";\n`, 'src/admin.ts': `const k = "${T.serviceRole}";\n`,
      'src/__tests__/ia.test.ts': `const k = "${T.openai}";\n`, 'package-lock.json': lockV3({ 'node_modules/lodash': { version: '4.17.15' } }),
    };
    const m = new Map(Object.entries(obj));
    const a = await analizarZip(m, inventarioDe(m));
    const lista = [...m].map(([path, content]) => ({ path, content }));
    const rutas = [...m.keys()].filter((p) => p === '.gitignore' || /(^|\/)\.env/.test(p));
    const repo = [...(await escanearSecretos(lista)).hallazgos, ...reglasEnv(rutas, lista)];
    const clave = (h: { rule_id: string; severity: string; resource: string; evidence: { path?: string } }) =>
      [h.rule_id, h.severity, h.evidence.path, h.resource].join('|');
    expect(a.resultado.findings.map(clave).sort()).toEqual(repo.map(clave).sort());
    expect(a.resultado.findings.map((f) => f.rule_id)).toEqual(expect.arrayContaining(['CB_ENV_COMMITTED', 'CB_GITIGNORE_NO_ENV',
      'CB_SECRET_SUPABASE_SERVICE_ROLE', 'CB_SECRET_POSTGRES_URL', 'CB_SECRET_PRIVATE_KEY', 'CB_SECRET_GENERIC', 'CB_SECRET_OPENAI']));
    expect(a.resultado.findings.find((f) => f.rule_id === 'CB_SECRET_OPENAI')!.severity).toBe('low');   // ruta de pruebas, como en core
    expect(ZipResult.parse(a.resultado)).toEqual(a.resultado);
  });
});

describe('surrogates sueltos', () => {
  it('ni path, ni resource, ni title, ni preview, ni dependencias llevan un surrogate suelto (Postgres jsonb los rechaza)', async () => {
    const raro = 'src/' + '😀'.repeat(200) + '/x.env';                 // emojis: recortar por la izquierda parte uno
    const archivos = new Map([[raro, `OPENAI_API_KEY=${T.openai}\n`], ['package-lock.json', JSON.stringify({ lockfileVersion: 3,
      packages: { '': { name: 'a' }, 'node_modules/ok': { version: '1.0.0' }, 'node_modules/mal\uD800': { version: '1.0.0' } } })]]);
    const { resultado } = await analizarZip(archivos, inventarioDe(archivos));
    const suelto = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const f of resultado.findings) for (const s of [f.title, f.resource, f.evidence.path, f.evidence.preview ?? ''])
      expect(suelto.test(s)).toBe(false);
    expect(resultado.deps.map((d) => d.name)).toEqual(['ok']);
    expect(ZipResult.safeParse(resultado).success).toBe(true);
  });
});
