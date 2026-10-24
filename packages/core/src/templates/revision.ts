// Texto FIJO del aviso de la revisión de código por WhatsApp (asignaciones/revision-codigo.md §5.2): texto simple
// (cuerpoTexto del despachador), ≤ 1.024 caracteres. Lo único que no es nuestro: la rama (de la config, y solo si casa
// una lista corta de caracteres), el sha7 en hex y los números. Nunca el repo (el nombre de un repo privado no tiene por
// qué llegar a Meta ni a Kapso), rutas, valores, previews, autor, mensajes de commit, título del PR ni texto de IA.
// Sin textoSeguro: no hay texto libre que redactar, y su quita de queries se comería el `?revision=` de la url.
import type { CodeReviewEvent, Severity } from '@vanguard/contracts';
import { SEVERIDADES } from '../severity.ts';

/** Severidades en masculino («1 crítico, 2 altos»): SEVERIDAD_ES de titles.ts va en femenino («crítica»). */
export const SEVERIDAD_M: Readonly<Record<Severity, string>> = {
  critical: 'crítico', high: 'alto', medium: 'medio', low: 'bajo', info: 'informativo',
};
/** counts = los hallazgos NUEVOS por severidad; reglas = rule_id de cada hallazgo nuevo (con repetidos); url =
 *  `${APP_ORIGIN}/o/${org_id}/codebase?revision=${review_id}`. */
export type DatosRevision = {
  evento: CodeReviewEvent; rama: string; sha: string; pr?: number | null;
  counts: Readonly<Record<Severity, number>>; reglas: readonly string[]; parcial: boolean; url: string;
};

const MAX_MENSAJE = 1024, MAX_URL = 300, MAX_CONTEO = 999_999;
// Sin puntos ni barras: WhatsApp convertiría una rama como `pagos.evil.com/login` en un enlace pulsable.
const RAMA = /^[A-Za-z0-9_-]{1,40}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
// La url es nuestra (dominio propio; en local http://localhost:5173), pero solo ASCII de URL: ni blancos ni controles.
const URL_APP = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/;
const conteo = (n: unknown) =>
  (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_CONTEO) : 0);
const OBJETO: Readonly<Record<CodeReviewEvent, string>> = {
  push: 'este push', pull_request: 'este pull request', manual: 'este cambio',
};

function cabecera(d: DatosRevision, rama: string, sha7: string): string {
  const s = sha7 ? ` (${sha7})` : '';
  if (d.evento === 'pull_request') {
    const n = typeof d.pr === 'number' && Number.isSafeInteger(d.pr) && d.pr > 0 ? ` #${d.pr}` : '';
    return `Pull request${n} hacia ${rama}${s}.`;
  }
  if (d.evento === 'manual') return `Revisión manual de ${rama}${s}.`;
  return `Push a ${rama}${s}.`;
}

/** VanGUARD · Revisión de código / Push a {rama} ({sha7}). / Nuevo: 1 crítico, 2 altos. / - {n} clave(s) o token(s) en
 *  el código / - {n} archivo(s) .env subido(s) / No pudimos revisar entero este push. / cierre con la url. Cada línea
 *  solo si tiene algo que decir; las categorías salen del prefijo de rule_id (CB_SECRET_* y CB_ENV_COMMITTED; las de
 *  .gitignore y dependencias entran con B6). */
export function mensajeRevision(d: DatosRevision): string {
  const rama = typeof d.rama === 'string' && RAMA.test(d.rama) ? d.rama : 'la rama vigilada';
  const sha7 = typeof d.sha === 'string' && SHA.test(d.sha) ? d.sha.slice(0, 7).toLowerCase() : '';
  const lineas = ['VanGUARD · Revisión de código', cabecera(d, rama, sha7)];
  const nuevos = SEVERIDADES.map((s) => [s, conteo(d.counts?.[s])] as const).filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${SEVERIDAD_M[s]}${n === 1 ? '' : 's'}`);
  if (nuevos.length) lineas.push(`Nuevo: ${nuevos.join(', ')}.`);
  const reglas = Array.isArray(d.reglas) ? d.reglas : [];
  const claves = conteo(reglas.filter((r) => typeof r === 'string' && r.startsWith('CB_SECRET_')).length);
  const env = conteo(reglas.filter((r) => r === 'CB_ENV_COMMITTED').length);
  if (claves) lineas.push(`- ${claves} ${claves === 1 ? 'clave o token' : 'claves o tokens'} en el código`);
  if (env) lineas.push(`- ${env} ${env === 1 ? 'archivo .env subido' : 'archivos .env subidos'}`);
  if (d.parcial) lineas.push(`No pudimos revisar entero ${OBJETO[d.evento] ?? OBJETO.push}.`);
  const url = typeof d.url === 'string' && d.url.length <= MAX_URL && URL_APP.test(d.url) ? d.url : '';
  const rotar = 'Rota las claves expuestas y revisa el detalle';
  lineas.push(claves || env ? (url ? `${rotar}: ${url}` : `${rotar} en VanGUARD.`)
    : (url ? `Revísalo en VanGUARD: ${url}` : 'Revísalo en VanGUARD.'));
  const texto = lineas.join('\n');
  return texto.length <= MAX_MENSAJE ? texto : texto.slice(0, MAX_MENSAJE);   // no pasa: cada parte tiene su tope
}
