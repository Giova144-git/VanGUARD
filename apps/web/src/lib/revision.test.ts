import { describe, expect, it } from 'vitest';
import { fixtures as fx, type CodeReview } from '@vanguard/contracts';
import { chipAviso, chipHook, chipParcial, chipRevision, textoErrorHook, textoErrorRevision, textoMotivo, umbralWhatsapp } from './revision';

const RAROS = ['__proto__', 'constructor', 'toString', 'zzz', '', 7, null] as never[];
const alerta = (a: Partial<CodeReview['alert']>): CodeReview['alert'] =>
  ({ state: 'none', reason: null, delivery: null, delivery_error: null, voice_pending: false, notified_at: null, seconds: null, ...a });

describe('textos de la revisión de código (§6.1)', () => {
  it('aviso no enviado por la ventana de 24 h cerrada y entrega fallida con 131047: cada uno dice qué hacer', () => {
    expect(chipAviso(alerta({ state: 'not_sent', reason: 'window_closed' })))
      .toEqual({ texto: 'Aviso no enviado: Escribe a VanGUARD por WhatsApp para abrir la ventana de 24 h', rol: 'aviso' });
    expect(chipAviso(alerta({ state: 'sent', delivery: 'failed', delivery_error: '131047' })))
      .toEqual({ texto: 'WhatsApp no entregado: Fuera de la ventana de 24 h: escribe a VanGUARD por WhatsApp', rol: 'aviso' });
    expect(chipAviso(alerta({ state: 'sent', delivery: 'failed', delivery_error: '470' }))?.texto).toBe('WhatsApp no entregado: WhatsApp no lo entregó');
  });
  it('enviado y leído con sus segundos; bajo el umbral, neutro; sin aviso, sin chip', () => {
    expect(chipAviso(fx.codeReviewState.recent[0]!.alert as CodeReview['alert'])).toEqual({ texto: 'WhatsApp en 6,4 s · Leído', rol: 'bien' });
    expect(chipAviso(alerta({ state: 'none', reason: 'bajo_umbral' }))).toEqual({ texto: 'Por debajo de tu umbral (Ajustes)', rol: 'neutra' });
    expect(chipAviso(alerta({}))).toBeNull();
    expect(chipAviso(alerta({ state: 'none', reason: 'fork' }))).toEqual({ texto: 'PR desde un fork: sin aviso', rol: 'neutra' });
    expect(chipAviso(alerta({ state: 'none', reason: 'ya_avisado_pr' }))).toEqual({ texto: 'Ya avisado en el PR', rol: 'neutra' });
    for (const k of RAROS) expect(chipAviso(alerta({ state: 'none', reason: k }))).toBeNull();
  });
  it('un código fuera de contrato o «__proto__» cae al texto por defecto, nunca al código crudo', () => {
    for (const k of RAROS) {
      expect(textoMotivo(k)).toBe('No se envió');
      expect(textoErrorRevision(k)).toBe('No pudimos revisarlo entero');
      expect(textoErrorHook(k)).toBe('GitHub no pudo hablar con VanGUARD. Revisa el webhook.');
      expect(chipHook({ state: k, last_event_at: null, last_ping_at: null }, () => '—')).toEqual({ texto: '—', rol: 'neutra' });
    }
    expect(textoErrorRevision('forbidden')).toBe('El token de GitHub ya no vale o no ve el repo: reconéctalo');
  });
  it('estado de una revisión: en curso, sin nuevos, con nuevos (peor severidad), fallida e incompleta', () => {
    const cero = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    expect(chipRevision({ status: 'running', error_code: null, counts: cero, max_severity: null })).toEqual({ texto: 'Revisando…', rol: 'info' });
    expect(chipRevision({ status: 'done', error_code: null, counts: cero, max_severity: null })).toEqual({ texto: 'Sin hallazgos nuevos', rol: 'bien' });
    expect(chipRevision({ status: 'done', error_code: null, counts: { ...cero, high: 2, low: 1 }, max_severity: 'high' })).toEqual({ texto: '3 nuevos · Alta', rol: 'mal' });
    expect(chipRevision({ status: 'failed', error_code: 'interrumpida', counts: cero, max_severity: null })).toEqual({ texto: 'No se pudo revisar: No pudimos terminar la revisión', rol: 'aviso' });
    expect(chipParcial({ partial: true, error_code: 'diff_grande' })?.texto).toBe('Revisión incompleta: Cambio demasiado grande: lanza una auditoría del repo');
    expect(chipParcial({ partial: false, error_code: null })).toBeNull();
  });
  it('umbral efectivo de WhatsApp: sin llamadas, el más permisivo de los dos; los dos en «Nunca», null', () => {
    expect(umbralWhatsapp({ review_whatsapp_min: 'high', review_voice_min: 'critical', voice_available: false })).toBe('high');
    expect(umbralWhatsapp({ review_whatsapp_min: 'off', review_voice_min: 'critical', voice_available: false })).toBe('critical');
    expect(umbralWhatsapp({ review_whatsapp_min: 'critical', review_voice_min: 'medium', voice_available: false })).toBe('medium');
    expect(umbralWhatsapp({ review_whatsapp_min: 'critical', review_voice_min: 'medium', voice_available: true })).toBe('critical');
    expect(umbralWhatsapp({ review_whatsapp_min: 'off', review_voice_min: 'off', voice_available: false })).toBeNull();
    expect(umbralWhatsapp({ review_whatsapp_min: '__proto__' as never, review_voice_min: 'off', voice_available: false })).toBeNull();
  });
});
