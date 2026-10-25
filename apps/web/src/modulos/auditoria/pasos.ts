// La lista de pasos y su estado los da el servidor (ScanRun.steps[], E12); aquí solo textos y traducción (S14 §14.14).
// api() en producción deja pasar un cuerpo fuera de contrato: todo mapa se lee con deMapa, así un paso, un estado o un
// «__proto__» desconocidos caen a un respaldo neutro (L3) en vez de lanzar TypeError y tumbar la auditoría.
import type { Module, ScanRun, ScanStep } from '@vanguard/contracts';
import { sinBidi } from '@/lib/bidi';
import { textoErrorZip } from '@/lib/errores-escaneo';
import { deMapa, type Rol } from '@/lib/severidad';

type TextoPaso = { nombre: string; detalle: string; modulo: Module | null };
export const TEXTO_PASO: Record<ScanStep['name'], TextoPaso> = {
  supabase:   { nombre: 'Supabase',       detalle: 'Advisors, RLS, políticas y funciones sin freno', modulo: 'supabase' },
  cloudflare: { nombre: 'Cloudflare',     detalle: 'Tu zona: tráfico, IPs y configuración',           modulo: 'cloudflare' },
  repo:       { nombre: 'Codebase',       detalle: '.env, secretos y dependencias con CVE',           modulo: 'codebase' },
  zip:        { nombre: 'Tu ZIP',         detalle: 'Dependencias contra OSV (lo abrimos en tu navegador)', modulo: 'codebase' },
  psi:        { nombre: 'Rendimiento',    detalle: 'Lighthouse con PageSpeed Insights',               modulo: 'performance' },
  resumen_ia: { nombre: 'Resumen con IA', detalle: 'Claude prioriza y relaciona los hallazgos',       modulo: null },
};
// Paso desconocido: su nombre crudo como texto y sin módulo (sin enlace ni ámbar).
export const textoPaso = (name: unknown): TextoPaso =>
  deMapa(TEXTO_PASO, name, { nombre: typeof name === 'string' && name ? sinBidi(name) : '—', detalle: '', modulo: null });

// «Medir ahora» (F-17) crea un scan kind 'lighthouse': la misma pantalla de auditoría, con sus textos y sin «Auditar todo».
export const esMedicion = (kind: unknown) => kind === 'lighthouse';

// ScanRun.step también vale 'waiting_result' entre E11 y E23 (ZIP): no es un paso de la lista, es la espera del navegador.
// En una medición (kind 'lighthouse') steps[] lleva solo 'psi'. Los psi-<estrategia>, perf-compare y fin de S10 §10.2 se
// leen por si llegan; el BACK de hoy no los escribe.
const PASO_ACTUAL: Record<string, string> = {
  waiting_result: 'esperando el resultado de tu ZIP',
  'psi-mobile': 'midiendo móvil con PageSpeed Insights', 'psi-desktop': 'midiendo escritorio con PageSpeed Insights',
  'perf-compare': 'comparando con la medición anterior', fin: 'guardando la medición',
};
// El BACK (vg_claim_step) deja step = 'psi' durante toda la medición: una sola pasada de Lighthouse (~10 s; PSI admite
// hasta 2 min). Sin la estrategia, el texto no la nombra.
export const textoPasoActual = (step: unknown, kind?: unknown): string | null =>
  typeof step !== 'string' || !step ? null
    : step === 'psi' && esMedicion(kind) ? 'midiendo con PageSpeed Insights (suele tardar menos de un minuto)'
    : deMapa(PASO_ACTUAL, step, textoPaso(step).nombre);

// error_code de un paso terminado (repo y zip, S09 §09.11): lo que no se llegó a mirar entero no sale en verde.
const INCOMPLETO: Record<string, string> = {
  tripwire: 'Descartamos algo que parecía un secreto sin tapar',
  osv_unavailable: 'OSV no respondió: hay dependencias sin revisar',
  hallazgos_truncados: 'Había más hallazgos de los que guardamos',
  parcial: 'Una parte quedó sin revisar',
  // psi (scans/psi.ts): Lighthouse devolvió runtimeError (NO_FCP…); la fila de perf_runs se guarda sin métricas.
  runtime_error: 'Lighthouse no pudo cargar la página: esta medición quedó sin cifras',
};
// Nota bajo el paso: la del código conocido; los ZIP_* (ZIP_RESULT_MISSING) con el texto del ZIP; el resto, nada.
export function notaPaso(s: Pick<ScanStep, 'error_code'>): string {
  const c = s.error_code;
  if (typeof c !== 'string' || !c) return '';
  if (/^ZIP_[A-Z_]+$/.test(c)) return textoErrorZip(c);
  return deMapa(INCOMPLETO, c, '');
}

// ScanRun.error: un mensaje del servidor en español, o un código (ZIP_RESULT_MISSING, que deja el vigilante de E24).
export const textoFallo = (e: string | null | undefined, kind?: unknown): string =>
  !e ? (esMedicion(kind) ? 'La medición falló' : 'La auditoría falló') : /^ZIP_[A-Z_]+$/.test(e) ? textoErrorZip(e) : e;

export type EstadoPaso = 'pendiente' | 'corriendo' | 'hecho' | 'en_parte' | 'sin_mirar' | 'error' | 'desconocido';
const DE: Record<ScanStep['status'], EstadoPaso> = { pending: 'pendiente', running: 'corriendo', done: 'hecho', skipped: 'sin_mirar', failed: 'error' };

export function estadoPaso(run: Pick<ScanRun, 'coverage'>, s: ScanStep): EstadoPaso {
  const m = textoPaso(s.name).modulo;
  const faltan = run.coverage?.missing;
  if (s.status === 'done' && m && Array.isArray(faltan) && faltan.includes(m)) return 'sin_mirar';   // nunca verde lo que no se miró
  if (s.status === 'done' && deMapa(INCOMPLETO, s.error_code, '')) return 'en_parte';
  return deMapa(DE, s.status, 'desconocido');
}

export const PINTA_PASO: Record<EstadoPaso, { texto: string; rol: Rol; hueco?: boolean; girando?: boolean }> = {
  pendiente: { texto: 'Pendiente', rol: 'neutra', hueco: true },
  corriendo: { texto: 'Revisando…', rol: 'info', girando: true },
  hecho: { texto: 'Hecho', rol: 'bien' },
  en_parte: { texto: 'Hecho en parte', rol: 'neutra' },   // neutro, como «Sin mirar»: no hay nada que arreglar aquí (L3)
  sin_mirar: { texto: 'Sin mirar', rol: 'neutra', hueco: true },
  error: { texto: 'No pudimos revisarlo', rol: 'aviso' },
  desconocido: { texto: '—', rol: 'neutra', hueco: true },
};

export const ESTADO_SCAN: Record<ScanRun['status'], { texto: string; rol: Rol }> = {
  queued: { texto: 'En cola', rol: 'neutra' }, running: { texto: 'En curso', rol: 'info' },
  succeeded: { texto: 'Terminada', rol: 'neutra' }, failed: { texto: 'Falló', rol: 'mal' },
};
export const estadoScan = (s: unknown) => deMapa(ESTADO_SCAN, s, { texto: '—', rol: 'neutra' });
