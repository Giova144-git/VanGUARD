import { redact } from '@vanguard/core';

// Una línea JSON por evento para Workers Logs (S15 15.3), siempre pasada por redact(). Aun así, prohibido registrar
// tokens, cuerpos de terceros, teléfonos completos o filas de clientes: redact() es la red, no el permiso.
export type Nivel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: Nivel, event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify(redact({ level, event, ...fields })));
}
