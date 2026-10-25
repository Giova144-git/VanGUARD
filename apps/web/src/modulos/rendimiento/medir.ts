// «Medir ahora» (F-17; S10 §10.4 y §10.10): E11 POST …/scans con el cuerpo plano {kind:'lighthouse', url, strategy,
// version_label?} → 202 {scan_run_id} y a /o/:org/audit/:id, donde se ve el paso de rendimiento. La lógica va aparte
// del componente para probarla sin DOM (renderToStaticMarkup no hace clic). Qué URL se mide lo decide el servidor
// (urlMedibleOrg de scans/psi.ts): cualquier web pública con https; nunca IPs, localhost, .local/.internal, puertos,
// credenciales, secretos ni los hosts de VanGUARD. No hace falta zona de Cloudflare.
import type { QueryClient } from '@tanstack/react-query';
import { ScanAccepted, ScanCreate, Version, type PerfRunExt } from '@vanguard/contracts';
import { api } from '@/lib/api';
import { sinBidi } from '@/lib/bidi';
import { esApiError, mensajeDe } from '@/lib/errores';
import { esId } from '@/lib/ids';
import type { Rol } from '@/lib/severidad';
import type { OrgActual } from '@/app/guardas';

const uuid = (x: unknown): x is string => typeof x === 'string' && esId(x);

export type Estrategia = 'mobile' | 'desktop';
export type CuerpoMedir = Extract<ScanCreate, { kind: 'lighthouse' }>;
export type Campo = 'url' | 'version_label';
export type ErroresCampo = Partial<Record<Campo, string>>;
// enCurso: id (ya validado como uuid) de la medición que dio el 409, para el enlace «Ver la medición».
export type Aviso = { texto: string; rol: Rol; enCurso?: string };
export type ResultadoMedir =
  | { tipo: 'creada'; ruta: string }
  | { tipo: 'oculto' }                                         // E11 dio 404: la función no está en esta API
  | { tipo: 'campo'; errores: ErroresCampo }                   // 422 de la URL o de la etiqueta: al lado de su campo
  | { tipo: 'aviso'; aviso: Aviso };

// Solo owner y admin miden (E11 lleva requireAdmin): al viewer y al anónimo de «Ver demo» no se les pinta nada.
export const puedeMedir = (org: Pick<OrgActual, 'puedeEscribir' | 'role'>) =>
  org.puedeEscribir && (org.role === 'owner' || org.role === 'admin');

// Ejemplo del campo: en la org de demo, la víctima real (la tienda de la demo en Pages); en otra, uno neutro.
export const URL_VICTIMA_DEMO = 'https://vanguard-demo-victima.pages.dev/';
export const ejemploUrl = (esDemo: boolean) => (esDemo ? URL_VICTIMA_DEMO : 'https://tusitio.com/');

// Se vuelve a medir tal cual: https, válida para el contrato y sin controles bidi (no se meten a escondidas en el campo
// ni en el cuerpo del POST). api() en producción deja pasar cuerpos fuera de contrato: lo que no sea texto, fuera.
export const medible = (u: unknown): u is string =>
  typeof u === 'string' && u.length <= 2048 && sinBidi(u) === u && ScanCreate.safeParse({ kind: 'lighthouse', url: u }).success;

const recientes = (runs: unknown): PerfRunExt[] => (Array.isArray(runs) ? (runs as PerfRunExt[]) : [])
  .filter((r) => r && typeof r === 'object')
  .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

// Sugerencias y valor por defecto: solo URLs con la forma que el servidor guarda tras medir (perf_runs.url, 0007:
// https://host/ruta, sin puerto, credenciales ni query) y de internet: sin IPs ni los nombres reservados o internos que
// urlMedible rechaza (INTERNOS de scans/psi.ts). No sustituye al servidor: lo que se escribe a mano lo decide él.
const URL_GUARDADA = /^https:\/\/[a-z0-9.-]+(\/[^?#\s]*)?$/;
const NO_DE_INTERNET = ['localhost', 'local', 'internal', 'lan', 'arpa', 'test', 'invalid', 'example', 'onion'];
const sugerible = (u: string) => {
  if (!URL_GUARDADA.test(u)) return false;
  const h = u.slice('https://'.length).split('/')[0]!.replace(/\.$/, '');
  return h.includes('.') && !/^\d+(\.\d+){3}$/.test(h) && !NO_DE_INTERNET.some((x) => h === x || h.endsWith(`.${x}`));
};

// URLs ya medidas (E24), la más reciente primero: las sugerencias del campo; la primera es la que trae por defecto.
export const urlsConocidas = (runs: unknown): string[] =>
  [...new Set(recientes(runs).map((r) => r.url).filter((u) => medible(u) && sugerible(u)))];

// Última etiqueta de versión de esa URL, para prellenar «Etiqueta de versión» (S10 §10.10); '' si no hay una válida.
export const etiquetaPrevia = (runs: unknown, url: string): string =>
  recientes(runs).find((r) => r.url === url && Version.safeParse(r.version_label).success)?.version_label ?? '';

// Al editar un campo su error se va; el del otro campo, no.
export const sinErrorDe = (e: ErroresCampo, campo: Campo): ErroresCampo =>
  Object.fromEntries(Object.entries(e).filter(([k]) => k !== campo)) as ErroresCampo;

// Cuerpo de E11 validado con el contrato antes de salir; version_label solo si se escribió.
export function cuerpoMedir(url: string, strategy: Estrategia, version: string): { body: CuerpoMedir } | { errores: ErroresCampo } {
  const u = url.trim();
  const v = version.trim();
  const errores: ErroresCampo = {};
  if (!u) errores.url = 'Escribe la URL que quieres medir';
  else if (!u.startsWith('https://')) errores.url = 'Solo medimos URLs que empiezan por https://';
  else if (u.length > 2048) errores.url = 'La URL es demasiado larga (máximo 2048 caracteres)';    // el texto de urlMedible
  else if (sinBidi(u) !== u) errores.url = 'La URL lleva caracteres invisibles de control de dirección: vuelve a escribirla';
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

export const EN_CURSO = 'Ya hay una medición en curso: espera a que termine para medir la otra';

export function errorMedir(e: unknown): Exclude<ResultadoMedir, { tipo: 'creada' }> {
  if (!esApiError(e)) return { tipo: 'aviso', aviso: { texto: mensajeDe(e), rol: 'mal' } };
  if (e.status === 404) return { tipo: 'oculto' };
  const d = e.details ?? {};
  // Un BACK que aún no mida (422 not_available): no es un fallo del usuario y el botón sigue ahí.
  if (e.status === 422 && d.reason === 'not_available') return { tipo: 'aviso', aviso: { texto: 'La medición en vivo llega pronto', rol: 'info' } };
  if (e.status === 422) {
    // field_errors de cuerpo() o el UrlNoMedible de urlMedibleOrg (field_errors.url = [message], p. ej. «No medimos
    // direcciones IP: usa el dominio del sitio»): bajo su campo. Sin field_errors (looks_like_secret), el message.
    const campos = (d.field_errors && typeof d.field_errors === 'object' ? d.field_errors : {}) as Record<string, unknown>;
    const version = primero(campos.version_label);
    return { tipo: 'campo', errores: version && !campos.url ? { version_label: version } : { url: primero(campos.url) ?? (e.message || 'Revisa la URL') } };
  }
  if (e.status === 429) return { tipo: 'aviso', aviso: { texto: e.code === 'budget_exceeded' ? mensajeDe(e) : esperar(e.retryAfter), rol: 'aviso' } };
  // 409 (PERF_EN_CURSO): una medición por org a la vez; móvil y escritorio son dos peticiones seguidas. No es culpa del
  // usuario: neutro, y enlace a la que corre si llega su id (el 23505 del índice 0019 no lo trae).
  if (e.status === 409) return { tipo: 'aviso', aviso: { texto: EN_CURSO, rol: 'info', ...(uuid(d.scan_run_id) ? { enCurso: d.scan_run_id } : {}) } };
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
