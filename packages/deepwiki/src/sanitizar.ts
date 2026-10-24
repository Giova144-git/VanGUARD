// Saneo de la salida del modelo antes de guardarla o mostrarla. Esa salida NO es confiable: un archivo del repo pudo
// inyectar instrucciones y el modelo pudo obedecer. Por eso: sin HTML, sin enlaces ni imágenes, sin URLs, sin bloques
// de código salvo Mermaid, y el Mermaid solo si pasa una lista blanca estricta (base: SAFE_LINE de Andrés en
// deepwiki/src/index.mjs, commit 14c229a). Todo es lineal y por líneas: corre en un paso del Worker con 10 ms de CPU.

export const NOTA_MERMAID = '_(Diagrama omitido: no pasó la validación de seguridad.)_';
export const MAX_MD = 20_000;       // WikiDoc.overview_md
export const MAX_MERMAID = 4_000;   // WikiDoc.mermaid
const MIN_NODOS = 2;
const MAX_NODOS = 14;
const MAX_LINEAS_MERMAID = 60;
const MAX_LARGO_LINEA = 300;

export type ValidacionMermaid = { ok: boolean; motivo: string | null };
export type MermaidExtraido = { md: string; mermaid: string | null; descartado: boolean };

// ---------------------------------------------------------------------------------------------------------------
// Bloques de código (cercos ``` o ~~~), recorridos línea a línea como CommonMark: un cerco sin cerrar llega hasta el
// final del texto, y un cerco de comillas invertidas no puede llevar comillas invertidas en su línea de apertura.

type Bloque = { tipo: 'texto' | 'mermaid' | 'codigo'; lineas: string[]; apertura: string; cierre: string | null };

const APERTURA = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)(.*)$/;
const CIERRE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function partirEnBloques(md: string): Bloque[] {
  const out: Bloque[] = [];
  let actual: Bloque = { tipo: 'texto', lineas: [], apertura: '', cierre: null };
  let valla = '';
  for (const linea of md.split('\n')) {
    if (!valla) {
      const m = APERTURA.exec(linea);
      const cerco = m?.[1];
      if (m && cerco && !(cerco[0] === '`' && (m[3] ?? '').includes('`'))) {
        if (actual.lineas.length) out.push(actual);
        const lengua = (m[2] ?? '').toLowerCase();
        actual = { tipo: lengua === 'mermaid' ? 'mermaid' : 'codigo', lineas: [], apertura: linea, cierre: null };
        valla = cerco;
        continue;
      }
      actual.lineas.push(linea);
      continue;
    }
    const c = CIERRE.exec(linea)?.[1];
    if (c && c[0] === valla[0] && c.length >= valla.length) {
      actual.cierre = linea;
      out.push(actual);
      actual = { tipo: 'texto', lineas: [], apertura: '', cierre: null };
      valla = '';
      continue;
    }
    actual.lineas.push(linea);
  }
  if (actual.tipo !== 'texto' || actual.lineas.length) out.push(actual);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Mermaid: lista blanca estricta. Solo «flowchart LR|TD», nodos id o id[Etiqueta] y flechas --> con rótulo opcional
// |texto|, encadenables en una línea. Cualquier otra cosa (click, style, %%{init}, formas, comillas, HTML) se rechaza.

const CABECERA = /^flowchart[ \t]+(?:LR|TD)$/;
const PROHIBIDAS = /\b(click|style|classdef|linkstyle|init|href|call|javascript|subgraph)\b/i;
const RESERVADOS = new Set(['end', 'graph', 'flowchart', 'subgraph', 'click', 'style', 'class', 'classdef', 'linkstyle',
  'direction', 'call', 'href', 'init', 'default']);
const ID = /[A-Za-z][A-Za-z0-9_]{0,30}/y;
// Solo letras (tildes y eñe del español), números y espacios: nada de ( ) " ' { } [ ] < > : ; # & | % / ni Unicode raro.
const ETIQUETA = /^[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ ]{1,40}$/;
const ETIQUETA_FLECHA = /^[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ ]{1,30}$/;

const no = (motivo: string): ValidacionMermaid => ({ ok: false, motivo });
const esBlanco = (c: string | undefined) => c === ' ' || c === '\t';

// Devuelve null si la línea es válida o el motivo si no. Añade a `nodos` los identificadores que vea.
function analizarLinea(l: string, nodos: Set<string>): string | null {
  let i = 0;
  for (;;) {
    ID.lastIndex = i;
    const m = ID.exec(l);
    if (!m) return 'se esperaba un nodo';
    const id = m[0];
    if (RESERVADOS.has(id.toLowerCase())) return 'identificador reservado';
    i = ID.lastIndex;
    if (l[i] === '[') {
      const fin = l.indexOf(']', i + 1);
      const et = fin < 0 ? '' : l.slice(i + 1, fin);
      if (!ETIQUETA.test(et) || !et.trim()) return 'etiqueta de nodo no permitida';
      i = fin + 1;
    }
    nodos.add(id);
    while (esBlanco(l[i])) i++;
    if (i >= l.length) return null;
    if (!l.startsWith('-->', i)) return 'solo se permiten flechas -->';
    i += 3;
    while (esBlanco(l[i])) i++;
    if (l[i] === '|') {
      const fin = l.indexOf('|', i + 1);
      const et = fin < 0 ? '' : l.slice(i + 1, fin);
      if (!ETIQUETA_FLECHA.test(et) || !et.trim()) return 'rótulo de flecha no permitido';
      i = fin + 1;
      while (esBlanco(l[i])) i++;
    }
  }
}

// `cuerpo` es lo que va dentro del cerco ```mermaid, sin los cercos. Los motivos nunca repiten contenido del modelo.
export function validarMermaid(cuerpo: string): ValidacionMermaid {
  if (typeof cuerpo !== 'string' || !cuerpo.trim()) return no('diagrama vacío');
  if (cuerpo.length > MAX_MERMAID) return no('diagrama demasiado largo');
  if (cuerpo.includes('%%')) return no('contiene directivas o comentarios %%');
  const p = PROHIBIDAS.exec(cuerpo);
  if (p) return no(`contiene la palabra prohibida ${(p[1] ?? '').toLowerCase()}`);
  const lineas = cuerpo.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lineas.length > MAX_LINEAS_MERMAID) return no('demasiadas líneas');
  if (!CABECERA.test(lineas[0] ?? '')) return no('debe empezar por flowchart LR o flowchart TD');
  const nodos = new Set<string>();
  for (let k = 1; k < lineas.length; k++) {
    const l = lineas[k] ?? '';
    if (l.length > MAX_LARGO_LINEA) return no(`línea ${k + 1} demasiado larga`);
    const error = analizarLinea(l, nodos);
    if (error) return no(`línea ${k + 1}: ${error}`);
  }
  if (nodos.size < MIN_NODOS || nodos.size > MAX_NODOS) {
    return no(`tiene ${nodos.size} nodos; se aceptan entre ${MIN_NODOS} y ${MAX_NODOS}`);
  }
  return { ok: true, motivo: null };
}

// Forma canónica del diagrama ya validado: cabecera y una conexión por línea con sangría fija.
function normalizarMermaid(cuerpo: string): string {
  const lineas = cuerpo.split('\n').map((l) => l.trim().replace(/[ \t]+/g, ' ')).filter(Boolean);
  return lineas.map((l, k) => (k === 0 ? l : `  ${l}`)).join('\n');
}

// Saca el diagrama del Markdown: el primer bloque ```mermaid válido se devuelve aparte (normalizado) y todos los
// bloques mermaid se quitan del texto; si había alguno y ninguno pasó, en el sitio del primero queda NOTA_MERMAID.
// Los demás bloques de código se dejan tal cual (los quita sanearMarkdown). Si recibe un texto ya saneado que trae
// la nota, también lo cuenta como descartado, para que el orden de las llamadas no cambie el resultado.
export function extraerYValidarMermaid(md: string): MermaidExtraido {
  const salida: string[] = [];
  let mermaid: string | null = null;
  let huboBloques = false;
  let posPrimero = -1;
  for (const b of partirEnBloques(normalizarEntrada(md))) {
    if (b.tipo === 'texto') { salida.push(b.lineas.join('\n')); continue; }
    if (b.tipo === 'codigo') {
      salida.push([b.apertura, ...b.lineas, ...(b.cierre === null ? [] : [b.cierre])].join('\n'));
      continue;
    }
    if (!huboBloques) { huboBloques = true; posPrimero = salida.length; salida.push(''); }
    const cuerpo = b.lineas.join('\n');
    if (mermaid === null && validarMermaid(cuerpo).ok) mermaid = normalizarMermaid(cuerpo);
  }
  const descartado = mermaid === null && (huboBloques || md.includes(NOTA_MERMAID));
  if (descartado && posPrimero >= 0) salida[posPrimero] = NOTA_MERMAID;
  return { md: colapsar(salida.join('\n')).trim(), mermaid, descartado };
}

// ---------------------------------------------------------------------------------------------------------------
// Texto: sin HTML, imágenes, enlaces ni URLs. Las clases de caracteres excluyen el propio delimitador de apertura
// para que entradas como «[[[[» o «<a<a<a» no hagan que cada intento recorra el resto del texto.

// Controles, marcas bidi (Trojan Source) y caracteres de ancho cero; los \r se normalizan a \n.
const INVISIBLES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function normalizarEntrada(md: string): string {
  return desenvolver(String(md ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLES, ''));
}

// A veces el modelo envuelve TODO en ```markdown ... ``` pese al prompt: sin esto el documento entero se tiraría
// como bloque de código. Solo se desenvuelve con lengua markdown/md explícita; si falta el cierre, se quita la apertura.
function desenvolver(md: string): string {
  const t = md.trim();
  const m = /^(?:`{3,}|~{3,})[ \t]*(?:markdown|md)[ \t]*\n/i.exec(t);
  if (!m) return md;
  const cuerpo = t.slice(m[0].length);
  const cierre = /\n[ \t]*(?:`{3,}|~{3,})[ \t]*$/.exec(cuerpo);
  return cierre ? cuerpo.slice(0, cierre.index) : cuerpo;
}

// El lookbehind deja un solo comienzo por racha de blancos: con /[ \t]+$/gm cada espacio de una racha larga en medio
// de una línea era un intento nuevo que la recorría entera (20.000 espacios: ~0,5 s en vez de ~0,2 ms).
function colapsar(t: string): string {
  return t.replace(/(?<![ \t])[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

// Destino de un enlace: admite un nivel de paréntesis, como en javascript:alert(1). Las dos ramas empiezan por
// caracteres distintos, así que no hay ambigüedad ni retroceso exponencial.
const DESTINO = String.raw`\((?:[^()\[\]\n]|\([^()\n]{0,200}\)){0,1000}\)`;
const IMAGEN = new RegExp(String.raw`!\[[^\[\]\n]{0,300}\]` + DESTINO, 'g');
const ENLACE = new RegExp(String.raw`\[([^\[\]\n]{0,300})\]` + DESTINO, 'g');

function limpiarTexto(t: string): string {
  return colapsar(t
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')                                    // comentarios HTML (también sin cerrar)
    // Elementos cuyo contenido tampoco debe quedar como texto; sin cierre, se va hasta el final.
    .replace(/<(script|style|iframe|object|embed|template|noscript|textarea|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(IMAGEN, '')                                                      // imagen ![alt](url)
    .replace(/!\[[^\[\]\n]{0,300}\]\[[^\[\]\n]{0,200}\]/g, '')                // imagen por referencia
    .replace(/^ {0,3}\[[^\[\]\n]{1,200}\]:[^\n]*$/gm, '')                     // definición [ref]: url
    .replace(ENLACE, '$1')                                                    // [texto](url) -> texto
    .replace(/\[([^\[\]\n]{1,300})\]\[[^\[\]\n]{0,200}\]/g, '$1')             // [texto][ref] -> texto
    .replace(/<\/?[A-Za-z!?][^<>]{0,2000}>/g, '')                             // etiquetas HTML y <http://...>
    .replace(/<(?=[A-Za-z\/!?])/g, '')                                        // etiquetas sin cerrar
    .replace(/\b(?:https?|ftps?|sftp|wss?):\/\/\S*/gi, '')                    // URLs sueltas
    .replace(/\b(?:javascript|vbscript|data|file|blob|mailto):\S+/gi, '')     // esquemas peligrosos
    .replace(/\bwww\.\S+/gi, '')                                              // GFM convierte www.x en enlace
    .replace(/(?<![:\w\/])\/\/[^\s)\/][^\s)]*/g, '')                         // destinos //host sin esquema
    // Al final, todo corchete que quede va escapado con UNA barra: un corchete escapado nunca forma enlace, imagen
    // ni definición, aunque venga anidado, partido en varias líneas, con el esquema escrito como entidad o con la
    // definición dentro de una cita o lista (que en CommonMark vale para todo el documento). Idempotente. El
    // lookbehind deja un solo comienzo por racha de barras (si no, una racha larga sin corchete sería cuadrática).
    .replace(/(?<!\\)\\*([\[\]])/g, '\\$1'));
}

// Recorta a `max` sin partir un diagrama: el texto se corta por línea con «…», un bloque mermaid entra entero o no.
function unirConTope(piezas: { s: string; atomica: boolean }[], max: number): string {
  let out = '';
  for (const p of piezas) {
    if (!p.s) continue;
    const sep = out ? '\n\n' : '';
    if (out.length + sep.length + p.s.length <= max) { out += sep + p.s; continue; }
    if (!p.atomica) {
      const resto = max - out.length - sep.length - 1;
      if (resto > 0) {
        let corte = p.s.slice(0, resto);
        const nl = corte.lastIndexOf('\n');
        if (nl > resto / 2) corte = corte.slice(0, nl);
        corte = corte.trimEnd();
        if (corte) out += sep + corte + '…';
      }
    }
    break;
  }
  return out;
}

// Sanea Markdown del modelo. Quita bloques de código salvo mermaid; un mermaid se conserva solo si pasa
// validarMermaid (si no, NOTA_MERMAID), así la función es segura por sí sola. Para el overview, mejor sanearSalida.
export function sanearMarkdown(md: string, max: number = MAX_MD): string {
  const piezas: { s: string; atomica: boolean }[] = [];
  for (const b of partirEnBloques(normalizarEntrada(md))) {
    if (b.tipo === 'texto') piezas.push({ s: limpiarTexto(b.lineas.join('\n')).trim(), atomica: false });
    else if (b.tipo === 'mermaid') {
      const cuerpo = b.lineas.join('\n');
      piezas.push(validarMermaid(cuerpo).ok
        ? { s: '```mermaid\n' + normalizarMermaid(cuerpo) + '\n```', atomica: true }
        : { s: NOTA_MERMAID, atomica: false });
    }
    // b.tipo === 'codigo': fuera, con su contenido.
  }
  return unirConTope(piezas, Math.max(0, max));
}

// Orden correcto para la salida de la síntesis: primero se separa y valida el diagrama, luego se sanea el resto.
export function sanearSalida(md: string, max: number = MAX_MD): MermaidExtraido {
  const e = extraerYValidarMermaid(md);
  return { md: sanearMarkdown(e.md, max), mermaid: e.mermaid, descartado: e.descartado };
}
