import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { crearApp } from './worker.ts';
import { PERF_VERSION } from './perf-version.ts';

const ctx = { waitUntil: (p: Promise<unknown>) => { void p; } };
const pedir = (ruta: string, init?: RequestInit, v: 'v1-sana' | 'v2-regresion' = 'v1-sana') =>
  Promise.resolve(crearApp(v).fetch(new Request(`https://demo.prueba${ruta}`, init), {}, ctx));

describe('rutas', () => {
  it('/ responde 200 en HTML con x-vg-victima', async () => {
    const r = await pedir('/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('x-vg-victima')).toBe('1');
  });

  it('/login muestra el formulario y todo POST falla con 401', async () => {
    expect((await pedir('/login')).status).toBe(200);
    const r = await pedir('/login', { method: 'POST', body: 'usuario=a&clave=b' });
    expect(r.status).toBe(401);
    expect(await r.text()).toContain('incorrectos');
  });

  it('/api/productos devuelve la lista en JSON', async () => {
    const r = await pedir('/api/productos');
    expect(r.status).toBe(200);
    const lista = await r.json() as { id: number; nombre: string }[];
    expect(lista.length).toBeGreaterThan(0);
    expect(lista[0]).toHaveProperty('nombre');
  });

  it('/admin responde 200 SIN sesión (falla simulada de CF_ADMIN_EXPOSED)', async () => {
    for (const ruta of ['/admin', '/admin/']) {
      const r = await pedir(ruta);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('Falla simulada');
    }
  });

  it('rutas desconocidas y sondeos dan 404 marcado; métodos raros, 405', async () => {
    for (const ruta of ['/.env', '/.git/config', '/wp-login.php', '/backup-01']) {
      const r = await pedir(ruta);
      expect(r.status).toBe(404);
      expect(r.headers.get('x-vg-victima')).toBe('1');
    }
    const r = await pedir('/', { method: 'DELETE' });
    expect(r.status).toBe(405);
    expect(r.headers.get('x-vg-victima')).toBe('1');
  });
});

describe('versiones de Rendimiento (S10 10.11)', () => {
  it('v1-sana: imagen dimensionada y prioritaria, JS diferido, sin recursos bloqueantes', async () => {
    const h = await (await pedir('/', undefined, 'v1-sana')).text();
    expect(h).toContain('<img class="hero" src="/img/hero-1200.webp" width="1200" height="600" fetchpriority="high"');
    expect(h).toContain('<script src="/js/app.js" defer>');
    expect(h).not.toContain('tema-pesado.css');
    expect(h).not.toContain('polyfills-legacy.js');
  });

  it('v2-regresion: CSS y polyfills bloqueantes, imagen perezosa sin medidas y widget pesado', async () => {
    const h = await (await pedir('/', undefined, 'v2-regresion')).text();
    const head = h.slice(0, h.indexOf('</head>'));
    expect(head).toContain('<link rel="stylesheet" href="/css/tema-pesado.css">');
    expect(head).toContain('<script src="/js/polyfills-legacy.js"></script>');
    expect(h).toMatch(/<img class="hero" src="\/img\/hero-original\.jpg" loading="lazy"(?![^>]*width)[^>]*>/);
    expect(h).toContain('<script src="/js/widget-pesado.js">');
  });

  it('la versión desplegada es una de las dos y la lee la regex de perf-medir/perf-hook', async () => {
    expect(['v1-sana', 'v2-regresion']).toContain(PERF_VERSION);
    const { readFileSync } = await import('node:fs');
    const fuente = readFileSync(new URL('./perf-version.ts', import.meta.url), 'utf8');
    expect(fuente.match(/PERF_VERSION\s*=\s*'([\w.-]+)'/)?.[1]).toBe(PERF_VERSION);
  });
});

describe('Worker completo (default export)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('/admin entra a la ingesta con status 200 y auth false', async () => {
    vi.useFakeTimers();
    const cuerpos: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { cuerpos.push(init.body as string); return new Response(null, { status: 202 }); }));
    const pendientes: Promise<unknown>[] = [];
    const env = { VG_INGEST_URL: 'http://ingest.prueba/ingest/v1/events', VG_INGEST_CONN_ID: '00000000-0000-4000-a000-0000000000c1',
      VG_INGEST_SECRET: 'vg' + 'i_' + 'y'.repeat(43) };
    const r = await worker.fetch(new Request('https://demo.prueba/admin', { headers: { 'cf-connecting-ip': '198.51.100.4' } }),
      env, { waitUntil: (p) => { pendientes.push(p); } });
    expect(r.status).toBe(200);
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(pendientes);
    const evs = cuerpos.flatMap((c) => (JSON.parse(c) as { events: { path: string; status: number; auth: boolean }[] }).events);
    expect(evs).toContainEqual(expect.objectContaining({ path: '/admin', status: 200, auth: false }));
  });
});
