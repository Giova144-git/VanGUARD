// Pruebas de github.ts con un doble de fetch: cero red real.
import { describe, expect, it } from 'vitest';
import { ErrorGithub, MAX_BYTES_ARBOL, MAX_SUBPETICIONES_ARBOL, esperaDe, leerArbol, leerArchivos, leerArchivosDetalle,
  leerMeta, normalizarRepo } from './github.ts';
import type { Deps, Fetch, MetaRepo } from './tipos.ts';

const SHA = 'a'.repeat(40);
const TOKEN = 'ghp' + '_tokenDePruebaQueNoDebeSalir123'; // armado por partes: ningún literal con forma de token en el repo
type Llamada = { url: string; init: RequestInit };

function dobleFetch(responder: (url: string, n: number) => Response | Promise<Response>) {
  const llamadas: Llamada[] = [];
  const fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = String(entrada);
    llamadas.push({ url, init: init ?? {} });
    return responder(url, llamadas.length);
  }) as Fetch;
  return { fetch, llamadas };
}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
const texto = (s: string, status = 200, headers: Record<string, string> = {}) => new Response(s, { status, headers });
const cab = (l: Llamada) => (l.init.headers ?? {}) as Record<string, string>;
const repoJson = { full_name: 'acme/app', description: 'Una app', language: 'TypeScript', private: false,
  default_branch: 'main', owner: { login: 'acme' } };
const meta: MetaRepo = { full_name: 'acme/app', description: null, language: null, private: false,
  default_branch: 'main', branch: 'main', commit_sha: SHA };

async function errorDe(p: Promise<unknown>): Promise<ErrorGithub> {
  try { await p; } catch (e) { if (e instanceof ErrorGithub) return e; throw e; }
  throw new Error('se esperaba un ErrorGithub');
}

describe('normalizarRepo', () => {
  it('acepta dueño/repo y URLs de GitHub', () => {
    expect(normalizarRepo('acme/app')).toBe('acme/app');
    expect(normalizarRepo(' https://github.com/acme/app ')).toBe('acme/app');
    expect(normalizarRepo('https://github.com/acme/app.git')).toBe('acme/app');
    expect(normalizarRepo('github.com/acme/app/')).toBe('acme/app');
    expect(normalizarRepo('http://www.github.com/Acme/my.repo')).toBe('Acme/my.repo');
  });
  it('rechaza lo que no cumple RepoFullName', () => {
    for (const r of ['acme', 'a/b/c', 'acme/..', 'https://gitlab.com/a/b', 'ac me/app', '']) {
      expect(() => normalizarRepo(r), r).toThrow(ErrorGithub);
    }
  });
});

describe('leerMeta', () => {
  it('resuelve la rama principal a su commit con 2 subpeticiones y cabeceras correctas', async () => {
    const { fetch, llamadas } = dobleFetch((url) =>
      url.endsWith('/repos/acme/app') ? json(repoJson) : texto(`${SHA.toUpperCase()}\n`));
    const m = await leerMeta({ repo_full_name: 'acme/app' }, { fetch });
    expect(m).toEqual({ full_name: 'acme/app', description: 'Una app', language: 'TypeScript', private: false,
      default_branch: 'main', branch: 'main', commit_sha: SHA });
    expect(llamadas.map((l) => l.url)).toEqual(['https://api.github.com/repos/acme/app',
      'https://api.github.com/repos/acme/app/commits/main']);
    const [primera, segunda] = llamadas as [Llamada, Llamada];
    expect(cab(primera)).toMatchObject({ 'User-Agent': 'vanguard-deepwiki', Accept: 'application/vnd.github+json' });
    expect(cab(segunda).Accept).toBe('application/vnd.github.sha');
    expect(cab(primera).Authorization).toBeUndefined();
    expect(primera.init.signal).toBeInstanceOf(AbortSignal);
    expect(primera.init.redirect).toBe('manual');
  });

  it('usa la rama pedida (codificada) y manda el token como Bearer', async () => {
    const { fetch, llamadas } = dobleFetch((url) => (url.endsWith('/repos/acme/app') ? json(repoJson) : texto(SHA)));
    const m = await leerMeta({ repo_full_name: 'acme/app', ref: ' feature/x#1 ' }, { fetch, githubToken: TOKEN });
    expect(m.branch).toBe('feature/x#1');
    expect(llamadas[1]?.url).toBe('https://api.github.com/repos/acme/app/commits/feature/x%231');
    for (const l of llamadas) expect(cab(l).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('valida dueño/repo y la rama sin tocar la red', async () => {
    const { fetch, llamadas } = dobleFetch(() => json(repoJson));
    for (const r of ['acme', 'acme/..', '../x', 'acme/app/extra']) {
      expect((await errorDe(leerMeta({ repo_full_name: r }, { fetch }))).codigo).toBe('repo_invalido');
    }
    for (const ref of ['a..b', 'x y', '/x', 'x/', 'a:b', 'x\u0000']) {
      expect((await errorDe(leerMeta({ repo_full_name: 'acme/app', ref }, { fetch }))).codigo).toBe('ref_invalida');
    }
    expect(llamadas).toHaveLength(0);
  });

  it('traduce los errores de GitHub a mensajes claros sin filtrar el token', async () => {
    const casos: [number, string, string][] = [
      [404, 'repo_no_encontrado', 'privado sin conexión'], [403, 'limite_github', 'conecta tu GitHub'],
      [429, 'limite_github', 'conecta tu GitHub'], [401, 'token_invalido', 'conectar tu GitHub'],
      [500, 'github_error', '500'],
    ];
    for (const [status, codigo, frase] of casos) {
      const { fetch } = dobleFetch(() => json({ message: 'x' }, status));
      const e = await errorDe(leerMeta({ repo_full_name: 'acme/app' }, { fetch }));
      expect(e.codigo).toBe(codigo);
      expect(e.status).toBe(status);
      expect(e.message).toContain(frase);
    }
    const { fetch } = dobleFetch(() => json({ message: 'Not Found' }, 404));
    const e = await errorDe(leerMeta({ repo_full_name: 'acme/app' }, { fetch, githubToken: TOKEN }));
    expect(e.codigo).toBe('repo_no_encontrado');
    expect(e.message).not.toContain(TOKEN);
  });

  it('rama inexistente (404/422) y repo vacío (409) al resolver el commit', async () => {
    for (const [status, codigo] of [[404, 'ref_no_encontrada'], [422, 'ref_no_encontrada'], [409, 'repo_vacio']] as const) {
      const { fetch } = dobleFetch((url) => (url.endsWith('/repos/acme/app') ? json(repoJson) : json({}, status)));
      expect((await errorDe(leerMeta({ repo_full_name: 'acme/app', ref: 'nope' }, { fetch }))).codigo).toBe(codigo);
    }
  });

  it('plan B si no llega el sha crudo: commits?sha=&per_page=1, sin pasar de 3 subpeticiones', async () => {
    const { fetch, llamadas } = dobleFetch((url) => {
      if (url.endsWith('/repos/acme/app')) return json(repoJson);
      if (url.includes('per_page=1')) return json([{ sha: SHA, commit: {} }]);
      return json({ sha: SHA, files: [] });
    });
    const m = await leerMeta({ repo_full_name: 'acme/app', ref: 'dev/1' }, { fetch });
    expect(m.commit_sha).toBe(SHA);
    expect(llamadas).toHaveLength(3);
    expect(llamadas[2]?.url).toBe('https://api.github.com/repos/acme/app/commits?sha=dev%2F1&per_page=1');
  });

  it('sigue una redirección del mismo host (repo renombrado) y usa el nombre canónico', async () => {
    const { fetch, llamadas } = dobleFetch((url) => {
      if (url.endsWith('/repos/viejo/app')) {
        return new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/42' } });
      }
      if (url.endsWith('/repositories/42')) return json({ ...repoJson, full_name: 'acme/nuevo' });
      return texto(SHA);
    });
    const m = await leerMeta({ repo_full_name: 'viejo/app' }, { fetch, githubToken: TOKEN });
    expect(m.full_name).toBe('acme/nuevo');
    expect(llamadas.map((l) => l.url)).toEqual(['https://api.github.com/repos/viejo/app',
      'https://api.github.com/repositories/42', 'https://api.github.com/repos/acme/nuevo/commits/main']);
  });

  it('no sigue redirecciones a otro host (el token no sale de GitHub)', async () => {
    const { fetch, llamadas } = dobleFetch(() =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/robar' } }));
    const e = await errorDe(leerMeta({ repo_full_name: 'acme/app' }, { fetch, githubToken: TOKEN }));
    expect(e.codigo).toBe('github_error');
    expect(llamadas).toHaveLength(1);
  });

  it('red caída → github_red', async () => {
    const fetch = (async () => { throw new TypeError(`fetch failed ${TOKEN}`); }) as Fetch;
    const e = await errorDe(leerMeta({ repo_full_name: 'acme/app' }, { fetch, githubToken: TOKEN }));
    expect(e.codigo).toBe('github_red');
    expect(e.message).not.toContain(TOKEN);
  });
});

const arbol = (tree: unknown[], truncated = false) => json({ sha: SHA, tree, truncated });
const SHA_SRC = 'c'.repeat(40);
const SHA_DOCS = 'd'.repeat(40);
const SHA_NM = 'e'.repeat(40);
const raizSuperficial = () => arbol([
  { path: 'README.md', type: 'blob', size: 10, sha: 'f'.repeat(40) },
  { path: 'docs', type: 'tree', sha: SHA_DOCS },
  { path: 'node_modules', type: 'tree', sha: SHA_NM },
  { path: 'src', type: 'tree', sha: SHA_SRC },
]);

describe('leerArbol', () => {
  it('árbol recursivo normal: 1 subpetición y solo blobs', async () => {
    const { fetch, llamadas } = dobleFetch(() => arbol([
      { path: 'README.md', type: 'blob', size: 10 }, { path: 'src', type: 'tree' },
      { path: 'src/a.ts', type: 'blob', size: 20 }, { path: 'vendor/sub', type: 'commit' }, { basura: true },
    ]));
    const r = await leerArbol(meta, { fetch });
    expect(r).toEqual({ entradas: [{ path: 'README.md', type: 'blob', size: 10 },
      { path: 'src/a.ts', type: 'blob', size: 20 }], truncado: false, subpeticiones: 1 });
    expect(llamadas[0]?.url).toBe(`https://api.github.com/repos/acme/app/git/trees/${SHA}?recursive=1`);
  });

  function dobleSuperficial(primera: () => Response) {
    return dobleFetch((url) => {
      if (url.endsWith(`/trees/${SHA}?recursive=1`)) return primera();
      if (url.endsWith(`/trees/${SHA}`)) return raizSuperficial();
      if (url.endsWith(`/trees/${SHA_SRC}?recursive=1`)) {
        return arbol([{ path: 'index.ts', type: 'blob', size: 5 }, { path: 'lib', type: 'tree' },
          { path: 'lib/a.ts', type: 'blob', size: 6 }]);
      }
      if (url.endsWith(`/trees/${SHA_DOCS}?recursive=1`)) return arbol([{ path: 'guia.md', type: 'blob', size: 7 }]);
      return json({ message: 'no esperada' }, 500);
    });
  }
  const esperadas = ['README.md', 'src/index.ts', 'src/lib/a.ts', 'docs/guia.md'];

  it('si GitHub trunca, usa el árbol superficial: carpetas de código primero y sin node_modules', async () => {
    const { fetch, llamadas } = dobleSuperficial(() => arbol([{ path: 'x.ts', type: 'blob' }], true));
    const r = await leerArbol(meta, { fetch });
    expect(r.truncado).toBe(true);
    expect(r.entradas.map((e) => e.path)).toEqual(esperadas);
    expect(llamadas.some((l) => l.url.includes(SHA_NM))).toBe(false);
    expect(r.subpeticiones).toBe(4);
  });

  it('si el cuerpo pasa del tope no lo parsea (aquí ni siquiera es JSON válido)', async () => {
    const { fetch } = dobleSuperficial(() => texto(`{"tree":[${'x'.repeat(5_000)}`));
    const r = await leerArbol(meta, { fetch }, { maxBytes: 2_000 });
    expect(r.truncado).toBe(true);
    expect(r.entradas.map((e) => e.path)).toEqual(esperadas);
  });

  it('respeta content-length sin leer el cuerpo', async () => {
    const { fetch } = dobleSuperficial(() => texto('{roto', 200, { 'content-length': '99999999' }));
    const r = await leerArbol(meta, { fetch });
    expect(r.truncado).toBe(true);
    expect(r.entradas).toHaveLength(4);
  });

  it('pide como mucho 20 carpetas de primer nivel', async () => {
    const carpetas = Array.from({ length: 25 }, (_, i) => ({ path: `m${i}`, type: 'tree', sha: String(i % 10).repeat(40) }));
    const { fetch, llamadas } = dobleFetch((url, n) => {
      if (n === 1) return arbol([], true);
      if (n === 2) return arbol(carpetas);
      return arbol([{ path: 'a.ts', type: 'blob', size: 1 }]);
    });
    const r = await leerArbol(meta, { fetch });
    expect(llamadas).toHaveLength(22);
    expect(r.subpeticiones).toBeLessThanOrEqual(MAX_SUBPETICIONES_ARBOL);
    expect(r.entradas).toHaveLength(20);
    expect(r.entradas[0]?.path).toBe('m0/a.ts');
  });

  it('una carpeta que no cabe en el presupuesto se lee solo en su primer nivel', async () => {
    const { fetch, llamadas } = dobleFetch((url, n) => {
      if (n === 1) return arbol([], true);
      if (url.endsWith(`/trees/${SHA}`)) return arbol([{ path: 'src', type: 'tree', sha: SHA_SRC }]);
      if (url.endsWith(`/trees/${SHA_SRC}?recursive=1`)) return texto(`{"tree":[${'y'.repeat(10_000)}`);
      if (url.endsWith(`/trees/${SHA_SRC}`)) return arbol([{ path: 'main.ts', type: 'blob', size: 3 }]);
      return json({}, 500);
    });
    const r = await leerArbol(meta, { fetch }, { maxBytes: 3_000 });
    expect(r.entradas.map((e) => e.path)).toEqual(['src/main.ts']);
    expect(llamadas).toHaveLength(4);
  });

  it('errores: 404 → repo_no_encontrado, 409 → repo_vacio, 403 en una carpeta → limite_github', async () => {
    expect((await errorDe(leerArbol(meta, dobleFetch(() => json({}, 404))))).codigo).toBe('repo_no_encontrado');
    expect((await errorDe(leerArbol(meta, dobleFetch(() => json({}, 409))))).codigo).toBe('repo_vacio');
    const { fetch } = dobleFetch((url, n) => (n === 1 ? arbol([], true) : n === 2 ? raizSuperficial() : json({}, 403)));
    expect((await errorDe(leerArbol(meta, { fetch }))).codigo).toBe('limite_github');
  });

  it('rechaza metadatos con commit inválido sin tocar la red', async () => {
    const { fetch, llamadas } = dobleFetch(() => arbol([]));
    expect((await errorDe(leerArbol({ ...meta, commit_sha: 'main' }, { fetch }))).codigo).toBe('respuesta_invalida');
    expect(llamadas).toHaveLength(0);
  });
});

describe('leerArchivos', () => {
  const lim = { maxBytesArchivo: 100 };

  it('descarga del commit exacto con la ruta codificada y el token', async () => {
    const { fetch, llamadas } = dobleFetch(() => texto('hola ñ'));
    const deps: Deps = { fetch, githubToken: TOKEN };
    const r = await leerArchivos(meta, ['docs/mi archivo#1.md'], deps, lim);
    expect(r).toEqual([{ path: 'docs/mi archivo#1.md', contenido: 'hola ñ', bytes: 7 }]);
    expect(llamadas[0]?.url).toBe(`https://raw.githubusercontent.com/acme/app/${SHA}/docs/mi%20archivo%231.md`);
    expect(cab(llamadas[0]!)).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'vanguard-deepwiki' });
  });

  it('omite grandes, binarios, vacíos, inexistentes, redirigidos y rutas inseguras; conserva el orden', async () => {
    const { fetch, llamadas } = dobleFetch((url) => {
      if (url.endsWith('/grande-cl.ts')) return texto('x', 200, { 'content-length': '5000' });
      if (url.endsWith('/grande.ts')) return texto('x'.repeat(101));
      if (url.endsWith('/binario.dat')) return new Response(new Uint8Array([1, 0, 2]));
      if (url.endsWith('/vacio.ts')) return texto('');
      if (url.endsWith('/no-existe.ts')) return texto('404: Not Found', 404);
      if (url.endsWith('/lfs.bin.ts')) return new Response(null, { status: 302, headers: { location: 'https://media.githubusercontent.com/x' } });
      return texto(`contenido de ${url.slice(url.lastIndexOf('/') + 1)}`);
    });
    const paths = ['src/b.ts', 'src/grande-cl.ts', 'src/grande.ts', 'src/binario.dat', 'src/vacio.ts', 'src/no-existe.ts',
      'src/lfs.bin.ts', '../fuera.ts', 'a//b.ts', 'src/a.ts', 'src/b.ts'];
    const r = await leerArchivos(meta, paths, { fetch }, lim);
    expect(r.map((a) => a.path)).toEqual(['src/b.ts', 'src/a.ts']);
    expect(r[0]?.contenido).toBe('contenido de b.ts');
    expect(llamadas).toHaveLength(8); // sin duplicados ni rutas inseguras; la redirección no se sigue
    expect(llamadas.some((l) => l.url.includes('media.githubusercontent.com'))).toBe(false);
  });

  it('no pasa de 5 descargas a la vez', async () => {
    let enVuelo = 0;
    let maximo = 0;
    const fetch = (async () => {
      enVuelo++; maximo = Math.max(maximo, enVuelo);
      await new Promise((ok) => setTimeout(ok, 5));
      enVuelo--;
      return texto('ok');
    }) as Fetch;
    const paths = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const r = await leerArchivos(meta, paths, { fetch }, lim);
    expect(r.map((a) => a.path)).toEqual(paths);
    expect(maximo).toBe(5);
  });

  it('límite de GitHub (429/403) corta todo con limite_github; un fallo de red suelto solo omite el archivo', async () => {
    const limite = dobleFetch(() => texto('', 429));
    const e = await errorDe(leerArchivos(meta, Array.from({ length: 12 }, (_, i) => `f${i}.ts`), limite, lim));
    expect(e.codigo).toBe('limite_github');
    expect(limite.llamadas.length).toBeLessThanOrEqual(5);

    const fetch = (async (u: RequestInfo | URL) => {
      if (String(u).endsWith('/cae.ts')) throw new TypeError('fetch failed');
      return texto('ok');
    }) as Fetch;
    const r = await leerArchivos(meta, ['cae.ts', 'sigue.ts'], { fetch }, lim);
    expect(r.map((a) => a.path)).toEqual(['sigue.ts']);
  });

  it('el límite de GitHub trae cuándo reintentar (retry-after o x-ratelimit-reset), acotado a 1 hora', async () => {
    const ahora = new Date('2026-10-24T18:00:00.000Z');
    const conRetry = dobleFetch(() => texto('', 429, { 'retry-after': '42' }));
    expect((await errorDe(leerArchivos(meta, ['a.ts'], conRetry, lim))).reintentarEnS).toBe(42);
    const reset = String(ahora.getTime() / 1000 + 600);
    const conReset = dobleFetch(() => texto('', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }));
    expect((await errorDe(leerArchivos(meta, ['a.ts'], { ...conReset, ahora: () => ahora }, lim))).reintentarEnS).toBe(600);
    expect(esperaDe(new Headers({ 'retry-after': '999999' }), ahora.getTime())).toBe(3600);
    expect(esperaDe(new Headers({}), ahora.getTime())).toBeNull();
    const sinDato = dobleFetch(() => texto('', 403));
    expect((await errorDe(leerArchivos(meta, ['a.ts'], sinDato, lim))).reintentarEnS).toBeNull();
  });
});

describe('leerArchivosDetalle: fallas momentáneas', () => {
  const lim = { maxBytesArchivo: 100 };
  const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];

  it('reintenta una vez los 5xx y los fallos de red dentro de lo que sobra; un 404 no', async () => {
    const vistas = new Map<string, number>();
    const fetch = (async (u: RequestInfo | URL) => {
      const nombre = String(u).slice(String(u).lastIndexOf('/') + 1);
      const n = (vistas.get(nombre) ?? 0) + 1;
      vistas.set(nombre, n);
      if (nombre === 'a.ts' && n === 1) return texto('caído', 503);
      if (nombre === 'b.ts' && n === 1) throw new TypeError('fetch failed');
      if (nombre === 'c.ts') return texto('no está', 404);
      return texto(`ok ${nombre}`);
    }) as Fetch;
    const r = await leerArchivosDetalle(meta, paths, { fetch }, lim, { reintentos: 5 });
    expect(r.archivos.map((a) => a.path)).toEqual(['a.ts', 'b.ts', 'd.ts']);
    expect(r.fallidos).toBe(0);
    expect(vistas.get('c.ts')).toBe(1);
  });

  it('si falla más de la mitad (o todo) por algo momentáneo, lanza github_red para que la cola reintente el paso', async () => {
    const caido = dobleFetch((url) => (url.endsWith('/d.ts') ? texto('ok') : texto('', 502)));
    const e = await errorDe(leerArchivosDetalle(meta, paths, caido, lim, { reintentos: 1 }));
    expect(e.codigo).toBe('github_red');
    expect(caido.llamadas).toHaveLength(4 + 1);   // una vuelta y un solo reintento (lo que sobraba)

    const todoCaido = dobleFetch(() => texto('', 500));
    expect((await errorDe(leerArchivosDetalle(meta, ['a.ts'], todoCaido, lim))).codigo).toBe('github_red');
  });

  it('una falla suelta se cuenta en `fallidos` para avisar', async () => {
    const uno = dobleFetch((url) => (url.endsWith('/a.ts') ? texto('', 500) : texto('ok')));
    const r = await leerArchivosDetalle(meta, paths, uno, lim, { reintentos: 0 });
    expect(r).toMatchObject({ fallidos: 1 });
    expect(r.archivos).toHaveLength(3);
  });

  it('no parsea árboles de más de ~450 KB (unas 2.000 entradas)', () => {
    expect(MAX_BYTES_ARBOL).toBeLessThanOrEqual(450_000);
  });
});
