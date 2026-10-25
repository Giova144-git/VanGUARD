// Bloqueo de merge con críticos (asignaciones/bloqueo-merge-criticos.md §2.2–2.3 y su anexo bloqueo-merge-cierre-pr.md).
// Puro, sin red ni base: qué hallazgos de lo AÑADIDO bloquean, qué estado de commit «VanGUARD» se publica en GitHub y el
// texto fijo del comentario con el que VanGUARD cierra un PR. Nunca lleva rutas, valores, títulos de PR, autores ni el
// nombre del repo: una ruta la elige quien empuja y puede traer un secreto.
import type { Severity } from '@vanguard/contracts';
import { porSeveridad, rank, SEVERIDADES } from '../severity.ts';

/** Contexto EXACTO del estado de commit (= GATE_CONTEXT del contrato): el que el dueño marca como obligatorio en GitHub. */
export const CONTEXTO_BLOQUEO = 'VanGUARD';
/** Severidad mínima de lo añadido que bloquea (code_review_configs.gate_min). */
export type UmbralBloqueo = 'critical' | 'high';
export type EstadoCommit = { state: 'pending' | 'success' | 'failure' | 'error'; description: string };
/** D2 = (a): una revisión parcial por diff_grande o binario sin bloqueantes publica `error` (falla cerrado). La salida es
 *  quitar la causa, «Dar por bueno» (E54) o el bypass de un admin. Con false, `success` «(revisión incompleta)». */
export const PARCIAL_BLOQUEA = true;
/** filas: tope de gate_findings (check de 0016) · descripcion: tope que se manda a GitHub (la doc no da uno). */
export const LIM_BLOQUEO: Readonly<{ filas: number; descripcion: number }> = Object.freeze({ filas: 20, descripcion: 140 });
/** Repos desde los que se despliega VanGUARD: E53 se niega a encender el bloqueo en ellos (si VanGUARD falla, no podría
 *  publicar el ✓ de su propio arreglo). En minúsculas: GitHub no distingue mayúsculas en dueño ni nombre. */
export const REPOS_DEL_PRODUCTO: readonly string[] = Object.freeze(['platanus-hack/platanus-hack-26-ve-team-22',
  'giova144-git/vanguard']);
export const esRepoDelProducto = (full: string): boolean => REPOS_DEL_PRODUCTO.includes(full.trim().toLowerCase());

const SEV = new Set<string>(SEVERIDADES);
const esSev = (s: string): s is Severity => SEV.has(s);
/** true si la severidad llega al umbral (una severidad desconocida nunca bloquea). */
export const superaBloqueo = (sev: string, umbral: UmbralBloqueo): boolean => esSev(sev) && rank(sev) >= rank(umbral);

/** Lo que el paso diff ya tiene de cada hallazgo tras aFila y ocultarRutas. */
export type FilaBloqueo = { rule_id: string; severity: string; title: string; resource: string; dedupe_key: string;
  evidence?: unknown };
/** Un hallazgo `ignored` de la org (findings.select('dedupe_key, rule_id, fp:evidence->>fingerprint_short')). */
export type Ignorado = { dedupe_key: string; rule_id: string; fp: string | null };

const huella = (e: unknown): string | null => {
  const fp = e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, unknown>).fingerprint_short : null;
  return typeof fp === 'string' && fp ? fp : null;
};

/** Lo que bloquea (§2.2): filas con severidad ≥ umbral que no tapa un `ignored` con el mismo valor. Es la regla de «no es
 *  nuevo» de 0013, pero solo con ignored: misma dedupe_key y misma huella (o sin huella en alguno de los dos lados), o
 *  misma regla y la misma huella en otro sitio (las dos existen). Lo `open`, `fixed` o `verified` sí bloquea: la clave
 *  sigue en lo que el cambio añade. Sin duplicados por dedupe_key; severidad desc y después dedupe_key. NO sale de
 *  `counts`: en un PR, «nuevo» excluye lo visto en el push anterior al mismo PR y el segundo push daría ✓. */
export function bloqueantes<T extends FilaBloqueo>(filas: readonly T[], ignorados: readonly Ignorado[],
  umbral: UmbralBloqueo): T[] {
  // Índices de los ignorados (≤ 500): sin ellos, 200 filas × 500 ignorados eran ~100.000 comparaciones (~1,7 ms medidos).
  const porClave = new Map<string, (string | null)[]>();      // dedupe_key → huellas
  const porHuella = new Map<string, Set<string>>();           // regla|huella → dedupe_keys
  for (const g of ignorados) {
    porClave.set(g.dedupe_key, [...(porClave.get(g.dedupe_key) ?? []), g.fp]);
    if (g.fp === null) continue;
    const k = `${g.rule_id}|${g.fp}`;
    porHuella.set(k, (porHuella.get(k) ?? new Set()).add(g.dedupe_key));
  }
  const tapada = (f: T) => {
    const fp = huella(f.evidence);
    const fps = porClave.get(f.dedupe_key);
    if (fps && (fp === null || fps.some((x) => x === null || x === fp))) return true;
    const otras = fp === null ? undefined : porHuella.get(`${f.rule_id}|${fp}`);
    return !!otras && (otras.size > 1 || !otras.has(f.dedupe_key));
  };
  const vistas = new Set<string>();
  const out: T[] = [];
  for (const f of filas) {
    if (!superaBloqueo(f.severity, umbral) || vistas.has(f.dedupe_key) || tapada(f)) continue;
    vistas.add(f.dedupe_key);
    out.push(f);
  }
  return out.sort((a, b) => porSeveridad(a.severity as Severity, b.severity as Severity)
    || (a.dedupe_key < b.dedupe_key ? -1 : a.dedupe_key > b.dedupe_key ? 1 : 0));
}

// Categoría por prefijo de rule_id, con singular y plural: lo único del hallazgo que sale a GitHub.
const CATEGORIAS: readonly (readonly [RegExp, string, string])[] = [
  [/^CB_SECRET_/, 'clave o token en el código', 'claves o tokens en el código'],
  [/^CB_ENV_COMMITTED$/, 'archivo .env subido', 'archivos .env subidos'],
  [/^CB_DEP_VULN$/, 'dependencia con vulnerabilidad', 'dependencias con vulnerabilidad'],
  [/^CB_GITIGNORE_NO_ENV$/, '.gitignore que ya no excluye .env', '.gitignore que ya no excluyen .env'],
];
const OTRA: readonly [string, string] = ['hallazgo de seguridad', 'hallazgos de seguridad'];
function categorias(reglas: readonly string[]): string[] {
  const cuenta = new Map<string, { n: number; formas: readonly [string, string] }>();
  for (const r of reglas) {
    const c = CATEGORIAS.find(([re]) => re.test(r));
    const formas: readonly [string, string] = c ? [c[1], c[2]] : OTRA;
    const prev = cuenta.get(formas[0]);
    if (prev) prev.n++; else cuenta.set(formas[0], { n: 1, formas });
  }
  return [...cuenta.values()].map(({ n, formas }) => (n === 1 ? formas[0] : formas[1]));
}

/** Lo que estadoCommit necesita de una revisión. reglas = rule_id de gate_findings (≤ 20), solo para las categorías. */
export type RevisionBloqueo = { status: string; partial: boolean; error_code: string | null; gate_blocking: number | null;
  reglas: readonly string[]; gate_override_at: string | null };

const TEXTO_PARCIAL: Readonly<Record<string, string>> = {
  diff_grande: 'Cambio demasiado grande para revisarlo entero. Que decida un admin en VanGUARD',
  binario: 'Hay archivos que no pudimos leer (binarios o rutas con acentos). Que decida un admin en VanGUARD',
};
const PARCIAL_OTRO = 'No pudimos leer entero este cambio. Que decida un admin en VanGUARD';
export const TEXTO_PRUEBA_E53 = 'Prueba de conexión: VanGUARD aún no revisó este commit';

/** «1 crítico: clave o token en el código. Detalle en VanGUARD». Si no cabe en 140, quita categorías del final y dice
 *  «y otros»; como último recurso, solo el número. */
function textoFallo(n: number, umbral: UmbralBloqueo, reglas: readonly string[]): string {
  const cab = umbral === 'high' ? `${n} ${n === 1 ? 'hallazgo crítico o alto' : 'hallazgos críticos o altos'}`
    : `${n} ${n === 1 ? 'crítico' : 'críticos'}`;
  const cats = categorias(reglas);
  for (let k = cats.length; k >= 1; k--) {
    const t = `${cab}: ${cats.slice(0, k).join(', ')}${k < cats.length ? ' y otros' : ''}. Detalle en VanGUARD`;
    if (t.length <= LIM_BLOQUEO.descripcion) return t;
  }
  return `${cab}. Detalle en VanGUARD`.slice(0, LIM_BLOQUEO.descripcion);
}

/** Estado de commit «VanGUARD» de una revisión (§2.3), con texto fijo ≤ 140. success solo con done, completa (o parcial
 *  por hallazgos_truncados: se leyó todo, solo se recortó lo guardado) y 0 bloqueantes. «Dar por bueno» (E54) manda. */
export function estadoCommit(r: RevisionBloqueo, umbral: UmbralBloqueo,
  o: { parcialBloquea?: boolean } = {}): EstadoCommit {
  const parcialBloquea = o.parcialBloquea ?? PARCIAL_BLOQUEA;
  const corta = (description: string, state: EstadoCommit['state']): EstadoCommit =>
    ({ state, description: description.slice(0, LIM_BLOQUEO.descripcion) });
  if (r.gate_override_at) return corta('Aprobado a mano en VanGUARD por un admin', 'success');
  if (r.status === 'queued' || r.status === 'running') return corta('Revisando lo añadido en este cambio…', 'pending');
  if (r.status !== 'done' || r.gate_blocking === null) {
    return corta('No pudimos revisar este cambio. Reenvía la entrega o mira VanGUARD', 'error');
  }
  if (r.gate_blocking > 0) return corta(textoFallo(r.gate_blocking, umbral, r.reglas), 'failure');
  const incompleta = r.partial && r.error_code !== 'hallazgos_truncados';
  if (incompleta && parcialBloquea) return corta(TEXTO_PARCIAL[r.error_code ?? ''] ?? PARCIAL_OTRO, 'error');
  if (incompleta) return corta('Sin críticos en lo revisado (revisión incompleta)', 'success');
  return corta(umbral === 'high' ? 'Sin hallazgos críticos ni altos en lo añadido' : 'Sin hallazgos críticos en lo añadido',
    'success');
}

// ── Cierre del PR con críticos (anexo bloqueo-merge-cierre-pr.md) ───────────────────────────────────────────────────
/** Hallazgos NUEVOS (counts de la revisión) con severidad ≥ umbral: VanGUARD cierra el PR solo si hay al menos uno. Un
 *  push al PR que mantiene la clave ya avisada no es nuevo (reported_keys): mantiene el ✗ sin volver a cerrar, y así se
 *  respeta a quien lo reabrió a mano. */
export function nuevosBloqueo(counts: unknown, umbral: UmbralBloqueo): number {
  const c = counts && typeof counts === 'object' && !Array.isArray(counts) ? counts as Record<string, unknown> : {};
  const num = (k: string) => {
    const v = c[k];
    return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0;
  };
  return num('critical') + (umbral === 'high' ? num('high') : 0);
}

/** Comentario FIJO al cerrar el PR: sin texto del autor ni de la IA, sin rutas ni valores. url = el panel con
 *  ?revision=<id> (el mismo enlace del WhatsApp y del estado; pide sesión). */
export function textoCierrePr(n: number, umbral: UmbralBloqueo, url: string): string {
  const que = umbral === 'high' ? (n === 1 ? 'hallazgo crítico o alto nuevo' : 'hallazgos críticos o altos nuevos')
    : n === 1 ? 'hallazgo crítico nuevo' : 'hallazgos críticos nuevos';
  return `VanGUARD cerró este pull request: trae ${n} ${que}. Corrige el código, rota las claves expuestas y vuelve a `
    + `abrirlo.${url ? ` Detalle: ${url}` : ''}`;
}
