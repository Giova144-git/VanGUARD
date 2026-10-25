import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const g = vi.hoisted(() => ({ guardar: vi.fn(), detalle: vi.fn() }));
vi.mock('./comun.ts', () => ({ guardarHallazgos: g.guardar }));
vi.mock('./cobertura.ts', () => ({ escribirDetalleModulo: g.detalle }));
vi.mock('../lib/db.ts', () => ({ db: () => ({}) }));
const { pasoCloudflareSitio, UA_VANGUARD } = await import('./cloudflare-sitio-paso.ts');

const HOST = 'mi-app.pages.dev';
const M = { v: 1, kind: 'scan', scan_run_id: 's1', org_id: 'o1', paso: 'cloudflare' } as const;
const CONN = { id: 'c1', meta: { mode: 'url', site_url: `https://${HOST}`, site_kind: 'pages', project: 'mi-app', account_id: null, config_read: false } };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  g.guardar.mockReset().mockImplementation(async (_e: unknown, _m: unknown, _mod: unknown, _c: unknown, b: unknown[]) => ({ n: b.length, descartadas: 0 }));
  g.detalle.mockReset().mockResolvedValue(undefined);
  fetchMock = vi.fn(async (u: unknown) => {
    const url = String(u);
    if (url === `http://${HOST}/`) return new Response(null, { status: 301, headers: { location: `https://${HOST}/` } });
    if (url === `https://${HOST}/`) return new Response('<!doctype html>', { status: 200 });
    if (url === `https://${HOST}/.env`) return new Response('API_KEY=valor\n', { status: 200 });
    return new Response('no', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('pasoCloudflareSitio sin token', () => {
  it('solo pide al host de la conexión, con el UA de VanGUARD y sin seguir redirecciones; guarda las reglas HTTP', async () => {
    const r = await pasoCloudflareSitio({} as CloudflareBindings, M, CONN);
    expect(r).toEqual({ status: 'done', findings: 5 });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => new URL(u).hostname === HOST)).toBe(true);
    expect(urls).toHaveLength(7);
    for (const c of fetchMock.mock.calls) {
      const init = c[1] as RequestInit;
      expect(init.redirect).toBe('manual');
      expect(new Headers(init.headers).get('user-agent')).toBe(UA_VANGUARD);
    }
    const reglas = (g.guardar.mock.calls[0]![4] as { rule_id: string }[]).map((b) => b.rule_id);
    expect(reglas).toEqual(['CF_SITE_HSTS', 'CF_SITE_CSP', 'CF_SITE_FRAME', 'CF_SITE_NOSNIFF', 'CF_SITE_EXPOSED']);
    expect(g.detalle).toHaveBeenCalledWith(expect.anything(), M, 'cloudflare', { modo: 'url', miradas: { sitio_http: true, configuracion: false } });
  });
  it('sitio caído: failed y nada mirado (nunca un verde)', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('red'); });
    expect(await pasoCloudflareSitio({} as CloudflareBindings, M, CONN)).toEqual({ status: 'failed', error_code: 'unavailable' });
    expect(g.guardar).not.toHaveBeenCalled();
    expect(g.detalle).toHaveBeenCalledWith(expect.anything(), M, 'cloudflare', { modo: 'url', miradas: { sitio_http: false, configuracion: false } });
  });
});
