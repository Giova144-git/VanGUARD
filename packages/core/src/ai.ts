// IA (S11 11.12 literal): precios, peor caso, costo real y filtro de salida del modelo. Puro: sin red ni SDK.
import { checkFixPrompt, CANARIO } from './untrusted.ts';   // 06.4: API canónica; checkFixPrompt ya mira canario y secretos
export { CANARIO };                                          // el mismo literal va escrito en apps/api/src/ia/prompts/nucleo.ts
export type Modelo = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5' | 'claude-opus-4-8' | 'claude-sonnet-5';
type Precio = { in: number; w5: number; w1h: number; read: number; out: number };            // USD por MTok (11.2)
export const PRECIOS: Record<Modelo, Precio> = {
  'claude-opus-5-5':   { in: 4,   w5: 5,     w1h: 8,   read: 0.2,  out: 20 },
  'claude-sonnet-5-5': { in: 2,   w5: 2.5,   w1h: 4,   read: 0.1,  out: 10 },
  'claude-haiku-5-5':  { in: 0.1, w5: 0.125, w1h: 0.2, read: 0.01, out: 0.5 },               // tramo ≤ 100K (guarda a 90K)
  'claude-opus-4-8':   { in: 5,   w5: 6.25,  w1h: 10,  read: 0.5,  out: 25 },                // respaldo de Opus 5.5
  'claude-sonnet-5':   { in: 2,   w5: 2.5,   w1h: 4,   read: 0.2,  out: 10 },                // respaldo de Sonnet 5.5
};
const RESPALDO: Partial<Record<Modelo, Modelo>> = { 'claude-opus-5-5': 'claude-opus-4-8', 'claude-sonnet-5-5': 'claude-sonnet-5' };

/** Peor caso: toda la entrada sin caché + max_tokens de salida; con fallback se suman los dos intentos. */
export function peorCasoUSD(m: Modelo, entrada: number, maxTokens: number, fallback: boolean): number {
  const a = PRECIOS[m];
  const f = fallback && RESPALDO[m] ? PRECIOS[RESPALDO[m]!] : undefined;
  return Math.ceil(entrada * (a.in + (f?.in ?? 0)) + maxTokens * (a.out + (f?.out ?? 0))) / 1e6;   // tokens × USD/MTok = µUSD
}
export type Uso = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null; cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null };
// `model` admite null: el SDK 0.137.0 tipa así los elementos `type:'message'` de usage.iterations
export type UsoMensaje = Uso & { iterations?: Array<Uso & { model?: string | null; type?: string }> | null };
export function costoUSD(model: string, u: Uso, batch = false): number {
  const p = PRECIOS[model as Modelo] ?? PRECIOS['claude-opus-4-8'];        // modelo desconocido → la tarifa más cara de la tabla
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5 = (u.cache_creation_input_tokens ?? 0) - w1h;
  const c = ((u.input_tokens ?? 0) * p.in + w5 * p.w5 + w1h * p.w1h + (u.cache_read_input_tokens ?? 0) * p.read
           + (u.output_tokens ?? 0) * p.out) / 1e6;
  return Math.round((batch ? c / 2 : c) * 1e6) / 1e6;                      // Batch: −50 % que se acumula con la caché
}
/** Con fallback de servidor, usage.iterations trae un elemento por intento (forma exacta de cada elemento: [no verificado]).
 *  Si un elemento no trae `model`, se cobra con el del mensaje (el del respaldo, más caro): conservador. */
export function costoMensajeUSD(model: string, u: UsoMensaje): number {
  const its = u.iterations ?? [];
  return its.length > 1 ? its.reduce((s, it) => s + costoUSD(it.model ?? model, it), 0) : costoUSD(model, u);
}
/** Filtro determinista de la salida del modelo (11.11 capa 5). [] = limpia. Banderas canónicas de 06.4
 *  (url_no_permitida, pipe_a_shell, borrado, ignora_instrucciones, etiqueta_rol, base64_largo, invisible, canario, secreto). */
export function checkSalidaIA(texto: string, extraHosts: string[] = []): string[] {
  return checkFixPrompt(texto, extraHosts);
}
