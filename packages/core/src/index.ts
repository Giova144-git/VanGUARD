// @vanguard/core: lógica pura de VanGUARD (reglas, puntaje, primitivas de seguridad). No importa nada de
// Cloudflare ni de Supabase: recibe datos y devuelve datos, y corre igual en el Worker, en Node 24 y en el navegador.
// Dueño único: chat BACK (S15 15.1); `perf/` es del ORQUESTADOR hasta el sáb 18:30.

export const CORE_VERSION = '0.1.0';
// Firma del analizador que viaja en ZipResult.analyzer (S15 E23).
export const ANALYZER = `core@${CORE_VERSION}`;

// Primitivas de seguridad (S15 15.11, S06, S13). crypto.ts NO se re-exporta: va por la subruta `@vanguard/core/crypto`.
export * from './key-guards.ts';
export * from './redact.ts';
export * from './untrusted.ts';
export * from './otp.ts';
export * from './egress.ts';

// Análisis (S15 15.9, S09): puntaje, severidad.
export * from './score.ts';
export * from './severity.ts';
export * from './rules/supabase.ts';
export * from './secrets/scan.ts';
export * from './lockfiles/npm.ts';
export * from './lockfiles/composer.ts';
export * from './secrets/rules.ts';
export * from './secrets/entropy.ts';
export * from './ip.ts';
export * from './stack.ts';

// Plantillas deterministas (S11 11.10, S15 15.14 recorte #4): títulos, resumen sin IA y prompts de corrección por regla.
export * from './templates/titles.ts';
export * from './templates/summary.ts';
export * from './templates/fix-prompt.ts';

// IA (S11 11.12): precios, peor caso, costo real y filtro de salida.
export * from './ai.ts';
