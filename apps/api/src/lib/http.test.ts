import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ProviderError, pedir, sondear } from './http.ts';

// pedir() con fetch simulado: lista de salida (S06 06.3) y redirecciones a mano, sin red.
type Fetch = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let f: Mock<Fetch>;
let logs: string[];

// Token falso armado en tiempo de ejecución (ningún literal con forma de secreto en el repo).
const TOKEN = ['prueba', 'z'.repeat(24)].join('_');
const GH = 'https://api.github.com';
const AUTH = { headers: { Authorization: `Bearer ${TOKEN}` } };

const redir = (status: number, location: string, cuerpo: BodyInit | null = null) =>
  new Response(cuerpo, { status, headers: { location } });

const falla = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e; }
  throw new Error('no lanzó');
};

beforeEach(() => {
  f = vi.fn<Fetch>(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', f);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('pedir · lista de salida', () => {
  it('host ajeno → ProviderError invalid sin llamar a fetch y sin la URL en el log', async () => {
    const e = await falla(pedir(`https://evil.example/x?token=${TOKEN}`, AUTH, 1000));
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).code).toBe('invalid');
    expect(f).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('egress.bloqueado');
    expect(logs.join('\n')).not.toContain('evil.example');
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('http, sufijo, puerto o credenciales en la URL también se bloquean', async () => {
    for (const url of ['http://api.github.com/repos', 'https://api.github.com.evil.example/x',
      'https://api.github.com:8443/x', 'https://u:p@api.github.com/x', 'no es una url']) {
      expect(((await falla(pedir(url, {}, 1000))) as ProviderError).code).toBe('invalid');
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('host permitido: un fetch con redirect manual y la respuesta tal cual', async () => {
    const r = await pedir(`${GH}/repos/acme/web`, AUTH, 1000);
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toBe(`${GH}/repos/acme/web`);
    expect(f.mock.calls[0]![1]?.redirect).toBe('manual');
  });
});

describe('pedir · redirecciones', () => {
  it('302 a otro host → rechaza tras 1 fetch con redirect manual y cancela el cuerpo', async () => {
    let cancelado = false;
    const cuerpo = new ReadableStream({ cancel() { cancelado = true; } });
    f.mockResolvedValueOnce(redir(302, 'https://evil.example/robado', cuerpo));
    const e = await falla(pedir(`${GH}/repos/acme/web`, AUTH, 1000));
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).code).toBe('invalid');
    expect((e as ProviderError).status).toBe(302);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![1]?.redirect).toBe('manual');
    expect(cancelado).toBe(true);
    expect(logs.join('\n')).not.toContain('evil.example');
  });

  it('301 al mismo host (repo renombrado) se sigue con el mismo plazo y devuelve el 200', async () => {
    f.mockResolvedValueOnce(redir(301, `${GH}/repositories/123`));
    f.mockResolvedValueOnce(new Response('{"id":123}', { status: 200 }));
    const r = await pedir(`${GH}/repos/acme/viejo`, AUTH, 1000);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 123 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(String(f.mock.calls[1]![0])).toBe(`${GH}/repositories/123`);
    const [i1, i2] = [f.mock.calls[0]![1], f.mock.calls[1]![1]];
    expect(i2?.redirect).toBe('manual');
    expect(i2?.signal).toBe(i1?.signal);
    expect(i2?.headers).toEqual(AUTH.headers);
  });

  it('Location relativo resuelve contra el host actual', async () => {
    f.mockResolvedValueOnce(redir(307, '/repositories/9'));
    expect((await pedir(`${GH}/repos/acme/web`, {}, 1000)).status).toBe(200);
    expect(String(f.mock.calls[1]![0])).toBe(`${GH}/repositories/9`);
  });

  it('mismo host pero http → se bloquea con el status del 3xx', async () => {
    f.mockResolvedValueOnce(redir(301, 'http://api.github.com/repos/acme/web'));
    const e = (await falla(pedir(`${GH}/repos/acme/web`, {}, 1000))) as ProviderError;
    expect([e.code, e.status]).toEqual(['invalid', 301]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('sigue como mucho 3 saltos: el cuarto 3xx se rechaza (4 fetch)', async () => {
    f.mockImplementation(async () => redir(301, `${GH}/otra-vez`));
    const e = (await falla(pedir(`${GH}/repos/acme/web`, {}, 1000))) as ProviderError;
    expect(e.code).toBe('invalid');
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('3xx sin Location (304) se devuelve tal cual', async () => {
    f.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect((await pedir(`${GH}/repos/acme/web`, {}, 1000)).status).toBe(304);
  });

  it('sondear: un 302 a otro host da invalid, no el status', async () => {
    f.mockResolvedValueOnce(redir(302, 'https://evil.example/'));
    expect(await sondear(`${GH}/repos/acme/web`, AUTH, 1000)).toBe('invalid');
  });
});

describe('pedir · errores de red', () => {
  it('fallo de red → unavailable; TimeoutError → timeout', async () => {
    f.mockRejectedValueOnce(new TypeError('red'));
    expect(((await falla(pedir(`${GH}/x`, {}, 1000))) as ProviderError).code).toBe('unavailable');
    f.mockRejectedValueOnce(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    expect(((await falla(pedir(`${GH}/x`, {}, 1000))) as ProviderError).code).toBe('timeout');
  });
});
