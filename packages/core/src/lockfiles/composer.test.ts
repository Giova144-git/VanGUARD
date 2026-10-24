// S15 15.13: `composer.lock` de muestra → número de dependencias y `dev` correctos (09.6).
import { describe, it, expect } from 'vitest';
import { fromComposerLock } from './composer.ts';

// Muestra con la forma del panel legado de la víctima (09.13): ignition vulnerable en dev, una rama dev-* que se salta.
const LOCK = JSON.stringify({
  'content-hash': 'abc',
  packages: [
    { name: 'laravel/framework', version: 'v8.83.27' },
    { name: 'monolog/monolog', version: '2.9.1' },
    { name: 'acme/interno', version: 'dev-main' },
  ],
  'packages-dev': [
    { name: 'facade/ignition', version: '2.5.1' },
    { name: 'phpunit/phpunit', version: '9.6.0' },
  ],
});
const COMPOSER_JSON = JSON.stringify({ require: { php: '^8.0', 'laravel/framework': '^8.0' }, 'require-dev': { 'facade/ignition': '^2.5' } });

describe('fromComposerLock', () => {
  const deps = fromComposerLock(LOCK, 'panel-legacy/composer.lock', COMPOSER_JSON);
  it('4 dependencias (salta dev-*): 2 de runtime y 2 de dev', () => {
    expect(deps).toHaveLength(4);
    expect(deps.filter((d) => !d.dev).map((d) => d.name)).toEqual(['laravel/framework', 'monolog/monolog']);
    expect(deps.filter((d) => d.dev).map((d) => d.name)).toEqual(['facade/ignition', 'phpunit/phpunit']);
  });
  it('versión sin v inicial, ecosistema Packagist y manifest', () => {
    expect(deps[0]).toEqual({ ecosystem: 'Packagist', name: 'laravel/framework', version: '8.83.27', dev: false, direct: true, manifest: 'panel-legacy/composer.lock' });
    expect(deps.find((d) => d.name === 'facade/ignition')).toMatchObject({ version: '2.5.1', dev: true });
  });
  it('directas = require del composer.json hermano (require-dev no cuenta, literal de 09.6)', () => {
    expect(deps.filter((d) => d.direct).map((d) => d.name)).toEqual(['laravel/framework']);
  });
  it('sin composer.json: nada es directo; sin packages-dev: solo runtime', () => {
    expect(fromComposerLock(LOCK, 'composer.lock').some((d) => d.direct)).toBe(false);
    expect(fromComposerLock(JSON.stringify({ packages: [{ name: 'a/b', version: '1.0.0' }] }), 'composer.lock')).toHaveLength(1);
  });
});
