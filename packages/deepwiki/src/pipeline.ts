// Pipeline de DeepWiki: un paso por invocación del Worker (cola vg-jobs, 10 ms de CPU y <= 40 subpeticiones cada uno).
// Entre pasos solo viaja EstadoWiki (va a wiki_runs.state): rutas, resúmenes, consumo y avisos, nunca el código leído.
// Flujo portado del CLI deepwiki de Andrés (14c229a, index.mjs): árbol -> triage con el modelo rápido -> un resumen por
// área -> síntesis con el modelo listo. La wiki por páginas (una por área, con id estable) sigue la idea de
// DeepWiki-Open (MIT, (c) 2024 Sheing Ng, api/schemas/wiki.py: WikiPage con id, title y content).
import type { WikiModelos, WikiPagina, WikiPaso, WikiRepoRef } from '@vanguard/contracts';
import { estimarCorrida, sumarConsumo, techoPaso } from './estimar.ts';
import { agruparEnAreas, areaDeRutaEn, elegirCandidatos, preseleccionar, rutaExcluida, tituloDeArea } from './filtros.ts';
import { leerArbol, leerArchivosDetalle, leerMeta } from './github.ts';
import { MODELOS_POR_DEFECTO } from './llm-fetch.ts';
import { armarArea, armarSintesis, armarTriage, esGrave, limpiarTitulo, parsearArea, parsearTriage, SECCIONES,
  tituloDeResumen } from './prompts.ts';
import type { PromptArmado } from './prompts.ts';
import { prepararDato, redactar } from './redactar.ts';
import { MAX_MD, sanearMarkdown, sanearSalida } from './sanitizar.ts';
import type { Consumo, Deps, Estimacion, EstadoWiki, HallazgoBreve, Limites, Llm, LlmPeticion, ResultadoWiki,
  ResumenArea, SiguientePaso } from './tipos.ts';

export { tituloDeArea } from './filtros.ts';
export type { SiguientePaso } from './tipos.ts';

// Topes por defecto (spec y RULES.md de Andrés). Son también el techo: Deps.limites solo puede bajarlos.
export const LIMITES_POR_DEFECTO: Readonly<Limites> = Object.freeze({
  maxCandidatos: 400, maxArchivos: 150, maxAreas: 12, maxArchivosPorArea: 25, maxBytesArchivo: 60_000,
  charsPorArchivo: 3000, charsPorArea: 24_000, maxTokensPrompt: 90_000,
});
// leerMeta (<= 3) + árbol superficial con 10 carpetas (2 + 2 x 10) = 25 subpeticiones en el paso `arbol`.
export const MAX_CARPETAS_ARBOL = 10;
export const MAX_SUBPETICIONES_PASO = 40;
// Lo que se deja para el modelo en el paso `area`: 1 llamada más hasta 3 reintentos del cliente del BACK.
const RESERVA_LLM = 4;
// Se redacta un poco más de lo que se manda y, si el archivo se recortó, se descarta esa cola ya redactada: un secreto
// partido por el corte bruto (que ya no casa con su patrón) nunca entra al prompt, haya o no encogido el texto antes.
const MARGEN_REDACCION = 1000;
const MAX_RESUMEN = 4000;          // WikiPagina.resumen_md
const MAX_ARCHIVOS_PAGINA = 60;    // WikiPagina.archivos
const MAX_PAGINAS = 13;            // WikiDoc.paginas (12 áreas + «otros»)
const MAX_AVISOS_ESTADO = 20;
const MAX_AVISOS_DOC = 10;         // WikiDoc.avisos
const MAX_HALLAZGOS_REDACTADOS = 40; // los que armarSintesis llega a imprimir
const MAX_VUELTAS = 1 + MAX_PAGINAS + 2;
// Una síntesis marcada hace menos que esto sigue en curso (otra entrega del mensaje la está pagando).
export const ESPERA_SINTESIS_MS = 5 * 60_000;

export type CodigoErrorWiki = 'estado_invalido' | 'sin_llm' | 'sin_archivos' | 'area_desconocida'
  | 'pasos_pendientes' | 'sin_resumenes' | 'tope_usd';

// Errores propios del pipeline; `codigo` sirve para WikiRunStep.error_code (los de GitHub llegan como ErrorGithub).
export class ErrorWiki extends Error {
  readonly codigo: CodigoErrorWiki;
  constructor(codigo: CodigoErrorWiki, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorWiki';
    this.codigo = codigo;
  }
}

export type AvanceWiki = { paso: WikiPaso; detalle: string; progreso: number; consumo: Consumo };
export type OpcionesWiki = {
  alAvanzar?: (avance: AvanceWiki) => void;
  // Tras cada paso que cambió el estado (la CLI lo guarda en estado.json para reanudar sin repagar).
  alGuardar?: (estado: EstadoWiki) => void | Promise<void>;
  // Tope en USD: antes de cada paso se corta con ErrorWiki('tope_usd') si consumo + techoPaso lo pasaría.
  maxUsd?: number;
};

// ── Auxiliares ─────────────────────────────────────────────────────────────────────────────────────────────────

// Mezcla con los topes por defecto sin dejar subir ninguno: cada paso sigue cabiendo en Workers Free.
export function limitesDe(parcial?: Partial<Limites>): Limites {
  const l: Limites = { ...LIMITES_POR_DEFECTO };
  if (!parcial) return l;
  for (const k of Object.keys(LIMITES_POR_DEFECTO) as (keyof Limites)[]) {
    const v = parcial[k];
    if (typeof v === 'number' && Number.isFinite(v)) l[k] = Math.min(LIMITES_POR_DEFECTO[k], Math.max(1, Math.floor(v)));
  }
  return l;
}

export function modelosDe(deps: { modelos?: Partial<WikiModelos> | undefined }): WikiModelos {
  const m = deps.modelos;
  return { fast: m?.fast || MODELOS_POR_DEFECTO.fast, smart: m?.smart || MODELOS_POR_DEFECTO.smart };
}

function requerirLlm(deps: Deps): Llm {
  if (!deps.llm) throw new ErrorWiki('sin_llm', 'Este paso necesita un modelo (Deps.llm) y no se recibió.');
  return deps.llm;
}

// El estado viene de la base (wiki_runs.state): se revisa la forma antes de usarlo.
function validarEstado(e: EstadoWiki): void {
  if (!e || e.version !== 1 || !e.meta || !Array.isArray(e.candidatos) || !Array.isArray(e.areas)
    || !Array.isArray(e.pendientes) || !Array.isArray(e.resumenes) || !Array.isArray(e.avisos) || !e.consumo) {
    throw new ErrorWiki('estado_invalido', 'El estado guardado de la wiki no tiene la forma esperada.');
  }
}
const siguienteN = (e: EstadoWiki): number => (typeof e.n === 'number' && Number.isFinite(e.n) ? e.n : 0) + 1;

// Solo lo que pide la interfaz Llm: el BACK no tiene por qué ver `incluidos` ni `recortado`.
const peticion = (p: PromptArmado): LlmPeticion => ({ tarea: p.tarea, system: p.system, user: p.user, maxTokens: p.maxTokens });
const corto = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const unaLinea = (s: string, max: number) => s.replace(/[\r\n]+/g, ' ').slice(0, max);
// Nombre de carpeta para avisos (texto plano): sin corchetes, ángulos, comillas ni comillas invertidas.
const rutaPlana = (s: string) => corto(s.replace(/[^\p{L}\p{N} ._\/()@+-]+/gu, ' ').replace(/\s+/g, ' ').trim() || 'sin nombre');

function acotarAvisos(avisos: readonly string[], max: number): string[] {
  return [...new Set(avisos.map((a) => a.slice(0, 200)))].slice(0, max);
}

// Textos de los avisos: una sola fuente para el pipeline, sus pruebas y los fixtures del contrato.
const PREFIJO_REDACCION = 'Antes de enviar el código al modelo se ocult';
export const AVISOS = {
  truncado: () => 'El repositorio es muy grande: GitHub entregó su estructura incompleta y se documenta solo una parte.',
  omitidos: (omitidos: number, total: number) =>
    `Se omitieron ${omitidos} de ${total} archivos sin leerlos: binarios, imágenes, lockfiles, generados o de configuración.`,
  claves: (n: number) =>
    `${n === 1 ? 'Hay 1 archivo' : `Hay ${n} archivos`} con posibles claves (como .env): nunca se leen ni se envían al modelo.`,
  rutasConClave: (n: number) => `Se omitieron ${n} rutas cuyo nombre parece contener una clave.`,
  muchosCandidatos: (total: number, max: number) =>
    `El repo tiene ${total} archivos candidatos; el triage ve los ${max} más prioritarios.`,
  triageInvalido: () =>
    'El modelo no devolvió una selección válida de archivos: se eligieron por prioridad (README, manifiestos y código).',
  redaccion: (total: number) => `${PREFIJO_REDACCION}${total === 1 ? 'ó 1 valor' : `aron ${total} valores`} con forma de clave.`,
  areaSinArchivos: (area: string) => `No se pudo leer ningún archivo del área «${rutaPlana(area)}»; se omitió.`,
  areaConFallos: (area: string, n: number) =>
    `En «${rutaPlana(area)}» no se pudieron leer ${n === 1 ? '1 archivo' : `${n} archivos`} por una falla momentánea de GitHub.`,
  areaSinResumen: (area: string) => `El modelo no resumió el área «${rutaPlana(area)}».`,
  areaCortada: (area: string) => `El resumen de «${rutaPlana(area)}» quedó incompleto: el modelo llegó a su tope de longitud.`,
  sinDocumento: () => 'El modelo no devolvió el documento general; queda uno armado con las páginas por área.',
  documentoCortado: () => 'El documento quedó incompleto: el modelo llegó a su tope de longitud.',
  seccionesFaltantes: (faltan: readonly string[]) => `Al documento le faltan secciones: ${faltan.join(', ')}.`,
  gravesNoMencionados: (n: number) => `El texto no mencionaba ${n === 1 ? '1 hallazgo grave' : `${n} hallazgos graves`}; `
    + 'se añadieron al final de «Riesgos y puntos de atención».',
  mermaidDescartado: () => 'El diagrama propuesto por el modelo no pasó la validación de seguridad y se descartó.',
  sinMermaid: () => 'El documento no trae diagrama: el modelo no propuso uno.',
  sintesisRecortada: () => 'La síntesis no alcanzó a ver todos los resúmenes por área (tope de tamaño).',
  leidos: (leidos: number, candidatos: number) =>
    `Se leyeron ${leidos} de ${candidatos} archivos candidatos; el resto se juzgó menos útil para explicar el proyecto.`,
  auditoria: (fecha: string) => `Los riesgos salen de la auditoría de VanGUARD del ${fecha}.`,
} as const;

// Un solo aviso con el total de valores ocultados en toda la corrida (no uno por área).
function conRedaccion(avisos: string[], n: number): string[] {
  if (n <= 0) return avisos;
  const i = avisos.findIndex((a) => a.startsWith(PREFIJO_REDACCION));
  const previo = i >= 0 ? Number(/\d+/.exec(avisos[i] ?? '')?.[0] ?? 0) : 0;
  const texto = AVISOS.redaccion(previo + n);
  if (i >= 0) avisos[i] = texto; else avisos.push(texto);
  return avisos;
}

// Una ruta con forma de secreto no se manda ni al triage. Camino rápido: un solo redactar sobre todas juntas.
function sinRutasConClave(paths: { path: string; size: number }[]): { limpios: { path: string; size: number }[]; quitados: number } {
  if (paths.length === 0 || redactar(paths.map((c) => c.path).join('\n')).n === 0) return { limpios: paths, quitados: 0 };
  const limpios = paths.filter((c) => redactar(c.path).n === 0);
  return { limpios, quitados: paths.length - limpios.length };
}

// Los hallazgos los genera VanGUARD, pero sus títulos y rutas también pasan por la redacción antes del modelo.
// undefined (sin auditoría) y [] (auditoría limpia) se mantienen distintos: el documento dice cosas distintas.
const ORDEN_GRAVEDAD: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
function hallazgosParaModelo(hallazgos: readonly HallazgoBreve[] | undefined): HallazgoBreve[] | undefined {
  if (!Array.isArray(hallazgos)) return undefined;
  // Mismo orden estable que armarSintesis: los que se imprimen son los primeros MAX_HALLAZGOS_REDACTADOS.
  const orden = hallazgos.filter((h) => h && typeof h.title === 'string' && typeof h.rule_id === 'string'
    && ORDEN_GRAVEDAD[h.severity] !== undefined)
    .sort((a, b) => (ORDEN_GRAVEDAD[a.severity] ?? 9) - (ORDEN_GRAVEDAD[b.severity] ?? 9));
  return orden.map((h, i) => {
    if (i >= MAX_HALLAZGOS_REDACTADOS) return h;   // solo se cuentan, no se imprimen
    const limpio: HallazgoBreve = { rule_id: h.rule_id, severity: h.severity, title: redactar(h.title.slice(0, 200)).texto };
    if (typeof h.path === 'string') limpio.path = redactar(h.path.slice(0, 300)).texto;
    return limpio;
  });
}

// ── Páginas: id estable, título legible ─────────────────────────────────────────────────────────────────────────

// [a-z0-9-]{1,60}, determinista para la misma área: el FRONT puede enlazar a la página por su id.
export function slugDeArea(nombre: string): string {
  const s = nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'area';
}

function paginasDe(resumenes: readonly ResumenArea[]): WikiPagina[] {
  const ids = new Set<string>();
  const titulos = new Set<string>();
  return resumenes.slice(0, MAX_PAGINAS).map((r) => {
    const base = slugDeArea(r.area);
    let id = base;
    for (let k = 2; ids.has(id); k++) id = `${base.slice(0, 60 - String(k).length - 1)}-${k}`;
    ids.add(id);
    // Título del modelo (otra vez saneado: el estado viene de la base) o el de respaldo; si dos coinciden, la carpeta
    // desempata.
    let titulo = ((r.titulo ? limpiarTitulo(r.titulo) : undefined) ?? tituloDeArea(r.area)).slice(0, 120);
    if (titulos.has(titulo.toLowerCase())) titulo = `${titulo} (${rutaPlana(r.area)})`.slice(0, 120);
    titulos.add(titulo.toLowerCase());
    return {
      id, area: r.area.slice(0, 120), titulo,
      // Ya venía saneado y redactado del paso `area`; se repite por si el estado de la base fue alterado.
      resumen_md: sanearMarkdown(redactar(r.texto).texto, MAX_RESUMEN) || 'Sin resumen para esta parte.',
      archivos: r.archivos.filter((p) => p.length <= 300).slice(0, MAX_ARCHIVOS_PAGINA),
    };
  });
}

// Página donde cae un hallazgo (regla del FRONT, la misma que usa la síntesis): ver areaDeRutaEn en filtros.ts.
export function paginaDeRuta(ruta: string, paginas: readonly WikiPagina[]): WikiPagina | null {
  return areaDeRutaEn(ruta, paginas);
}

// Huella de los hallazgos usados (sha-256 de rule_id|severity|path ordenados): va en la llave de la caché junto al
// commit, porque arreglar algo en Supabase cambia los riesgos sin cambiar el commit. «sin-auditoria» si no hubo.
export async function huellaHallazgos(hallazgos: readonly HallazgoBreve[] | undefined): Promise<string> {
  if (!Array.isArray(hallazgos)) return 'sin-auditoria';
  const lineas = hallazgos.map((h) => `${h.rule_id}|${h.severity}|${h.path ?? ''}`).sort();
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lineas.join('\n')));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Pasos ───────────────────────────────────────────────────────────────────────────────────────────────────────

// Paso `arbol`: metadatos, commit exacto y árbol filtrado. Sin LLM. <= 25 subpeticiones (33 si GitHub redirige).
export async function pasoArbol(ref: WikiRepoRef, deps: Deps): Promise<EstadoWiki> {
  const limites = limitesDe(deps.limites);
  const meta = await leerMeta(ref, deps);
  const arbol = await leerArbol(meta, deps, { maxCarpetas: MAX_CARPETAS_ARBOL });
  const sel = elegirCandidatos(arbol.entradas, limites);
  const { limpios: candidatos, quitados } = sinRutasConClave(sel.candidatos);

  const avisos: string[] = [];
  if (arbol.truncado) avisos.push(AVISOS.truncado());
  const omitidos = arbol.entradas.length - sel.total;
  if (omitidos > 0) avisos.push(AVISOS.omitidos(omitidos, arbol.entradas.length));
  if (sel.conClaves > 0) avisos.push(AVISOS.claves(sel.conClaves));
  if (quitados > 0) avisos.push(AVISOS.rutasConClave(quitados));
  if (sel.total > limites.maxCandidatos) avisos.push(AVISOS.muchosCandidatos(sel.total, limites.maxCandidatos));

  return {
    version: 1, ref,
    // La descripción de GitHub también llega al modelo: se redacta aquí, una vez.
    meta: { ...meta, description: meta.description === null ? null : redactar(meta.description.slice(0, 500)).texto },
    files_total: arbol.entradas.length, candidatos, truncado: arbol.truncado,
    areas: [], pendientes: [], resumenes: [], consumo: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    avisos: acotarAvisos(avisos, MAX_AVISOS_ESTADO), n: 1,
  };
}

// Estimación ANTES de correr (E40): sin red ni LLM, con el estado del paso `arbol`.
export function estimar(estado: EstadoWiki, deps: Pick<Deps, 'limites' | 'modelos'>): Estimacion {
  validarEstado(estado);
  return estimarCorrida(estado, modelosDe(deps), limitesDe(deps.limites));
}

// Lo máximo que puede costar el paso que sigue (para cortar ANTES de pagarlo si pasaría max_usd).
export function costoMaximoPaso(estado: EstadoWiki, s: SiguientePaso, deps: Pick<Deps, 'limites' | 'modelos'>): number {
  validarEstado(estado);
  return techoPaso(s, estado, modelosDe(deps), limitesDe(deps.limites));
}

// Paso `triage`: 1 llamada al modelo rápido sobre las rutas; si no devuelve una lista usable, se eligen por prioridad.
// Si ya estaba hecho devuelve el MISMO objeto: es un mensaje repetido y el BACK no debe guardar ni encolar nada.
export async function pasoTriage(estado: EstadoWiki, deps: Deps): Promise<EstadoWiki> {
  validarEstado(estado);
  if (estado.areas.length > 0) return estado;
  const limites = limitesDe(deps.limites);
  // rutaExcluida otra vez: el estado viene de la base y un .env jamás debe llegar a pedirse.
  const paths = estado.candidatos.slice(0, limites.maxCandidatos).map((c) => c.path).filter((p) => !rutaExcluida(p));
  if (paths.length === 0) throw new ErrorWiki('sin_archivos', 'No hay archivos que documentar tras los filtros.');
  const llm = requerirLlm(deps);

  const prompt = armarTriage(paths, limites);
  const r = await llm(peticion(prompt));
  const avisos = [...estado.avisos];
  let elegidas = parsearTriage(r.texto, prompt.incluidos);
  if (!elegidas) {
    avisos.push(AVISOS.triageInvalido());
    elegidas = paths;
  }
  const areas = agruparEnAreas(elegidas.slice(0, limites.maxArchivos), limites.maxAreas);
  return { ...estado, areas, pendientes: areas.map((a) => a.nombre), consumo: sumarConsumo(estado.consumo, r),
    avisos: acotarAvisos(avisos, MAX_AVISOS_ESTADO), n: siguienteN(estado) };
}

// Paso `area`: lee los archivos de ESA área que caben en su prompt (más 3 de reserva), los redacta, 1 llamada al
// modelo rápido y guarda solo el resumen saneado. <= 25 descargas + reintentos de las que fallen + 1 llamada, y nunca
// más de 40 - RESERVA_LLM subpeticiones de GitHub. Un área ya resumida devuelve el MISMO objeto (mensaje repetido).
export async function pasoArea(estado: EstadoWiki, nombreArea: string, deps: Deps): Promise<EstadoWiki> {
  validarEstado(estado);
  const area = estado.areas.find((a) => a.nombre === nombreArea);
  if (!area) throw new ErrorWiki('area_desconocida', 'El área pedida no existe en esta corrida.');
  if (!estado.pendientes.includes(nombreArea)) return estado;
  const limites = limitesDe(deps.limites);
  const llm = requerirLlm(deps);
  const pendientes = estado.pendientes.filter((n) => n !== nombreArea);

  const tam = new Map(estado.candidatos.map((c) => [c.path, c.size] as const));
  const paths = preseleccionar(area.archivos.filter((p) => !rutaExcluida(p)), tam, limites);
  const reintentos = Math.max(0, Math.min(paths.length, MAX_SUBPETICIONES_PASO - RESERVA_LLM - paths.length));
  // Un 5xx o un fallo de red en la mayoría de los archivos lanza github_red: la cola reintenta el paso en vez de
  // guardar un área degradada en la caché del commit.
  const lectura = paths.length > 0
    ? await leerArchivosDetalle(estado.meta, paths, deps, limites, { reintentos }) : { archivos: [], fallidos: 0 };
  const avisos = [...estado.avisos];
  if (lectura.fallidos > 0) avisos.push(AVISOS.areaConFallos(nombreArea, lectura.fallidos));
  if (lectura.archivos.length === 0) {
    return { ...estado, pendientes, avisos: acotarAvisos([...avisos, AVISOS.areaSinArchivos(nombreArea)], MAX_AVISOS_ESTADO),
      n: siguienteN(estado) };
  }

  // Redactar ANTES de armar el prompt; prepararDato además neutraliza las etiquetas <repo_*> del contenido.
  let ocultos = 0;
  const lim = limites.charsPorArchivo + MARGEN_REDACCION;
  const preparados = lectura.archivos.map((a) => {
    const recortado = a.contenido.length > lim;
    const d = prepararDato(a.contenido.slice(0, lim));
    ocultos += d.n;
    // Si se recortó, la cola de MARGEN_REDACCION caracteres del texto redactado se tira: ahí puede quedar un secreto
    // partido por el corte bruto, y una redacción grande anterior (una PEM) la habría metido en lo que se envía.
    const contenido = recortado ? d.texto.slice(0, Math.max(0, d.texto.length - MARGEN_REDACCION)) : d.texto;
    return { path: a.path, contenido, recortado };
  });
  const prompt = armarArea(area.nombre, preparados, limites,
    { repo: estado.meta.full_name, descripcion: estado.meta.description });
  const r = await llm(peticion(prompt));

  conRedaccion(avisos, ocultos);
  const { texto, archivosClave, titulo } = parsearArea(r.texto, prompt.incluidos);
  // Defensa en profundidad: la salida también se redacta (si un secreto se coló y el modelo lo repite, no se guarda).
  // Primero redactar y luego sanear: así el «[REDACTADO]» queda escapado y no puede formar un enlace.
  let resumen = sanearMarkdown(redactar(texto).texto, MAX_RESUMEN);
  if (!resumen) {
    resumen = 'El modelo no devolvió un resumen para esta parte.';
    avisos.push(AVISOS.areaSinResumen(nombreArea));
  }
  if (r.stop_reason === 'max_tokens') avisos.push(AVISOS.areaCortada(nombreArea));
  const archivos = [...archivosClave, ...prompt.incluidos.filter((p) => !archivosClave.includes(p))];
  const nuevo: ResumenArea = { area: area.nombre, texto: resumen, archivos: archivos.slice(0, MAX_ARCHIVOS_PAGINA) };
  if (titulo) nuevo.titulo = titulo;
  return {
    ...estado, pendientes, resumenes: [...estado.resumenes, nuevo],
    consumo: sumarConsumo(estado.consumo, r), avisos: acotarAvisos(avisos, MAX_AVISOS_ESTADO), n: siguienteN(estado),
  };
}

// Antes de pagar la síntesis, el BACK guarda este estado con compare-and-set sobre `n`: si otra entrega del mismo
// mensaje ya la marcó (sintesisEnCurso), no la corre. Pasado ESPERA_SINTESIS_MS se da por caída y se puede repetir.
export function marcarSintesis(estado: EstadoWiki, ahora: Date = new Date()): EstadoWiki {
  validarEstado(estado);
  return { ...estado, sintesis_iniciada: ahora.toISOString(), n: siguienteN(estado) };
}
export function sintesisEnCurso(estado: EstadoWiki, ahora: Date = new Date()): boolean {
  const t = estado.sintesis_iniciada ? Date.parse(estado.sintesis_iniciada) : NaN;
  return Number.isFinite(t) && ahora.getTime() - t < ESPERA_SINTESIS_MS;
}

// Marcas [Hn] con que el modelo cita los hallazgos (también [H1, H3]). Se cuentan y se quitan del texto.
const RE_MARCA = /[ \t]{0,3}\[[ \t]{0,3}H(\d{1,2})((?:[ \t]{0,3}[,;][ \t]{0,3}H\d{1,2}){0,40})[ \t]{0,3}\]/gi;
function extraerMarcas(texto: string): { texto: string; citadas: Set<number> } {
  const citadas = new Set<number>();
  const limpio = texto.replace(RE_MARCA, (_m: string, primera: string, resto: string) => {
    citadas.add(Number(primera));
    for (const x of resto.matchAll(/\d{1,2}/g)) citadas.add(Number(x[0]));
    return '';
  });
  return { texto: limpio, citadas };
}

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Palabra que identifica cada sección de SECCIONES, tolerante a tildes y a títulos algo distintos.
const CLAVE_SECCION = ['que es', 'como funciona', 'piezas', 'mapa', 'riesgos'] as const;
const titulosDe = (md: string) => md.split('\n').filter((l) => /^##\s/.test(l)).map(sinTildes);
function seccionesFaltantes(md: string): string[] {
  const titulos = titulosDe(md);
  return SECCIONES.filter((_s, k) => !titulos.some((t) => t.includes(CLAVE_SECCION[k] ?? '\u0000')));
}
const esTituloRiesgos = (l: string) => /^##\s/.test(l) && sinTildes(l).includes('riesgos');

// Inserta `bloque` al final de la sección de riesgos (o crea la sección al final del documento).
function alFinalDeRiesgos(md: string, bloque: string): string {
  const lineas = md.split('\n');
  const i = lineas.findIndex(esTituloRiesgos);
  if (i < 0) return `${md.trimEnd()}\n\n## ${SECCIONES[4]}\n${bloque}`;
  let j = lineas.findIndex((l, k) => k > i && /^#{1,2}\s/.test(l));
  if (j < 0) j = lineas.length;
  lineas.splice(j, 0, '', bloque, '');
  return lineas.join('\n');
}
// «## Mapa visual» antes de «## Riesgos» (o al final): el FRONT dibuja ahí el diagrama.
function conTituloMapa(md: string): string {
  const lineas = md.split('\n');
  const i = lineas.findIndex(esTituloRiesgos);
  if (i < 0) return `${md.trimEnd()}\n\n## ${SECCIONES[3]}`;
  lineas.splice(i, 0, `## ${SECCIONES[3]}`, '');
  return lineas.join('\n');
}

const GRAVEDAD_ES: Record<HallazgoBreve['severity'], string> = { critical: 'crítica', high: 'alta', medium: 'media',
  low: 'baja', info: 'informativa' };
const listaHallazgos = (hs: readonly HallazgoBreve[]) =>
  hs.map((h) => `- ${unaLinea(h.title, 160)} (gravedad ${GRAVEDAD_ES[h.severity]})`).join('\n');

// Documento determinista cuando el modelo no devolvió nada usable: las 5 secciones con lo que se sabe sin él.
function documentoRespaldo(estado: EstadoWiki, paginas: readonly WikiPagina[],
  hallazgos: readonly HallazgoBreve[] | undefined): string {
  const nombre = estado.meta.full_name.split('/').pop() ?? estado.meta.full_name;
  const riesgos = hallazgos === undefined
    ? 'No se hizo un análisis de seguridad de este repositorio, así que no se pueden afirmar riesgos concretos.'
    : hallazgos.length === 0
      ? 'VanGUARD auditó este repositorio y no reportó hallazgos; eso no garantiza que sea seguro.'
      : `Hallazgos de la auditoría de VanGUARD, de más a menos graves:\n${listaHallazgos(hallazgos.slice(0, 10))}`;
  return [
    `# ${nombre}`,
    `## ${SECCIONES[0]}`,
    `${unaLinea(estado.meta.description ?? 'El repositorio no trae una descripción.', 500)} El modelo no devolvió el `
      + 'documento general, así que este resumen se armó solo con los datos disponibles.',
    `## ${SECCIONES[1]}`,
    'Sin el documento del modelo no hay una explicación de conjunto: las páginas por área cuentan qué hace cada parte.',
    `## ${SECCIONES[2]}`,
    paginas.map((p) => `- **${p.titulo}**`).join('\n') || '- (sin páginas)',
    `## ${SECCIONES[3]}`,
    `## ${SECCIONES[4]}`,
    riesgos,
  ].join('\n\n');
}

// Fecha corta dd/mm/aaaa (UTC) para el aviso de la auditoría; null si el ISO no es válido.
function fechaCorta(iso: string | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(d.getUTCDate())}/${dos(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

// Paso `sintesis`: 1 llamada al modelo listo con los resúmenes y los hallazgos; devuelve el documento final.
export async function pasoSintesis(estado: EstadoWiki, deps: Deps): Promise<ResultadoWiki> {
  validarEstado(estado);
  if (estado.areas.length === 0) throw new ErrorWiki('pasos_pendientes', 'Falta el paso triage.');
  if (estado.pendientes.length > 0) {
    throw new ErrorWiki('pasos_pendientes', `Faltan ${estado.pendientes.length} áreas por resumir.`);
  }
  if (estado.resumenes.length === 0) throw new ErrorWiki('sin_resumenes', 'No se pudo resumir ninguna parte del repo.');
  const limites = limitesDe(deps.limites);
  const llm = requerirLlm(deps);

  const hallazgos = hallazgosParaModelo(deps.hallazgos);
  const prompt = armarSintesis(estado.meta, estado.resumenes, hallazgos, limites);
  const r = await llm(peticion(prompt));
  const consumo = sumarConsumo(estado.consumo, r);
  const paginas = paginasDe(estado.resumenes);

  // Las marcas [Hn] dicen qué hallazgos cubrió el texto: un archivo del repo pudo pedirle al modelo que callara los
  // graves, así que no se confía solo en su texto y los que falten se anexan por código.
  const { texto: crudo, citadas } = extraerMarcas(r.texto);
  const faltan = prompt.marcas.filter((h, i) => esGrave(h) && !citadas.has(i + 1));
  // Redactar (defensa en profundidad) y luego separar y validar el Mermaid y sanear el texto: el diagrama viaja aparte.
  const salida = sanearSalida(redactar(crudo).texto, MAX_MD);

  const avisos: string[] = [];
  let overview = salida.md;
  if (!overview) {
    overview = sanearMarkdown(documentoRespaldo(estado, paginas, hallazgos), MAX_MD);
    avisos.push(AVISOS.sinDocumento());
  } else {
    let cambiado = false;
    if (faltan.length > 0) {
      overview = alFinalDeRiesgos(overview, `**Hallazgos graves de la auditoría que el texto no menciona:**\n${listaHallazgos(faltan)}`);
      avisos.push(AVISOS.gravesNoMencionados(faltan.length));
      cambiado = true;
    }
    const ausentes = seccionesFaltantes(overview);
    if (salida.mermaid && ausentes.includes(SECCIONES[3])) { overview = conTituloMapa(overview); cambiado = true; }
    if (ausentes.length > 0) avisos.push(AVISOS.seccionesFaltantes(ausentes));
    if (cambiado) overview = sanearMarkdown(overview, MAX_MD);
  }
  if (r.stop_reason === 'max_tokens') avisos.push(AVISOS.documentoCortado());
  if (salida.descartado) avisos.push(AVISOS.mermaidDescartado());
  else if (!salida.mermaid) avisos.push(AVISOS.sinMermaid());
  if (prompt.recortado) avisos.push(AVISOS.sintesisRecortada());

  let files_leidos = 0;
  for (const res of estado.resumenes) files_leidos += res.archivos.length;
  if (files_leidos < estado.candidatos.length) avisos.push(AVISOS.leidos(files_leidos, estado.candidatos.length));
  const fecha = hallazgos !== undefined ? fechaCorta(deps.auditoria_at) : null;
  if (fecha) avisos.push(AVISOS.auditoria(fecha));

  return {
    repo_full_name: estado.meta.full_name, branch: estado.meta.branch, commit_sha: estado.meta.commit_sha,
    generated_at: (deps.ahora?.() ?? new Date()).toISOString(), models: modelosDe(deps),
    overview_md: overview, mermaid: salida.mermaid, mermaid_descartado: salida.descartado, paginas,
    stats: { files_total: estado.files_total, files_leidos, areas: paginas.length, input_tokens: consumo.input_tokens,
      output_tokens: consumo.output_tokens, cost_usd: consumo.cost_usd },
    // Primero los de la síntesis: son los que más importan a quien lee y el tope de 10 no debe dejarlos fuera.
    avisos: acotarAvisos([...avisos, ...estado.avisos], MAX_AVISOS_DOC),
  };
}

// ── Orquestación ────────────────────────────────────────────────────────────────────────────────────────────────

// Qué mensaje encola el BACK después de guardar este estado (si el paso devolvió el mismo objeto, nada).
export function siguientePaso(estado: EstadoWiki): SiguientePaso {
  if (estado.areas.length === 0) return { paso: 'triage' };
  const area = estado.pendientes[0];
  return area !== undefined ? { paso: 'area', area } : { paso: 'sintesis' };
}

// 10 árbol + 20 triage + 60 repartido entre áreas + 10 síntesis (misma fórmula que los fixtures del contrato).
// `enCurso`: hay un área corriendo ahora; cuenta media.
export function progreso(estado: EstadoWiki, enCurso = false): number {
  const total = estado.areas.length;
  if (total === 0) return 10;
  const hechas = total - estado.pendientes.length + (enCurso && estado.pendientes.length > 0 ? 0.5 : 0);
  return Math.max(0, Math.min(100, Math.round(30 + (60 * hechas) / total)));
}

// Detalle de WikiRunStep (<= 80 caracteres, texto plano): el área se nombra con su título de respaldo, porque el del
// modelo aún no existe cuando el paso empieza.
export function detalleInicio(s: SiguientePaso, estado: EstadoWiki): string {
  if (s.paso === 'triage') return `Eligiendo archivos entre ${estado.candidatos.length} candidatos`;
  if (s.paso === 'area') {
    const k = estado.areas.length - estado.pendientes.length + 1;
    return corto(`Área ${k} de ${estado.areas.length}: ${tituloDeArea(s.area)}`, 80);
  }
  return `Escribiendo el documento con ${estado.resumenes.length} áreas`;
}

// Corre desde un estado hasta el final (CLI y pruebas). El BACK no la usa: encola paso a paso con siguientePaso.
export async function completarWiki(inicial: EstadoWiki, deps: Deps, opciones: OpcionesWiki = {}): Promise<ResultadoWiki> {
  const avisar = opciones.alAvanzar ?? (() => {});
  let estado = inicial;
  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const s = siguientePaso(estado);
    if (opciones.maxUsd !== undefined) {
      const techo = costoMaximoPaso(estado, s, deps);
      if (estado.consumo.cost_usd + techo > opciones.maxUsd) {
        throw new ErrorWiki('tope_usd', `El paso ${s.paso} podría costar hasta US$ ${techo.toFixed(4)} y, con lo gastado `
          + `(US$ ${estado.consumo.cost_usd.toFixed(4)}), pasaría el tope de US$ ${opciones.maxUsd.toFixed(4)}.`);
      }
    }
    avisar({ paso: s.paso, detalle: detalleInicio(s, estado), progreso: progreso(estado, s.paso === 'area'),
      consumo: estado.consumo });
    if (s.paso === 'sintesis') {
      const doc = await pasoSintesis(estado, deps);
      const detalle = doc.mermaid ? 'Documento y diagrama listos'
        : doc.mermaid_descartado ? 'Documento listo; diagrama descartado' : 'Documento listo; sin diagrama';
      avisar({ paso: 'fin', detalle, progreso: 100, consumo: { input_tokens: doc.stats.input_tokens,
        output_tokens: doc.stats.output_tokens, cost_usd: doc.stats.cost_usd } });
      return doc;
    }
    const nuevo = s.paso === 'triage' ? await pasoTriage(estado, deps) : await pasoArea(estado, s.area, deps);
    if (nuevo !== estado) await opciones.alGuardar?.(nuevo);
    estado = nuevo;
  }
  throw new ErrorWiki('estado_invalido', 'La corrida no terminó en el número de pasos esperado.');
}

// Todo en secuencia: árbol, triage, áreas y síntesis.
export async function generarWiki(ref: WikiRepoRef, deps: Deps, opciones: OpcionesWiki = {}): Promise<ResultadoWiki> {
  opciones.alAvanzar?.({ paso: 'arbol', detalle: 'Leyendo el repositorio en GitHub', progreso: 0,
    consumo: { input_tokens: 0, output_tokens: 0, cost_usd: 0 } });
  const estado = await pasoArbol(ref, deps);
  await opciones.alGuardar?.(estado);
  return completarWiki(estado, deps, opciones);
}

// Escapes para lo que no viene del modelo pero sí del repo (títulos de respaldo, rutas, avisos con nombres de
// carpeta): en Markdown no deben formar enlaces, HTML ni énfasis. Cada ruta va en código en línea.
const escMd = (s: string) => s.replace(/[\\`*_[\]()<>#!|~]/g, '\\$&');
const enCodigo = (p: string) => `\`${p.replace(/`/g, "'")}\``;

// Documento para leer fuera de la app (CLI): el overview con el diagrama bajo «Mapa visual», las páginas por área y
// las notas de esta versión (si el repo se documentó a medias o el diagrama se descartó, quien lo lea debe saberlo).
export function documentoMarkdown(doc: ResultadoWiki): string {
  const lineas = doc.overview_md.split('\n');
  if (doc.mermaid) {
    const diagrama = ['', '```mermaid', doc.mermaid, '```', ''];
    const i = lineas.findIndex((l) => /^##\s/.test(l) && sinTildes(l).includes('mapa visual'));
    if (i >= 0) {
      let j = lineas.findIndex((l, k) => k > i && /^#{1,2}\s/.test(l));
      if (j < 0) j = lineas.length;
      lineas.splice(j, 0, ...diagrama);
    } else {
      const r = lineas.findIndex(esTituloRiesgos);
      const bloque = [`## ${SECCIONES[3]}`, ...diagrama];
      if (r >= 0) lineas.splice(r, 0, ...bloque); else lineas.push('', ...bloque);
    }
  }
  const partes = [lineas.join('\n').replace(/\n{3,}/g, '\n\n').trim()];
  if (doc.paginas.length > 0) {
    partes.push('---', '# Páginas por área');
    for (const p of doc.paginas) {
      partes.push(`## ${escMd(p.titulo)}`, p.resumen_md, `Archivos: ${p.archivos.map(enCodigo).join(', ')}`);
    }
  }
  if (doc.avisos.length > 0) partes.push('---', '## Notas de esta versión', doc.avisos.map((a) => `- ${escMd(a)}`).join('\n'));
  partes.push('---', `_Commit ${doc.commit_sha.slice(0, 7)} de ${escMd(doc.repo_full_name)} (${escMd(doc.branch)}), `
    + `${doc.stats.files_leidos} archivos leídos, US$ ${doc.stats.cost_usd.toFixed(4)}._`);
  return `${partes.join('\n\n')}\n`;
}
