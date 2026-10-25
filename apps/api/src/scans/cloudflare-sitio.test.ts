import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clasificarSitio, probarCloudflareSitio } from './cloudflare-sitio.ts';

const CUENTA = 'c'.repeat(32);
const TOKEN = ['token', 'cuenta', 'cloudflare', 'de', 'prueba'].join('-');
let rutas: Record<string, () => Response>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  rutas = { [`/accounts?per_page=5`]: () => new Response(JSON.stringify({ result: [{ id: CUENTA }] })) };
  fetchMock = vi.fn(async (u: unknown) => {
    const p = String(u).replace('https://api.cloudflare.com/client/v4', '');
    return (rutas[p] ?? (() => new Response('{}', { status: 404 })))();
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('clasificarSitio', () => {
  it('Pages, alias de rama, Workers y dominio propio; normaliza a https://host sin ruta ni query', () => {
    expect(clasificarSitio('https://Mi-App.pages.dev/precios?x=1')).toEqual({ site_url: 'https://mi-app.pages.dev',
      host: 'mi-app.pages.dev', kind: 'pages', project: 'mi-app' });
    expect(clasificarSitio('https://dev.mi-app.pages.dev')).toMatchObject({ kind: 'pages', project: 'mi-app' });
    expect(clasificarSitio('https://api.acme.workers.dev/v1')).toEqual({ site_url: 'https://api.acme.workers.dev',
      host: 'api.acme.workers.dev', kind: 'workers', project: 'api' });
    expect(clasificarSitio('https://tienda.acme.com')).toEqual({ site_url: 'https://tienda.acme.com', host: 'tienda.acme.com',
      kind: 'custom', project: null });
  });
  it('rechaza http, IPs, localhost, puerto, credenciales, los dominios de VanGUARD y formas que no son de Pages/Workers', () => {
    for (const u of ['http://mi-app.pages.dev', 'https://203.0.113.7', 'https://localhost', 'https://x.localhost',
      'https://mi-app.pages.dev:8443', 'https://a:b@mi-app.pages.dev', 'https://officialvanguard.com',
      'https://demo.officialvanguard.com', 'https://pages.dev', 'https://a.b.c.pages.dev', 'https://acme.workers.dev',
      'no es una url', 'https://intranet']) {
      expect('error' in clasificarSitio(u), u).toBe(true);
    }
  });
});

describe('probarCloudflareSitio', () => {
  const pages = clasificarSitio('https://mi-app.pages.dev') as Exclude<ReturnType<typeof clasificarSitio>, { error: string }>;
  it('sin token: activa solo con HTTP, sin llamar a Cloudflare; meta de modo url', async () => {
    const s = await probarCloudflareSitio(null, pages);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s).toMatchObject({ estado: 'ok', label: 'Cloudflare · mi-app.pages.dev', capabilities: { site_http: true, config_read: false },
      meta: { mode: 'url', site_url: 'https://mi-app.pages.dev', site_kind: 'pages', project: 'mi-app', account_id: null, config_read: false } });
  });
  it('con token que ve el proyecto de Pages: config_read y la cuenta', async () => {
    rutas[`/accounts/${CUENTA}/pages/projects/mi-app`] = () => new Response(JSON.stringify({ result: { name: 'mi-app' } }));
    const s = await probarCloudflareSitio(TOKEN, pages);
    expect(s).toMatchObject({ estado: 'ok', meta: { account_id: CUENTA, config_read: true }, capabilities: { config_read: true } });
    expect(new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });
  it('con token que no ve el proyecto: activa solo con HTTP y lo dice; 401 → rechazado (no se guarda)', async () => {
    const s = await probarCloudflareSitio(TOKEN, pages);
    expect(s).toMatchObject({ estado: 'ok', meta: { config_read: false, account_id: CUENTA } });
    expect(s.mensaje).toContain('El token no ve ese proyecto');
    rutas['/accounts?per_page=5'] = () => new Response('{}', { status: 401 });
    expect(await probarCloudflareSitio(TOKEN, pages)).toMatchObject({ estado: 'rechazado', motivo: 'unauthorized' });
  });
  it('dominio propio: lo busca en los dominios de Pages y de Workers de la cuenta', async () => {
    const propio = clasificarSitio('https://tienda.acme.com') as typeof pages;
    rutas[`/accounts/${CUENTA}/pages/projects?per_page=50`] = () => new Response(JSON.stringify({ result: [{ name: 'otra', domains: [] }] }));
    rutas[`/accounts/${CUENTA}/workers/domains`] = () => new Response(JSON.stringify({ result: [{ hostname: 'tienda.acme.com', service: 'tienda' }] }));
    rutas[`/accounts/${CUENTA}/workers/scripts/tienda/settings`] = () => new Response(JSON.stringify({ result: {} }));
    const s = await probarCloudflareSitio(TOKEN, propio);
    expect(s.meta).toMatchObject({ site_kind: 'custom', project: 'tienda', project_kind: 'workers', config_read: true });
  });
});
