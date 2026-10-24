// S15 15.13: `package-lock.json` v3 de muestra → número de dependencias y `dev` correctos (más v1, alias y link de 09.6).
import { describe, it, expect } from 'vitest';
import { fromPackageLock } from './npm.ts';

// Muestra con la forma de la víctima (09.13): jquery y lodash vulnerables, una dev, una anidada, un alias y un workspace.
const V3 = JSON.stringify({
  name: 'vanguard-demo-victima', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'vanguard-demo-victima', dependencies: { jquery: '3.4.1', lodash: '4.17.15', hono: '^4' }, devDependencies: { vite: '^8', 'mi-alias': 'npm:left-pad@1.3.0' } },
    'node_modules/jquery': { version: '3.4.1', resolved: 'https://registry.npmjs.org/jquery/-/jquery-3.4.1.tgz' },
    'node_modules/lodash': { version: '4.17.15' },
    'node_modules/hono': { version: '4.9.0' },
    'node_modules/vite': { version: '8.3.5', dev: true },
    'node_modules/esbuild': { version: '0.25.0', dev: true },
    'node_modules/vite/node_modules/rollup': { version: '4.0.0', dev: true },
    'node_modules/mi-alias': { name: 'left-pad', version: '1.3.0', dev: true },
    'node_modules/@vanguard/web': { resolved: 'packages/web', link: true },
    'packages/web': { name: '@vanguard/web', version: '0.0.0' },
  },
});

describe('fromPackageLock v2/v3', () => {
  const deps = fromPackageLock(V3, 'package-lock.json');
  it('cuenta solo node_modules/ con versión y sin link (salta "" y el workspace)', () => {
    expect(deps).toHaveLength(7);
    expect(deps.map((d) => d.name)).not.toContain('@vanguard/web');
  });
  it('dev correcto: 4 de dev y 3 de runtime', () => {
    expect(deps.filter((d) => d.dev).map((d) => d.name).sort()).toEqual(['esbuild', 'left-pad', 'rollup', 'vite']);
    expect(deps.filter((d) => !d.dev).map((d) => d.name).sort()).toEqual(['hono', 'jquery', 'lodash']);
  });
  it('directas = dependencies + devDependencies de la raíz; anidada por el último node_modules/', () => {
    const por = Object.fromEntries(deps.map((d) => [d.name, d]));
    expect(por.jquery).toEqual({ ecosystem: 'npm', name: 'jquery', version: '3.4.1', dev: false, direct: true, manifest: 'package-lock.json' });
    expect(por.vite?.direct).toBe(true);
    expect(por.esbuild?.direct).toBe(false);
    expect(por.rollup).toMatchObject({ version: '4.0.0', direct: false });
  });
  it('alias npm: el nombre real sale de v.name', () => {
    expect(deps.find((d) => d.name === 'left-pad')).toMatchObject({ version: '1.3.0', direct: true, dev: true });
  });
});

describe('fromPackageLock v1', () => {
  it('dependencies recursivo; directas = primer nivel; salta file:', () => {
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: {
      lodash: { version: '4.17.15' },
      jest: { version: '29.0.0', dev: true, dependencies: { chalk: { version: '4.1.2', dev: true } } },
      local: { version: 'file:../local' },
    } });
    const deps = fromPackageLock(v1, 'web/package-lock.json');
    expect(deps).toEqual([
      { ecosystem: 'npm', name: 'lodash', version: '4.17.15', dev: false, direct: true, manifest: 'web/package-lock.json' },
      { ecosystem: 'npm', name: 'jest', version: '29.0.0', dev: true, direct: true, manifest: 'web/package-lock.json' },
      { ecosystem: 'npm', name: 'chalk', version: '4.1.2', dev: true, direct: false, manifest: 'web/package-lock.json' },
    ]);
  });
  it('JSON roto lanza (el llamador marca lockfiles[].error = "parse")', () => {
    expect(() => fromPackageLock('{', 'package-lock.json')).toThrow();
  });
});
