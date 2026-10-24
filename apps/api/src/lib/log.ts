// Una línea JSON por evento para Workers Logs (S15 15.3). Prohibido registrar tokens, cuerpos de terceros,
// teléfonos completos o filas de clientes. Cuando exista packages/core/src/redact.ts (hito 2), cada línea pasa
// por redact() antes de salir; hasta entonces solo se registran campos nuestros (ids, contadores, códigos).
export type Nivel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: Nivel, event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, event, ...fields }));
}
