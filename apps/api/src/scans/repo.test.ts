import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ProviderError } from '../lib/http.ts';
import { LIM_REPO, MAX_ARBOL, SALTOS_MAX, arbolRepo, codigoGithub, elegirArchivosRiesgo, leerAcotado, leerContenidos, lockfilesDe,
  rutasEnv, type EntradaArbol } from './repo.ts';

// Paso repo sin red: fetch simulado por ruta de la API de GitHub (§09.4).
type Fetch = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let f: Mock<Fetch>;
const TOKEN = ['prueba', 'z'.repeat(24)].join('_');   // armado en tiempo de ejecución: ningún literal con forma de secreto
const e = (path: string, size = 100): EntradaArbol => ({ path, size });
const falla = async (p: Promise<unknown>) => { try { await p; } catch (x) { return x as ProviderError; } throw new Error('no lanzó'); };
const flujo = (trozos: Uint8Array[]) => new ReadableStream<Uint8Array>({
  pull(c) { const t = trozos.shift(); if (t) c.enqueue(t); else c.close(); },
});
const bytes = (n: number, ch = 'a') => new TextEncoder().encode(ch.repeat(n));

// contents/<ruta> → respuesta; lo que no está en el mapa responde su propia ruta.
const contenidos = (mapa: Record<string, () => Response | Promise<Response>>) => async (url: RequestInfo | URL) => {
  const u = new URL(String(url));
  const path = decodeURIComponent(u.pathname.replace(/^\/repos\/o\/r\/contents\//, ''));
  return mapa[path]?.() ?? new Response(`contenido de ${path}`);
};

beforeEach(() => {
  f = vi.fn<Fetch>(async () => new Response('{}'));
  vi.stubGlobal('fetch', f);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('elegirArchivosRiesgo · orden de lockfiles (hallazgo 23)', () => {
  it('en un monorepo el lockfile y el package.json de la raíz entran antes que los manifiestos anidados', () => {
    // Orden de git ls-tree de este mismo repo: los package.json de apps/ y packages/ van antes de pnpm-lock.yaml.
    const arbol = ['apps/api/package.json', 'apps/web/package.json', 'package.json', 'packages/contracts/package.json',
      'packages/core/package.json', 'packages/deepwiki/package.json', 'pnpm-lock.yaml'].map((p) => e(p));
    const elegidos = elegirArchivosRiesgo(arbol);
    expect(elegidos.slice(0, 2)).toEqual(['pnpm-lock.yaml', 'package.json']);
    expect(elegidos.filter((p) => p.endsWith('package.json') || p.endsWith('.yaml'))).toHaveLength(LIM_REPO.lockfiles);
  });

  it('los lockfiles anidados van antes que los manifiestos sueltos y su manifiesto hermano antes que el resto', () => {
    const arbol = ['a/package.json', 'b/package.json', 'c/package.json', 'd/package.json', 'e/package.json', 'f/package.json',
      'package-lock.json', 'package.json', 'panel-legacy/composer.json', 'panel-legacy/composer.lock'].map((p) => e(p));
    expect(elegirArchivosRiesgo(arbol).slice(0, LIM_REPO.lockfiles)).toEqual(['package-lock.json', 'package.json',
      'panel-legacy/composer.lock', 'panel-legacy/composer.json', 'a/package.json', 'b/package.json']);
  });

  it('nunca más de 20 archivos ni más de 3 MB, y nada de node_modules ni binarios', () => {
    const arbol = [e('node_modules/x/package-lock.json'), e('logo.png'), e('.gitignore'),
      ...Array.from({ length: 40 }, (_, i) => e(`src/auth${i}.ts`, 200_000))];
    const elegidos = elegirArchivosRiesgo(arbol);
    expect(elegidos).not.toContain('node_modules/x/package-lock.json');
    expect(elegidos).not.toContain('logo.png');
    expect(elegidos.length).toBeLessThanOrEqual(LIM_REPO.archivos);
    expect(elegidos.length).toBe(1 + 14);   // .gitignore + 14 × 200 KB ≤ 3 MB
  });

  it('los lockfiles dejan sitio al .gitignore: con 3 lockfiles de ~1 MB el .gitignore entra igual (revisión de 4/5/8)', () => {
    const arbol = [e('.gitignore', 40), e('apps/a/package-lock.json', 999_990), e('composer.lock', 999_990),
      e('package-lock.json', 999_990), e('src/config.ts', 100)];
    const elegidos = elegirArchivosRiesgo(arbol);
    expect(elegidos).toContain('.gitignore');
    expect(elegidos).not.toContain('apps/a/package-lock.json');   // no cabe: el paso lo cuenta como lockfile sin leer
    const lleno = [e('.gitignore', 40), ...Array.from({ length: 25 }, (_, i) => e(`p${i}/package-lock.json`, 10))];
    expect(elegirArchivosRiesgo(lleno, { ...LIM_REPO, lockfiles: 25 })).toHaveLength(LIM_REPO.archivos);
    expect(elegirArchivosRiesgo(lleno, { ...LIM_REPO, lockfiles: 25 })).toContain('.gitignore');
  });
});

describe('rutas del árbol', () => {
  it('rutasEnv pasa a reglasEnv solo .gitignore y .env* (hallazgo 22)', () => {
    const arbol = [e('src/a.ts'), e('.gitignore'), e('api/.env'), e('.env.example'), e('docs/x.md'), e('sub/.gitignore')];
    expect(rutasEnv(arbol)).toEqual(['.gitignore', 'api/.env', '.env.example']);
  });

  it('lockfilesDe separa los que sabemos leer de pnpm/yarn y deja fuera node_modules', () => {
    const arbol = [e('package-lock.json'), e('web/yarn.lock'), e('pnpm-lock.yaml'), e('legacy/composer.lock'),
      e('node_modules/a/package-lock.json'), e('package.json')];
    expect(lockfilesDe(arbol)).toEqual({ legibles: ['package-lock.json', 'legacy/composer.lock'], otros: ['web/yarn.lock', 'pnpm-lock.yaml'] });
  });

  it('codigoGithub: 403 con el límite agotado o retry-after es rate_limited; 403 a secas, forbidden', () => {
    expect(codigoGithub(new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))).toBe('rate_limited');
    expect(codigoGithub(new Response(null, { status: 403, headers: { 'retry-after': '60' } }))).toBe('rate_limited');
    expect(codigoGithub(new Response(null, { status: 403 }))).toBe('forbidden');
    expect(codigoGithub(new Response(null, { status: 502 }))).toBe('unavailable');
  });
});

describe('leerAcotado (hallazgo 18)', () => {
  it('sin Content-Length corta exactamente en el tope y cancela el resto', async () => {
    const cancel = vi.fn();
    const trozos = [bytes(400), bytes(400), bytes(400), bytes(400)];
    const cuerpo = new ReadableStream<Uint8Array>({ pull(c) { const t = trozos.shift(); if (t) c.enqueue(t); else c.close(); }, cancel });
    const r = await leerAcotado(new Response(cuerpo), 1000);
    expect(r.cortado).toBe(true);
    expect(r.texto).toHaveLength(1000);
    expect(cancel).toHaveBeenCalled();
  });

  it('con Content-Length mayor que el tope no lee el cuerpo', async () => {
    const pull = vi.fn();
    const cuerpo = new ReadableStream<Uint8Array>({ pull });
    const r = await leerAcotado(new Response(cuerpo, { headers: { 'content-length': '90000000' } }), 1000);
    expect(r).toEqual({ texto: '', cortado: true });
  });

  it('justo en el tope no cuenta como cortado; la bolsa compartida descuenta lo leído', async () => {
    const bolsa = { restante: 1500 };
    expect(await leerAcotado(new Response(flujo([bytes(500), bytes(500)])), 1000, bolsa)).toEqual({ texto: 'a'.repeat(1000), cortado: false });
    expect(bolsa.restante).toBe(500);
    const r = await leerAcotado(new Response(flujo([bytes(800)])), 1000, bolsa);
    expect(r.cortado).toBe(true);
    expect(r.texto).toHaveLength(500);
    expect(bolsa.restante).toBe(0);
  });

  it('un corte de red a mitad del cuerpo es ProviderError transitorio', async () => {
    let n = 0;
    const cuerpo = new ReadableStream<Uint8Array>({ pull(c) { if (n++) c.error(new TypeError('reset')); else c.enqueue(bytes(10)); } });
    expect((await falla(leerAcotado(new Response(cuerpo), 1000))).code).toBe('unavailable');
  });
});

describe('leerContenidos (hallazgos 4, 5, 8 y 18)', () => {
  const rutas = ['package-lock.json', '.gitignore', 'src/lib/supabaseAdmin.ts'];

  it.each([
    ['502', () => new Response('x', { status: 502 }), 'unavailable'],
    ['429', () => new Response('x', { status: 429 }), 'rate_limited'],
    ['403 con el límite agotado', () => new Response('x', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), 'rate_limited'],
    ['401', () => new Response('x', { status: 401 }), 'unauthorized'],
    ['red caída', () => { throw new TypeError('fetch failed'); }, 'unavailable'],
    ['plazo vencido', () => { throw new DOMException('plazo', 'TimeoutError'); }, 'timeout'],
  ])('%s en un archivo → lanza ProviderError (el mensaje vuelve a la cola), nunca lo omite', async (_n, resp, code) => {
    f.mockImplementation(contenidos({ '.gitignore': resp }));
    const x = await falla(leerContenidos(TOKEN, 'o/r', 'abc', rutas));
    expect(x).toBeInstanceOf(ProviderError);
    expect(x.code).toBe(code);
  });

  it('un 404 de un archivo se omite y queda en incompletos; el resto se lee en el orden pedido', async () => {
    f.mockImplementation(contenidos({ '.gitignore': () => new Response('no', { status: 404 }) }));
    const r = await leerContenidos(TOKEN, 'o/r', 'abc', rutas);
    expect(r.incompletos).toEqual(['.gitignore']);
    expect(r.archivos.map((a) => a.path)).toEqual(['package-lock.json', 'src/lib/supabaseAdmin.ts']);
    expect(String(f.mock.calls[0]?.[0])).toContain('/contents/package-lock.json?ref=abc');
  });

  it('un archivo vacío leído entero (200 sin cuerpo o cuerpo vacío) va en archivos con content vacío, no se pierde (ronda 1)', async () => {
    f.mockImplementation(contenidos({ '.gitignore': () => new Response(''), 'package-lock.json': () => new Response(null) }));
    const r = await leerContenidos(TOKEN, 'o/r', 'abc', rutas);
    expect(r.incompletos).toEqual([]);
    expect(r.archivos).toEqual([{ path: 'package-lock.json', content: '' }, { path: '.gitignore', content: '' },
      { path: 'src/lib/supabaseAdmin.ts', content: 'contenido de src/lib/supabaseAdmin.ts' }]);
    expect(f).toHaveBeenCalledTimes(rutas.length);   // 1 subpetición por ruta (presupuesto del paso)
  });

  it('corta cada archivo en bytesArchivo y el total en bytesTotal (enlace simbólico o Content-Length ausente)', async () => {
    const lim = { ...LIM_REPO, bytesArchivo: 1000, bytesTotal: 1500 };
    f.mockImplementation(contenidos({
      'package-lock.json': () => new Response(flujo([bytes(700), bytes(700)])),   // 1400 B sin Content-Length
      '.gitignore': () => new Response(flujo([bytes(100, 'b')])),
      'src/lib/supabaseAdmin.ts': () => new Response(flujo([bytes(900, 'c')])),
    }));
    const r = await leerContenidos(TOKEN, 'o/r', 'abc', rutas, lim);
    // Se leen en paralelo: el reparto exacto depende del orden de llegada, los topes no.
    expect(r.archivos.every((a) => a.content.length <= lim.bytesArchivo)).toBe(true);
    expect(r.archivos.reduce((s, a) => s + a.content.length, 0)).toBe(lim.bytesTotal);
    expect(r.incompletos).toContain('package-lock.json');
    const solo = await leerContenidos(TOKEN, 'o/r', 'abc', ['package-lock.json'], lim);
    expect(solo.archivos[0]?.content).toHaveLength(1000);
    expect(solo.incompletos).toEqual(['package-lock.json']);
  });
});

describe('arbolRepo (hallazgos 18 y 22)', () => {
  const base = (arbol: (u: URL) => Response) => async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    if (u.pathname === '/repos/o/r') return Response.json({ default_branch: 'main' });
    if (u.pathname === '/repos/o/r/commits') return Response.json([{ sha: 'abc' }]);
    return arbol(u);
  };
  const raiz = { tree: [{ path: 'package-lock.json', type: 'blob', mode: '100644', size: 10 }, { path: 'src', type: 'tree' }] };

  it('un árbol de más de 2 MB (Content-Length) no se parsea: solo la raíz y truncado', async () => {
    f.mockImplementation(base((u) => u.searchParams.has('recursive')
      ? new Response('{"tree":[', { headers: { 'content-length': String(MAX_ARBOL + 1) } })
      : Response.json(raiz)));
    const r = await arbolRepo(TOKEN, 'o/r');
    expect(r).toEqual({ sha: 'abc', rama: 'main', arbol: [{ path: 'package-lock.json', size: 10 }], truncado: true, vacio: false,
      repo: 'o/r', subpeticiones: 4 });
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('un árbol de más de 2 MB sin Content-Length se corta al leerlo, sin JSON.parse', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    f.mockImplementation(base((u) => u.searchParams.has('recursive')
      ? new Response(flujo(Array.from({ length: 5 }, () => bytes(500_000, ' '))))
      : Response.json(raiz)));
    const r = await arbolRepo(TOKEN, 'o/r');
    expect(r.truncado).toBe(true);
    expect(parse.mock.calls.every(([t]) => String(t).length < MAX_ARBOL)).toBe(true);
  });

  it('descarta enlaces simbólicos y respeta truncated de GitHub', async () => {
    f.mockImplementation(base(() => Response.json({ truncated: true, tree: [
      { path: '.env', type: 'blob', mode: '120000', size: 18 },
      { path: 'src/a.ts', type: 'blob', mode: '100644', size: 50 },
      { path: 'sub', type: 'commit', mode: '160000' },
    ] })));
    expect(await arbolRepo(TOKEN, 'o/r')).toEqual({ sha: 'abc', rama: 'main', arbol: [{ path: 'src/a.ts', size: 50 }], truncado: true,
      vacio: false, repo: 'o/r', subpeticiones: 3 });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('un cuerpo cortado a mitad (repo o árbol) o un árbol que no es JSON es ProviderError transitorio, no un TypeError', async () => {
    const cortado = () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('{"default_')); c.error(new TypeError('Network connection lost.')); },
    }));
    f.mockImplementation(async () => cortado());
    expect((await falla(arbolRepo(TOKEN, 'o/r'))).code).toBe('unavailable');
    f.mockImplementation(base(() => cortado()));
    expect((await falla(arbolRepo(TOKEN, 'o/r'))).code).toBe('unavailable');
    f.mockImplementation(base(() => new Response('<html>no</html>')));
    expect((await falla(arbolRepo(TOKEN, 'o/r'))).code).toBe('unavailable');
  });

  it('el límite de GitHub en el árbol es rate_limited (transitorio)', async () => {
    f.mockImplementation(base(() => new Response('x', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })));
    expect((await falla(arbolRepo(TOKEN, 'o/r'))).code).toBe('rate_limited');
  });

  // Revisión de la ronda 2: con el nombre viejo GitHub da 301 en cada llamada (46 fetch en vez de 23 con 20 archivos).
  it('repo renombrado: solo /repos/<viejo> paga el 301; commits, árbol y contenidos van con el full_name canónico', async () => {
    const arbol = { tree: [{ path: '.gitignore', type: 'blob', size: 10 },
      ...Array.from({ length: 30 }, (_, i) => ({ path: `src/auth${i}.ts`, type: 'blob', size: 100 }))] };
    f.mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.pathname.startsWith('/repos/viejo/nombre')) {
        return new Response(null, { status: 301, headers: { location: u.pathname.replace('/repos/viejo/nombre', '/repositories/123') + u.search } });
      }
      if (u.pathname === '/repositories/123') return Response.json({ default_branch: 'main', full_name: 'nuevo/nombre' });
      if (u.pathname === '/repos/nuevo/nombre/commits') return Response.json([{ sha: 'abc' }]);
      if (u.pathname === '/repos/nuevo/nombre/git/trees/abc') return Response.json(arbol);
      if (u.pathname.startsWith('/repos/nuevo/nombre/contents/')) return new Response('hola');
      return new Response('x', { status: 404 });
    });
    const a = await arbolRepo(TOKEN, 'viejo/nombre');
    expect(a).toMatchObject({ sha: 'abc', repo: 'nuevo/nombre', truncado: false, vacio: false });
    expect(f).toHaveBeenCalledTimes(4);   // 301 + info + commits + árbol
    expect(a.subpeticiones).toBe(3 + SALTOS_MAX);   // los saltos, por lo alto: nunca por debajo del gasto real
    const rutas = elegirArchivosRiesgo(a.arbol);
    const l = await leerContenidos(TOKEN, a.repo, a.sha, rutas);
    expect(rutas).toHaveLength(LIM_REPO.archivos);
    expect(l.incompletos).toEqual([]);
    expect(f).toHaveBeenCalledTimes(4 + rutas.length);   // ningún contents paga otro salto
  });

  it('full_name igual salvo mayúsculas, ausente o con forma rara: se queda el nombre de la conexión, sin saltos', async () => {
    for (const full_name of ['O/R', undefined, '../x', 'o/..', 'o/r?x=1', 'o/r/contents']) {
      f.mockImplementation(base(() => Response.json({ tree: [] })));
      f.mockImplementationOnce(async () => Response.json({ default_branch: 'main', full_name }));
      const r = await arbolRepo(TOKEN, 'o/r');
      expect(r).toMatchObject({ repo: 'o/r', subpeticiones: 3 });
      expect(String(f.mock.calls.at(-1)?.[0])).toContain('/repos/o/r/git/trees/abc');
    }
  });

  it('repo vacío (409 en /commits): árbol vacío y vacio, no un fallo; un [] sin 409 sigue siendo not_found', async () => {
    f.mockImplementation(async (url) => (new URL(String(url)).pathname.endsWith('/commits')
      ? Response.json({ message: 'Git Repository is empty.' }, { status: 409 }) : Response.json({ default_branch: 'main' })));
    expect(await arbolRepo(TOKEN, 'o/r')).toEqual({ sha: '', rama: 'main', arbol: [], truncado: false, vacio: true, repo: 'o/r',
      subpeticiones: 2 });
    expect(f).toHaveBeenCalledTimes(2);
    f.mockImplementation(async (url) => (new URL(String(url)).pathname.endsWith('/commits')
      ? Response.json([]) : Response.json({ default_branch: 'main' })));
    expect((await falla(arbolRepo(TOKEN, 'o/r'))).code).toBe('not_found');
  });
});
