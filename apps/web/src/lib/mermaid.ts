// Mermaid de la wiki (DeepWiki): el motor solo deja pasar `flowchart LR` con líneas `A[Etiqueta] --> B` o
// `A -->|texto| B` (lista blanca: alfanumérico y espacios, 6–12 nodos). Aquí se parsea y se dispone en columnas por
// camino más largo para pintarlo como SVG con <text> de React: sin la librería mermaid (~1 MB) ni innerHTML.
export type Nodo = { id: string; etiqueta: string; col: number; fila: number };
export type Arista = { de: string; a: string; texto: string | null };
export type Grafo = { nodos: Nodo[]; aristas: Arista[]; columnas: number; filas: number };

const ID = '([A-Za-z][A-Za-z0-9_]*)';
const ETQ = '(?:\\[([A-Za-z0-9áéíóúüñÁÉÍÓÚÜÑ .,_-]{1,60})\\])?';
const TEXTO = '[A-Za-z0-9áéíóúüñÁÉÍÓÚÜÑ .,_-]{1,60}';
const ARISTA = new RegExp(`^${ID}${ETQ}\\s*-->\\s*(?:\\|(${TEXTO})\\|\\s*)?${ID}${ETQ}$`);
const SOLO = new RegExp(`^${ID}${ETQ}$`);
const MAX_NODOS = 16;

export function parsearMermaid(fuente: string): Grafo | null {
  const lineas = fuente.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!/^(flowchart|graph) LR$/.test(lineas[0] ?? '')) return null;
  const etiquetas = new Map<string, string>();
  const aristas: Arista[] = [];
  const nombrar = (id: string, e?: string) => { if (e) etiquetas.set(id, e.trim()); else if (!etiquetas.has(id)) etiquetas.set(id, id); };
  for (const l of lineas.slice(1)) {
    const m = l.match(ARISTA);
    if (m) {
      const [, de, eDe, texto, a, eA] = m;
      nombrar(de!, eDe); nombrar(a!, eA);
      aristas.push({ de: de!, a: a!, texto: texto?.trim() ?? null });
      continue;
    }
    const s = l.match(SOLO);
    if (!s) return null;                                   // cualquier otra sintaxis: no se dibuja, se muestra el código
    nombrar(s[1]!, s[2]);
  }
  if (etiquetas.size === 0 || etiquetas.size > MAX_NODOS) return null;

  // Columna = camino más largo desde una fuente (relajación acotada: con ciclos no se queda en bucle).
  const ids = [...etiquetas.keys()];
  const col = new Map(ids.map((id) => [id, 0]));
  for (let i = 0; i < ids.length; i++) {
    let cambio = false;
    for (const ar of aristas) {
      const c = col.get(ar.de)! + 1;
      if (ar.de !== ar.a && c > col.get(ar.a)! && c < ids.length) { col.set(ar.a, c); cambio = true; }
    }
    if (!cambio) break;
  }
  const porCol = new Map<number, string[]>();
  for (const id of ids) porCol.set(col.get(id)!, [...(porCol.get(col.get(id)!) ?? []), id]);
  const nodos = ids.map((id) => ({ id, etiqueta: etiquetas.get(id)!, col: col.get(id)!, fila: porCol.get(col.get(id)!)!.indexOf(id) }));
  return { nodos, aristas, columnas: Math.max(...nodos.map((n) => n.col)) + 1, filas: Math.max(...[...porCol.values()].map((v) => v.length)) };
}

// Parte una etiqueta en dos líneas como mucho para que quepa en la caja.
export function partir(t: string, max = 18): string[] {
  if (t.length <= max) return [t];
  const corte = t.lastIndexOf(' ', max);
  const i = corte > 4 ? corte : max;
  const resto = t.slice(i).trim();
  return [t.slice(0, i).trim(), resto.length > max ? resto.slice(0, max - 1) + '…' : resto];
}
