// Cliente mínimo de la Messages API para la CLI de desarrollo (en el Worker el LLM lo inyecta el BACK vía
// apps/api/src/ia/claude.ts). Portado de deepwiki/src/claude.mjs de Andrés (14c229a). Sin SDK: solo fetch.
// Nunca se envían temperature, top_p, top_k ni tool_choice forzado (400 desde 2026-10-21) y la clave jamás sale
// en errores ni avisos.
import type { WikiModelos } from '@vanguard/contracts';
import type { Fetch, Llm, LlmUso, Tarea } from './tipos.ts';

export const URL_MESSAGES = 'https://api.anthropic.com/v1/messages';
export const VERSION_API = '2023-06-01';
export const MODELOS_POR_DEFECTO: WikiModelos = { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' };
// Tarea -> nivel. Una tarea sin ruta no se llama (regla de RULES.md).
const NIVEL: Record<Tarea, keyof WikiModelos> = { wiki_triage: 'fast', wiki_area: 'fast', wiki_sintesis: 'smart' };
// 502/503/504 también: un proxy o el borde (Norton intercepta TLS en el equipo de desarrollo) los devuelve sueltos.
const REINTENTABLES = new Set([429, 500, 502, 503, 504, 529]);

export type Esfuerzo = 'low' | 'medium' | 'high';
export type OpcionesLlmFetch = {
  apiKey: string;
  fetch: Fetch;
  modelos?: Partial<WikiModelos>;
  intentos?: number;                 // 3 por defecto (el primero cuenta)
  esperaBaseMs?: number;             // backoff 2 s, 4 s…
  timeoutMs?: number;                // 120 s por llamada
  // Opcional: output_config.effort por tarea. Apagado por defecto porque los modelos viejos lo rechazan con 400.
  esfuerzo?: Partial<Record<Tarea, Esfuerzo>>;
  dormir?: (ms: number) => Promise<void>;
  avisar?: (mensaje: string) => void;
};

export function modeloPara(tarea: Tarea, modelos: WikiModelos): string {
  const nivel = NIVEL[tarea];
  if (!nivel) throw new Error(`Tarea sin ruta de modelo: ${String(tarea).slice(0, 40)}`);
  return modelos[nivel];
}

// Quita la clave (y cualquier cosa con forma de clave de Anthropic) de un texto que va a un error.
function limpiar(texto: string, apiKey: string): string {
  let t = texto.slice(0, 400);
  if (apiKey.length >= 8) t = t.split(apiKey).join('[REDACTADO]');
  return t.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTADO]').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);

export function crearLlmFetch(op: OpcionesLlmFetch): Llm {
  const apiKey = op.apiKey?.trim() ?? '';
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY (ponla en el .env de la raíz; nunca en el código).');
  const modelos: WikiModelos = { ...MODELOS_POR_DEFECTO, ...op.modelos };
  const intentos = Math.max(1, op.intentos ?? 3);
  const esperaBase = op.esperaBaseMs ?? 2000;
  const timeoutMs = op.timeoutMs ?? 120_000;
  const dormir = op.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const avisar = op.avisar ?? ((m: string) => console.warn(m));
  const f = op.fetch;

  return async (p) => {
    const modelo = modeloPara(p.tarea, modelos);
    const cuerpo: Record<string, unknown> = {
      model: modelo,
      max_tokens: p.maxTokens,
      // El system es estable entre llamadas del mismo paso: se marca para caché (si no llega al mínimo, no se cachea).
      system: [{ type: 'text', text: p.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: p.user }],
    };
    const esfuerzo = op.esfuerzo?.[p.tarea];
    if (esfuerzo) cuerpo.output_config = { effort: esfuerzo };
    const init = {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION_API, 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
    };

    let res: Response | undefined;
    for (let i = 0; i < intentos; i++) {
      const ultimo = i === intentos - 1;
      try {
        res = await f(URL_MESSAGES, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        const nombre = e instanceof Error ? e.name : '';
        // Un timeout ya esperó 120 s: reintentarlo triplica la espera. Solo se reintenta el fallo de red.
        if (nombre === 'TimeoutError' || nombre === 'AbortError') {
          throw new Error(`Anthropic: sin respuesta en ${Math.round(timeoutMs / 1000)} s (${p.tarea}).`);
        }
        if (ultimo) throw new Error(`Anthropic: fallo de red tras ${intentos} intentos (${p.tarea}).`);
        await dormir(esperaBase * 2 ** i);
        continue;
      }
      if (!REINTENTABLES.has(res.status) || ultimo) break;
      const retryAfter = Number(res.headers.get('retry-after'));
      try { await res.body?.cancel(); } catch { /* el cuerpo ya no importa */ }
      const espera = esperaBase * 2 ** i;
      await dormir(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(espera, Math.min(retryAfter * 1000, 60_000)) : espera);
    }
    if (!res) throw new Error(`Anthropic: sin respuesta (${p.tarea}).`);

    if (!res.ok) {
      // Solo estado, tipo y mensaje del error: jamás cabeceras ni la clave.
      let tipo = '', mensaje = 'error desconocido';
      try {
        const cuerpoError = JSON.parse((await res.text()).slice(0, 4000)) as { error?: { type?: unknown; message?: unknown } };
        if (typeof cuerpoError.error?.type === 'string') tipo = cuerpoError.error.type;
        if (typeof cuerpoError.error?.message === 'string') mensaje = cuerpoError.error.message;
      } catch { /* cuerpo no JSON */ }
      throw new Error(`Anthropic ${res.status}${tipo ? ` ${limpiar(tipo, apiKey)}` : ''}: ${limpiar(mensaje, apiKey)}`);
    }

    const data = (await res.json()) as { model?: unknown; content?: unknown; usage?: Record<string, unknown>;
      stop_reason?: unknown };
    const bloques = Array.isArray(data.content) ? data.content as { type?: unknown; text?: unknown }[] : [];
    // Solo bloques de texto: los de thinking (los 5.5 piensan por defecto) no forman parte de la respuesta.
    const texto = bloques.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('');
    const u = data.usage ?? {};
    const uso: LlmUso = { input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens),
      cache_read_input_tokens: num(u.cache_read_input_tokens), cache_creation_input_tokens: num(u.cache_creation_input_tokens) };
    const stop = typeof data.stop_reason === 'string' ? data.stop_reason : undefined;
    if (stop === 'max_tokens') avisar(`Aviso: la respuesta de ${p.tarea} se cortó al llegar a max_tokens (${p.maxTokens}).`);
    if (stop === 'refusal') avisar(`Aviso: el modelo rechazó la petición de ${p.tarea}; la respuesta puede venir vacía.`);
    return { texto, modelo: typeof data.model === 'string' ? data.model : modelo, uso, stop_reason: stop };
  };
}
