// Pruebas del push de la demo de «Revisión de código». Sin red ni push real: repos git locales en una carpeta temporal.
// Los patrones con forma de secreto se arman por CONCATENACIÓN para que este archivo no contenga ninguno (§01.6).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ARCHIVO, ARCHIVO_PLAN_B, claveStripeFalsa, contenidoPagos, empujar } from './empujar-revision.mjs';

const STRIPE = new RegExp('\\b' + 'sk' + '_live_[a-zA-Z0-9]{24}\\b');
const temporales = [];
function repo({ origin } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vg-revision-'));
  temporales.push(dir);
  const g = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
  g(['init', '--quiet', '-b', 'main']);
  g(['commit', '--quiet', '--allow-empty', '-m', 'inicio']);
  if (origin) g(['remote', 'add', 'origin', origin]);
  return dir;
}
const log = (dir) => execFileSync('git', ['log', '--format=%s'], { cwd: dir }).toString().trim().split('\n');

afterAll(() => { for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignora */ } } });

describe('empujar-revision', () => {
  it('cada clave es distinta y casa la regla de Stripe live', () => {
    const a = claveStripeFalsa();
    const b = claveStripeFalsa();
    expect(a).not.toBe(b);
    expect(STRIPE.test(a)).toBe(true);
    expect(contenidoPagos(a).split('\n')[2]).toContain(a); // línea 3 = resource src/lib/pagos.ts:3
  });

  it('crea el archivo y el commit sin empujar, y --deshacer lo quita', async () => {
    const dir = repo();
    const r = await empujar([dir, '--no-push']);
    expect(r.hecho).toMatch(/sin push/);
    expect(STRIPE.test(readFileSync(join(dir, ARCHIVO), 'utf8'))).toBe(true);
    const d = await empujar([dir, '--deshacer', '--no-push']);
    expect(d.hecho).toMatch(/sin push/);
    expect(existsSync(join(dir, ARCHIVO))).toBe(false);
    expect(log(dir).slice(0, 2)).toEqual(['revert: quita el cobro con tarjeta', 'feat: cobro con tarjeta']);
    expect((await empujar([dir, '--deshacer', '--no-push'])).hecho).toBe('nada que deshacer');
  });

  it('dos ejecuciones seguidas dejan claves distintas (cada push es nuevo)', async () => {
    const dir = repo();
    await empujar([dir, '--no-push']);
    const primera = readFileSync(join(dir, ARCHIVO), 'utf8');
    await empujar([dir, '--no-push']);
    expect(readFileSync(join(dir, ARCHIVO), 'utf8')).not.toBe(primera);
  });

  it('--plan-b sube .env.staging con una URL de Postgres', async () => {
    const dir = repo();
    await empujar([dir, '--plan-b', '--no-push']);
    expect(readFileSync(join(dir, ARCHIVO_PLAN_B), 'utf8')).toMatch(new RegExp('^DATABASE_URL=' + 'postgres' + 'ql://'));
    await empujar([dir, '--deshacer', '--no-push']);
    expect(existsSync(join(dir, ARCHIVO_PLAN_B))).toBe(false);
  });

  it('se niega con un origin que no es el repo de la demo y con el clon sucio', async () => {
    await expect(empujar([repo({ origin: 'https://github.com/platanus-hack/platanus-hack-26-ve-team-22.git' })]))
      .rejects.toThrow(/solo empujo al repo de la demo/);
    const otro = repo({ origin: 'https://github.com/alguien/mi-repo-nuevo.git' });
    await expect(empujar([otro, '--no-push', '--origen-contiene', 'mi-repo-nuevo'])).resolves.toMatchObject({ rama: 'main' });
    const sucio = repo();
    writeFileSync(join(sucio, 'a-medias.txt'), 'x');
    await expect(empujar([sucio, '--no-push'])).rejects.toThrow(/sin commitear/);
  });
});
