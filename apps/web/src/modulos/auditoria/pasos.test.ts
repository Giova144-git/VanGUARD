import { describe, expect, it } from 'vitest';
import { fixtures as fx, type AuditDelta } from '@vanguard/contracts';
import { PINTA_PASO, estadoPaso, estadoScan, faseEspera, hayCriticosNuevos, notaPaso, textoFallo, textoPaso, textoPasoActual } from './pasos';

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
  it('una medición (kind lighthouse, «Medir ahora»): su paso actual y su fallo en español', () => {
    expect(textoPasoActual('psi-mobile')).toBe('midiendo móvil con PageSpeed Insights');
    expect(textoPasoActual('psi-desktop')).toBe('midiendo escritorio con PageSpeed Insights');
    expect(textoPasoActual('perf-compare')).toBe('comparando con la medición anterior');
    expect(textoPasoActual('psi')).toBe('Rendimiento');                                   // un full_audit con psi (P1-b)
    expect(textoPasoActual('psi', 'lighthouse')).toBe('midiendo con PageSpeed Insights (suele tardar menos de un minuto)');   // el BACK
    for (const k of ['psi-mobile', 'psi-desktop', 'psi'] as const) expect(textoPasoActual(k, 'lighthouse')).not.toMatch(/repetici|~1 min/);
    expect(notaPaso({ error_code: 'runtime_error' })).toBe('Lighthouse no pudo cargar la página: esta medición quedó sin cifras');
    expect(estadoPaso({ coverage: null }, { name: 'psi', status: 'done', error_code: 'runtime_error' })).toBe('en_parte');
    expect(textoFallo(null, 'lighthouse')).toBe('La medición falló');
    expect(textoFallo(null, 'full_audit')).toBe('La auditoría falló');
  });
});

// Vigía en la espera (useEspera): la fase sale del estado de la corrida y, al terminar una auditoría, del delta (E51).
describe('faseEspera', () => {
  const d = fx.auditDelta as unknown as AuditDelta;
  const conCritico = { ...d, first: false, counts: { ...(d as Extract<AuditDelta, { available: true }>).counts,
    new: { supabase: { critical: 1, high: 0, medium: 0, low: 0, info: 0 } } } } as unknown as AuditDelta;
  it('en cola o corriendo espera; falla → fallo; sin corrida o estado raro → inactiva', () => {
    expect(faseEspera(undefined, { cargando: false })).toBe('inactiva');
    expect(faseEspera({ status: 'queued', kind: 'full_audit' }, { cargando: false })).toBe('esperando');
    expect(faseEspera({ status: 'running', kind: 'lighthouse' }, { cargando: false })).toBe('esperando');
    expect(faseEspera({ status: 'failed', kind: 'full_audit' }, { cargando: false })).toBe('fallo');
    expect(faseEspera({ status: '??' as never, kind: 'full_audit' }, { cargando: false })).toBe('inactiva');
  });
  it('terminada: espera al delta; con críticos nuevos alerta; si no, bien; una medición no mira el delta', () => {
    const ok = { status: 'succeeded', kind: 'full_audit' } as const;
    expect(faseEspera(ok, { cargando: true })).toBe('esperando');
    expect(faseEspera(ok, { cargando: false })).toBe('bien');
    expect(faseEspera(ok, { cargando: false, datos: conCritico })).toBe('alerta');
    expect(faseEspera({ status: 'succeeded', kind: 'lighthouse' }, { cargando: true })).toBe('bien');
  });
  it('hayCriticosNuevos: solo con foto, con anterior y con algún crítico nuevo; un conteo raro no lanza', () => {
    expect(hayCriticosNuevos(conCritico)).toBe(true);
    expect(hayCriticosNuevos({ ...conCritico, first: true } as AuditDelta)).toBe(false);
    expect(hayCriticosNuevos({ available: false, scan_run_id: d.scan_run_id, reason: 'en_curso' })).toBe(false);
    expect(hayCriticosNuevos(undefined)).toBe(false);
    expect(hayCriticosNuevos({ ...conCritico, counts: { new: { supabase: null } } } as unknown as AuditDelta)).toBe(false);
  });
});
