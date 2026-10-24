import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../lib/http.ts';
import { envDoble } from '../test/dobles.ts';
import {
  aDestino, codigoMeta, cuerpoInteractivo, cuerpoTexto, enmascararTelefono, enviarKapso, enviarTexto, idMensaje, KAPSO_BASE,
  KapsoError,
} from './kapso.ts';

// Valores falsos armados en tiempo de ejecución: ningún literal con forma de secreto queda en el repo.
const CLAVE = ['clave', 'kapso', 'de', 'prueba'].join('-');
const NUMERO = '1234567890';
const TEL = '+584141234567';
const env = (extra: Partial<CloudflareBindings> = {}) =>
  envDoble({ KAPSO_API_KEY: CLAVE, KAPSO_PHONE_NUMBER_ID: NUMERO, ...extra }).env;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.HBgM1' }] })));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('cuerpos (funciones puras)', () => {
  it('texto simple: to sin "+", forma de Meta y recorte a 4096', () => {
    expect(cuerpoTexto(TEL, ' Hola ')).toEqual({ messaging_product: 'whatsapp', to: '584141234567', type: 'text', text: { body: 'Hola' } });
    expect(cuerpoTexto(TEL, 'x'.repeat(5000)).text.body).toHaveLength(4096);
    expect(() => cuerpoTexto(TEL, '   ')).toThrow(RangeError);
  });

  it('interactivo con header, body, footer y botones exactamente como S15 15.10', () => {
    const m = cuerpoInteractivo(TEL, {
      header: 'ALERTA CRÍTICA · Cloudflare', body: 'Una IP hizo 1820 peticiones en 60 s.', footer: 'Incidente #A1F3C9 · VanGUARD',
      botones: [{ id: 'ack:A1F3C9:Zx9kQm2Lp0Ab7Yt4cD3eFg', title: 'Lo estoy viendo' }, { id: 'snz:A1F3C9:Lp0Ab7Yt4cD3eFgZx9kQm', title: 'Silenciar 1 h' }],
    });
    expect(m).toEqual({
      messaging_product: 'whatsapp', to: '584141234567', type: 'interactive',
      interactive: {
        type: 'button', header: { type: 'text', text: 'ALERTA CRÍTICA · Cloudflare' }, body: { text: 'Una IP hizo 1820 peticiones en 60 s.' },
        footer: { text: 'Incidente #A1F3C9 · VanGUARD' },
        action: { buttons: [
          { type: 'reply', reply: { id: 'ack:A1F3C9:Zx9kQm2Lp0Ab7Yt4cD3eFg', title: 'Lo estoy viendo' } },
          { type: 'reply', reply: { id: 'snz:A1F3C9:Lp0Ab7Yt4cD3eFgZx9kQm', title: 'Silenciar 1 h' } },
        ] },
      },
    });
  });

  it('sin header ni footer no los manda; body > 1024 se recorta', () => {
    const m = cuerpoInteractivo(TEL, { body: 'y'.repeat(2000), botones: [{ id: 'a', title: 'Sí' }] });
    expect(m.interactive).not.toHaveProperty('header');
    expect(m.interactive).not.toHaveProperty('footer');
    expect(m.interactive.body.text).toHaveLength(1024);
  });

  it('límites de Meta: 1–3 botones, ids únicos, title ≤ 20, id ≤ 256; teléfono no E.164 → lanza', () => {
    const b = (id: string, title = 'Ok') => ({ id, title });
    expect(() => cuerpoInteractivo(TEL, { body: 'x', botones: [] })).toThrow('KAPSO_BOTONES');
    expect(() => cuerpoInteractivo(TEL, { body: 'x', botones: [b('1'), b('2'), b('3'), b('4')] })).toThrow('KAPSO_BOTONES');
    expect(() => cuerpoInteractivo(TEL, { body: 'x', botones: [b('1'), b('1')] })).toThrow('KAPSO_BOTON_REPETIDO');
    expect(() => cuerpoInteractivo(TEL, { body: 'x', botones: [b('1', 'x'.repeat(21))] })).toThrow('KAPSO_TITULO_BOTON');
    expect(() => cuerpoInteractivo(TEL, { body: 'x', botones: [b('i'.repeat(257))] })).toThrow('KAPSO_ID_BOTON');
    expect(() => aDestino('584141234567')).toThrow('KAPSO_DESTINO');
    expect(() => aDestino('+0123456789')).toThrow('KAPSO_DESTINO');
  });

  it('enmascara como +58•••4567 (check de notifications.recipient_masked)', () => {
    expect(enmascararTelefono(TEL)).toBe('+58•••4567');
    expect(enmascararTelefono('584141234567')).toBe('+58•••4567');
    expect(enmascararTelefono(TEL)).toMatch(/^\+[0-9]{2}•+[0-9]{4}$/);
  });

  it('idMensaje y codigoMeta solo leen messages[0].id y error.code', () => {
    expect(idMensaje('{"messages":[{"id":"wamid.HBgM=="}]}')).toBe('wamid.HBgM==');
    expect(idMensaje('{"messages":[]}')).toBeNull();
    expect(idMensaje('{"messages":[{"id":"<script>"}]}')).toBeNull();
    expect(idMensaje('no json')).toBeNull();
    expect(codigoMeta('{"error":{"message":"Re-engagement message","code":131047}}')).toBe('131047');
    expect(codigoMeta('{"error":"Active sandbox session required to send messages"}')).toBeNull();
    expect(codigoMeta('{"error":{"code":"x; DROP"}}')).toBeNull();
  });
});

describe('enviarKapso', () => {
  it('POST al proxy de Meta con X-API-Key y devuelve provider_id = messages[0].id', async () => {
    const r = await enviarTexto(env(), TEL, 'Hola');
    expect(r).toEqual({ provider_id: 'wamid.HBgM1' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${KAPSO_BASE}/${NUMERO}/messages`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe(CLAVE);
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(String(init.body))).toEqual({ messaging_product: 'whatsapp', to: '584141234567', type: 'text', text: { body: 'Hola' } });
  });

  it('sin KAPSO_API_KEY o con un phone_number_id raro → KapsoError sin_config y ni un fetch', async () => {
    for (const e of [env({ KAPSO_API_KEY: undefined }), env({ KAPSO_PHONE_NUMBER_ID: '../x' })]) {
      const err = await enviarTexto(e, TEL, 'Hola').catch((x: unknown) => x);
      expect(err).toBeInstanceOf(KapsoError);
      expect((err as KapsoError).detalle).toBe('sin_config');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('error de Meta → KapsoError (es ProviderError) con el código corto y sin el mensaje del proveedor', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }), { status: 400 }));
    const err = await enviarTexto(env(), TEL, 'Hola').catch((x: unknown) => x) as KapsoError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('invalid');
    expect(err.status).toBe(400);
    expect(err.detalle).toBe('131047');
    expect(err.message).not.toContain('Re-engagement');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('401 → unauthorized; 200 sin messages[0].id → invalid/sin_id', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect((await enviarTexto(env(), TEL, 'Hola').catch((x: unknown) => x) as KapsoError).code).toBe('unauthorized');
    fetchMock.mockResolvedValueOnce(new Response('{"messages":[]}', { status: 200 }));
    expect((await enviarTexto(env(), TEL, 'Hola').catch((x: unknown) => x) as KapsoError).detalle).toBe('sin_id');
  });

  it('un error de red sin respuesta se reintenta UNA vez; un plazo vencido no se repite', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('red'));
    expect(await enviarKapso(env(), cuerpoTexto(TEL, 'Hola'))).toEqual({ provider_id: 'wamid.HBgM1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockRejectedValue(new TypeError('red'));
    expect((await enviarTexto(env(), TEL, 'Hola').catch((x: unknown) => x) as KapsoError).code).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockRejectedValue(Object.assign(new Error('plazo'), { name: 'TimeoutError' }));
    expect((await enviarTexto(env(), TEL, 'Hola').catch((x: unknown) => x) as KapsoError).code).toBe('timeout');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('un 5xx no se reintenta (el mensaje podría salir doble)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
    expect((await enviarTexto(env(), TEL, 'Hola').catch((x: unknown) => x) as KapsoError).code).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
