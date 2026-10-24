// Tipos compartidos del análisis local del ZIP (F-18, S09 09.3). Sin imports de @vanguard/core: zip-local.ts y la UI
// los usan desde fuera de zip/, y lint-imports solo deja importar core (y leer, analizar o el worker) desde aquí dentro.
import type { ZipResult } from '@vanguard/contracts';

// Topes de S09 09.3 (LIM): ZIP ≤ 25 MB, ≤ 20 000 entradas, archivo leído ≤ 1 MB, total ≤ 40 MB, ruta ≤ 512, ≤ 32 niveles,
// ratio ≤ 100 para archivos de más de 1 MB.
export const LIM = { zip: 26_214_400, entradas: 20_000, archivo: 1_000_000, total: 41_943_040, ruta: 512, prof: 32, ratio: 100 } as const;
// El tamaño mínimo de un ZIP (solo el fin de directorio central) y el de ScanCreate.
export const ZIP_MIN = 22;

export type CodigoZip =
  | 'ZIP_TOO_BIG' | 'ZIP_BAD_MAGIC' | 'ZIP_TOO_MANY_ENTRIES' | 'ZIP_TOO_BIG_UNCOMPRESSED' | 'ZIP_RATIO' | 'ZIP_INVALID'
  | 'ZIP_NOT_ZIP_NAME' | 'ZIP_TOO_SMALL'   // comprobaciones del FRONT antes de abrir el archivo
  | 'ZIP_REJECTED';                        // el Worker murió (memoria) o no respondió a tiempo

export type Inventario = {
  entradas: number;               // del directorio central, directorios incluidos
  leidos: number;                 // archivos decodificados a texto
  omitidos: number;               // fuera de la lista blanca, binarios, demasiado grandes o con ruta hostil
  tiene_git: boolean;             // hay una carpeta .git/ (aviso CB_ZIP_HAS_GIT, no se envía)
  rutas: { p: string; s: number }[];   // todas las rutas normalizadas con su tamaño declarado (para reglasEnv)
};

// Avisos que se quedan en el navegador: su rule_id no está en la lista blanca de ZipFinding a propósito.
export type CodigoAviso = 'CB_ZIP_HAS_GIT' | 'CB_NO_LOCKFILE' | 'CB_SENSITIVE_FILE' | 'RECORTADO';
export type AvisoZip = { codigo: CodigoAviso; texto: string };

export type ResumenZip = { archivos: number; deps: number; lockfiles: number; secretos: number; env: number };

export type Analisis = { resultado: ZipResult; avisos: AvisoZip[]; resumen: ResumenZip };

// Mensajes entre zip-local.ts (hilo principal) y zip/zip.worker.ts. El worker no manda nunca contenido de archivos.
export type FaseZip = 'leyendo' | 'analizando';
export type EntradaWorker = { archivo: File };
export type SalidaWorker =
  | { tipo: 'progreso'; fase: FaseZip }
  | { tipo: 'listo'; analisis: Analisis }
  | { tipo: 'error'; codigo: CodigoZip };
