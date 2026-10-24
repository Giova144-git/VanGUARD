// @vanguard/deepwiki: motor puro que explica un repositorio a un directivo (ver LEEME.md).
// API pública explícita (dos módulos exportan escaparAtributo y ArchivoLeido: un `export *` los volvería ambiguos).
// Fuera a propósito: cli.ts (usa node:fs) y crearLlmFetch (en el Worker el LLM llega por apps/api/src/ia/claude.ts,
// con sus topes y su registro de uso; llamar a Anthropic directo desde el BACK se saltaría esas guardas).
export type * from './tipos.ts';

// Pasos para la cola vg-jobs, estimación, tope de costo y orquestación.
export {
  AVISOS, completarWiki, costoMaximoPaso, detalleInicio, documentoMarkdown, ErrorWiki, ESPERA_SINTESIS_MS, estimar,
  generarWiki, huellaHallazgos, LIMITES_POR_DEFECTO, limitesDe, marcarSintesis, MAX_CARPETAS_ARBOL,
  MAX_SUBPETICIONES_PASO, modelosDe, paginaDeRuta, pasoArbol, pasoArea, pasoSintesis, pasoTriage, progreso,
  siguientePaso, sintesisEnCurso, slugDeArea, tituloDeArea,
} from './pipeline.ts';
export type { AvanceWiki, CodigoErrorWiki, OpcionesWiki } from './pipeline.ts';

// Costos.
export { avisoTecho, costoDe, estimarCorrida, precioDe, PRECIOS, sumarConsumo, techoDesglose, techoPaso,
  tokensDe } from './estimar.ts';
export type { Precio } from './estimar.ts';
export { MODELOS_POR_DEFECTO, modeloPara } from './llm-fetch.ts';

// GitHub y filtros.
export { ErrorGithub, esperaDe, leerArbol, leerArchivos, leerArchivosDetalle, leerMeta, normalizarRepo } from './github.ts';
export type { ArbolRepo, CodigoErrorGithub, LecturaArchivos } from './github.ts';
export { AREA_OTROS, AREA_RAIZ, agruparEnAreas, areaDeRutaEn, elegirCandidatos, esCandidato, nombreArea,
  ordenarCandidatos, pareceArchivoDeClaves, preseleccionar, prioridad, rutaExcluida, rutaInsegura,
  seleccionarCandidatos } from './filtros.ts';
export type { Candidato, SeleccionCandidatos } from './filtros.ts';

// Seguridad: redacción de secretos y saneo de la salida del modelo.
export { escaparEtiquetas, prepararDato, REDACTADO, redactar } from './redactar.ts';
export { extraerYValidarMermaid, NOTA_MERMAID, sanearMarkdown, sanearSalida, validarMermaid } from './sanitizar.ts';

// Prompts (por si el BACK quiere auditarlos o medirlos).
export { armarArea, armarSintesis, armarTriage, MAX_TOKENS_SALIDA, parsearArea, parsearTriage, SECCIONES, SYS_AREA,
  SYS_SINTESIS, SYS_TRIAGE } from './prompts.ts';
export type { PromptArmado, PromptSintesis } from './prompts.ts';
