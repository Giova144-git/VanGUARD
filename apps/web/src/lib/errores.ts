import { sinBidi } from './bidi';

// Error de la API tal como lo ve la UI (S14 §14.8). El `message` del servidor ya viene en español y se muestra tal cual,
// salvo los controles bidi (lib/bidi.ts), que se ven: así ningún sitio que pinte un error los deja pasar crudos.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfter?: number;                          // segundos de la cabecera Retry-After de un 429, si vino

  constructor(status: number, code: string, message: string, requestId?: string, details?: Record<string, unknown>, retryAfter?: number) {
    super(typeof message === 'string' ? sinBidi(message) : message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = typeof requestId === 'string' ? sinBidi(requestId) : requestId;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

export const esApiError = (e: unknown): e is ApiError => e instanceof ApiError;

// Mensaje corto para el sitio del botón o del bloque cuando el servidor no manda uno útil.
export function mensajeDe(e: unknown): string {
  if (!esApiError(e)) return 'Algo falló';
  if (e.code === 'network') return 'Sin conexión con VanGUARD';
  if (e.code === 'rate_limited') return 'Espera un minuto';
  return e.message || 'Algo falló';
}
