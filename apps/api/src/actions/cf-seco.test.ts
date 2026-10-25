import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mutarEnSeco } from './cf-seco.ts';

// mutarEnSeco (modo-bajo-ataque.md §8 y §10): dry_run=true siempre en la URL, solo POST, result null = válida, y una
// escritura colada (2xx con un ruleset) se borra al instante por nuestro ref. Sin red: fetch simulado.
const TOKEN = ['tok', 'acciones', 'x'.repeat(20)].join('-');
const ZONA = '023e105f4ecef8ad9ca31a8372d0c353';
const RS = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
const REF = 'vg_ua_' + 'a'.repeat(32);
const REGLA = { ref: REF, expression: 'http.host eq "demo.officialvanguard.com"' };
const BASE = `https://api.cloudflare.com/client/v4/zones/${ZONA}`;

let fetchMock: ReturnType<typeof vi.fn>;
let logs: { mock: { calls: unknown[][] } };
const responde = (...rs: Response[]) => { for (const r of rs) fetchMock.mockImplementationOnce(async () => r); };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const llamadas = () => fetchMock.mock.calls.map((c) => ({ url: String(c[0]), method: (c[1] as RequestInit).method }));

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ success: true, result: null }));
  vi.stubGlobal('fetch', fetchMock);
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('mutarEnSeco', () => {
  it('POST con dry_run=true en la URL (añadir regla o crear el ruleset) y result null → valida', async () => {
    expect(await mutarEnSeco(TOKEN, ZONA, `/rulesets/${RS}/rules`, REGLA, REF)).toEqual({ tipo: 'valida' });
    expect(await mutarEnSeco(TOKEN, ZONA, '/rulesets', { rules: [REGLA] }, REF)).toEqual({ tipo: 'valida' });
    expect(llamadas()).toEqual([{ url: `${BASE}/rulesets/${RS}/rules?dry_run=true`, method: 'POST' },
      { url: `${BASE}/rulesets?dry_run=true`, method: 'POST' }]);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual(REGLA);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('200 con un ruleset que trae nuestro ref → DELETE de esa regla (sin dry_run) y escrita; log sin cuerpo ni token', async () => {
    responde(json({ success: true, result: { id: RS, rules: [{ id: 'c'.repeat(32), ref: 'del_cliente' }, { id: 'd'.repeat(32), ref: REF }] } }),
      new Response(null, { status: 200 }));
    expect(await mutarEnSeco(TOKEN, ZONA, `/rulesets/${RS}/rules`, REGLA, REF)).toEqual({ tipo: 'escrita', retirada: true });
    expect(llamadas()[1]).toEqual({ url: `${BASE}/rulesets/${RS}/rules/${'d'.repeat(32)}`, method: 'DELETE' });
    const linea = logs.mock.calls.map((c) => String(c[0])).join('\n');
    expect(linea).toContain('"bajo_ataque.dry_run_escribio"');
    expect(linea).toContain('"retirada":true');
    expect(linea).not.toContain(TOKEN);
    expect(linea).not.toContain('del_cliente');
  });

  it('escrita sin nuestro ref en la respuesta, o con el DELETE caído → retirada:false (nunca borra otra regla)', async () => {
    responde(json({ result: { id: RS, rules: [{ id: 'c'.repeat(32), ref: 'del_cliente' }] } }));
    expect(await mutarEnSeco(TOKEN, ZONA, `/rulesets/${RS}/rules`, REGLA, REF)).toEqual({ tipo: 'escrita', retirada: false });
    expect(llamadas()).toHaveLength(1);
    responde(json({ result: { id: RS, rules: [{ id: 'd'.repeat(32), ref: REF }] } }), new Response(null, { status: 503 }));
    expect(await mutarEnSeco(TOKEN, ZONA, `/rulesets/${RS}/rules`, REGLA, REF)).toEqual({ tipo: 'escrita', retirada: false });
  });

  it('403 → sin_permiso; 401 → token_invalido; 400 → rechazada con el código de Cloudflare', async () => {
    responde(json({ success: false }, 403), json({ success: false }, 401),
      json({ success: false, errors: [{ code: 20021, message: 'x' }] }, 400), json({ success: false }, 422));
    expect(await mutarEnSeco(TOKEN, ZONA, '/rulesets', {}, REF)).toEqual({ tipo: 'sin_permiso' });
    expect(await mutarEnSeco(TOKEN, ZONA, '/rulesets', {}, REF)).toEqual({ tipo: 'token_invalido' });
    expect(await mutarEnSeco(TOKEN, ZONA, '/rulesets', {}, REF)).toEqual({ tipo: 'rechazada', status: 400, codigo: 20021 });
    expect(await mutarEnSeco(TOKEN, ZONA, '/rulesets', {}, REF)).toEqual({ tipo: 'rechazada', status: 422, codigo: null });
  });

  it('5xx, 429, red, plazo o un 2xx sin result → sin_respuesta (nunca valida)', async () => {
    responde(json({}, 502), json({}, 429), json({ success: true }), new Response('no es json', { status: 200 }));
    fetchMock.mockImplementationOnce(async () => { throw new TypeError('network'); });
    fetchMock.mockImplementationOnce(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
    for (let i = 0; i < 6; i++) expect(await mutarEnSeco(TOKEN, ZONA, '/rulesets', {}, REF)).toEqual({ tipo: 'sin_respuesta' });
  });

  it('solo las dos rutas del modo bajo ataque y una zona de 32 hex: lo demás no sale', async () => {
    for (const [z, ruta] of [[ZONA, '/rulesets/x/../../settings'], [ZONA, '/settings/security_level'], ['zona', '/rulesets'],
      [ZONA, `/rulesets/${RS}/rules/${RS}`]]) {
      expect(await mutarEnSeco(TOKEN, z!, ruta!, {}, REF)).toMatchObject({ tipo: 'rechazada' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
