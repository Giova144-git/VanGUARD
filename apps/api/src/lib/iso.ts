// Postgres devuelve `2026-10-24T18:04:11.123456+00:00`; el contrato quiere siempre `…Z` (S15 15.3).
export function iso(x: string | Date): string {
  return new Date(x).toISOString();
}
