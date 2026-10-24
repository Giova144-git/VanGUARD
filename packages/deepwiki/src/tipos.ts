// Tipos compartidos del motor DeepWiki. El motor es puro: no importa el SDK de Anthropic (regla de §11, solo
// apps/api/src/ia/claude.ts lo hace) y recibe por inyección `fetch` y la función `llm`. Así corre igual en el
// Worker (un paso por invocación de la cola vg-jobs, <= 40 subpeticiones) y en Node (CLI de desarrollo).
import type { WikiDoc, WikiEstimate, WikiModelos, WikiRepoRef } from '@vanguard/contracts';

export type Fetch = typeof fetch;

// Entrada del árbol de GitHub (GET /repos/{o}/{r}/git/trees/{sha}?recursive=1).
export type EntradaArbol = { path: string; type: 'blob' | 'tree' | 'commit'; size?: number };

export type MetaRepo = {
  full_name: string;          // "dueño/repo" tal como lo devuelve GitHub
  description: string | null;
  language: string | null;
  private: boolean;
  default_branch: string;
  branch: string;             // la rama o tag que se documenta
  commit_sha: string;         // 40 hex: llave de la caché
};

// Topes por corrida. Todos se pueden bajar, nunca subir por encima de lo que cabe en Workers Free.
export type Limites = {
  maxCandidatos: number;      // rutas que ve el triage (400)
  maxArchivos: number;        // archivos que se leen en total (150)
  maxAreas: number;           // áreas/páginas (12; el resto va a «otros»)
  maxArchivosPorArea: number; // archivos leídos por paso `area` (25: <= 40 subpeticiones con el LLM)
  maxBytesArchivo: number;    // archivos más grandes se descartan sin leer (60.000)
  charsPorArchivo: number;    // recorte por archivo antes de mandarlo al modelo (3.000)
  charsPorArea: number;       // presupuesto de caracteres por área (24.000)
  maxTokensPrompt: number;    // guarda de Haiku: ningún prompt pasa de 90.000 tokens estimados
};

export type Tarea = 'wiki_triage' | 'wiki_area' | 'wiki_sintesis';
export type LlmPeticion = { tarea: Tarea; system: string; user: string; maxTokens: number };
export type LlmUso = { input_tokens: number; output_tokens: number;
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
export type LlmRespuesta = { texto: string; modelo: string; uso: LlmUso; stop_reason?: string };
// En el Worker la pasa el BACK y enruta por apps/api/src/ia/claude.ts (topes, interruptor, ai_usage).
export type Llm = (p: LlmPeticion) => Promise<LlmRespuesta>;

// Hallazgos de VanGUARD que se cruzan con la sección de riesgos (solo títulos y rutas: nunca evidencia).
export type HallazgoBreve = { rule_id: string; severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string; path?: string };

export type Deps = {
  fetch: Fetch;
  llm?: Llm;                  // obligatorio para triage, area y sintesis; no para arbol ni estimar
  githubToken?: string;       // PAT de la conexión GitHub (repos privados); nunca se registra
  limites?: Partial<Limites>;
  modelos?: WikiModelos;      // por defecto { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' }
  hallazgos?: HallazgoBreve[];
  ahora?: () => Date;         // inyectable para pruebas
};

export type Area = { nombre: string; archivos: string[] };
export type ResumenArea = { area: string; texto: string; archivos: string[] };
export type Consumo = { input_tokens: number; output_tokens: number; cost_usd: number };

// Estado serializable entre pasos (va a wiki_runs.state jsonb): solo rutas y resúmenes, nunca el código leído.
export type EstadoWiki = {
  version: 1;
  ref: WikiRepoRef;
  meta: MetaRepo;
  files_total: number;
  candidatos: { path: string; size: number }[];   // ya filtrados por reglas locales, ordenados por prioridad
  truncado: boolean;                               // GitHub truncó el árbol o se usó el árbol superficial
  areas: Area[];                                   // se llena en el paso `triage`
  pendientes: string[];                            // nombres de áreas aún sin resumir
  resumenes: ResumenArea[];
  consumo: Consumo;
  avisos: string[];
};

// Resultado final sin run_id (lo pone el BACK al guardar).
export type ResultadoWiki = Omit<WikiDoc, 'run_id'>;
export type Estimacion = Omit<WikiEstimate, 'cached_run_id'>;
