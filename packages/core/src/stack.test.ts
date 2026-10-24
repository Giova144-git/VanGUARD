// detectarStack() de S09 09.5: extensiones por bytes, manifiestos, plataformas, CI y gestores. Sin red ni IA.
import { describe, it, expect } from 'vitest';
import { detectarStack } from './stack.ts';

// Forma de la víctima de 09.13: Vite + React + Hono con Supabase, panel PHP legado con Laravel, Worker de Cloudflare.
const INVENTARIO = [
  { path: 'package.json', size: 900 }, { path: 'package-lock.json', size: 250_000 },
  { path: 'src/main.tsx', size: 4000 }, { path: 'src/lib/supabaseAdmin.ts', size: 600 }, { path: 'src/api/index.ts', size: 9000 },
  { path: 'vite.config.js', size: 300 }, { path: 'wrangler.jsonc', size: 400 }, { path: 'supabase/migrations/0001.sql', size: 2000 },
  { path: 'panel-legacy/composer.json', size: 300 }, { path: 'panel-legacy/composer.lock', size: 9000 }, { path: 'panel-legacy/index.php', size: 2210 },
  { path: '.github/workflows/ci.yml', size: 500 }, { path: 'Dockerfile', size: 200 },
  { path: 'node_modules/react/index.js', size: 999_999 }, { path: 'vendor/laravel/x.php', size: 999_999 }, { path: 'dist/app.js', size: 999_999 },
];
const ARCHIVOS = [
  { path: 'package.json', content: JSON.stringify({ dependencies: { react: '19.3.1', hono: '^4', '@supabase/supabase-js': '2.118.0', jquery: '3.4.1' },
    devDependencies: { vite: '8.3.5', typescript: '6.0.3' } }) },
  { path: 'panel-legacy/composer.json', content: JSON.stringify({ require: { 'laravel/framework': '^8.0' }, 'require-dev': { 'symfony/var-dumper': '^5' } }) },
];

describe('detectarStack', () => {
  const s = detectarStack(INVENTARIO, ARCHIVOS);
  it('lenguajes por bytes, sin node_modules/vendor/dist', () => {
    expect(s.lenguajes).toEqual([
      { nombre: 'TypeScript', archivos: 3, bytes: 13_600 }, { nombre: 'PHP', archivos: 1, bytes: 2210 }, { nombre: 'JavaScript', archivos: 1, bytes: 300 }]);
  });
  it('frameworks y servicios de los manifiestos, en orden fijo', () => {
    expect(s.frameworks).toEqual(['react', 'vite', 'hono', 'laravel', 'symfony']);
    expect(s.servicios).toEqual(['supabase']);
  });
  it('plataformas, CI y gestores (package_manager = el primero)', () => {
    expect(s.plataformas).toEqual(['cloudflare_workers', 'supabase', 'docker']);
    expect(s.ci).toEqual(['github_actions']);
    expect(s.gestores).toEqual(['npm', 'composer']);
  });
  it('repo vacío o con un package.json roto → todo vacío, sin lanzar', () => {
    expect(detectarStack([], [{ path: 'package.json', content: '{' }]))
      .toEqual({ lenguajes: [], frameworks: [], servicios: [], plataformas: [], ci: [], gestores: [] });
  });
  it('Python, Flutter, Rails y monorepo pnpm', () => {
    const r = detectarStack(
      [{ path: 'api/main.py', size: 10 }, { path: 'app/lib/main.dart', size: 20 }, { path: 'pnpm-lock.yaml', size: 1 }, { path: 'apps/api/wrangler.toml', size: 1 },
        { path: 'vercel.json', size: 1 }, { path: 'web/.vercel/project.json', size: 1 }, { path: 'netlify.toml', size: 1 }, { path: 'firebase.json', size: 1 },
        { path: 'poetry.lock', size: 1 }, { path: 'pubspec.lock', size: 1 }, { path: 'Cargo.lock', size: 1 }, { path: 'go.sum', size: 1 }, { path: 'yarn.lock', size: 1 }],
      [{ path: 'requirements.txt', content: 'Django==5.1\nrequests>=2\n# flask comentado no cuenta\n' },
        { path: 'pyproject.toml', content: 'dependencies = ["fastapi>=0.110", "uvicorn"]' },
        { path: 'app/pubspec.yaml', content: 'dependencies:\n  flutter:\n    sdk: flutter\n' },
        { path: 'Gemfile', content: "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n" }]);
    expect(r.frameworks).toEqual(['django', 'fastapi', 'flutter', 'rails']);
    expect(r.plataformas).toEqual(['cloudflare_workers', 'vercel', 'netlify', 'firebase']);
    expect(r.gestores).toEqual(['pnpm', 'yarn', 'pip', 'go', 'pub', 'cargo']);
    expect(r.lenguajes.map((l) => l.nombre)).toEqual(['Dart', 'Python']);
  });
  it('un nombre parecido no cuenta (preact no es react; un workflow fuera de la raíz no es CI)', () => {
    const r = detectarStack([{ path: 'pkg/.github/workflows/x.yml', size: 1 }],
      [{ path: 'package.json', content: JSON.stringify({ dependencies: { preact: '10', 'react-dom': '19' } }) }]);
    expect(r.frameworks).toEqual([]);
    expect(r.ci).toEqual([]);
  });
});
