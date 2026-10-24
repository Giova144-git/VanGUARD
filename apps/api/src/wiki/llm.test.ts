import { describe, expect, it, vi } from 'vitest';
import type { LlmPeticion } from '@vanguard/deepwiki';
import { ErrorLlmWiki, llmWiki, type LlamarTexto } from './llm.ts';

// Adaptador Deps.llm → ia/claude.ts (LEEME de deepwiki, punto 7). Sin red: la llamada a Claude es un doble.
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const env = { ANTHROPIC_API_KEY: 'clave-de-prueba' } as CloudflareBindings;
const MODELOS = { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' };
const USO = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
type Resultado = Awaited<ReturnType<LlamarTexto>>;

const pet = (tarea: LlmPeticion['tarea'], maxTokens = 1500): LlmPeticion =>
  ({ tarea, system: `sistema ${tarea}`, user: `<repo_paths>${tarea}</repo_paths>`, maxTokens });
function doble(r: Resultado | ((p: Parameters<LlamarTexto>[1]) => Resultado)) {
  return vi.fn(async (_e: CloudflareBindings, p: Parameters<LlamarTexto>[1]) => (typeof r === 'function' ? r(p) : r));
}

describe('llmWiki · ruta, modelo y max_tokens', () => {
  it('cada tarea va por su ruta de ai_usage con el modelo de modeloPara y el max_tokens del motor', async () => {
    const llamar = doble((p) => ({ ok: true, texto: `ok ${p.ruta}`, model: p.modelo, uso: USO, stop_reason: 'end_turn', cost_usd: 0.001 }));
    const llm = llmWiki(env, ORG, MODELOS, llamar as unknown as LlamarTexto);
    expect(await llm(pet('wiki_triage', 4000))).toEqual({ texto: 'ok wiki_triage', modelo: 'claude-haiku-5-5', uso: USO,
      stop_reason: 'end_turn' });
    await llm(pet('wiki_area', 1500));
    const r = await llm(pet('wiki_sintesis', 6000));
    expect(r.modelo).toBe('claude-sonnet-5-5');
    expect(llamar.mock.calls.map(([, p]) => [p.ruta, p.modelo, p.maxTokens])).toEqual([
      ['wiki_triage', 'claude-haiku-5-5', 4000], ['wiki_area', 'claude-haiku-5-5', 1500], ['wiki_sintesis', 'claude-sonnet-5-5', 6000]]);
    expect(llamar.mock.calls[0]?.[1]).toEqual({ org_id: ORG, ruta: 'wiki_triage', modelo: 'claude-haiku-5-5',
      sistema: 'sistema wiki_triage', usuario: '<repo_paths>wiki_triage</repo_paths>', maxTokens: 4000 });
  });

  it('los modelos de la corrida mandan; stop_reason max_tokens o refusal llega al motor tal cual', async () => {
    const llamar = doble((p) => ({ ok: true, texto: '', model: p.modelo, uso: USO, stop_reason: 'refusal', cost_usd: 0 }));
    const llm = llmWiki(env, ORG, { fast: 'claude-sonnet-5-5', smart: 'claude-opus-5-5' }, llamar as unknown as LlamarTexto);
    const r = await llm(pet('wiki_area'));
    expect(r).toMatchObject({ modelo: 'claude-sonnet-5-5', stop_reason: 'refusal', texto: '' });
  });

  it('sin stop_reason no se inventa uno', async () => {
    const llamar = doble({ ok: true, texto: 'x', model: 'claude-haiku-5-5', uso: USO, stop_reason: null, cost_usd: 0 });
    const r = await llmWiki(env, ORG, MODELOS, llamar as unknown as LlamarTexto)(pet('wiki_triage'));
    expect('stop_reason' in r).toBe(false);
  });

  it('una tarea sin ruta no llama a Claude', async () => {
    const llamar = doble({ ok: false, code: 'invalid' });
    const llm = llmWiki(env, ORG, MODELOS, llamar as unknown as LlamarTexto);
    await expect(llm({ ...pet('wiki_area'), tarea: 'otra' as LlmPeticion['tarea'] })).rejects.toMatchObject({ codigo: 'ia_invalida' });
    expect(llamar).not.toHaveBeenCalled();
  });
});

describe('llmWiki · fallos de claude.ts → ErrorLlmWiki', () => {
  const casos: [Resultado, string, boolean, number | null][] = [
    [{ ok: false, code: 'disabled' }, 'sin_llm', false, null],
    [{ ok: false, code: 'budget' }, 'ia_sin_presupuesto', false, null],
    [{ ok: false, code: 'budget', reintentar: true }, 'ia_ritmo', true, 60],
    [{ ok: false, code: 'timeout' }, 'ia_no_disponible', true, null],
    [{ ok: false, code: 'invalid' }, 'ia_invalida', false, null],
    [{ ok: false, code: 'refusal' }, 'ia_invalida', false, null],
  ];
  it.each(casos)('%j → %s (reintentable %s, espera %s)', async (r, codigo, reintentable, espera) => {
    const llm = llmWiki(env, ORG, MODELOS, doble(r) as unknown as LlamarTexto);
    const e = await llm(pet('wiki_area')).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorLlmWiki);
    expect(e).toMatchObject({ codigo, reintentable, esperaS: espera });
  });

  it('el mensaje es propio: nunca texto del proveedor', () => {
    for (const c of ['sin_llm', 'ia_sin_presupuesto', 'ia_ritmo', 'ia_no_disponible', 'ia_invalida'] as const) {
      const e = new ErrorLlmWiki(c);
      expect(e.message.length).toBeGreaterThan(10);
      expect(e.message).not.toMatch(/anthropic|credit|api key/i);
    }
  });
});
