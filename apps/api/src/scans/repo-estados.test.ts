import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { leerRama, probarEstadosGithub, sondeoEscrituraPr, sondeoNegativoEstados } from './repo.ts';

// Token de acciones de GitHub (bloqueo de merge, asignaciones/bloqueo-merge-criticos.md §2.8 y §4.1; anexo de cierre de
// PR): lecturas y sondeos sin efecto, con fetch simulado por método y ruta.
type Fetch = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let f: Mock<Fetch>;
let porRuta: Record<string, () => Response>;
const TOKEN = ['prueba', 'z'.repeat(24)].join('_');   // armado en tiempo de ejecución: ningún literal con forma de secreto
const GH = 'https://api.github.com/repos/acme/tienda';

beforeEach(() => {
  porRuta = {};
  f = vi.fn<Fetch>(async (url, init) => {
    const r = porRuta[`${init?.method ?? 'GET'} ${String(url)}`];
    if (!r) throw Object.assign(new Error('plazo'), { name: 'TimeoutError' });
    return r();
  });
  vi.stubGlobal('fetch', f);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const llamadas = () => f.mock.calls.map(([u, i]) => `${i?.method ?? 'GET'} ${String(u)}`);

describe('probarEstadosGithub (E9)', () => {
  it('200 → ok con un solo check statuses:read, sin capacidades (no pisa las de E53); la rama va codificada', async () => {
    porRuta[`GET ${GH}/commits/release%2Fv1/status`] = () => Response.json({ state: 'pending' });
    const s = await probarEstadosGithub(TOKEN, 'acme/tienda', 'release/v1');
    expect(s).toMatchObject({ estado: 'ok', checks: [{ permission: 'statuses:read', ok: true, required: true }], capabilities: {} });
  });
  it('401 → rechazado unauthorized; 403 o 404 → rechazado; 5xx, 403 con límite o plazo → caido; repo raro → sin red', async () => {
    const con = async (r: () => Response) => {
      porRuta[`GET ${GH}/commits/main/status`] = r;
      return probarEstadosGithub(TOKEN, 'acme/tienda', 'main');
    };
    expect(await con(() => new Response('{}', { status: 401 }))).toMatchObject({ estado: 'rechazado', motivo: 'unauthorized' });
    expect(await con(() => new Response('{}', { status: 404 }))).toMatchObject({ estado: 'rechazado', faltan: ['statuses:read'] });
    expect((await con(() => new Response('{}', { status: 403 }))).estado).toBe('rechazado');
    expect((await con(() => new Response('{}', { status: 503 }))).estado).toBe('caido');
    expect((await con(() => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))).estado).toBe('caido');
    delete porRuta[`GET ${GH}/commits/main/status`];
    expect((await probarEstadosGithub(TOKEN, 'acme/tienda', 'main')).estado).toBe('caido');
    f.mockClear();
    expect((await probarEstadosGithub(TOKEN, 'acme/..', 'main')).estado).toBe('rechazado');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('leerRama', () => {
  it('head de la rama (40 hex); 404 → sin_rama; 401/403 → token; 5xx, plazo o cuerpo raro → caido', async () => {
    const sha = 'c'.repeat(40);
    porRuta[`GET ${GH}/branches/main`] = () => Response.json({ name: 'main', commit: { sha } });
    expect(await leerRama(TOKEN, 'acme/tienda', 'main')).toEqual({ tipo: 'ok', sha });
    const casos: [() => Response, string][] = [[() => new Response('', { status: 404 }), 'sin_rama'],
      [() => new Response('', { status: 401 }), 'token'], [() => new Response('', { status: 403 }), 'token'],
      [() => new Response('', { status: 502 }), 'caido'], [() => Response.json({ commit: { sha: 'HEAD' } }), 'caido'],
      [() => new Response('no json'), 'caido']];
    for (const [r, tipo] of casos) {
      porRuta[`GET ${GH}/branches/main`] = r;
      expect((await leerRama(TOKEN, 'acme/tienda', 'main')).tipo).toBe(tipo);
    }
  });
});

describe('sondeoNegativoEstados', () => {
  it('repo público: solo GET /keys; 200 → sobra administration', async () => {
    porRuta[`GET ${GH}/keys`] = () => Response.json([]);
    expect(await sondeoNegativoEstados(TOKEN, 'acme/tienda', 'main', false)).toEqual({ sobra: ['administration'], caido: false });
    expect(llamadas()).toEqual([`GET ${GH}/keys`]);
  });
  it('repo privado: también GET /branches; 403/404 → nada sobra; 200 → contents; 403 con límite → caido', async () => {
    porRuta[`GET ${GH}/keys`] = () => new Response('{}', { status: 403 });
    porRuta[`GET ${GH}/branches/main`] = () => new Response('{}', { status: 404 });
    expect(await sondeoNegativoEstados(TOKEN, 'acme/tienda', 'main', true)).toEqual({ sobra: [], caido: false });
    porRuta[`GET ${GH}/branches/main`] = () => Response.json({});
    expect(await sondeoNegativoEstados(TOKEN, 'acme/tienda', 'main', true)).toEqual({ sobra: ['contents'], caido: false });
    porRuta[`GET ${GH}/keys`] = () => new Response('{}', { status: 403, headers: { 'retry-after': '60' } });
    expect((await sondeoNegativoEstados(TOKEN, 'acme/tienda', 'main', true)).caido).toBe(true);
  });
});

describe('sondeoEscrituraPr', () => {
  it('POST vacío a /pulls y /issues: 422 = tiene el permiso (no crea nada); 403/404/410 = no; 5xx = caido', async () => {
    porRuta[`POST ${GH}/pulls`] = () => new Response('{}', { status: 422 });
    porRuta[`POST ${GH}/issues`] = () => new Response('{}', { status: 410 });
    expect(await sondeoEscrituraPr(TOKEN, 'acme/tienda')).toEqual({ pull_requests: true, issues: false, caido: false });
    expect(f.mock.calls.map(([, i]) => i?.body)).toEqual(['{}', '{}']);
    porRuta[`POST ${GH}/pulls`] = () => new Response('{}', { status: 403 });
    porRuta[`POST ${GH}/issues`] = () => new Response('{}', { status: 422 });
    expect(await sondeoEscrituraPr(TOKEN, 'acme/tienda')).toEqual({ pull_requests: false, issues: true, caido: false });
    porRuta[`POST ${GH}/issues`] = () => new Response('{}', { status: 502 });
    expect((await sondeoEscrituraPr(TOKEN, 'acme/tienda')).caido).toBe(true);
  });
});
