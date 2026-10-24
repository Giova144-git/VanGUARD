// Enrutado de modelos (ver RULES.md): Haiku para trabajo masivo y barato, Sonnet para razonar y redactar.
export const MODELS = {
  fast: process.env.DEEPWIKI_MODEL_FAST || 'claude-haiku-5-5',
  smart: process.env.DEEPWIKI_MODEL_SMART || 'claude-sonnet-5-5',
};
// tarea -> nivel. Cualquier tarea nueva debe declararse aqui.
export const ROUTE = {
  triage: 'fast', // decidir que archivos importan (solo rutas)
  area: 'fast', // resumen por carpeta
  synthesis: 'smart', // documento final para el CEO
};
