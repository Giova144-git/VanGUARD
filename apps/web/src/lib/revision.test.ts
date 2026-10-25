import { describe, expect, it } from 'vitest';
import { fixtures as fx, type CodeReview } from '@vanguard/contracts';
import {
  chipAccionWhatsapp, chipAviso, chipBloqueo, chipEstadoBloqueo, chipHook, chipParcial, chipPr, chipRevision, sePuedeAprobar, sePuedeRepublicar, textoErrorBloqueo,
  textoErrorCierre, textoErrorHook, textoErrorRevision, textoMotivo, textoParcialBloqueo, textoPrueba, textoSilenciado, umbralWhatsapp,
} from './revision';

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

// Bloqueo de merge (bloqueo-merge-criticos.md §6.2 y §6.4; anexo de cierre de PR).
describe('chips del bloqueo de merge (§6.2)', () => {
  type Gate = NonNullable<CodeReview['gate']>;
  const gate = (g: Partial<Gate>): Gate => ({ blocking: 1, findings: [], state: 'failure', error: null, published_at: null, override_at: null, ...g });
  const pr = (g: Partial<Gate>, extra: Partial<CodeReview> = {}) => ({ gate: gate(g), event: 'pull_request' as const, branch: 'main', status: 'done' as const, partial: false, ...extra });

  it('PR con ✗ cuenta lo que bloquea (con el umbral alto, «o alto»); push con ✗, «Ya está en {rama}»', () => {
    expect(chipBloqueo(pr({ blocking: 1 }), 'critical')).toEqual({ texto: '✗ Merge bloqueado · 1 crítico', rol: 'mal' });
    expect(chipBloqueo(pr({ blocking: 3 }), 'high')).toEqual({ texto: '✗ Merge bloqueado · 3 críticos o altos', rol: 'mal' });
    expect(chipBloqueo(pr({ blocking: null }))?.texto).toBe('✗ Merge bloqueado');
    expect(chipBloqueo(pr({}, { event: 'push' }))).toEqual({ texto: '✗ Ya está en', ltr: 'main', rol: 'mal' });   // la rama, en <bdi>
  });

  it('✓, aprobado a mano, error (incompleta o fallida), pendiente y sin publicar', () => {
    expect(chipBloqueo(pr({ state: 'success', blocking: 0 }))).toEqual({ texto: '✓ GitHub', rol: 'bien' });
    expect(chipBloqueo(pr({ state: 'success', override_at: '2026-10-24T19:50:00.000Z' }))).toEqual({ texto: '✓ Aprobado a mano', rol: 'aviso' });
    expect(chipBloqueo(pr({ state: 'failure', override_at: '2026-10-24T19:50:00.000Z' }))?.texto).toBe('Aprobando a mano…');
    expect(chipBloqueo(pr({ state: 'error' }, { partial: true }))).toEqual({ texto: 'GitHub: no pudimos leerlo entero', rol: 'aviso' });
    expect(chipBloqueo(pr({ state: 'error' }, { status: 'failed' }))).toEqual({ texto: 'GitHub: no pudimos revisar', rol: 'aviso' });
    expect(chipBloqueo(pr({ state: 'pending' }))).toEqual({ texto: 'GitHub: revisando…', rol: 'info' });
    expect(chipBloqueo(pr({ state: 'success', error: 'estado_ajeno' }))).toEqual({ texto: 'Otro publicó “VanGUARD” en este commit', rol: 'mal' });   // P1
    expect(chipBloqueo(pr({ state: null, error: 'dry_run' }))).toEqual({ texto: 'No publicado: Solo se publica desde officialvanguard.com', rol: 'neutra' });
    expect(chipBloqueo(pr({ state: null, error: 'otro_repo' }))?.texto).toBe('No publicado: El token de estados es de otro repo');
    expect(chipBloqueo(pr({ state: null, error: null }))).toBeNull();
    expect(chipBloqueo({ gate: undefined, event: 'push', branch: 'main', status: 'done', partial: false })).toBeNull();
  });

  it('mapa cerrado: un gate.error desconocido sale «No se publicó»; un estado fuera de contrato no pinta nada', () => {
    for (const k of RAROS) {
      expect(textoErrorBloqueo(k)).toBe('No se publicó');
      expect(chipBloqueo(pr({ state: null, error: k }))?.texto ?? 'No publicado: No se publicó').toBe('No publicado: No se publicó');
      expect(chipBloqueo(pr({ state: k }))).toBeNull();
      expect(chipEstadoBloqueo({ state: k })).toEqual({ texto: '—', rol: 'neutra' });
      expect(textoParcialBloqueo(k)).toBe('No pudimos leer el cambio entero');
      expect(textoErrorCierre(k)).toBe('GitHub no lo aceptó');
      expect(textoPrueba(k)).toBe('un estado de prueba');
    }
    expect(textoParcialBloqueo('binario')).not.toContain('grande');
    expect(chipEstadoBloqueo({ state: 'unchecked' })).toEqual({ texto: 'Publicando en GitHub', rol: 'info' });
  });

  it('cierre del PR (anexo): cerrado por VanGUARD, reabierto a mano, reabierto y cierre fallido con su motivo', () => {
    expect(chipPr(pr({ pr_action: 'closed' }))).toEqual({ texto: 'PR cerrado por VanGUARD', rol: 'aviso' });
    expect(chipPr(pr({ pr_action: 'reopened_by_human' }))?.texto).toBe('PR reabierto a mano');
    expect(chipPr(pr({ pr_action: 'reopened' }))?.texto).toBe('PR reabierto');
    expect(chipPr(pr({ pr_action: 'close_failed', pr_close_error: 'forbidden' }))).toEqual({ texto: 'No pudimos cerrar el PR', rol: 'aviso' });
    expect(textoErrorCierre('forbidden')).toBe('al token le falta Pull requests: Read and write');
    expect(chipPr(pr({ pr_action: null }))).toBeNull();
    expect(chipPr(pr({ pr_action: 'zzz' as never }))).toBeNull();
  });

  it('«Dar por bueno» solo con ✗ o error y sin aprobación previa', () => {
    expect(sePuedeAprobar(gate({ state: 'failure' }))).toBe(true);
    expect(sePuedeAprobar(gate({ state: 'error' }))).toBe(true);
    expect(sePuedeAprobar(gate({ state: 'success' }))).toBe(false);
    expect(sePuedeAprobar(gate({ state: 'failure', override_at: '2026-10-24T19:50:00.000Z' }))).toBe(false);
    expect(sePuedeAprobar(undefined)).toBe(false);
  });

  it('«Publicar de nuevo» (P1) solo si no se publicó o lo último falló; un «VanGUARD» ajeno lo republica el BACK', () => {
    expect(sePuedeRepublicar(gate({ state: null, error: 'sin_token' }))).toBe(true);
    expect(sePuedeRepublicar(gate({ state: 'failure', error: 'red' }))).toBe(true);
    expect(sePuedeRepublicar(gate({ state: 'failure', error: null }))).toBe(false);
    expect(sePuedeRepublicar(gate({ state: 'success', error: 'estado_ajeno' }))).toBe(false);
    expect(sePuedeRepublicar(undefined)).toBe(false);
  });
});

// Anexo de botones de WhatsApp (avisos-whatsapp-botones.md, «FRONT»). Horas en Caracas (UTC−4).
describe('acciones desde WhatsApp y repo silenciado', () => {
  const AHORA = new Date('2026-10-24T19:40:00.000Z');
  it('cada acción con su texto y su hora; sin acción, sin chip; una desconocida o «__proto__», el texto por defecto', () => {
    const a = (whatsapp_action: unknown, whatsapp_action_at: string | null = '2026-10-24T19:22:05.000Z') =>
      chipAccionWhatsapp({ whatsapp_action: whatsapp_action as never, whatsapp_action_at }, AHORA);
    expect(a('fix_sent')).toEqual({ texto: 'Arreglo enviado por WhatsApp · 15:22', rol: 'info' });
    expect(a('issue_created')).toEqual({ texto: 'Issue creado por WhatsApp · 15:22', rol: 'bien' });
    expect(a('muted')).toEqual({ texto: 'Silenciado 1 h por WhatsApp · 15:22', rol: 'neutra' });
    expect(a('pr_reopened')?.texto).toBe('PR reabierto por WhatsApp · 15:22');
    expect(a('pr_reopened', null)?.texto).toBe('PR reabierto por WhatsApp');
    expect(a('fix_sent', 'no-es-fecha')?.texto).toBe('Arreglo enviado por WhatsApp');
    expect(a(null)).toBeNull();
    expect(a(undefined)).toBeNull();
    expect(chipAccionWhatsapp(alerta({}), AHORA)).toBeNull();   // BACK de antes del anexo: el campo no viene
    for (const k of RAROS.filter((x) => x !== null)) expect(a(k)?.texto).toBe('Acción por WhatsApp · 15:22');
  });
  it('«Silenciado hasta hh:mm» solo con muted_until en el futuro', () => {
    expect(textoSilenciado({ muted_until: '2026-10-24T20:30:00.000Z' }, AHORA)).toBe('Silenciado hasta 16:30');
    expect(textoSilenciado({ muted_until: '2026-10-25T04:30:00.000Z' }, AHORA)).toBe('Silenciado hasta 25-10 00:30');
    expect(textoSilenciado({ muted_until: '2026-10-24T19:39:59.000Z' }, AHORA)).toBeNull();
    expect(textoSilenciado({ muted_until: null }, AHORA)).toBeNull();
    expect(textoSilenciado({}, AHORA)).toBeNull();
    expect(textoSilenciado({ muted_until: 'mañana' }, AHORA)).toBeNull();
    expect(textoSilenciado(null, AHORA)).toBeNull();
  });
});
