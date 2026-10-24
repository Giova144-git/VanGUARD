// Textos de la revisión de código en cada push (asignaciones/revision-codigo.md §6.1 y §6.2). Todo valor del servidor se
// lee con un mapa cerrado (deMapa) y un texto por defecto: nunca se pinta un código crudo ni «__proto__».
import type { AlertPrefs, CodeReview, CodeReviewConfig, Severity, UmbralAviso } from '@vanguard/contracts';
import { decimal } from './formato';
import { deMapa, severidad, type Rol } from './severidad';

export type Chip = { texto: string; rol: Rol };

// Ajustes (§6.2): las cinco opciones de cada selector, en este orden.
export const UMBRALES: [UmbralAviso, string][] = [
  ['critical', 'Solo crítica'], ['high', 'Alta o más'], ['medium', 'Media o más'], ['low', 'Baja o más'], ['off', 'Nunca'],
];
export const TEXTO_UMBRAL = Object.fromEntries(UMBRALES) as Record<UmbralAviso, string>;

// §5 «Canal»: mientras no haya llamadas, el umbral efectivo de WhatsApp es el más permisivo de los dos. null = nunca.
const ORDEN: Record<Exclude<UmbralAviso, 'off'>, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export function umbralWhatsapp(p: Pick<AlertPrefs, 'review_whatsapp_min' | 'review_voice_min' | 'voice_available'>): Exclude<UmbralAviso, 'off'> | null {
  const canales = p.voice_available ? [p.review_whatsapp_min] : [p.review_whatsapp_min, p.review_voice_min];
  const validos = canales.filter((u): u is Exclude<UmbralAviso, 'off'> => typeof u === 'string' && Object.hasOwn(ORDEN, u));
  return validos.length ? validos.reduce((a, b) => (ORDEN[b] < ORDEN[a] ? b : a)) : null;
}

const MOTIVO: Record<string, string> = {
  sin_contactos: 'No hay contactos con WhatsApp: añádelos en Ajustes',
  unverified: 'Verifica el contacto en Ajustes',
  window_closed: 'Escribe a VanGUARD por WhatsApp para abrir la ventana de 24 h',
  cap: 'Tope de avisos de revisión por hora',
  fuera_de_ventana_demo: 'Avisos de la demo en pausa',
  dry_run: 'Solo se envía desde officialvanguard.com',
  sin_config: 'WhatsApp aún no está configurado',
  envio: 'WhatsApp no aceptó el envío',
  dlq: 'No pudimos terminar el aviso',
};
export const textoMotivo = (r: unknown) => deMapa(MOTIVO, r, 'No se envió');

const TOKEN = 'El token de GitHub ya no vale o no ve el repo: reconéctalo';
const TERMINAR = 'No pudimos terminar la revisión';
const ERROR_REVISION: Record<string, string> = {
  unauthorized: TOKEN, forbidden: TOKEN,
  not_found: 'GitHub ya no tiene ese commit (¿push forzado?)',
  diff_grande: 'Cambio demasiado grande: lanza una auditoría del repo',
  binario: 'Trae archivos que no sabemos leer',
  tripwire: 'Ocultamos una ruta con forma de clave',
  interrumpida: TERMINAR, dlq: TERMINAR, encolar: TERMINAR,
};
export const textoErrorRevision = (c: unknown) => deMapa(ERROR_REVISION, c, 'No pudimos revisarlo entero');

const ENTREGA: Record<string, string> = { 131047: 'Fuera de la ventana de 24 h: escribe a VanGUARD por WhatsApp' };
export const textoEntrega = (c: unknown) => deMapa(ENTREGA, c, 'WhatsApp no lo entregó');

const ERROR_HOOK: Record<string, string> = {
  firma: 'GitHub llegó con otro secreto. Pega el secreto de nuevo.',
  otro_repo: 'Ese webhook es de otro repositorio.',
  sin_push: 'Marca el evento “Pushes” en el webhook.',
  token: 'El token de GitHub ya no vale o no ve el repo. Vuelve a conectarlo.',
};
export const textoErrorHook = (e: unknown) => deMapa(ERROR_HOOK, e, 'GitHub no pudo hablar con VanGUARD. Revisa el webhook.');

// Estado del webhook (chip de la cabecera). `cuandoEvento` lo pone quien llama (formato de hora de la página).
export function chipHook(c: Pick<CodeReviewConfig, 'state' | 'last_event_at' | 'last_ping_at'>, cuandoEvento: (t: string | null) => string): Chip {
  switch (c.state) {
    case 'off': return { texto: 'Desactivada', rol: 'neutra' };
    case 'waiting_ping': return { texto: 'Esperando a GitHub', rol: 'info' };
    case 'connected': return { texto: `Conectada · último evento ${cuandoEvento(c.last_event_at ?? c.last_ping_at)}`, rol: 'bien' };
    case 'error': return { texto: 'Con error', rol: 'mal' };   // el texto del error va al lado, con su arreglo (L3)
    default: return { texto: '—', rol: 'neutra' };
  }
}

// Chip de estado de una revisión. Una parcial suma su propio chip (chipParcial).
export function chipRevision(r: Pick<CodeReview, 'status' | 'error_code' | 'counts' | 'max_severity'>): Chip {
  if (r.status === 'queued' || r.status === 'running') return { texto: 'Revisando…', rol: 'info' };
  if (r.status === 'failed') return { texto: `No se pudo revisar: ${textoErrorRevision(r.error_code)}`, rol: 'aviso' };
  if (r.status !== 'done') return { texto: '—', rol: 'neutra' };
  const n = Object.values(r.counts ?? {}).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (!n) return { texto: 'Sin hallazgos nuevos', rol: 'bien' };
  const peor = severidad(r.max_severity as Severity | null);
  return { texto: `${n} ${n === 1 ? 'nuevo' : 'nuevos'} · ${peor.etiqueta}`, rol: peor.rol };
}
export const chipParcial = (r: Pick<CodeReview, 'partial' | 'error_code'>): Chip | null =>
  r.partial ? { texto: `Revisión incompleta: ${textoErrorRevision(r.error_code)}`, rol: 'aviso' } : null;

// state 'none' con motivo (el BACK, tras B7): sin motivo no hay chip.
const SIN_AVISO: Record<string, Chip | null> = {
  bajo_umbral: { texto: 'Por debajo de tu umbral (Ajustes)', rol: 'neutra' },
  fork: { texto: 'PR desde un fork: sin aviso', rol: 'neutra' },
  ya_avisado_pr: { texto: 'Ya avisado en el PR', rol: 'neutra' },
};
const ENTREGADO: Record<string, string> = { queued: 'Enviado', sent: 'Enviado', delivered: 'Entregado', read: 'Leído' };
// Chip del aviso. voice_pending no va en la fila: se leería como «te vamos a llamar» (va en la fila abierta).
export function chipAviso(a: CodeReview['alert']): Chip | null {
  if (a.state === 'pending') return { texto: 'Avisando…', rol: 'info' };
  if (a.state === 'not_sent') return { texto: `Aviso no enviado: ${textoMotivo(a.reason)}`, rol: 'aviso' };
  if (a.state === 'none') return deMapa(SIN_AVISO, a.reason, null);
  if (a.state !== 'sent') return null;
  if (a.delivery === 'failed') return { texto: `WhatsApp no entregado: ${textoEntrega(a.delivery_error)}`, rol: 'aviso' };
  const en = typeof a.seconds === 'number' && Number.isFinite(a.seconds) ? ` en ${decimal(a.seconds, 1)} s` : '';
  const estado = deMapa(ENTREGADO, a.delivery, 'Enviado');
  return { texto: `WhatsApp${en} · ${estado}`, rol: a.delivery === 'delivered' || a.delivery === 'read' ? 'bien' : 'info' };
}
