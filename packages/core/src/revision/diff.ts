// Del diff unificado de GitHub (compare con `Accept: application/vnd.github.diff`) a las líneas con su número en head,
// y de ahí al texto compacto que escanea la revisión de código (asignaciones/revision-codigo.md §2.2–2.4). Puro: recibe
// el texto ya leído y devuelve datos. Solo se escanean las líneas AÑADIDAS, una tras otra (más el contexto de un bloque de
// clave privada tocado): CPU y memoria van con lo añadido (≤ LIM_DIFF.bytesAnadidos), no con el número de línea, y cada
// hallazgo vuelve después a su línea de head.
import type { CodebaseEvidence } from '@vanguard/contracts';
import { porSeveridad } from '../severity.ts';
import { escanearSecretos, esEnvSubido, esLockfile, EXT_BINARIA, recurso, reglasEnv, type ArchivoTexto,
  type BorradorCodebase, type OpcionesSecretos } from '../secrets/scan.ts';

export type LineaDiff = { t: '+' | ' ' | '-'; texto: string; linea: number | null };   // linea = número en head
export type ArchivoDiff = { path: string; estado: 'added' | 'modified' | 'deleted' | 'renamed'; binario: boolean;
  lineas: LineaDiff[] };
/** Topes del diff (§2.2): archivos que se miran y texto añadido que se escanea (en caracteres, con el salto que los
 *  junta). Pasado cualquiera de los dos, el resto no se mira y el resultado sale `cortado` (y la revisión avisa como
 *  parcial). 128 KB y no 512 (decisión del ORQUESTADOR, sáb 24-oct): con 512 KB de texto hostil el escaneo gastaba
 *  ~60–90 ms en node; con 128 queda en la zona de un push normal (~20 ms) sin depender de la DLQ. */
export const LIM_DIFF: Readonly<{ archivos: number; bytesAnadidos: number }> =
  Object.freeze({ archivos: 300, bytesAnadidos: 128_000 });

// Copia de apps/api/src/scans/repo.ts: allí es const sin exportar y core no puede importar de apps/api.
const FUERA = /(^|\/)(node_modules|vendor|dist|build|\.git)\//;
// Medios: EXT_BINARIA de scan.ts (lo que scanArchivo nunca escanea por la extensión), que contiene el BINARIO de repo.ts.
// Con la copia de BINARIO, un .avif, .otf, .webm, .bmp o .sqlite de verdad daba una revisión parcial falsa.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const PEM_INI = /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/i;
const PEM_FIN = /-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/i;

/** Bloques de clave privada con alguna línea añadida. CB_SECRET_PRIVATE_KEY necesita BEGIN y END en el texto escaneado, y
 *  al rotar una clave solo cambia el cuerpo: BEGIN y END quedan como contexto. `contexto` = índices de las líneas de
 *  contexto de esos bloques, de BEGIN a END: van al compacto con su línea de head, así el valor, la huella y el resource
 *  (línea del BEGIN) son los de la auditoría. `ciego`: un bloque con añadidas cuyo BEGIN o END no sale en el hunk (git da
 *  3 líneas de contexto), que no se puede escanear entero. */
function bloquesPem(lineas: readonly LineaDiff[]): { contexto: Set<number>; ciego: boolean } {
  const contexto = new Set<number>();
  let ciego = false, prev = -2;
  let ini = -1, anadidas = false;      // BEGIN abierto; añadidas dentro de él o, sin bloque, desde el hunk o el último END
  const cerrarHunk = () => { if (ini >= 0 && anadidas) ciego = true; ini = -1; anadidas = false; };
  lineas.forEach((l, i) => {
    if (l.linea === null) return;                                   // borrada: no está en head
    if (l.linea !== prev + 1) cerrarHunk();                         // otro hunk: lo de en medio no se ve
    prev = l.linea;
    const mas = l.t === '+', guiones = l.texto.includes('-----');
    const b = guiones ? PEM_INI.exec(l.texto) : null, e = guiones ? PEM_FIN.exec(l.texto) : null;
    if (e && (!b || e.index < b.index)) {                           // END: cierra
      if (ini >= 0 && (anadidas || mas)) { for (let k = ini; k <= i; k++) if (lineas[k]?.t === ' ') contexto.add(k); }
      else if (ini < 0 && (anadidas || mas)) ciego = true;          // su BEGIN quedó antes del hunk
      ini = -1; anadidas = false;
    }
    if (b && !(e && e.index > b.index)) { ini = i; anadidas = mas; } // BEGIN sin su END en la misma línea: abre
    else if (!b && !e && mas) anadidas = true;
  });
  cerrarHunk();
  return { contexto, ciego };
}

/** Archivo mientras se lee su cabecera. La ruta se decide al primer hunk o al cerrar (un binario no trae hunks). */
type Abierto = {
  cab: string; estado: ArchivoDiff['estado']; binario: boolean; comillas: boolean;
  mas: string | null; menos: string | null; renombre: string | null;   // `+++ b/…`, `--- a/…`, `rename to …`
  decidido: boolean; fuera: boolean; lineas: LineaDiff[];
};
/** `diff --git a/P b/P` → P. En un renombre las dos mitades no coinciden y la ruta sale de `rename to`. */
function rutaCabecera(cab: string): string | null {
  const n = (cab.length - 5) / 2;
  if (!Number.isInteger(n) || n < 1 || !cab.startsWith('a/') || cab.slice(2 + n, 5 + n) !== ' b/') return null;
  const p = cab.slice(2, 2 + n);
  return p === cab.slice(5 + n) ? p : null;
}

/** cortado: tope de archivos o de texto, ruta entre comillas, binario que no es multimedia, texto (con hunks) con una
 *  extensión que scanArchivo salta, o bloque de clave privada tocado sin su BEGIN o su END a la vista. Salta
 *  node_modules, vendor, dist, build y .git sin cortar. Una ruta entre comillas (git cita las que no son ASCII) se salta
 *  en P0 (P1: decodificarla); un borrado no corta nunca: no añade nada que escanear. */
export function parsearDiff(texto: string, lim: Readonly<{ archivos: number; bytesAnadidos: number }> = LIM_DIFF):
  { archivos: ArchivoDiff[]; cortado: boolean } {
  const archivos: ArchivoDiff[] = [];
  let cortado = false, bytes = 0;
  let a: Abierto | null = null;
  let viejo = 0, nuevo = 0, sig = 0;                // líneas que le quedan al hunk (base, head) y la próxima de head
  let enParche = false;                             // tras `GIT binary patch`: nada hasta el próximo `diff --git`
  /** Ruta de `+++`, `---` o `rename`: sin el prefijo, sin el tab que git añade si la ruta lleva espacios; entre
   *  comillas → null y el archivo se salta. */
  const ruta = (x: Abierto, r: string, prefijo: string): string | null => {
    const s = r.endsWith('\t') ? r.slice(0, -1) : r;
    if (s.startsWith('"')) { x.comillas = true; return null; }
    return s.startsWith(prefijo) ? s.slice(prefijo.length) : s;
  };
  /** Decide la ruta, si el archivo entra y si corta. false = tope de archivos: se para ahí. */
  const decidir = (x: Abierto): boolean => {
    if (x.decidido) return true;
    x.decidido = true;
    const path = x.comillas ? null : x.mas ?? x.renombre ?? rutaCabecera(x.cab) ?? x.menos;
    if (!path || FUERA.test(path)) {
      if (!path && x.estado !== 'deleted') cortado = true;
      x.fuera = true;
      return true;
    }
    if (archivos.length >= lim.archivos) { cortado = true; x.fuera = true; return false; }
    // Un binario que no es multimedia no se escanea: así un `.ts` con un NUL no esconde una clave.
    if (x.binario && x.estado !== 'deleted' && !EXT_BINARIA.test(path)) cortado = true;
    archivos.push({ path, estado: x.estado, binario: x.binario, lineas: x.lineas });
    return true;
  };

  for (const bruta of texto.split('\n')) {
    const l = bruta.endsWith('\r') ? bruta.slice(0, -1) : bruta;
    if (a && (viejo > 0 || nuevo > 0)) {            // en un hunk manda el 1.er carácter: un `++ b/x` añadido no es cabecera
      const c = l[0];
      if (c === '\\') continue;                     // \ No newline at end of file
      if (c === '+') {
        if (!a.fuera) {
          const t = l.slice(1);
          if (bytes + t.length + 1 > lim.bytesAnadidos) { cortado = true; a = null; break; }
          bytes += t.length + 1;
          a.lineas.push({ t: '+', texto: t, linea: sig });
        }
        nuevo--; sig++;
        continue;
      }
      if (c === '-') { if (!a.fuera) a.lineas.push({ t: '-', texto: l.slice(1), linea: null }); viejo--; continue; }
      if (c === ' ' || l === '') {                  // contexto (vacío si alguien quitó el espacio del final)
        if (!a.fuera) a.lineas.push({ t: ' ', texto: l.slice(1), linea: sig });
        viejo--; nuevo--; sig++;
        continue;
      }
      viejo = nuevo = 0;                            // hunk mal contado: la línea se lee como cabecera
    }
    if (l.startsWith('diff --git ')) {
      if (a && !decidir(a)) { a = null; break; }
      const cab = l.slice(11);
      a = { cab, estado: 'modified', binario: false, comillas: cab.includes('"'), mas: null, menos: null, renombre: null,
        decidido: false, fuera: false, lineas: [] };
      enParche = false;
      continue;
    }
    if (!a || enParche || l.startsWith('\\')) continue;
    const h = HUNK.exec(l);
    if (h) {
      if (!decidir(a)) { a = null; break; }
      viejo = Number(h[2] ?? 1); nuevo = Number(h[4] ?? 1); sig = Number(h[3]);
      continue;
    }
    if (a.decidido) continue;                       // entre hunks no hay más cabecera
    if (l.startsWith('new file mode')) a.estado = 'added';
    else if (l.startsWith('deleted file mode')) a.estado = 'deleted';
    else if (l.startsWith('rename from ')) { a.estado = 'renamed'; ruta(a, l.slice(12), ''); }
    else if (l.startsWith('rename to ')) { a.estado = 'renamed'; a.renombre = ruta(a, l.slice(10), ''); }
    else if (l.startsWith('+++ ')) {
      if (l === '+++ /dev/null') a.estado = 'deleted'; else a.mas = ruta(a, l.slice(4), 'b/');
    } else if (l.startsWith('--- ')) {
      if (l !== '--- /dev/null') a.menos = ruta(a, l.slice(4), 'a/');
      else if (a.estado === 'modified') a.estado = 'added';
    } else if (l.startsWith('Binary files ') && l.endsWith(' differ')) a.binario = true;
    else if (l === 'GIT binary patch') { a.binario = true; enParche = true; }
  }
  if (a) decidir(a);
  // Lo que el escáner no vería: texto con una extensión que scanArchivo salta (git ya dijo que es texto) o un bloque de
  // clave privada sin su BEGIN o su END. Los lockfiles no se escanean nunca (§2.3).
  for (const x of archivos) {
    if (cortado) break;
    if (x.binario || x.estado === 'deleted' || esLockfile(x.path)) continue;
    if (EXT_BINARIA.test(x.path) ? x.lineas.some((l) => l.t === '+') : bloquesPem(x.lineas).ciego) cortado = true;
  }
  return { archivos, cortado };
}

/** Solo las líneas añadidas, una tras otra (y el contexto de un bloque de clave privada tocado, ver bloquesPem);
 *  lineas[i] = línea de head de la línea i + 1 del texto. */
export type ArchivoCompacto = { archivo: ArchivoTexto; lineas: number[] };
/** null si es binario, borrado o no añade nada. Un archivo rellenado hasta su línea de head daría N saltos por una línea
 *  añadida en la N, y scanArchivo pasa toLowerCase y arma un arreglo con todos los saltos (§2.3). Un NUL pasa a espacio:
 *  git mira los primeros 8000 bytes del archivo entero para decir que es texto, pero en el compacto ese NUL caería en los
 *  primeros 8000 caracteres y scanArchivo lo tomaría por binario, sin escanear nada ni cortar. No mueve líneas ni
 *  columnas, y el snippet ya lo cambia igual. */
export function archivoCompacto(a: ArchivoDiff): ArchivoCompacto | null {
  if (a.binario || a.estado === 'deleted') return null;
  const { contexto } = bloquesPem(a.lineas);
  const textos: string[] = [], lineas: number[] = [];
  a.lineas.forEach((l, i) => {
    if (l.linea === null || (l.t !== '+' && !contexto.has(i))) return;
    textos.push(l.texto.includes('\0') ? l.texto.replace(/\0/g, ' ') : l.texto);
    lineas.push(l.linea);
  });
  return lineas.length ? { archivo: { path: a.path, content: textos.join('\n') }, lineas } : null;
}

/** escanearSecretos sobre los compactos, sin rebajar por ruta de pruebas, y vuelta a la línea de head: rehace
 *  evidence.line, evidence.ubicaciones[].line, resource y dedupe_input. La correspondencia crece con la línea dentro de
 *  cada archivo, así que el orden de las ubicaciones se mantiene. El snippet enseña las líneas añadidas vecinas, no las
 *  reales; va redactado como siempre. */
export async function secretosDelDiff(cs: readonly ArchivoCompacto[], opts: OpcionesSecretos = {}):
  Promise<BorradorCodebase[]> {
  const porRuta = new Map(cs.map((c) => [c.archivo.path, c.lineas] as const));
  const aHead = (path: string, n: number) => porRuta.get(path)?.[n - 1] ?? n;
  const prefijo = opts.prefijo ?? '';
  const { hallazgos } = await escanearSecretos(cs.map((c) => c.archivo), { ...opts, rebajarPruebas: false });
  return hallazgos.map((h): BorradorCodebase => {
    const ev = h.evidence, path = ev.path ?? '';
    if (typeof ev.line !== 'number') return h;
    const line = aHead(path, ev.line);
    const evidence: CodebaseEvidence = { ...ev, line };
    if (ev.ubicaciones) evidence.ubicaciones = ev.ubicaciones.map((u) => ({ ...u, line: aHead(u.path, u.line) }));
    const resource = recurso(prefijo, `${path}:${line}`);
    return { ...h, evidence, resource, dedupe_input: resource };
  }).sort((a, b) => porSeveridad(a.severity, b.severity) || (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0));
}

/** CB_ENV_COMMITTED de los .env* añadidos o renombrados, sin gitignore_lo_lista (la revisión no lee el .gitignore: con
 *  false en cada .env, E15 podría aconsejar añadir al .gitignore algo que ya está). */
export function envDelDiff(as: readonly ArchivoDiff[], cs: readonly ArchivoCompacto[]): BorradorCodebase[] {
  const rutas = as.filter((a) => (a.estado === 'added' || a.estado === 'renamed') && esEnvSubido(a.path)).map((a) => a.path);
  if (!rutas.length) return [];
  const env = new Set(rutas);
  const leidos = cs.filter((c) => env.has(c.archivo.path)).map((c) => c.archivo);   // solo los nombres de variables
  return reglasEnv(rutas, leidos).filter((r) => r.rule_id === 'CB_ENV_COMMITTED').map((r) => {
    const evidence: CodebaseEvidence = { ...r.evidence };
    delete evidence.gitignore_lo_lista;
    return { ...r, evidence };
  });
}
