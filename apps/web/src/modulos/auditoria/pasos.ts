// La lista de pasos y su estado los da el servidor (ScanRun.steps[], E12); aquí solo textos y traducción (S14 §14.14).
// api() en producción deja pasar un cuerpo fuera de contrato: todo mapa se lee con deMapa, así un paso, un estado o un
// «__proto__» desconocidos caen a un respaldo neutro (L3) en vez de lanzar TypeError y tumbar la auditoría.
import type { Module, ScanRun, ScanStep } from '@vanguard/contracts';
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
  deMapa(TEXTO_PASO, name, { nombre: typeof name === 'string' && name ? name : '—', detalle: '', modulo: null });

export type EstadoPaso = 'pendiente' | 'corriendo' | 'hecho' | 'sin_mirar' | 'error' | 'desconocido';
const DE: Record<ScanStep['status'], EstadoPaso> = { pending: 'pendiente', running: 'corriendo', done: 'hecho', skipped: 'sin_mirar', failed: 'error' };

export function estadoPaso(run: Pick<ScanRun, 'coverage'>, s: ScanStep): EstadoPaso {
  const m = textoPaso(s.name).modulo;
  const faltan = run.coverage?.missing;
  if (s.status === 'done' && m && Array.isArray(faltan) && faltan.includes(m)) return 'sin_mirar';   // nunca verde lo que no se miró
  return deMapa(DE, s.status, 'desconocido');
}

export const PINTA_PASO: Record<EstadoPaso, { texto: string; rol: Rol; hueco?: boolean; girando?: boolean }> = {
  pendiente: { texto: 'Pendiente', rol: 'neutra', hueco: true },
  corriendo: { texto: 'Revisando…', rol: 'info', girando: true },
  hecho: { texto: 'Hecho', rol: 'bien' },
  sin_mirar: { texto: 'Sin mirar', rol: 'neutra', hueco: true },
  error: { texto: 'No pudimos revisarlo', rol: 'aviso' },
  desconocido: { texto: '—', rol: 'neutra', hueco: true },
};

export const ESTADO_SCAN: Record<ScanRun['status'], { texto: string; rol: Rol }> = {
  queued: { texto: 'En cola', rol: 'neutra' }, running: { texto: 'En curso', rol: 'info' },
  succeeded: { texto: 'Terminada', rol: 'neutra' }, failed: { texto: 'Falló', rol: 'mal' },
};
export const estadoScan = (s: unknown) => deMapa(ESTADO_SCAN, s, { texto: '—', rol: 'neutra' });
