import { describe, expect, it } from 'vitest';
import { RESPALDO_ESCANEO, textoErrorZip } from './errores-escaneo';

describe('textoErrorZip', () => {
  it('traduce los códigos del ZIP con el mapa de S09 §09.3', () => {
    expect(textoErrorZip('ZIP_INVALID')).toBe('El archivo no es un ZIP válido o está dañado');
    expect(textoErrorZip('ZIP_BAD_MAGIC')).toBe('El archivo no es un ZIP');
    expect(textoErrorZip('ZIP_TOO_BIG')).toBe('El ZIP pesa más de 25 MB');
    expect(textoErrorZip('ZIP_TOO_MANY_ENTRIES')).toBe('El ZIP tiene más de 20 000 archivos');
    expect(textoErrorZip('ZIP_TOO_BIG_UNCOMPRESSED')).toBe('Descomprimido supera 40 MB (posible bomba zip)');
    expect(textoErrorZip('ZIP_RATIO')).toBe('Un archivo del ZIP se comprime de forma sospechosa (posible bomba zip)');
    expect(textoErrorZip('ZIP_REJECTED')).toBe('No pudimos abrir el ZIP; prueba con uno más pequeño');
  });

  it('pide un .zip si el nombre o el tamaño no lo son', () => {
    expect(textoErrorZip('ZIP_NOT_ZIP_NAME')).toBe('Elige un archivo .zip');
    expect(textoErrorZip('ZIP_TOO_SMALL')).toBe('Elige un archivo .zip');
  });

  it('el resultado que no llegó tiene el mismo texto con el nombre del plan y con el del código', () => {
    expect(textoErrorZip('ZIP_RESULT_MISSING')).toBe('No llegó el resultado del análisis; vuelve a elegir el ZIP');
    expect(textoErrorZip('ZIP_NOT_FOUND')).toBe(textoErrorZip('ZIP_RESULT_MISSING'));
  });

  it('un código desconocido o del prototipo cae al respaldo', () => {
    for (const c of ['ZIP_OTRO', '', 'zip_invalid', '__proto__', 'constructor', 'toString', 'hasOwnProperty'])
      expect(textoErrorZip(c)).toBe(RESPALDO_ESCANEO);
    expect(RESPALDO_ESCANEO).toBe('No pudimos analizar el código');
  });
});
