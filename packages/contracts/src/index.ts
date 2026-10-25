// @vanguard/contracts: único contrato entre FRONT y BACK. Lo edita solo el ORQUESTADOR.
export * from './comun.ts';
export * from './api.ts';
export * from './estado.ts';
export * from './ingest.ts';
export * from './realtime.ts';
export * from './perf.ts';
export * from './export.ts';
export * from './codebase.ts';
export * from './wiki.ts';
export * from './historial.ts';
// Tipos de la base generados (T6): solo tipos, para createClient<Database> del BACK.
export type { Database, Json as DbJson, Tables, TablesInsert, TablesUpdate } from './database.types.ts';
export { fixtures } from './fixtures/index.ts';
