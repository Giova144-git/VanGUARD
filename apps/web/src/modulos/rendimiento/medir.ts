// «Medir ahora» (F-17; S10 §10.4 y §10.10): E11 POST …/scans con el cuerpo plano {kind:'lighthouse', url, strategy,
// version_label?} → 202 {scan_run_id} y a /o/:org/audit/:id, donde se ve el paso de rendimiento. La lógica va aparte
// del componente para probarla sin DOM (renderToStaticMarkup no hace clic).
import type { QueryClient } from '@tanstack/react-query';
import { ScanAccepted, ScanCreate, Version, type PerfRunExt } from '@vanguard/contracts';
import { api } from '@/lib/api';
import { sinBidi } from '@/lib/bidi';
import { esApiError, mensajeDe } from '@/lib/errores';
import { esId } from '@/lib/ids';
import type { Rol } from '@/lib/severidad';

const uuid = (x: unknown): x is string => typeof x === 'string' && esId(x);

export type Estrategia = 'mobile' | 'desktop';
export type CuerpoMedir = Extract<ScanCreate, { kind: 'lighthouse' }>;
export type Campo = 'url' | 'version_label';
export type ErroresCampo = Partial<Record<Campo, string>>;
// enCurso: id (ya validado como uuid) de la medición que dio el 409, para el enlace «Verla».
export type Aviso = { texto: string; rol: Rol; enCurso?: string };
export type ResultadoMedir =
  | { tipo: 'creada'; ruta: string }
  | { tipo: 'oculto' }                                         // E11 dio 404: la función no está en esta API
  | { tipo: 'campo'; errores: ErroresCampo }                   // 422 de la URL o de la etiqueta: al lado de su campo
  | { tipo: 'aviso'; aviso: Aviso };

// Se vuelve a medir tal cual: https, válida para el contrato y sin controles bidi (no se meten a escondidas en el campo
// ni en el cuerpo del POST). api() en producción deja pasar cuerpos fuera de contrato: lo que no sea texto, fuera.
export const medible = (u: unknown): u is string =>
  typeof u === 'string' && u.length <= 2048 && sinBidi(u) === u && ScanCreate.safeParse({ kind: 'lighthouse', url: u }).success;

const recientes = (runs: unknown): PerfRunExt[] => (Array.isArray(runs) ? (runs as PerfRunExt[]) : [])
  .filter((r) => r && typeof r === 'object')
  .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

// URLs ya medidas (E24), la más reciente primero: la primera es la que el campo trae por defecto.
export const urlsConocidas = (runs: unknown): string[] => [...new Set(recientes(runs).map((r) => r.url).filter(medible))];

// Última etiqueta de versión de esa URL, para prellenar «Etiqueta de versión» (S10 §10.10); '' si no hay una válida.
export const etiquetaPrevia = (runs: unknown, url: string): string =>
  recientes(runs).find((r) => r.url === url && Version.safeParse(r.version_label).success)?.version_label ?? '';

// Cuerpo de E11 validado con el contrato antes de salir; version_label solo si se escribió.
export function cuerpoMedir(url: string, strategy: Estrategia, version: string): { body: CuerpoMedir } | { errores: ErroresCampo } {
  const u = url.trim();
  const v = version.trim();
  const errores: ErroresCampo = {};
  if (!u) errores.url = 'Escribe la URL que quieres medir';
  else if (!u.startsWith('https://')) errores.url = 'Solo medimos URLs que empiezan por https://';
  else if (!medible(u)) errores.url = 'Esa URL no es válida';
  if (v && !Version.safeParse(v).success) errores.version_label = 'Hasta 40 letras, números, «.», «_» o «-»';
  if (errores.url || errores.version_label) return { errores };
  return { body: { kind: 'lighthouse', url: u, strategy, ...(v ? { version_label: v } : {}) } };
}

// Al crearla y al terminar su auditoría: el histórico (E24) y el estado del módulo se releen.
export const invalidarPerf = (qc: QueryClient, org: string) => Promise.all([
  qc.invalidateQueries({ queryKey: ['org', org, 'perf'] }),
  qc.invalidateQueries({ queryKey: ['org', org, 'module', 'performance'] }),
]);

// Bandera por 404 (en memoria de la pestaña, por org): si E11 responde 404, «Medir ahora» deja de pintarse.
const sinRuta = new Set<string>();
export const medirOculto = (org: string) => sinRuta.has(org);

const esperar = (s: number | undefined) => (!s || s === 60 ? 'Espera un minuto' : s < 60 ? `Espera ${s} s` : `Espera ${Math.ceil(s / 60)} min`);
const primero = (x: unknown) => (Array.isArray(x) && typeof x[0] === 'string' ? sinBidi(x[0]) : null);

export function errorMedir(e: unknown): Exclude<ResultadoMedir, { tipo: 'creada' }> {
  if (!esApiError(e)) return { tipo: 'aviso', aviso: { texto: mensajeDe(e), rol: 'mal' } };
  if (e.status === 404) return { tipo: 'oculto' };
  const d = e.details ?? {};
  // El BACK de hoy aún no mide (rutas/scans.ts): no es un fallo del usuario y el botón sigue ahí.
  if (e.status === 422 && d.reason === 'not_available') return { tipo: 'aviso', aviso: { texto: 'La medición en vivo llega pronto', rol: 'info' } };
  if (e.status === 422) {
    // field_errors de cuerpo() o el PerfUrlError de la guarda de zonas («Solo dominios de tus zonas: …»): bajo su campo.
    const campos = (d.field_errors && typeof d.field_errors === 'object' ? d.field_errors : {}) as Record<string, unknown>;
    const version = primero(campos.version_label);
    return { tipo: 'campo', errores: version && !campos.url ? { version_label: version } : { url: primero(campos.url) ?? (e.message || 'Revisa la URL') } };
  }
  if (e.status === 429) return { tipo: 'aviso', aviso: { texto: e.code === 'budget_exceeded' ? mensajeDe(e) : esperar(e.retryAfter), rol: 'aviso' } };
  if (e.status === 409 && uuid(d.scan_run_id)) return { tipo: 'aviso', aviso: { texto: 'Ya hay una medición en curso', rol: 'info', enCurso: d.scan_run_id } };
  return { tipo: 'aviso', aviso: { texto: mensajeDe(e), rol: 'mal' } };
}

// POST de E11 y, con el 202, a la auditoría. El id del servidor solo entra en la ruta si es un uuid.
export async function medir(org: string, body: CuerpoMedir, qc: QueryClient, navegar: (ruta: string) => void): Promise<ResultadoMedir> {
  let id: unknown;
  try {
    id = (await api(`/api/orgs/${org}/scans`, { method: 'POST', body, esquema: ScanAccepted }))?.scan_run_id;
  } catch (e) {
    const r = errorMedir(e);
    if (r.tipo === 'oculto') sinRuta.add(org);
    return r;
  }
  void invalidarPerf(qc, org);                                // sin esperar: no retrasa la navegación
  if (!uuid(id)) return { tipo: 'aviso', aviso: { texto: 'Algo falló', rol: 'mal' } };
  const ruta = `/o/${org}/audit/${encodeURIComponent(id)}`;
  navegar(ruta);
  return { tipo: 'creada', ruta };
}
