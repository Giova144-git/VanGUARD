// Versión de Rendimiento que sirve GET / (S10 10.11). Para pasar de una a otra se cambia esta línea y se despliega:
// scripts/perf-medir.ts y perf-hook.mjs la leen de aquí con /PERF_VERSION\s*=\s*'([\w.-]+)'/ para etiquetar la medición,
// así que es la única fuente (no hay variable de entorno que la pise). La regresión de v2 es deliberada.
export type PerfVersion = 'v1-sana' | 'v2-regresion';
export const PERF_VERSION = 'v1-sana' satisfies PerfVersion;
