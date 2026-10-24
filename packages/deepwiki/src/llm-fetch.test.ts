import { describe, expect, it, vi } from 'vitest';
import { crearLlmFetch, modeloPara, MODELOS_POR_DEFECTO, URL_MESSAGES } from './llm-fetch.ts';
import type { Fetch } from './tipos.ts';

const CLAVE = 'sk-ant-api03-PRUEBA-NO-REAL-abcdefghijklmnop';
type Llamada = { url: string; init: RequestInit };

function respuestaOk(extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    model: 'claude-haiku-5-5', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hola ' }, { type: 'text', text: 'mundo' }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
    ...extra,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
function error(status: number, mensaje: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'x_error', message: mensaje } }), { status, headers });
}
function fetchDoble(respuestas: (Response | Error)[]) {
  const llamadas: Llamada[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init: init ?? {} });
    const r = respuestas.shift();
    if (!r) throw new Error('sin más respuestas');
    if (r instanceof Error) throw r;
    return r;
  });
  return { f: f as unknown as Fetch, llamadas };
}
const PET = { tarea: 'wiki_area' as const, system: 'SYS', user: 'USER', maxTokens: 600 };
const sinEspera = { dormir: async () => {}, avisar: () => {} };
// Espera que la promesa falle y devuelve el Error (si no falla, la prueba cae).
async function fallo(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { if (e instanceof Error) return e; throw e; }
  throw new Error('se esperaba un error');
}

describe('crearLlmFetch', () => {
  it('arma la petición correcta y NO envía parámetros de muestreo', async () => {
    const { f, llamadas } = fetchDoble([respuestaOk()]);
    const llm = crearLlmFetch({ apiKey: CLAVE, fetch: f, ...sinEspera });
    const r = await llm(PET);
    expect(llamadas).toHaveLength(1);
    const { url, init } = llamadas[0]!;
    expect(url).toBe(URL_MESSAGES);
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe(CLAVE);
    expect(h['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    for (const k of ['temperature', 'top_p', 'top_k', 'tool_choice', 'output_config', 'thinking']) expect(body).not.toHaveProperty(k);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(600);
    expect(body.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(body.messages).toEqual([{ role: 'user', content: 'USER' }]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(r.texto).toBe('Hola mundo');
    expect(r.uso).toEqual({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 });
    expect(r.stop_reason).toBe('end_turn');
  });

  it('enruta cada tarea a su modelo', async () => {
    expect(modeloPara('wiki_triage', MODELOS_POR_DEFECTO)).toBe('claude-haiku-5-5');
    expect(modeloPara('wiki_area', MODELOS_POR_DEFECTO)).toBe('claude-haiku-5-5');
    expect(modeloPara('wiki_sintesis', MODELOS_POR_DEFECTO)).toBe('claude-sonnet-5-5');
    expect(() => modeloPara('otra' as never, MODELOS_POR_DEFECTO)).toThrow(/sin ruta/);
    const { f, llamadas } = fetchDoble([respuestaOk({ model: undefined })]);
    const llm = crearLlmFetch({ apiKey: CLAVE, fetch: f, modelos: { smart: 'claude-sonnet-x' }, ...sinEspera });
    const r = await llm({ ...PET, tarea: 'wiki_sintesis' });
    expect(JSON.parse(String(llamadas[0]!.init.body)).model).toBe('claude-sonnet-x');
    expect(r.modelo).toBe('claude-sonnet-x');
  });

  it('reintenta 429, 500 y 529 con backoff y luego responde', async () => {
    const { f, llamadas } = fetchDoble([error(529, 'sobrecargado'), error(429, 'lento', { 'retry-after': '7' }), respuestaOk()]);
    const esperas: number[] = [];
    const llm = crearLlmFetch({ apiKey: CLAVE, fetch: f, dormir: async (ms) => { esperas.push(ms); }, avisar: () => {} });
    const r = await llm(PET);
    expect(llamadas).toHaveLength(3);
    expect(esperas).toEqual([2000, 7000]);
    expect(r.texto).toBe('Hola mundo');
  });

  it('reintenta también 502, 503 y 504 (proxies y el borde)', async () => {
    for (const status of [502, 503, 504]) {
      const { f, llamadas } = fetchDoble([error(status, 'borde'), respuestaOk()]);
      const r = await crearLlmFetch({ apiKey: CLAVE, fetch: f, ...sinEspera })(PET);
      expect(llamadas, String(status)).toHaveLength(2);
      expect(r.texto).toBe('Hola mundo');
    }
  });

  it('se rinde tras 3 intentos y el error no lleva la clave ni cabeceras', async () => {
    const { f, llamadas } = fetchDoble([error(500, 'a'), error(500, 'b'), error(500, `falló con ${CLAVE} x-api-key`)]);
    const llm = crearLlmFetch({ apiKey: CLAVE, fetch: f, ...sinEspera });
    const e = await fallo(llm(PET));
    expect(llamadas).toHaveLength(3);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toMatch(/^Anthropic 500 x_error:/);
    expect(e.message).not.toContain(CLAVE);
    expect(e.message).not.toContain('sk-ant-');
    expect(e.message).not.toContain('anthropic-version');
  });

  it('no reintenta un 400 y no filtra la clave', async () => {
    const { f, llamadas } = fetchDoble([error(400, `temperature no permitido; clave ${CLAVE}`)]);
    const llm = crearLlmFetch({ apiKey: CLAVE, fetch: f, ...sinEspera });
    const e = await fallo(llm(PET));
    expect(llamadas).toHaveLength(1);
    expect(e.message).toContain('Anthropic 400');
    expect(e.message).not.toContain(CLAVE);
  });

  it('reintenta fallos de red, pero no un timeout', async () => {
    const red = fetchDoble([new TypeError('fetch failed'), respuestaOk()]);
    expect((await crearLlmFetch({ apiKey: CLAVE, fetch: red.f, ...sinEspera })(PET)).texto).toBe('Hola mundo');
    const t = new Error('tiempo'); t.name = 'TimeoutError';
    const lento = fetchDoble([t, respuestaOk()]);
    const e = await fallo(crearLlmFetch({ apiKey: CLAVE, fetch: lento.f, timeoutMs: 120_000, ...sinEspera })(PET));
    expect(e.message).toContain('sin respuesta en 120 s');
    expect(lento.llamadas).toHaveLength(1);
  });

  it('avisa si la respuesta se cortó por max_tokens, sin la clave', async () => {
    const avisos: string[] = [];
    const { f } = fetchDoble([respuestaOk({ stop_reason: 'max_tokens' })]);
    const r = await crearLlmFetch({ apiKey: CLAVE, fetch: f, dormir: async () => {}, avisar: (m) => avisos.push(m) })(PET);
    expect(r.stop_reason).toBe('max_tokens');
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('max_tokens');
    expect(avisos[0]).not.toContain(CLAVE);
  });

  it('envía effort solo si se pide para esa tarea', async () => {
    const { f, llamadas } = fetchDoble([respuestaOk(), respuestaOk()]);
    const llm = crearLlmFetch({ apiKey: CLAVE, fetch: f, esfuerzo: { wiki_area: 'low' }, ...sinEspera });
    await llm(PET);
    await llm({ ...PET, tarea: 'wiki_sintesis' });
    expect(JSON.parse(String(llamadas[0]!.init.body)).output_config).toEqual({ effort: 'low' });
    expect(JSON.parse(String(llamadas[1]!.init.body))).not.toHaveProperty('output_config');
  });

  it('exige la clave al crearse', () => {
    expect(() => crearLlmFetch({ apiKey: '', fetch: fetchDoble([]).f })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
