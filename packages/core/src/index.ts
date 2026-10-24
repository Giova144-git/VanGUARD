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
