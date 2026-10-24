// La lista de pasos y su estado los da el servidor (ScanRun.steps[], E12); aquí solo textos y traducción (S14 §14.14).
import type { Module, ScanRun, ScanStep } from '@vanguard/contracts';
import type { Rol } from '@/lib/severidad';

export const TEXTO_PASO: Record<ScanStep['name'], { nombre: string; detalle: string; modulo: Module | null }> = {
  supabase:   { nombre: 'Supabase',       detalle: 'Advisors, RLS, políticas y funciones sin freno', modulo: 'supabase' },
  cloudflare: { nombre: 'Cloudflare',     detalle: 'Tu zona: tráfico, IPs y configuración',           modulo: 'cloudflare' },
  repo:       { nombre: 'Codebase',       detalle: '.env, secretos y dependencias con CVE',           modulo: 'codebase' },
  zip:        { nombre: 'Tu ZIP',         detalle: 'Dependencias contra OSV (lo abrimos en tu navegador)', modulo: 'codebase' },
  psi:        { nombre: 'Rendimiento',    detalle: 'Lighthouse con PageSpeed Insights',               modulo: 'performance' },
  resumen_ia: { nombre: 'Resumen con IA', detalle: 'Claude prioriza y relaciona los hallazgos',       modulo: null },
};

export type EstadoPaso = 'pendiente' | 'corriendo' | 'hecho' | 'sin_mirar' | 'error';
const DE: Record<ScanStep['status'], EstadoPaso> = { pending: 'pendiente', running: 'corriendo', done: 'hecho', skipped: 'sin_mirar', failed: 'error' };

export function estadoPaso(run: Pick<ScanRun, 'coverage'>, s: ScanStep): EstadoPaso {
  const m = TEXTO_PASO[s.name].modulo;
  if (s.status === 'done' && m && run.coverage?.missing.includes(m)) return 'sin_mirar';         // nunca verde lo que no se miró
  return DE[s.status];
}

export const PINTA_PASO: Record<EstadoPaso, { texto: string; rol: Rol; hueco?: boolean; girando?: boolean }> = {
  pendiente: { texto: 'Pendiente', rol: 'neutra', hueco: true },
  corriendo: { texto: 'Revisando…', rol: 'info', girando: true },
  hecho: { texto: 'Hecho', rol: 'bien' },
  sin_mirar: { texto: 'Sin mirar', rol: 'neutra', hueco: true },
  error: { texto: 'No pudimos revisarlo', rol: 'aviso' },
};

export const ESTADO_SCAN: Record<ScanRun['status'], { texto: string; rol: Rol }> = {
  queued: { texto: 'En cola', rol: 'neutra' }, running: { texto: 'En curso', rol: 'info' },
  succeeded: { texto: 'Terminada', rol: 'neutra' }, failed: { texto: 'Falló', rol: 'mal' },
};
