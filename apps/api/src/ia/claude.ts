// Única puerta a Claude (S11 11.12 literal, S15 15.10, S05 05.4). Corre igual en el Worker y en Node 24 (dev-node.ts).
// Nadie más importa @anthropic-ai/sdk (11.1). Orden: (1) IA_CORTE=1 → disabled sin tocar la base; (2) vg_ai_status →
// nivel de la escalera; (3) vg_ai_reserve con el modelo ya elegido; (4) llamada; (5) vg_ai_settle. Nunca lanza.
// Nunca se registra el prompt, la salida del modelo ni la key: solo ids, tokens, costo y stop_reason.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { AuditSummary, type Coverage } from '@vanguard/contracts';
import { redact, fence, detectInjection } from '@vanguard/core';
// PROVISIONAL: ruta relativa hasta que packages/core/src/index.ts re-exporte ai.ts; entonces pasa a '@vanguard/core'.
import { peorCasoUSD, costoMensajeUSD, checkSalidaIA, type Modelo, type UsoMensaje } from '@vanguard/core';
import { log } from '../lib/log.ts';
import { NUCLEO } from './prompts/nucleo.ts';
import { SISTEMA_FIX, INSTRUCCION_FINAL as FINAL_FIX } from './prompts/fix_prompt.ts';
import { SISTEMA_RESUMEN, INSTRUCCION_FINAL as FINAL_RESUMEN } from './prompts/audit_summary.ts';
import { SISTEMA_ALERTA, INSTRUCCION_FINAL as FINAL_ALERTA } from './prompts/alert_text.ts';
import { estadoIA, reservarIA, liquidarIA } from './budget.ts';

export type RutaIA = 'fix_prompt' | 'audit_summary' | 'alert_text';
type Nivel = 'normal' | 'reduced' | 'minimal';
export type Fallo = 'disabled' | 'budget' | 'refusal' | 'timeout' | 'invalid';   // timeout = cualquier fallo transitorio del proveedor
type Plan = { model: Modelo; effort: 'low' | 'medium'; max_tokens: number; fallback: boolean; stream: boolean;
  thinking?: { type: 'between_tools' }; timeoutMs: number; retries: number };

// El plan reúne esto en prompts/index.ts; aquí, para no crear archivos fuera del encargo.
export const INSTRUCCION_FINAL: Record<RutaIA, string> = { fix_prompt: FINAL_FIX, audit_summary: FINAL_RESUMEN,
  alert_text: FINAL_ALERTA };

// ── Esquemas (S11 11.5 literal; el plan los pone en ia/esquemas.ts). El JSON Schema va a output_config.format y zod
// valida después lo que el API no admite (longitudes, tamaños de arrays). `triage` (P2) no está.
const s = { type: 'string' } as const;
const b = { type: 'boolean' } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const obj = (properties: Record<string, unknown>) =>
  ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties }) as const;

export const ESQUEMAS_JSON = {
  fix_prompt: obj({ contexto: s, pasos: { type: 'array', items: s }, prompt_para_tu_ia: s,
                    prueba_de_aceptacion: s, sospecha_inyeccion: b }),
  audit_summary: obj({ resumen: s, top: { type: 'array', items: obj({ finding_id: uuid, por_que: s }) },
                       relaciones: { type: 'array', items: obj({ finding_ids: { type: 'array', items: uuid }, explicacion: s }) },
                       sospecha_inyeccion: b }),
  alert_text: obj({ whatsapp: s, voz: s, sospecha_inyeccion: b }),
} as const;

// zod: límites que el API no puede imponer. Holgura sobre lo que pide el prompt para no tirar respuestas buenas,
// pero por debajo de los máximos del contrato de la sección 15 (FixPromptResponse.prompt ≤ 12.000; AuditSummary).
export const FixPromptIA = z.object({
  contexto: z.string().min(20).max(900), pasos: z.array(z.string().min(5).max(600)).min(2).max(7),
  prompt_para_tu_ia: z.string().min(80).max(2200), prueba_de_aceptacion: z.string().min(10).max(700),
  sospecha_inyeccion: z.boolean() });
export const AuditSummaryIA = z.object({
  resumen: z.string().min(80).max(1100),
  top: z.array(z.object({ finding_id: z.uuid(), por_que: z.string().max(400) })).min(1).max(5),
  relaciones: z.array(z.object({ finding_ids: z.array(z.uuid()).min(2).max(6), explicacion: z.string().max(500) })).max(5),
  sospecha_inyeccion: z.boolean() });
const SIN_IP_NI_ENLACE = (v: string) => !/https?:|www\.|@|\b\d{1,3}(\.\d{1,3}){3}\b/i.test(v);
export const AlertTextIA = z.object({
  whatsapp: z.string().min(20).max(300).refine(SIN_IP_NI_ENLACE, 'whatsapp con IP completa, correo o enlace'),
  voz: z.string().min(20).max(300).refine((v) => !/[0-9@]|https?:/i.test(v), 'voz con dígitos, correo o enlace'),
  sospecha_inyeccion: z.boolean() });
export type FixPromptIA = z.infer<typeof FixPromptIA>;
export type AuditSummaryIA = z.infer<typeof AuditSummaryIA>;
export type AlertTextIA = z.infer<typeof AlertTextIA>;

// ── Ruteo y escalera de degradación (11.3) ─────────────────────────────────────────────────────────────────────────
const FIX: Plan = { model: 'claude-sonnet-5-5', effort: 'medium', max_tokens: 6000, fallback: true /* decidido, 11.6 */,
  stream: false, timeoutMs: 75_000, retries: 0 };
const RESUMEN: Plan = { model: 'claude-opus-5-5', effort: 'medium', max_tokens: 16_000, fallback: true,
  stream: false /* Workers Free: un JSON.parse, no cientos de eventos SSE (11.3) */, timeoutMs: 180_000, retries: 1 };
const ALERTA: Plan = { model: 'claude-sonnet-5-5', effort: 'low', max_tokens: 800, fallback: false, stream: false,
  thinking: { type: 'between_tools' }, timeoutMs: 3_000, retries: 0 };
const RUTAS: Record<RutaIA, Record<Nivel, Plan | null>> = {
  fix_prompt:    { normal: FIX, reduced: FIX, minimal: { ...FIX, model: 'claude-haiku-5-5', fallback: false } },
  audit_summary: { normal: RESUMEN, reduced: { ...RESUMEN, model: 'claude-sonnet-5-5' },
                   minimal: { ...RESUMEN, model: 'claude-haiku-5-5', fallback: false } },   // Haiku: nunca `fallbacks`
  alert_text:    { normal: ALERTA, reduced: ALERTA, minimal: null },                         // sección 15: IA-3 apagada
};
const TOPE_PETICION_USD = 1;
const RITMO_POR_MINUTO = 10;
const TOPE_HAIKU_TOKENS = 90_000;                                            // tarifa ×5 por encima de 100K (11.2)
let cliente: Anthropic | undefined;                                          // uno por isolate

export type ResultadoIA<T> = { ok: true; data: T; model: string; cost_usd: number } | { ok: false; code: Fallo; reasons?: string[] };

export async function llamarIA<T>(env: CloudflareBindings, p: { org_id: string; ruta: RutaIA; sistema: string; datos: unknown;
  esquema: z.ZodType<T>; timeoutMs?: number; extraHosts?: string[] }): Promise<ResultadoIA<T>> {
  if (env.IA_CORTE === '1') return { ok: false, code: 'disabled' };
  if (!env.ANTHROPIC_API_KEY) return { ok: false, code: 'disabled' };        // sin key no hay IA: ni libro ni reserva
  const st = await estadoIA(env, p.org_id);
  if (!st || !st.enabled) return { ok: false, code: 'disabled' };            // sin libro no se gasta
  if (st.level === 'off' || st.calls_1m >= RITMO_POR_MINUTO) return { ok: false, code: 'budget' };
  const plan = RUTAS[p.ruta][st.level];
  if (!plan) return { ok: false, code: 'budget' };

  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: NUCLEO, cache_control: { type: 'ephemeral' } },     // punto de caché 1 (común)
    { type: 'text', text: p.sistema, cache_control: { type: 'ephemeral' } },  // punto de caché 2 (ruta)
  ];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: [
    { type: 'text', text: fence(p.ruta, redact(p.datos)).block },             // 06.4: {block, flags}; origen = ruta
    { type: 'text', text: INSTRUCCION_FINAL[p.ruta] },
  ] }];

  // 1) Peor caso con la cota de 11.3 (sin count_tokens: un viaje menos)
  const entrada = Math.ceil((NUCLEO.length + p.sistema.length + JSON.stringify(messages).length) / 2);
  if (plan.model === 'claude-haiku-5-5' && entrada > TOPE_HAIKU_TOKENS) return { ok: false, code: 'invalid' };
  const peor = peorCasoUSD(plan.model, entrada, plan.max_tokens, plan.fallback);
  if (peor > TOPE_PETICION_USD) return { ok: false, code: 'budget' };

  // 2) Reserva atómica en el libro (vg_ai_reserve de la sección 5)
  const rv = await reservarIA(env, p.org_id, p.ruta, plan.model, peor);
  if (!rv?.ok || !rv.usage_id) return { ok: false, code: rv?.code === 'disabled' ? 'disabled' : 'budget' };
  const reserva = rv.usage_id;

  // 3) Llamada
  let msg: Anthropic.Message;
  try {
    const ai = (cliente ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 }));
    msg = await enviar(ai, plan, system, messages, p.ruta, p.timeoutMs ?? plan.timeoutMs);
  } catch (e) {
    // En el SDK de TS, APIConnectionError (y su timeout) es subclase de APIError sin `status`: cuenta como transitorio
    const es4xx = e instanceof Anthropic.APIError && typeof e.status === 'number' && e.status < 500;
    await liquidarIA(env, reserva, { cost: es4xx ? 0 : null, stop: es4xx ? 'error_4xx' : 'error_transient' });
    log('warn', 'ia.error', { ruta: p.ruta, model: plan.model, usage_id: reserva,
      status: e instanceof Anthropic.APIError ? (e.status ?? null) : null, tipo: e instanceof Error ? e.name : 'desconocido' });
    if (e instanceof Anthropic.RateLimitError) return { ok: false, code: 'budget' };          // incluye enforced_spend_limit_reached
    if (e instanceof Anthropic.BadRequestError)                                              // límite de gasto del workspace = 400
      return { ok: false, code: /usage limits/i.test(e.message) ? 'budget' : 'invalid' };
    return { ok: false, code: 'timeout' };                                                   // timeout, conexión, 5xx, 529
  }

  // 4) Liquidar con el usage real (con fallback suma usage.iterations). La fila conserva plan.model (check de la sección 5)
  const u = msg.usage as UsoMensaje;
  const costo = costoMensajeUSD(msg.model, u);
  const refusal = msg.stop_reason === 'refusal' ? (msg.stop_details?.category ?? 'unknown') : null;
  await liquidarIA(env, reserva, { input: u.input_tokens, cache_read: u.cache_read_input_tokens,
    cache_write: u.cache_creation_input_tokens, output: u.output_tokens, cost: costo, stop: msg.stop_reason ?? 'unknown',
    refusal, request_id: msg.id });
  log('info', 'ia.llamada', { ruta: p.ruta, model: msg.model, usage_id: reserva, request_id: msg.id,
    stop_reason: msg.stop_reason, refusal, input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, cost_usd: costo });

  // 5) Validar: stop_reason → JSON → zod → filtro determinista
  if (msg.stop_reason === 'refusal') return { ok: false, code: 'refusal' };
  if (msg.stop_reason !== 'end_turn') return { ok: false, code: 'invalid' };               // max_tokens = JSON cortado
  const texto = msg.content.flatMap((bl) => (bl.type === 'text' ? [bl.text] : [])).join(''); // ignora thinking y bloques `fallback`
  let json: unknown;
  try { json = JSON.parse(texto); } catch { return { ok: false, code: 'invalid' }; }
  const v = p.esquema.safeParse(json);
  if (!v.success) return { ok: false, code: 'invalid' };
  const reasons = checkSalidaIA(texto, p.extraHosts ?? []);
  if (reasons.length > 0) {
    log('warn', 'ia.salida_filtrada', { ruta: p.ruta, usage_id: reserva, reasons });     // banderas nuestras, no la salida
    return { ok: false, code: 'invalid', reasons };
  }
  return { ok: true, data: v.data, model: msg.model, cost_usd: costo };
}

async function enviar(ai: Anthropic, plan: Plan, system: Anthropic.TextBlockParam[], messages: Anthropic.MessageParam[],
                      ruta: RutaIA, timeout: number): Promise<Anthropic.Message> {
  // Sin temperature, top_p, top_k, tool_choice ni tools (11.2, 11.11): dan 400 o abren superficie de ataque.
  const cuerpo = {
    model: plan.model, max_tokens: plan.max_tokens, system, messages,
    output_config: { effort: plan.effort, format: { type: 'json_schema' as const, schema: ESQUEMAS_JSON[ruta] } },
    ...(plan.thinking ? { thinking: plan.thinking } : {}),
  };
  const opciones = { timeout, maxRetries: plan.retries };
  if (plan.fallback) {               // fallback de servidor (11.6): solo existe en el espacio beta; forma "default" + SU beta
    // cast puntual: el esquema escrito a mano es readonly y los tipos de la beta lo piden mutable
    const bc = { ...cuerpo, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as any;
    const m = plan.stream ? await ai.beta.messages.stream(bc, opciones).finalMessage() : await ai.beta.messages.create(bc, opciones);
    return m as unknown as Anthropic.Message;
  }
  const c = cuerpo as any;           // cast puntual, mismo motivo
  return plan.stream ? ai.messages.stream(c, opciones).finalMessage() : ai.messages.create(c, opciones);
}

// ── Ayudantes por ruta para el BACK ─────────────────────────────────────────────────────────────────────────────────
const unicos = (xs: string[]) => [...new Set(xs)];

export type HallazgoFix = { rule_id: string; severity: string; confirmed: boolean; title: string; resource: string;
  module: string; evidence: unknown };
export type StackFix = { provider?: string | null; framework?: string | null; package_manager?: string | null;
  repo_full_name?: string | null };
export type ResultadoFix = { ok: true; data: FixPromptIA; model: string; cost_usd: number; injection_flags: string[] }
  | { ok: false; code: Fallo; injection_flags: string[] };

/** IA-1 (E15). `data` son los cuatro campos que envuelve armarPromptCorreccion (core/templates/fix-prompt.ts); el
 *  `flavor` no entra aquí: se antepone al responder (la caché es una por hallazgo). `injection_flags` = banderas de entrada
 *  de detectInjection(evidence) + 'model_flag' si el modelo marcó sospecha + las del filtro de salida si lo tumbó. */
export async function pedirFixPrompt(env: CloudflareBindings, p: { org_id: string; hallazgo: HallazgoFix;
  stack?: StackFix | null; extraHosts?: string[]; timeoutMs?: number }): Promise<ResultadoFix> {
  const h = p.hallazgo;
  const entrada = detectInjection(h.evidence ?? {});
  const r = await llamarIA(env, { org_id: p.org_id, ruta: 'fix_prompt', sistema: SISTEMA_FIX, esquema: FixPromptIA,
    extraHosts: p.extraHosts, timeoutMs: p.timeoutMs,
    datos: { hallazgo: { rule_id: h.rule_id, severity: h.severity, confirmed: h.confirmed, title: h.title,
                         resource: h.resource, module: h.module, evidence: h.evidence ?? null },
             stack: { provider: p.stack?.provider ?? null, framework: p.stack?.framework ?? null,          // desconocidos = null
                      package_manager: p.stack?.package_manager ?? null, repo_full_name: p.stack?.repo_full_name ?? null } } });
  if (!r.ok) return { ok: false, code: r.code, injection_flags: unicos([...entrada, ...(r.reasons ?? [])]) };
  return { ok: true, data: r.data, model: r.model, cost_usd: r.cost_usd,
    injection_flags: unicos([...entrada, ...(r.data.sospecha_inyeccion ? ['model_flag'] : [])]) };
}

export const MAX_HALLAZGOS_RESUMEN = 30;                                     // S15: los 30 abiertos más graves, sin evidencia
export type HallazgoResumen = { id: string; module: string; rule_id: string; severity: string; confirmed: boolean;
  title: string; resource: string };
export type ResultadoResumen = { ok: true; summary: AuditSummary; cost_usd: number } | { ok: false; code: Fallo; reasons?: string[] };

/** IA-2 (paso resumen_ia). Devuelve el `summary` de ScanRun ya filtrado y validado con AuditSummary, o el fallo para que
 *  el BACK ponga resumenPlantilla() (con suspected_injection:true si vienen `reasons`). Sin hallazgos no llama al modelo. */
export async function pedirResumen(env: CloudflareBindings, p: { org_id: string; scan_run_id?: string; score: number | null;
  band: string | null; coverage: Coverage | null; stack?: unknown; hallazgos: HallazgoResumen[]; extraHosts?: string[];
  timeoutMs?: number }): Promise<ResultadoResumen> {
  const filas = p.hallazgos.slice(0, MAX_HALLAZGOS_RESUMEN);
  if (filas.length === 0) return { ok: false, code: 'invalid' };
  const r = await llamarIA(env, { org_id: p.org_id, ruta: 'audit_summary', sistema: SISTEMA_RESUMEN, esquema: AuditSummaryIA,
    extraHosts: p.extraHosts, timeoutMs: p.timeoutMs,
    datos: { score: p.score, band: p.band, coverage: p.coverage, stack: p.stack ?? null,
             hallazgos: filas.map(({ id, ...x }) => ({ finding_id: id, ...x })) } });
  if (!r.ok) return r.reasons ? { ok: false, code: r.code, reasons: r.reasons } : { ok: false, code: r.code };
  // Se descartan finding_id inventados (y repetidos en top) y las relaciones que quedan con < 2 ids (11.10.3)
  const enviados = new Set(filas.map((f) => f.id));
  const top: AuditSummaryIA['top'] = [];
  for (const t of r.data.top) if (enviados.has(t.finding_id) && !top.some((x) => x.finding_id === t.finding_id)) top.push(t);
  const relaciones = r.data.relaciones
    .map((x) => ({ finding_ids: unicos(x.finding_ids.filter((id) => enviados.has(id))), explicacion: x.explicacion }))
    .filter((x) => x.finding_ids.length >= 2);
  if (top.length === 0) return { ok: false, code: 'invalid' };
  if (r.data.sospecha_inyeccion) log('warn', 'ia.injection_flag', { ruta: 'audit_summary', scan_run_id: p.scan_run_id ?? null });
  const v = AuditSummary.safeParse({ resumen: r.data.resumen, top, relaciones, model: r.model,
    ...(r.data.sospecha_inyeccion ? { suspected_injection: true } : {}) });
  return v.success ? { ok: true, summary: v.data, cost_usd: r.cost_usd } : { ok: false, code: 'invalid' };
}

export type HechosAlerta = { servicio: string; reglas: string[]; host: string | null; eventos: number | null;
  porcentaje: number | null; minutos: number | null; accion_propuesta: string | null };

/** IA-3 (P1). Solo hechos generados por nosotros (sin IP, UA, rutas ni severidad). Quien llama envuelve todo en
 *  Promise.race de 3.000 ms (cubre también las RPC del libro) y, si no llega, usa la plantilla de la sección 12. */
export async function pedirTextoAlerta(env: CloudflareBindings, p: { org_id: string; hechos: HechosAlerta;
  timeoutMs?: number }): Promise<ResultadoIA<AlertTextIA>> {
  return llamarIA(env, { org_id: p.org_id, ruta: 'alert_text', sistema: SISTEMA_ALERTA, esquema: AlertTextIA,
    datos: p.hechos, timeoutMs: p.timeoutMs });
}
