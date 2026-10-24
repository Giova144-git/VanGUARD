import { describe, expect, it } from 'vitest';
import { PINTA_PASO, estadoPaso, estadoScan, notaPaso, textoFallo, textoPaso, textoPasoActual } from './pasos';

const cob = (missing: ('supabase' | 'cloudflare' | 'codebase' | 'performance')[]) => ({ coverage: { seen: 4 - missing.length, total: 4, missing } });

describe('estadoPaso', () => {
  it('traduce los estados del servidor', () => {
    expect(estadoPaso(cob([]), { name: 'supabase', status: 'pending' })).toBe('pendiente');
    expect(estadoPaso(cob([]), { name: 'supabase', status: 'running' })).toBe('corriendo');
    expect(estadoPaso(cob([]), { name: 'repo', status: 'skipped' })).toBe('sin_mirar');
    expect(estadoPaso(cob([]), { name: 'psi', status: 'failed' })).toBe('error');
  });
  it('nunca pinta hecho un paso cuyo módulo quedó en coverage.missing', () => {
    expect(estadoPaso(cob(['codebase']), { name: 'repo', status: 'done' })).toBe('sin_mirar');
    expect(estadoPaso(cob(['codebase']), { name: 'supabase', status: 'done' })).toBe('hecho');
    expect(estadoPaso({ coverage: null }, { name: 'resumen_ia', status: 'done' })).toBe('hecho');
  });
  // api() en producción deja pasar un cuerpo fuera de contrato: «__proto__» o «constructor» no son nullish, así que un
  // `MAPA[k] ?? respaldo` no basta. Todo cae a un respaldo neutro (L3), nunca al prototipo ni a TypeError.
  const RAROS = ['__proto__', 'constructor', 'toString', 'valueOf', 'zzz', '', 7, null] as never[];
  it('un estado de paso fuera de contrato es «desconocido»: «—», neutro y hueco', () => {
    for (const k of RAROS) {
      const e = estadoPaso(cob([]), { name: 'supabase', status: k });
      expect(e).toBe('desconocido');
      expect(PINTA_PASO[e]).toEqual({ texto: '—', rol: 'neutra', hueco: true });
    }
  });
  it('un paso fuera de contrato sale con su nombre crudo, sin módulo y sin lanzar', () => {
    for (const k of RAROS) {
      const t = textoPaso(k);
      expect(t).toEqual({ nombre: typeof k === 'string' && k ? k : '—', detalle: '', modulo: null });
      expect(() => estadoPaso(cob(['codebase']), { name: k, status: 'done' })).not.toThrow();
      expect(estadoPaso(cob(['codebase']), { name: k, status: 'done' })).toBe('hecho');
    }
    expect(textoPaso('repo').nombre).toBe('Codebase');
  });
  it('un coverage.missing que no es lista no lanza', () => {
    expect(estadoPaso({ coverage: { seen: 1, total: 4, missing: '__proto__' as never } }, { name: 'repo', status: 'done' })).toBe('hecho');
  });
  it('un estado de auditoría fuera de contrato sale «—» y neutro', () => {
    for (const k of RAROS) expect(estadoScan(k)).toEqual({ texto: '—', rol: 'neutra' });
    expect(estadoScan('failed')).toEqual({ texto: 'Falló', rol: 'mal' });
  });
  it('un paso terminado con error_code de «incompleto» (repo y zip) no sale en verde: «Hecho en parte» y su nota', () => {
    for (const c of ['tripwire', 'osv_unavailable', 'hallazgos_truncados', 'parcial']) {
      const s = { name: 'zip' as const, status: 'done' as const, error_code: c };
      expect(estadoPaso(cob([]), s)).toBe('en_parte');
      expect(PINTA_PASO.en_parte.rol).toBe('neutra');
      expect(notaPaso(s)).not.toBe('');
    }
    expect(notaPaso({ error_code: 'osv_unavailable' })).toMatch(/OSV/);
    expect(estadoPaso(cob(['codebase']), { name: 'zip', status: 'done', error_code: 'parcial' })).toBe('sin_mirar');   // missing manda
    expect(estadoPaso(cob([]), { name: 'zip', status: 'done' })).toBe('hecho');
  });
  it('ZIP_RESULT_MISSING en un paso fallido lleva el texto del ZIP; un código raro o «__proto__», ninguna nota', () => {
    expect(notaPaso({ error_code: 'ZIP_RESULT_MISSING' })).toBe('No llegó el resultado del análisis; vuelve a elegir el ZIP');
    for (const k of [...RAROS, 'ZIP_', 'zip_result_missing']) {
      expect(notaPaso({ error_code: k as never })).toBe('');
      expect(estadoPaso(cob([]), { name: 'zip', status: 'done', error_code: k as never })).toBe('hecho');
    }
  });
  it('el paso actual «waiting_result» (entre E11 y E23) se lee en español; los demás, como textoPaso', () => {
    expect(textoPasoActual('waiting_result')).toBe('esperando el resultado de tu ZIP');
    expect(textoPasoActual('zip')).toBe('Tu ZIP');
    expect(textoPasoActual('__proto__')).toBe('__proto__');
    expect(textoPasoActual(null)).toBeNull();
    expect(textoPasoActual('')).toBeNull();
  });
  it('el error de una auditoría fallida: el código ZIP_* con su texto; un mensaje del servidor, tal cual', () => {
    expect(textoFallo('ZIP_RESULT_MISSING')).toBe('No llegó el resultado del análisis; vuelve a elegir el ZIP');
    expect(textoFallo('No se pudo encolar')).toBe('No se pudo encolar');
    expect(textoFallo(null)).toBe('La auditoría falló');
    expect(textoFallo('')).toBe('La auditoría falló');
  });
});
