import { describe, expect, it } from 'vitest';
import { PINTA_PASO, estadoPaso, estadoScan, textoPaso } from './pasos';

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
});
