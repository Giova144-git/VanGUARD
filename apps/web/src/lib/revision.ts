// Textos de la revisión de código en cada push (asignaciones/revision-codigo.md §6.1 y §6.2). Todo valor del servidor se
// lee con un mapa cerrado (deMapa) y un texto por defecto: nunca se pinta un código crudo ni «__proto__».
import type { AlertPrefs, CodeReview, CodeReviewConfig, CommitStatusState, MergeGateConfig, MergeGateMin, Severity, UmbralAviso } from '@vanguard/contracts';
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

// ── Bloqueo de merge con críticos (bloqueo-merge-criticos.md §6.1, §6.2 y §6.4; anexo bloqueo-merge-cierre-pr.md) ──
export const UMBRALES_BLOQUEO: [MergeGateMin, string][] = [['critical', 'Solo crítico'], ['high', 'Crítico o alto']];

// Estado del bloqueo (cabecera de la sección). En P0 lo normal es `unchecked`: publica sin saber si GitHub exige el check.
const ESTADO_BLOQUEO: Record<string, Chip> = {
  off: { texto: 'Apagado', rol: 'neutra' },
  needs_token: { texto: 'Falta el token de estados', rol: 'aviso' },
  unchecked: { texto: 'Publicando en GitHub', rol: 'info' },
  needs_protection: { texto: 'Falta la protección de rama', rol: 'aviso' },
  active: { texto: 'Activo: GitHub exige “VanGUARD”', rol: 'bien' },
  error: { texto: 'Con error', rol: 'mal' },
};
export const chipEstadoBloqueo = (g: Pick<MergeGateConfig, 'state'>): Chip => deMapa(ESTADO_BLOQUEO, g.state, { texto: '—', rol: 'neutra' });

// last_error de la config: solo problemas del TOKEN al publicar (un 422 de un commit va en su revisión).
const ERROR_TOKEN_BLOQUEO: Record<string, string> = {
  token: 'El token de estados caducó o se revocó: pega uno nuevo.',
  forbidden: 'El token no puede publicar estados: márcale Commit statuses: Read and write, o espera la aprobación de la organización.',
  not_found: 'El token de estados no ve el repo: márcalo en Only select repositories.',
};
export const textoErrorTokenBloqueo = (e: unknown) => deMapa(ERROR_TOKEN_BLOQUEO, e, 'El token de estados falló al publicar: pega uno nuevo.');

// Apagar el bloqueo (o «Revisar cada push») con GitHub exigiendo el check deja los PR en «Expected». Sin la protección
// leída (P0, o nunca comprobada) se avisa siempre que el bloqueo no esté apagado; leída (P1), salvo que GitHub no lo exija.
export const avisoAlApagar = (g: (Pick<MergeGateConfig, 'state'> & { protection?: MergeGateConfig['protection'] }) | null | undefined) =>
  !!g && g.state !== 'off' && g.protection?.required !== 'no';

// P1 (§6.1): lo que E53 leyó de la protección de la rama con el token de lectura. Valores fuera de contrato: nada.
const PROTECCION_REQUERIDA: Record<string, string> = {
  yes: 'GitHub exige “VanGUARD” para fusionar en la rama vigilada.',
  other_source: 'GitHub exige “VanGUARD” de una app concreta. Elige “Any source” en ese check para que cuente el nuestro.',
  no: 'GitHub aún no exige “VanGUARD”: un ✗ solo avisa. Sigue los pasos para proteger la rama.',
  unknown: 'No pudimos leer la protección de la rama.',
};
const PROTECCION_ADMINS: Record<string, string> = {
  bypass: 'Los admins del repo pueden saltárselo.', enforced: 'Vale también para los admins.',
};
export function textosProteccion(p: NonNullable<MergeGateConfig['protection']>): string[] {
  return [
    deMapa(PROTECCION_REQUERIDA, p.required, ''),
    deMapa(PROTECCION_ADMINS, p.admins, ''),
    p.pr_required === 'unknown' ? 'Comprueba que “Require a pull request before merging” está marcado: con un token de solo lectura no lo vemos.' : '',
  ].filter(Boolean);
}
export const AVISO_APAGAR_BLOQUEO = 'Si GitHub exige el check “VanGUARD”, los pull requests quedarán en “Expected” y no se podrán fusionar. Quita el check en GitHub antes, o déjalo encendido.';

// gate.error de una revisión (§6.4): por qué no se publicó su estado. Texto por defecto «No se publicó».
const ERROR_BLOQUEO: Record<string, string> = {
  sin_token: 'Falta el token de estados',
  dry_run: 'Solo se publica desde officialvanguard.com',
  sin_calculo: 'Se activó después de esta revisión',
  otro_repo: 'El token de estados es de otro repo',
  unauthorized: 'El token de estados caducó',
  forbidden: 'El token no puede publicar estados',
  not_found: 'El token no ve el repo',
  limite: 'GitHub rechazó el estado de este commit',
  red: 'GitHub no respondió',
  dlq: 'No pudimos terminar',
  estado_ajeno: 'Otro publicó “VanGUARD” en este commit',
};
export const textoErrorBloqueo = (e: unknown) => deMapa(ERROR_BLOQUEO, e, 'No se publicó');

// «1 crítico» · «2 críticos» · con el umbral alto, «1 crítico o alto» · «2 críticos o altos».
export function cuentaBloqueo(n: number, min: unknown) {
  const alto = min === 'high';
  return n === 1 ? `1 crítico${alto ? ' o alto' : ''}` : `${n} críticos${alto ? ' o altos' : ''}`;
}

// Chip del check «VanGUARD» de una revisión (§6.2). Solo si la revisión trae `gate` (con el bloqueo encendido al revisar).
// `min`: el umbral de la config, para decir «crítico(s) o alto(s)».
export function chipBloqueo(r: Pick<CodeReview, 'gate' | 'event' | 'branch' | 'status' | 'partial'>, min?: unknown): Chip | null {
  const g = r.gate;
  if (!g) return null;
  if (g.error === 'estado_ajeno') return { texto: textoErrorBloqueo('estado_ajeno'), rol: 'mal' };
  // «Dar por bueno» ya guardado y el paso `estado` de la cola aún sin publicar el ✓.
  if (g.override_at && g.state !== 'success') return { texto: 'Aprobando a mano…', rol: 'info' };
  switch (g.state) {
    case 'failure': {
      if (r.event !== 'pull_request') return { texto: `✗ Ya está en ${r.branch}`, rol: 'mal' };
      const n = typeof g.blocking === 'number' && Number.isFinite(g.blocking) ? g.blocking : 0;
      return { texto: n > 0 ? `✗ Merge bloqueado · ${cuentaBloqueo(n, min)}` : '✗ Merge bloqueado', rol: 'mal' };
    }
    case 'success': return g.override_at ? { texto: '✓ Aprobado a mano', rol: 'aviso' } : { texto: '✓ GitHub', rol: 'bien' };
    case 'error': return { texto: r.status !== 'failed' && r.partial ? 'GitHub: no pudimos leerlo entero' : 'GitHub: no pudimos revisar', rol: 'aviso' };
    case 'pending': return { texto: 'GitHub: revisando…', rol: 'info' };
    default: return g.error ? { texto: `No publicado: ${textoErrorBloqueo(g.error)}`, rol: 'neutra' } : null;
  }
}

// Motivo de una revisión incompleta que publicó `error` (D2 = a): sale de su error_code.
const PARCIAL_BLOQUEO: Record<string, string> = {
  diff_grande: 'El cambio es demasiado grande para revisarlo entero',
  binario: 'Hay archivos que no pudimos leer: binarios que no son imágenes, o rutas con acentos',
};
export const textoParcialBloqueo = (c: unknown) => deMapa(PARCIAL_BLOQUEO, c, 'No pudimos leer el cambio entero');

// «Dar por bueno» (E54 override) vale para revisiones con ✗ o con error y sin aprobación previa; «Deshacer», con ella.
export const sePuedeAprobar = (g: CodeReview['gate']) => !!g && !g.override_at && (g.state === 'failure' || g.state === 'error');

// Anexo de cierre de PR: qué hizo VanGUARD con el pull request. pr_close_error con mapa cerrado (códigos cortos del BACK).
const CIERRE_PR: Record<string, string> = {
  unauthorized: 'el token caducó', token: 'el token caducó',
  forbidden: 'al token le falta Pull requests: Read and write', sin_permiso: 'al token le falta Pull requests: Read and write',
  not_found: 'el token no ve el pull request',
  limite: 'GitHub no aceptó el cierre', unprocessable: 'GitHub no aceptó el cierre',
  red: 'GitHub no respondió',
};
export const textoErrorCierre = (e: unknown) => deMapa(CIERRE_PR, e, 'GitHub no lo aceptó');
export function chipPr(r: Pick<CodeReview, 'gate'>): Chip | null {
  switch (r.gate?.pr_action) {
    case 'closed': return { texto: 'PR cerrado por VanGUARD', rol: 'aviso' };
    case 'reopened_by_human': return { texto: 'PR reabierto a mano', rol: 'neutra' };
    case 'reopened': return { texto: 'PR reabierto', rol: 'neutra' };
    case 'close_failed': return { texto: `No pudimos cerrar el PR: ${textoErrorCierre(r.gate.pr_close_error)}`, rol: 'aviso' };
    default: return null;
  }
}

// Lo que publicó el POST de prueba de E53 al guardar el token (probe_state). Nunca un ✓ sobre un commit sin revisar.
const PRUEBA: Record<string, string> = {
  failure: '✗ “VanGUARD”: ese commit ya tenía un crítico',
  success: '✓ “VanGUARD”: ese commit ya estaba revisado y limpio',
  pending: '“pendiente”: aún no revisamos ese commit con el bloqueo',
  error: '“error”: no pudimos revisar ese commit entero',
};
export const textoPrueba = (s: CommitStatusState | null | undefined) => deMapa(PRUEBA, s, 'un estado de prueba');
