// Códigos de error del análisis de código → texto (S09 §09.3). El BACK guarda solo el código y el ZIP local da los mismos.
import type { CodigoZip } from '@/modulos/codebase/zip/tipos';

const NO_ZIP = 'Elige un archivo .zip';
const SIN_RESULTADO = 'No llegó el resultado del análisis; vuelve a elegir el ZIP';

// ZIP_NOT_FOUND es el nombre del plan y ZIP_RESULT_MISSING el que escribe E11 al reemplazar un scan que esperaba.
const TEXTO_ZIP: Record<CodigoZip | 'ZIP_NOT_FOUND' | 'ZIP_RESULT_MISSING', string> = {
  ZIP_INVALID: 'El archivo no es un ZIP válido o está dañado',
  ZIP_BAD_MAGIC: 'El archivo no es un ZIP',
  ZIP_TOO_BIG: 'El ZIP pesa más de 25 MB',
  ZIP_TOO_MANY_ENTRIES: 'El ZIP tiene más de 20 000 archivos',
  ZIP_TOO_BIG_UNCOMPRESSED: 'Descomprimido supera 40 MB (posible bomba zip)',
  ZIP_RATIO: 'Un archivo del ZIP se comprime de forma sospechosa (posible bomba zip)',
  ZIP_NOT_FOUND: SIN_RESULTADO,
  ZIP_RESULT_MISSING: SIN_RESULTADO,
  ZIP_REJECTED: 'No pudimos abrir el ZIP; prueba con uno más pequeño',
  ZIP_NOT_ZIP_NAME: NO_ZIP,
  ZIP_TOO_SMALL: NO_ZIP,
};

export const RESPALDO_ESCANEO = 'No pudimos analizar el código';

// hasOwn: un código «__proto__» o «toString» que llegue del servidor cae al respaldo, nunca al prototipo.
export const textoErrorZip = (codigo: string): string =>
  Object.hasOwn(TEXTO_ZIP, codigo) ? TEXTO_ZIP[codigo as keyof typeof TEXTO_ZIP] : RESPALDO_ESCANEO;
