// Cliente minimo de la Messages API de Anthropic. La clave solo se lee de process.env y nunca se imprime.
import { MODELS, ROUTE } from './models.mjs';

export async function ask({ task, system, user, maxTokens = 4000 }) {
  const tier = ROUTE[task];
  if (!tier) throw new Error(`Tarea sin ruta de modelo: ${task}`);
  const model = MODELS[tier];
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY (ponla en deepwiki/.env, ver .env.example)');
  let res;
  for (let i = 0; i < 3; i++) {
    res = await fetch('https://api.anthropic.com/v1/messages', {
    signal: AbortSignal.timeout(120_000),
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (![429, 500, 529].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
  if (!res.ok) {
    // Solo tipo/mensaje del error; jamas cabeceras ni la clave.
    const body = await res.json().catch(() => ({}));
    throw new Error(`Anthropic ${res.status}: ${body?.error?.message ?? 'error desconocido'}`);
  }
  const data = await res.json();
  if (data.stop_reason === 'max_tokens') console.warn('Aviso: respuesta cortada por limite de tokens.');
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}
