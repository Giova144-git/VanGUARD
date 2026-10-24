// Lector del ZIP en el navegador (F-18, S09 09.3). Corre dentro del worker de zip/: solo memoria, nada a disco ni a red.
// Topes, listas y filtro son los del leerZip del plan. La mejora: lo elegido se descomprime en streaming (Unzip +
// UnzipInflate) contando los bytes REALES, así que un tamaño declarado falso no llena la memoria. Solo API síncronas de
// fflate: unzip() y AsyncUnzipInflate crean workers desde blob:, que la CSP bloquea.
//
// Qué hace fflate 0.8.3 con un originalSize que miente (esm/browser.js, igual en esm/index.mjs):
// - unzipSync no lo comprueba: reserva new u8(originalSize) e inflateSync escribe ahí sin agrandarlo (inflt con búfer
//   dado y st.i = 2, o sea resize = false). Lo que cae fuera se pierde en silencio (escribir fuera de un Uint8Array no
//   hace nada): el archivo sale TRUNCADO a lo declarado, pero el bucle recorre el flujo entero, así que la CPU de una
//   bomba se gasta igual. Un bloque stored dentro del deflate hace buf.set fuera de rango y lanza RangeError. En una
//   entrada stored (método 0) copia `size` bytes y no mira originalSize. El CRC no lo verifica nunca.
// - Unzip + UnzipInflate no lo usan para nada: Inflate agranda su búfer (resize = true) y entrega todo lo que sale de
//   cada push. Por eso aquí se cuentan los bytes que llegan y se corta al pasar los topes.
import { Unzip, UnzipInflate, UnzipPassThrough, unzipSync } from 'fflate';
import { LIM, type CodigoZip, type Inventario } from './tipos';

export { LIM };

const SALTAR = /(^|\/)(node_modules|vendor|dist|build|\.next|\.nuxt|coverage|\.git)\//;
// Lista blanca (06.10: «solo se descomprime lo que el escáner usa»), con .jsonc (wrangler.jsonc), .md, Dockerfile y las
// configuraciones donde suelen filtrarse claves. Lo demás se lista en el inventario y no se descomprime.
const LEER = /(^|\/)(\.gitignore|\.env(\.[\w-]+)?|\.npmrc|\.pypirc|Dockerfile|Gemfile|go\.mod|requirements[\w-]*\.txt|[\w.-]+\.lock|pnpm-lock\.yaml)$|\.(m?[jt]sx?|cjs|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|properties|xml|php|py|rb|go|java|kts?|cs|rs|dart|swift|vue|svelte|astro|sql|sh|ps1|tf|tfvars|pem|md|txt)$/i;
const NO_LEER = /\.(min\.js|map)$/i;

// El ZIP entra en Unzip de 16 KB en 16 KB: Unzip.push se llama a sí mismo una vez por cabecera, y con trozos pequeños
// la pila no crece con miles de entradas diminutas.
const TROZO_ZIP = 16_384;
// Y el deflate entra en Inflate de 4 KB en 4 KB: deflate no pasa de ~1032:1, así que entre dos comprobaciones del tope
// salen como mucho ~4 MB.
const TROZO_INFLAR = 4096;

export class ZipError extends Error {
  codigo: CodigoZip;
  constructor(codigo: CodigoZip) {
    super(codigo);
    this.name = 'ZipError';
    this.codigo = codigo;
  }
}

export function normalizarRuta(n: string): string | null {
  const p = n.replace(/\\/g, '/');
  if (p.length > LIM.ruta || /[\u0000-\u001f‪-‮⁦-⁩]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const seg = p.split('/');
  return seg.includes('..') || seg.length > LIM.prof ? null : p;
}

export function leerZip(buf: Uint8Array, opts: { origen: 'repo' | 'zip' }): { archivos: Map<string, string>; inventario: Inventario } {
  if (buf.byteLength > LIM.zip) throw new ZipError('ZIP_TOO_BIG');
  // Un ZIP vacío (22 B, solo el fin de directorio central: 50 4B 05 06) también cae aquí. Pasa ScanCreate, pero no hay
  // nada que analizar, así que se trata como «no es un ZIP».
  if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) throw new ZipError('ZIP_BAD_MAGIC');
  if (contarEntradas(buf) > LIM.entradas) throw new ZipError('ZIP_TOO_MANY_ENTRIES');
  const inv: Inventario = { entradas: 0, leidos: 0, omitidos: 0, tiene_git: false, rutas: [] };
  const archivos = new Map<string, string>();
  try {
    const elegidos = elegir(buf, opts.origen, inv);
    const td = new TextDecoder('utf-8', { fatal: false });
    if (elegidos.size) descomprimir(buf, elegidos, (p, b) => {
      if (b.subarray(0, 8192).includes(0)) return;                       // binario: byte NUL en los primeros 8 KB
      archivos.set(p, td.decode(b));
      inv.leidos++;
    });
  } catch (e) {
    throw e instanceof ZipError ? e : new ZipError('ZIP_INVALID');
  }
  inv.omitidos = inv.entradas - inv.leidos;
  return { archivos, inventario: inv };
}

// Número de entradas según el fin de directorio central (firma en los últimos 65 557 B) o, si hay localizador, según el
// ZIP64. Sin ZIP64, 0xFFFF son 65 535 entradas (APPNOTE 4.4.22): también pasa del tope. No descomprime nada.
function contarEntradas(buf: Uint8Array): number {
  const tope = Math.max(0, buf.length - 22 - 0xffff);
  let e = buf.length - 22;
  while (e >= tope && u32(buf, e) !== 0x06054b50) e--;
  if (e < tope) throw new ZipError('ZIP_INVALID');
  let n = Math.max(u16(buf, e + 8), u16(buf, e + 10));
  if (e >= 20 && u32(buf, e - 20) === 0x07064b50) {
    const z = u64(buf, e - 12);
    if (u32(buf, z) === 0x06064b50) n = Math.max(n, u64(buf, z + 24), u64(buf, z + 32));
  }
  return n;
}

const u16 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, i: number) => (u16(b, i) | (u16(b, i + 2) << 16)) >>> 0;
const u64 = (b: Uint8Array, i: number) => u32(b, i) + u32(b, i + 4) * 2 ** 32;

// Metadatos de «Comprimir» del Finder de macOS: __MACOSX/ (AppleDouble) y .DS_Store. Ni se leen ni cuentan para la raíz
// común: si contaran, la carpeta del proyecto no se quitaría y su .gitignore no estaría «en la raíz» (CB_GITIGNORE_NO_ENV falso).
const BASURA_MAC = /(^|\/)(__MACOSX\/|\.DS_Store$)/;

type Candidata = { nombre: string; p: string; coste: number; metodo: number };

// Primera pasada, con los tamaños declarados del directorio central: unzipSync lo recorre y el filtro devuelve siempre
// false, así que no se descomprime nada. Devuelve nombre crudo → rutas elegidas, ya sin la raíz común (una por
// aparición: puede repetirse).
function elegir(buf: Uint8Array, origen: 'repo' | 'zip', inv: Inventario): Map<string, string[]> {
  const candidatas: Candidata[] = [];
  unzipSync(buf, { filter(f) {
    if (++inv.entradas > LIM.entradas) throw new ZipError('ZIP_TOO_MANY_ENTRIES');
    const p = normalizarRuta(f.name);
    if (!p || p.endsWith('/') || BASURA_MAC.test(p)) return false;
    if (/(^|\/)\.git\//.test(p)) inv.tiene_git = true;
    inv.rutas.push({ p, s: f.originalSize });
    if (origen === 'zip' && f.originalSize > LIM.archivo && f.originalSize / Math.max(f.size, 1) > LIM.ratio)
      throw new ZipError('ZIP_RATIO');
    // coste = lo que unzipSync reservaría (S09 09.3)
    candidatas.push({ nombre: f.name, p, coste: f.compression === 0 ? f.size : f.originalSize, metodo: f.compression });
    return false;
  } });
  // Raíz común: el zipball de GitHub mete todo bajo "owner-repo-<sha7>/"; muchos ZIP de usuario, bajo "proyecto/".
  const primeros = new Set(inv.rutas.map((r) => r.p.split('/')[0]));
  const raiz = primeros.size === 1 && inv.rutas.every((r) => r.p.includes('/')) ? `${[...primeros][0]}/` : '';
  inv.rutas = inv.rutas.map((r) => ({ p: r.p.slice(raiz.length), s: r.s }));
  // SALTAR, LEER y NO_LEER se miran sin la raíz: un proyecto en una carpeta «dist» o «build» no se salta entero.
  const elegidos = new Map<string, string[]>();
  let total = 0;
  for (const c of candidatas) {
    const p = c.p.slice(raiz.length);
    if (SALTAR.test(p) || !LEER.test(p) || NO_LEER.test(p) || c.coste > LIM.archivo || (c.metodo !== 0 && c.metodo !== 8)) continue;
    if ((total += c.coste) > LIM.total) throw new ZipError('ZIP_TOO_BIG_UNCOMPRESSED');
    const cola = elegidos.get(c.nombre);
    if (cola) cola.push(p);
    else elegidos.set(c.nombre, [p]);
  }
  return elegidos;
}

// Segunda pasada: Unzip recorre las cabeceras locales y solo arranca las elegidas. Cada entrada que pasa de LIM.archivo
// bytes reales se para y se omite; si la suma real pasa de LIM.total, el ZIP entero se rechaza.
function descomprimir(buf: Uint8Array, elegidos: Map<string, string[]>, guardar: (p: string, b: Uint8Array) => void) {
  const estado: { fallo: CodigoZip | null } = { fallo: null };
  let locales = 0, real = 0;
  // ondata corre dentro del try de UnzipInflate.push, que se tragaría un throw: los fallos se apuntan y se lanzan fuera.
  const unzip = new Unzip((f) => {
    if (++locales > LIM.entradas) throw new ZipError('ZIP_TOO_MANY_ENTRIES');   // respaldo: cabeceras locales de más
    const cola = elegidos.get(f.name);
    // Con otro método, start() revienta. Lo que no se arranca ni se descomprime.
    if (!cola?.length || (f.compression !== 0 && f.compression !== 8)) return;
    const p = cola.shift()!;
    const partes: Uint8Array[] = [];
    let n = 0;
    f.ondata = (err, dat, final) => {
      if (err) { estado.fallo = 'ZIP_INVALID'; f.terminate(); return; }
      n += dat.length;
      if ((real += dat.length) > LIM.total) { estado.fallo = 'ZIP_TOO_BIG_UNCOMPRESSED'; f.terminate(); return; }
      if (n > LIM.archivo) { partes.length = 0; f.terminate(); return; }      // trae más de lo que declaró: se omite
      partes.push(dat);
      if (!final) return;
      guardar(p, unir(partes, n));
      partes.length = 0;
    };
    f.start();
  });
  unzip.register(InflarCortable);
  unzip.register(PasarCortable);
  for (let i = 0; i < buf.length && !estado.fallo; i += TROZO_ZIP)
    unzip.push(buf.subarray(i, i + TROZO_ZIP), i + TROZO_ZIP >= buf.length);
  if (estado.fallo) throw new ZipError(estado.fallo);
}

function unir(partes: Uint8Array[], n: number): Uint8Array {
  if (partes.length === 1) return partes[0]!;
  const b = new Uint8Array(n);
  let o = 0;
  for (const x of partes) { b.set(x, o); o += x.length; }
  return b;
}

// Decodificadores que se pueden parar: tras terminate() (lo llama UnzipFile.terminate), push() no hace nada.
class InflarCortable extends UnzipInflate {
  cortado = false;
  override push(dat: Uint8Array, final: boolean): void {
    for (let i = 0; !this.cortado;) {
      const j = Math.min(i + TROZO_INFLAR, dat.length);
      super.push(dat.subarray(i, j), final && j === dat.length);
      if ((i = j) >= dat.length) break;
    }
  }
  terminate(): void { this.cortado = true; }
}

class PasarCortable extends UnzipPassThrough {
  cortado = false;
  override push(dat: Uint8Array, final: boolean): void {
    if (!this.cortado) super.push(dat, final);
  }
  terminate(): void { this.cortado = true; }
}
