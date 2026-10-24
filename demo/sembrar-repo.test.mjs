// Pruebas de la siembra del repo víctima. Sin red ni push real: usan una carpeta temporal y un repo git local.
// Los patrones con forma de secreto se arman por CONCATENACIÓN para que este propio archivo no contenga ninguno
// (si no, dispararía el escáner de VanGUARD al auditarnos, §01.6 / §09.9).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sembrar } from './sembrar-repo.mjs';

const PLANTILLA = join(import.meta.dirname, 'repo-vulnerable');
const REF = 'abcdefghijklmnopqrst'; // 20 letras minúsculas

// Patrones con forma de secreto (armados por partes, nunca enteros en el fuente).
const PATRONES = {
  jwt: new RegExp('ey' + 'J[A-Za-z0-9_-]{10,}\\.' + 'ey' + 'J[A-Za-z0-9_/\\\\-]{10,}\\.[A-Za-z0-9_/\\\\-]{10,}'),
  postgres: new RegExp('postgres' + '(?:ql)?:\\/\\/[^:\\s/]+:[^@\\s/]{6,}@[^\\s"\'`]+'),
  sbSecret: new RegExp('sb' + '_secret_[A-Za-z0-9_-]{20,}'),
  ghp: new RegExp('\\bghp' + '_[0-9A-Za-z]{36}\\b'),
  githubPat: new RegExp('github' + '_pat_\\w{30,}'),
  skAnt: new RegExp('sk' + '-ant-' + '[a-z0-9]{2,}'),
  aws: new RegExp('\\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\\b'),
  hexConNombre: new RegExp('(?:secret|token|key|passw|auth|credential)[\\w.-]{0,20}["\']?\\s*[:=]\\s*["\']?[0-9a-fA-F]{32,}', 'i'),
};

// Lista de archivos de texto de un árbol (sin .git ni node_modules).
function archivosTexto(raiz) {
  return readdirSync(raiz, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(raiz, join(d.parentPath, d.name)).split(sep).join('/'))
    .filter((r) => !r.startsWith('.git/') && !r.startsWith('node_modules/'))
    .map((r) => ({ rel: r, texto: readFileSync(join(raiz, r), 'utf8') }));
}

function coincidenciasDeSecreto(texto) {
  return Object.entries(PATRONES).filter(([, re]) => re.test(texto)).map(([n]) => n);
}

const temporales = [];
function repoTemporal() {
  const dir = mkdtempSync(join(tmpdir(), 'vg-siembra-'));
  temporales.push(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  return dir;
}

afterAll(() => {
  for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignora */ } }
});

describe('plantilla demo/repo-vulnerable', () => {
  it('no contiene ningún literal con forma de secreto', () => {
    const culpables = [];
    for (const { rel, texto } of archivosTexto(PLANTILLA)) {
      const hits = coincidenciasDeSecreto(texto);
      if (hits.length) culpables.push(`${rel}: ${hits.join(', ')}`);
    }
    expect(culpables).toEqual([]);
  });

  it('tiene los marcadores que la siembra reemplaza', () => {
    const admin = readFileSync(join(PLANTILLA, 'src/lib/supabaseAdmin.ts'), 'utf8');
    const wrangler = readFileSync(join(PLANTILLA, 'wrangler.jsonc'), 'utf8');
    expect(admin).toContain('__VG_SERVICE_ROLE_JWT__');
    expect(wrangler).toContain('__VG_INGEST_SECRET__');
    // El marcador va en la línea 4 (resource esperado src/lib/supabaseAdmin.ts:4, §09.13).
    expect(admin.split('\n')[3]).toContain('__VG_SERVICE_ROLE_JWT__');
  });

  it('declara las dependencias vulnerables exactas', () => {
    const lock = readFileSync(join(PLANTILLA, 'package-lock.json'), 'utf8');
    expect(lock).toContain('"jquery"');
    expect(lock).toContain('3.4.1');
    expect(lock).toContain('"lodash"');
    expect(lock).toContain('4.17.15');
    const composer = readFileSync(join(PLANTILLA, 'panel-legacy/composer.lock'), 'utf8');
    expect(composer).toContain('facade/ignition');
    expect(composer).toContain('2.5.1');
  });
});

describe('sembrar()', () => {
  it('rechaza un project_ref que no case ^[a-z]{20}$', () => {
    const clon = repoTemporal();
    const ingest = join(clon, '..', 'ingest.txt');
    writeFileSync(ingest, 'vgi' + '_' + 'x'.repeat(24));
    for (const malo of ['ABCDEFGHIJKLMNOPQRST', 'abc', 'abcdefghijklmnopqrs1', 'abcdefghijklmnopqrstu']) {
      expect(() => sembrar([clon, '--ref', malo, '--ingest-secret-file', ingest, '--no-push'])).toThrow();
    }
  });

  it('produce un clon con los secretos falsos y el historial esperado', () => {
    const clon = repoTemporal();
    const ingestValor = 'vgi' + '_' + 'demo_senuelo_' + 'abc123'.repeat(4);
    const ingest = join(clon, '..', 'ingest-ok.txt');
    writeFileSync(ingest, ingestValor + '\n');

    sembrar([clon, '--ref', REF, '--ingest-secret-file', ingest, '--no-push']);

    const env = readFileSync(join(clon, '.env'), 'utf8');
    const admin = readFileSync(join(clon, 'src/lib/supabaseAdmin.ts'), 'utf8');
    const wrangler = readFileSync(join(clon, 'wrangler.jsonc'), 'utf8');
    const gitignore = readFileSync(join(clon, '.gitignore'), 'utf8');

    // El resultado SÍ contiene literales con forma de secreto (lo contrario de la plantilla).
    expect(PATRONES.jwt.test(env)).toBe(true);        // CB_SECRET_SUPABASE_SERVICE_ROLE (.env:2)
    expect(PATRONES.postgres.test(env)).toBe(true);   // CB_SECRET_POSTGRES_URL (.env:3)
    expect(PATRONES.jwt.test(admin)).toBe(true);      // mismo JWT en supabaseAdmin.ts:4

    // Es el MISMO JWT en .env y en supabaseAdmin.ts (dedupe => un solo hallazgo, §09.13).
    const jwtEnv = env.match(PATRONES.jwt)[0];
    const jwtAdmin = admin.match(PATRONES.jwt)[0];
    expect(jwtAdmin).toBe(jwtEnv);
    expect(admin.split('\n')[3]).toContain(jwtEnv); // en la línea 4

    // El payload del JWT decodificado trae role service_role y el ref.
    const payload = JSON.parse(Buffer.from(jwtEnv.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.role).toBe('service' + '_role');
    expect(payload.ref).toBe(REF);

    // El .env lista las tres variables del plan.
    expect(env.split('\n')[0]).toMatch(/^SUPABASE_URL=https:\/\/abcdefghijklmnopqrst\.supabase\.co$/);
    expect(env).toContain('SUPABASE_SERVICE_ROLE_KEY=');
    expect(env).toContain('DATABASE_URL=');
    // El host de Postgres es db.<ref>.supabase.co (=> critical).
    expect(env).toContain('@db.' + REF + '.supabase.co:5432/');

    // wrangler.jsonc reusa el secreto de ingesta (CB_KEY_REUSE).
    expect(wrangler).toContain(ingestValor);

    // .gitignore NO saca .env (CB_GITIGNORE_NO_ENV).
    expect(/^\/?\.env/m.test(gitignore)).toBe(false);

    // Historial: 4 commits; .env está en HEAD, .env.production NO, pero sí en el historial.
    const nCommits = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: clon }).toString().trim();
    expect(nCommits).toBe('4');
    const enHead = execFileSync('git', ['ls-files'], { cwd: clon }).toString();
    expect(enHead).toContain('.env');
    expect(enHead.split('\n')).not.toContain('.env.production');
    const enHistorial = execFileSync('git', ['log', '--all', '--pretty=format:', '--name-only', '--', '.env.production'],
      { cwd: clon }).toString();
    expect(enHistorial).toContain('.env.production');
  });

  it('la plantilla queda intacta tras sembrar (no se le inyecta nada)', () => {
    const culpables = [];
    for (const { rel, texto } of archivosTexto(PLANTILLA)) {
      const hits = coincidenciasDeSecreto(texto);
      if (hits.length) culpables.push(`${rel}: ${hits.join(', ')}`);
    }
    expect(culpables).toEqual([]);
  });

  it('la CLI no imprime ningún valor de secreto', () => {
    const clon = repoTemporal();
    const ingestValor = 'vgi' + '_' + 'demo_cli_' + 'z'.repeat(20);
    const ingest = join(clon, '..', 'ingest-cli.txt');
    writeFileSync(ingest, ingestValor);

    const salida = execFileSync('node', [join(import.meta.dirname, 'sembrar-repo.mjs'), clon, '--ref', REF,
      '--ingest-secret-file', ingest, '--no-push'], { encoding: 'utf8' });

    const env = readFileSync(join(clon, '.env'), 'utf8');
    const jwt = env.match(PATRONES.jwt)[0];
    const pass = env.match(new RegExp('@db'))?.input.match(/postgres:([0-9a-f]{32})@/)[1];
    expect(salida).not.toContain(jwt);
    expect(salida).not.toContain(pass);
    expect(salida).not.toContain(ingestValor);
    // Sí nombra las fallas sembradas.
    expect(salida).toContain('CB_ENV_COMMITTED');
    expect(salida).toContain('CB_SECRET_SUPABASE_SERVICE_ROLE');
  });

  it('se niega a sembrar un clon cuyo origin no es la víctima (p. ej. el monorepo)', () => {
    const clon = repoTemporal();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/platanus-hack/platanus-hack-26-ve-team-22.git'], { cwd: clon });
    const ingest = join(clon, '..', 'ingest-bad-origin.txt');
    writeFileSync(ingest, 'vgi' + '_' + 'x'.repeat(24));
    expect(() => sembrar([clon, '--ref', REF, '--ingest-secret-file', ingest, '--no-push'])).toThrow(/vanguard-demo-victima/);
    // No tocó nada: ningún commit se creó en el clon equivocado.
    expect(() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clon, stdio: ['ignore', 'pipe', 'ignore'] })).toThrow();
  });

  it('acepta un origin que nombra la víctima y con --no-push no empuja', () => {
    const clon = repoTemporal();
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/demo/vanguard-demo-victima.git'], { cwd: clon });
    const ingest = join(clon, '..', 'ingest-ok-origin.txt');
    writeFileSync(ingest, 'vgi' + '_' + 'z'.repeat(24));
    const empuje = sembrar([clon, '--ref', REF, '--ingest-secret-file', ingest, '--no-push']);
    expect(empuje).toContain('--no-push');
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: clon }).toString().trim()).toBe('4');
  });
});
