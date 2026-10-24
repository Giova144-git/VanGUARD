import { describe, expect, it } from 'vitest';
import {
  AREA_OTROS, AREA_RAIZ, MAX_BYTES_ARCHIVO, RESERVA_PRESELECCION, agruparEnAreas, areaDeRutaEn, carpetaExcluida,
  elegirCandidatos, esCandidato, nombreArea, ordenarCandidatos, pareceArchivoDeClaves, preseleccionar, prioridad,
  rutaExcluida, rutaInsegura, seleccionarCandidatos,
} from './filtros.ts';
import { LIMITES_POR_DEFECTO } from './pipeline.ts';
import type { EntradaArbol } from './tipos.ts';

const lim = { maxBytesArchivo: MAX_BYTES_ARCHIVO };
const blob = (path: string, size = 1_000): EntradaArbol => ({ path, type: 'blob', size });

describe('esCandidato', () => {
  it('acepta código, docs escritos a mano, manifiestos y workflows', () => {
    for (const p of ['src/index.ts', 'README.md', 'package.json', 'pyproject.toml', 'apps/api/src/rutas.ts',
      'docs/guia.md', '.github/workflows/ci.yml', 'cmd/server/main.go', 'Dockerfile', 'wrangler.toml']) {
      expect(esCandidato(blob(p), lim), p).toBe(true);
    }
  });

  it('salta carpetas de dependencias, builds, cachés y docs generados en cualquier nivel', () => {
    for (const p of ['node_modules/x/index.js', 'apps/web/node_modules/a.js', 'dist/main.js', 'build/x.js',
      '.next/server.js', 'vendor/lib.php', 'pkg/__pycache__/a.py', 'coverage/lcov.js', '.venv/lib/x.py',
      'target/debug/a.rs', '_site/index.html', 'docs/_build/x.html', 'site-docs/a.md', '.turbo/log.txt',
      'Node_Modules/x.js', 'foo.egg-info/PKG-INFO', '.wrangler/state/x.json', 'bin/tool.js']) {
      expect(esCandidato(blob(p), lim), p).toBe(false);
    }
  });

  it('salta todo lo que parezca secreto', () => {
    for (const p of ['.env', '.env.local', '.env.example', 'apps/api/.dev.vars', 'config/prod.env', '.envrc',
      'id_rsa', 'keys/id_ed25519.pub', 'certs/server.pem', 'tls.key', 'cert.p12', 'a.pfx', '.npmrc', '.netrc',
      'credentials.json', 'gcp/service-account-prod.json', 'client_secret_123.json', 'infra/prod.tfvars',
      'terraform.tfstate', 'terraform.tfstate.backup', 'secrets.yaml', 'setup.cfg', 'app.ini', '.git-credentials']) {
      expect(esCandidato(blob(p), lim), p).toBe(false);
    }
  });

  it('salta lockfiles, binarios, multimedia, minificados y generados', () => {
    for (const p of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'go.sum', 'poetry.lock',
      'logo.png', 'LOGO.PNG', 'icon.svg', 'manual.pdf', 'font.woff2', 'a.zip', 'app.exe', 'mod.wasm', 'data.sqlite',
      'vendor.bundle.js', 'app.min.js', 'style.min.css', 'main.js.map', 'api_pb2.py', 'model.onnx', '.DS_Store',
      'tsconfig.json', '.gitignore', '__snapshots__/a.snap']) {
      expect(esCandidato(blob(p), lim), p).toBe(false);
    }
  });

  it('aplica tamaño, tipo y forma de la ruta', () => {
    expect(esCandidato(blob('src/a.ts', MAX_BYTES_ARCHIVO), lim)).toBe(true);
    expect(esCandidato(blob('src/a.ts', MAX_BYTES_ARCHIVO + 1), lim)).toBe(false);
    expect(esCandidato(blob('src/vacio.py', 0), lim)).toBe(false);
    expect(esCandidato({ path: 'src/a.ts', type: 'blob' }, lim)).toBe(true); // sin tamaño: lo acota la descarga
    expect(esCandidato({ path: 'src', type: 'tree' }, lim)).toBe(false);
    expect(esCandidato({ path: 'sub', type: 'commit' }, lim)).toBe(false);
    expect(esCandidato(blob(`src/${'a'.repeat(300)}.ts`), lim)).toBe(false);
    expect(esCandidato(blob('src/../etc/passwd'), lim)).toBe(false);
    expect(esCandidato(blob('src\\a.ts'), lim)).toBe(false);
    expect(esCandidato(blob('a.ts', 500), { maxBytesArchivo: 100 })).toBe(false);
  });
});

describe('rutas', () => {
  it('rutaInsegura detecta segmentos vacíos, . y .. y caracteres de control', () => {
    expect(rutaInsegura('src/a.ts')).toBe(false);
    for (const p of ['', '/a.ts', 'a//b.ts', 'a/./b', '../a', 'a/', 'a\u0000b', 'a\nb']) expect(rutaInsegura(p), p).toBe(true);
  });
  it('rutaInsegura descarta controles C1, bidi, ancho cero y lo que solo sirve para inyectar HTML', () => {
    for (const p of ['docs/a‮b.md', 'a​b.ts', 'a\u0085b.ts', 'a⁦b.ts', 'a﻿b.ts',
      '<img src=x onerror=alert(1)>/a.ts', 'a"b.ts', 'a`b.ts']) {
      expect(rutaInsegura(p), JSON.stringify(p)).toBe(true);
    }
    // Rutas reales de Next.js: corchetes y paréntesis se aceptan (y se tratan como texto plano al mostrarlos).
    for (const p of ['app/[slug]/page.tsx', 'app/(marketing)/page.tsx', 'pages/[...todo].tsx']) {
      expect(rutaInsegura(p), p).toBe(false);
    }
  });
  it('salta wp-config.php y los secrets.* / .secrets*', () => {
    for (const p of ['wp-config.php', 'blog/WP-CONFIG.php', 'app/secrets.py', 'config/secrets.ts', '.secrets',
      '.secrets.toml']) {
      expect(rutaExcluida(p), p).toBe(true);
      expect(pareceArchivoDeClaves(p), p).toBe(true);
    }
    expect(pareceArchivoDeClaves('src/secretos-de-cocina.md')).toBe(false);
  });
  it('rutaExcluida y carpetaExcluida no distinguen mayúsculas', () => {
    expect(rutaExcluida('DIST/a.js')).toBe(true);
    expect(carpetaExcluida('Node_Modules')).toBe(true);
    expect(carpetaExcluida('src')).toBe(false);
  });
});

describe('prioridad y orden', () => {
  it('README y manifiestos primero, luego por profundidad; pruebas al final', () => {
    expect(prioridad('README.md')).toBeLessThan(prioridad('index.ts'));
    expect(prioridad('apps/api/package.json')).toBeLessThan(prioridad('src/index.ts'));
    expect(prioridad('src/index.ts')).toBeLessThan(prioridad('src/a/b/c.ts'));
    expect(prioridad('src/a/b/c/d/e.ts')).toBeLessThan(prioridad('src/a.test.ts'));
    expect(prioridad('src/a.ts')).toBeLessThan(prioridad('tests/a.ts'));
    expect(prioridad('src/a.ts')).toBeLessThan(prioridad('pkg/server_test.go'));
    expect(prioridad('src/a.ts')).toBeLessThan(prioridad('.github/workflows/ci.yml'));
    expect(prioridad('src/latest.ts')).toBe(prioridad('src/a.ts')); // «latest» no es una prueba
  });

  it('ordenarCandidatos es determinista y no muta la entrada', () => {
    const entrada = [blob('src/z.ts'), blob('tests/a.test.ts'), blob('src/a.ts'), blob('README.md'), blob('go.mod')];
    const copia = entrada.map((e) => e.path);
    const orden = ordenarCandidatos(entrada).map((e) => e.path);
    expect(orden).toEqual(['README.md', 'go.mod', 'src/a.ts', 'src/z.ts', 'tests/a.test.ts']);
    expect(entrada.map((e) => e.path)).toEqual(copia);
  });

  it('seleccionarCandidatos filtra, ordena y deja {path, size}', () => {
    const r = seleccionarCandidatos([blob('src/b.ts', 10), blob('node_modules/x.js'), { path: 'src', type: 'tree' },
      blob('.env'), blob('README.md', 20), { path: 'src/c.ts', type: 'blob' }], lim);
    expect(r).toEqual([{ path: 'README.md', size: 20 }, { path: 'src/b.ts', size: 10 }, { path: 'src/c.ts', size: 0 }]);
  });

  it('elegirCandidatos corta en maxCandidatos, cuenta el total y los archivos con claves en una pasada', () => {
    const entradas = [blob('.env'), blob('id_rsa'), blob('README.md'), blob('logo.png'),
      ...Array.from({ length: 30 }, (_, i) => blob(`src/m${String(i).padStart(2, '0')}.ts`)),
      blob('tests/a.test.ts')];
    const r = elegirCandidatos(entradas, { maxBytesArchivo: MAX_BYTES_ARCHIVO, maxCandidatos: 10 });
    expect(r.total).toBe(32);
    expect(r.conClaves).toBe(2);
    expect(r.candidatos).toHaveLength(10);
    // Con el árbol en el orden de GitHub (ya ordenado por ruta) sale lo mismo que con el orden completo.
    expect(r.candidatos.map((c) => c.path)).toEqual(seleccionarCandidatos(entradas, lim).slice(0, 10).map((c) => c.path));
    // Si una cubeta desborda, se queda con las primeras del árbol: determinista para el mismo commit.
    const alReves = elegirCandidatos([...entradas].reverse(), { maxBytesArchivo: MAX_BYTES_ARCHIVO, maxCandidatos: 10 });
    expect(alReves).toEqual(elegirCandidatos([...entradas].reverse(), { maxBytesArchivo: MAX_BYTES_ARCHIVO, maxCandidatos: 10 }));
    expect(r.candidatos[0]?.path).toBe('README.md');
    expect(elegirCandidatos(entradas, { maxBytesArchivo: MAX_BYTES_ARCHIVO, maxCandidatos: 0 }).candidatos).toEqual([]);
  });

  it('elegirCandidatos cabe en el presupuesto de CPU con el árbol más grande que se parsea', () => {
    const carpetas = ['src', 'apps/web/src', 'apps/api/src', 'packages/core/src', 'docs', 'tests', 'public/img'];
    const grande = Array.from({ length: 2_000 }, (_, i) =>
      blob(`${carpetas[i % carpetas.length]}/modulo${i % 37}/archivo-${i}.${i % 5 === 0 ? 'png' : 'ts'}`, 900));
    elegirCandidatos(grande, LIMITES_POR_DEFECTO);   // calienta el JIT como haría un isolate ya usado
    // El mínimo de 5 corridas: con `pnpm -r test` en paralelo, una sola medida absorbe la carga de los otros procesos.
    let mejor = Infinity;
    let r = elegirCandidatos(grande, LIMITES_POR_DEFECTO);
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      r = elegirCandidatos(grande, LIMITES_POR_DEFECTO);
      mejor = Math.min(mejor, performance.now() - t0);
    }
    expect(mejor).toBeLessThan(20);
    expect(r.candidatos).toHaveLength(400);
    expect(r.total).toBe(1_600);
  });
});

describe('preseleccionar', () => {
  const l = { charsPorArchivo: 3000, charsPorArea: 24_000, maxArchivosPorArea: 25 };
  it('pide solo lo que cabe en el prompt del área, más 3 de reserva', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `api/f${i}.ts`);
    const grandes = new Map(paths.map((p) => [p, 50_000] as const));
    expect(preseleccionar(paths, grandes, l)).toHaveLength(8 + RESERVA_PRESELECCION);
    const chicos = new Map(paths.map((p) => [p, 200] as const));
    expect(preseleccionar(paths, chicos, l)).toEqual(paths);
    expect(preseleccionar(paths, new Map(), l)).toHaveLength(8 + RESERVA_PRESELECCION);   // sin tamaño: el máximo
    expect(preseleccionar(paths, chicos, { ...l, maxArchivosPorArea: 5 })).toHaveLength(5);
  });
});

describe('areaDeRutaEn (misma regla para la síntesis y para paginaDeRuta del FRONT)', () => {
  const items = [
    { area: AREA_RAIZ, archivos: ['README.md'] },
    { area: 'src', archivos: ['src/index.ts'] },
    { area: 'src/lib', archivos: ['src/lib/a.ts'] },
    { area: AREA_OTROS, archivos: ['varios/x.ts'] },
  ];
  it.each([
    ['archivo leído', 'src/lib/a.ts', 'src/lib'],
    ['con número de línea', 'src/lib/a.ts:4', 'src/lib'],
    ['prefijo más largo, no el primero', 'src/lib/b.ts', 'src/lib'],
    ['prefijo con barra: srcfoo no es src', 'srcfoo/a.ts', null],
    ['misma carpeta que un archivo de «(otros)»', 'varios/y.ts', AREA_OTROS],
    ['archivo suelto en la raíz (.env, lockfile)', '.env', AREA_RAIZ],
    ['carpeta desconocida', 'otra/z.ts', null],
  ])('%s', (_n, ruta, esperado) => {
    expect(areaDeRutaEn(ruta, items)?.area ?? null).toBe(esperado);
  });
  it('sin página de raíz, un archivo suelto no cae en ninguna', () => {
    expect(areaDeRutaEn('.env', items.slice(1))).toBeNull();
  });
});

describe('agruparEnAreas', () => {
  it('usa la carpeta de primer nivel y «(raiz)» para archivos sueltos', () => {
    expect(nombreArea('README.md')).toBe(AREA_RAIZ);
    expect(nombreArea('lib/x/y.ts')).toBe('lib');
    expect(nombreArea('docs/a.md')).toBe('docs');
  });

  it('en contenedores de monorepo usa dos niveles', () => {
    expect(nombreArea('apps/api/src/index.ts')).toBe('apps/api');
    expect(nombreArea('packages/contracts/src/wiki.ts')).toBe('packages/contracts');
    expect(nombreArea('services/pagos/main.go')).toBe('services/pagos');
    expect(nombreArea('cmd/server/main.go')).toBe('cmd/server');
    expect(nombreArea('internal/db/x.go')).toBe('internal/db');
    expect(nombreArea('libs/ui/a.ts')).toBe('libs/ui');
    expect(nombreArea('src/componentes/Boton.tsx')).toBe('src/componentes');
    expect(nombreArea('Packages/Foo/x.ts')).toBe('Packages/Foo');
    expect(nombreArea('src/index.ts')).toBe('src'); // archivo directo del contenedor
    expect(nombreArea('apps/README.md')).toBe('apps');
  });

  it('agrupa conservando el orden de entrada y pone «(raiz)» primero', () => {
    const areas = agruparEnAreas(['README.md', 'apps/web/a.tsx', 'apps/api/a.ts', 'apps/api/b.ts', 'package.json'], 12);
    expect(areas).toEqual([
      { nombre: AREA_RAIZ, archivos: ['README.md', 'package.json'] },
      { nombre: 'apps/api', archivos: ['apps/api/a.ts', 'apps/api/b.ts'] },
      { nombre: 'apps/web', archivos: ['apps/web/a.tsx'] },
    ]);
  });

  it('fusiona el exceso en «(otros)» sin perder archivos y respetando maxAreas', () => {
    const paths: string[] = ['README.md'];
    for (let i = 0; i < 6; i++) for (let j = 0; j <= i; j++) paths.push(`mod${i}/f${j}.ts`);
    const areas = agruparEnAreas(paths, 4);
    expect(areas.map((a) => a.nombre)).toEqual([AREA_RAIZ, 'mod5', 'mod4', 'mod3', AREA_OTROS]);
    const otros = areas.at(-1)!;
    expect(otros.archivos).toEqual(paths.filter((p) => /^mod[0-2]\//.test(p)));
    expect(areas.reduce((n, a) => n + a.archivos.length, 0)).toBe(paths.length);
  });

  it('sin raíz caben maxAreas áreas propias; con maxAreas < 1 se usa 1', () => {
    const paths = ['a/1.ts', 'a/2.ts', 'b/1.ts', 'c/1.ts'];
    expect(agruparEnAreas(paths, 2).map((a) => a.nombre)).toEqual(['a', 'b', AREA_OTROS]);
    expect(agruparEnAreas(paths, 0).map((a) => a.nombre)).toEqual(['a', AREA_OTROS]);
    expect(agruparEnAreas(paths, 3).map((a) => a.nombre)).toEqual(['a', 'b', 'c']);
    expect(agruparEnAreas([], 12)).toEqual([]);
  });
});
