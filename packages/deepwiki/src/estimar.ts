// Costo de DeepWiki: tokens estimados, tabla de precios y estimación ANTES de correr (E40: solo lee GitHub).
// Sin red ni LLM: trabaja con el estado tras el paso `arbol` (rutas y tamaños) y con los prompts reales.
import type { WikiCostoPaso, WikiModelos } from '@vanguard/contracts';
import { agruparEnAreas, preseleccionar } from './filtros.ts';
import { armarSintesis, armarTriage, cabeceraArea, CHARS_POR_TOKEN, MAX_TOKENS_SALIDA, SYS_AREA } from './prompts.ts';
import type { Consumo, Estimacion, EstadoWiki, Limites, LlmRespuesta, LlmUso, SiguientePaso } from './tipos.ts';

// Salidas ESPERADAS por llamada, no topes: no incluyen el pensamiento adaptativo de los modelos 5.5 (ver
// MAX_TOKENS_SALIDA en prompts.ts). Por eso la estimación es un valor típico y el techo (salidas al tope de max_tokens)
// va aparte: techoDesglose para el aviso de E40 y techoPaso para cortar ANTES de pagar un paso.
export const SALIDA_ESTIMADA = { triage: 1200, area: 450, sintesis: 2800 } as const;
// Lo que suelen ocupar hasta 40 hallazgos de VanGUARD en la síntesis (aún no se conocen al estimar).
export const RESERVA_HALLAZGOS = 800;

export function tokensDe(texto: string): number {
  return Math.ceil(texto.length / CHARS_POR_TOKEN);
}

// USD por millón de tokens. La escritura de caché es la de 5 minutos (cache_control ephemeral).
export type Precio = { entrada: number; salida: number; lecturaCache: number; escrituraCache: number };
export const PRECIOS: Record<string, Precio> = {
  'claude-haiku-5-5': { entrada: 0.10, salida: 0.50, lecturaCache: 0.01, escrituraCache: 0.125 },
  'claude-sonnet-5-5': { entrada: 2.00, salida: 10.00, lecturaCache: 0.10, escrituraCache: 2.50 },
};
// Un modelo desconocido se cobra con el precio más caro de la tabla: nunca sale «gratis» y no burla el tope max_usd.
const PRECIO_CONSERVADOR: Precio = Object.values(PRECIOS).reduce((a, b) => (b.entrada > a.entrada ? b : a));

// Precio exacto o por prefijo (p. ej. un id con fecha); null si no se conoce.
export function precioDe(modelo: string): Precio | null {
  if (PRECIOS[modelo]) return PRECIOS[modelo];
  for (const [id, p] of Object.entries(PRECIOS)) if (modelo.startsWith(id)) return p;
  return null;
}

const redondear = (usd: number): number => Math.round(usd * 1e6) / 1e6;

// input_tokens de la API no incluye lo leído ni lo escrito en caché: cada parte se cobra a su tarifa.
export function costoDe(modelo: string, uso: LlmUso): number {
  const p = precioDe(modelo) ?? PRECIO_CONSERVADOR;
  return redondear((uso.input_tokens * p.entrada + uso.output_tokens * p.salida
    + (uso.cache_read_input_tokens ?? 0) * p.lecturaCache + (uso.cache_creation_input_tokens ?? 0) * p.escrituraCache) / 1e6);
}

// Suma una respuesta del LLM al consumo de la corrida (los tokens de entrada cuentan también los de caché).
export function sumarConsumo(c: Consumo, r: Pick<LlmRespuesta, 'modelo' | 'uso'>): Consumo {
  const entrada = r.uso.input_tokens + (r.uso.cache_read_input_tokens ?? 0) + (r.uso.cache_creation_input_tokens ?? 0);
  return { input_tokens: c.input_tokens + entrada, output_tokens: c.output_tokens + r.uso.output_tokens,
    cost_usd: redondear(c.cost_usd + costoDe(r.modelo, r.uso)) };
}

function paso(nombre: 'triage' | 'area' | 'sintesis', modelo: string, llamadas: number, entrada: number,
  salida: number): WikiCostoPaso {
  return { paso: nombre, modelo, llamadas, input_tokens: entrada, output_tokens: salida,
    usd: costoDe(modelo, { input_tokens: entrada, output_tokens: salida }) };
}

// Techo de una estimación: la misma entrada, pero cada llamada con la salida al tope de max_tokens.
export function techoDesglose(desglose: readonly WikiCostoPaso[]): number {
  let usd = 0;
  for (const d of desglose) {
    const tope = d.paso === 'triage' || d.paso === 'area' || d.paso === 'sintesis' ? MAX_TOKENS_SALIDA[d.paso] : 0;
    usd += costoDe(d.modelo, { input_tokens: d.input_tokens, output_tokens: tope * d.llamadas });
  }
  return redondear(usd);
}
export const avisoTecho = (usd: number): string =>
  `Si el modelo razona más de lo previsto, el costo puede llegar a US$ ${usd.toFixed(4)}.`;

// Entrada estimada de un paso `area`: los archivos que de verdad leerá (misma preselección que pasoArea), cada uno
// recortado a charsPorArchivo, con el área acotada a charsPorArea y la guarda de tokens de Haiku.
function entradaArea(archivos: readonly string[], tam: ReadonlyMap<string, number>, limites: Limites,
  tokSys: number, cabecera: number) {
  const leidos = preseleccionar(archivos, tam, limites);
  let chars = cabecera + 120;                          // contexto, cabecera e instrucción final
  for (const p of leidos) chars += Math.min(tam.get(p) || limites.charsPorArchivo, limites.charsPorArchivo) + p.length + 40;
  const recortada = chars > limites.charsPorArea;
  if (recortada) chars = limites.charsPorArea;
  let tokens = tokSys + Math.ceil(chars / CHARS_POR_TOKEN);
  const guarda = tokens > limites.maxTokensPrompt;
  if (guarda) tokens = limites.maxTokensPrompt;
  return { leidos: leidos.length, tokens, recortada, guarda };
}

// Estimación determinista: los primeros maxArchivos candidatos, agrupados como lo hará el paso `triage`.
// El triage real deja <= 80 rutas y los tamaños en bytes acotan los caracteres por arriba.
export function estimarCorrida(estado: EstadoWiki, modelos: WikiModelos, limites: Limites): Estimacion {
  const avisos: string[] = [];
  const candidatos = estado.candidatos;
  const desglose: WikiCostoPaso[] = [];

  // Triage: se mide el prompt real (armarTriage ya aplica la guarda de tokens).
  const rutasTriage = candidatos.slice(0, limites.maxCandidatos).map((c) => c.path);
  if (rutasTriage.length > 0) {
    const t = armarTriage(rutasTriage, limites);
    if (t.recortado) avisos.push(`El triage solo verá ${t.incluidos.length} de ${rutasTriage.length} rutas (guarda de ${limites.maxTokensPrompt} tokens).`);
    desglose.push(paso('triage', modelos.fast, 1, tokensDe(t.system + t.user), SALIDA_ESTIMADA.triage));
  }
  if (candidatos.length > limites.maxCandidatos) {
    avisos.push(`El repo tiene ${candidatos.length} archivos candidatos; el triage ve los ${limites.maxCandidatos} más prioritarios.`);
  }

  // Áreas: una llamada por área con los archivos que caben en su presupuesto.
  const seleccion = candidatos.slice(0, limites.maxArchivos);
  const tam = new Map(seleccion.map((c) => [c.path, c.size] as const));
  const areas = seleccion.length > 0 ? agruparEnAreas(seleccion.map((c) => c.path), limites.maxAreas) : [];
  const tokSys = tokensDe(SYS_AREA);
  const cabecera = cabeceraArea('x'.repeat(60), { repo: estado.meta.full_name, descripcion: estado.meta.description }).length;
  let entradaAreas = 0, archivosALeer = 0, areasRecortadas = 0;
  for (const a of areas) {
    const e = entradaArea(a.archivos, tam, limites, tokSys, cabecera);
    archivosALeer += e.leidos;
    if (e.recortada) areasRecortadas++;
    if (e.guarda) avisos.push(`El área «${a.nombre.slice(0, 60)}» supera la guarda de ${limites.maxTokensPrompt} tokens: se recorta.`);
    entradaAreas += e.tokens;
  }
  if (areasRecortadas > 0) {
    avisos.push(`En ${areasRecortadas} área(s) se leerá solo una parte del contenido (tope de ${limites.charsPorArea} caracteres por área).`);
  }
  if (areas.length > 0) {
    desglose.push(paso('area', modelos.fast, areas.length, entradaAreas, SALIDA_ESTIMADA.area * areas.length));
  }

  // Síntesis: el prompt real con resúmenes del largo esperado, más la reserva de hallazgos.
  if (areas.length > 0) {
    const relleno = 'x'.repeat(Math.ceil(SALIDA_ESTIMADA.area * CHARS_POR_TOKEN));
    const s = armarSintesis(estado.meta, areas.map((a) => ({ area: a.nombre, texto: relleno, archivos: a.archivos })));
    desglose.push(paso('sintesis', modelos.smart, 1, tokensDe(s.system + s.user) + RESERVA_HALLAZGOS, SALIDA_ESTIMADA.sintesis));
  }

  for (const m of new Set([modelos.fast, modelos.smart])) {
    if (!precioDe(m)) avisos.push(`Modelo sin precio conocido (${m.slice(0, 60)}): se estimó con la tarifa más cara de la tabla.`);
  }
  if (candidatos.length === 0) avisos.push('No hay archivos que documentar tras los filtros: no se llamará al modelo.');

  const input_tokens = desglose.reduce((s, d) => s + d.input_tokens, 0);
  const output_tokens = desglose.reduce((s, d) => s + d.output_tokens, 0);
  const usd = redondear(desglose.reduce((s, d) => s + d.usd, 0));
  // El techo va siempre (último, con su sitio reservado): con él el FRONT propone un max_usd que no corte la síntesis.
  const otros = [...new Set([...estado.avisos, ...avisos])].slice(0, desglose.length > 0 ? 9 : 10);
  const todos = [...otros, ...(desglose.length > 0 ? [avisoTecho(techoDesglose(desglose))] : [])].map((a) => a.slice(0, 200));

  return {
    repo_full_name: estado.meta.full_name, branch: estado.meta.branch, commit_sha: estado.meta.commit_sha,
    files_total: estado.files_total, files_candidatos: candidatos.length, files_a_leer_max: archivosALeer,
    areas_max: areas.length, truncado: estado.truncado,
    est: { input_tokens, output_tokens, usd, desglose },
    models: modelos, avisos: todos,
  };
}

// Lo MÁXIMO que puede costar el paso que viene (entrada estimada con el prompt real o sus tamaños, salida al tope de
// max_tokens). El BACK y la CLI cortan ANTES de llamar al modelo si consumo + techoPaso > max_usd: cortar después
// tiraría un paso ya pagado (la síntesis con Sonnet es cerca del 87 % del costo).
export function techoPaso(s: SiguientePaso, estado: EstadoWiki, modelos: WikiModelos, limites: Limites): number {
  if (s.paso === 'triage') {
    const t = armarTriage(estado.candidatos.slice(0, limites.maxCandidatos).map((c) => c.path), limites);
    return costoDe(modelos.fast, { input_tokens: tokensDe(t.system + t.user), output_tokens: MAX_TOKENS_SALIDA.triage });
  }
  if (s.paso === 'area') {
    const archivos = estado.areas.find((a) => a.nombre === s.area)?.archivos ?? [];
    const tam = new Map(estado.candidatos.map((c) => [c.path, c.size] as const));
    const cabecera = cabeceraArea(s.area, { repo: estado.meta.full_name, descripcion: estado.meta.description }).length;
    const e = entradaArea(archivos, tam, limites, tokensDe(SYS_AREA), cabecera);
    return costoDe(modelos.fast, { input_tokens: e.tokens, output_tokens: MAX_TOKENS_SALIDA.area });
  }
  const sx = armarSintesis(estado.meta, estado.resumenes, undefined, limites);
  return costoDe(modelos.smart, { input_tokens: tokensDe(sx.system + sx.user) + RESERVA_HALLAZGOS,
    output_tokens: MAX_TOKENS_SALIDA.sintesis });
}
