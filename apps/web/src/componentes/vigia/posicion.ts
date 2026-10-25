// Dónde se pone Vigía y hacia dónde señala (puro, sin DOM). Las cajas van en píxeles de la ventana.
import { CENTRO, DIRECCIONES, VIEWBOX, type Dir } from './formas';

export type Caja = { x: number; y: number; w: number; h: number };
export type Vista = { w: number; h: number };
export const TAM = { w: 140, h: 128 } as const;        // caja de Vigía en pantalla (proporción del viewBox)
const MARGEN = 12;                                      // con el borde de la ventana
const SEPARACION = 14;                                  // con el elemento señalado
const AIRE_BURBUJA = 8;                                 // entre la burbuja y Vigía

// Altura del centro de la cara (de donde sale la mano que señala) como fracción de la caja: sale del viewBox del dibujo.
const [, VB_Y = -40, , VB_ALTO = 256] = VIEWBOX.split(/\s+/).map(Number);
const ALTURA_CARA = (CENTRO.y - VB_Y) / VB_ALTO;

/** Dirección (de las 8) más cercana al vector (dx, dy), con y hacia abajo. */
export function dir8(dx: number, dy: number): Dir {
  if (!dx && !dy) return 's';
  const a = Math.atan2(dy, dx);                                    // -π..π, 0 = este
  const sector = Math.round(a / (Math.PI / 4));                    // -4..4
  const porSector: Record<number, Dir> = { 0: 'e', 1: 'se', 2: 's', 3: 'so', 4: 'o', [-4]: 'o', [-3]: 'no', [-2]: 'n', [-1]: 'ne' };
  return porSector[sector] ?? 'e';
}

const centro = (c: Caja) => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 });
const cabe = (c: Caja, v: Vista) => c.x >= MARGEN && c.y >= MARGEN && c.x + c.w <= v.w - MARGEN && c.y + c.h <= v.h - MARGEN;
const entre = (n: number, min: number, max: number) => Math.min(Math.max(min, n), Math.max(min, max));
export const limitar = (c: Caja, v: Vista): Caja => ({ ...c, x: entre(c.x, MARGEN, v.w - MARGEN - c.w), y: entre(c.y, MARGEN, v.h - MARGEN - c.h) });
/** Área en que se pisan dos cajas (0 si no se tocan). */
export const solape = (a: Caja, b: Caja) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// Huecos alrededor del objetivo, en orden de preferencia: a la derecha y abajo se lee mejor (el texto va de izquierda a
// derecha) y no tapa la cabecera.
const HUECOS: { dx: (o: Caja, t: typeof TAM) => number; dy: (o: Caja, t: typeof TAM) => number }[] = [
  { dx: (o) => o.x + o.w + SEPARACION, dy: (o, t) => o.y + o.h / 2 - t.h / 2 },             // derecha
  { dx: (o) => o.x + o.w + SEPARACION, dy: (o) => o.y + o.h + SEPARACION },                   // abajo a la derecha
  { dx: (o, t) => o.x + o.w / 2 - t.w / 2, dy: (o) => o.y + o.h + SEPARACION },               // abajo
  { dx: (o, t) => o.x - SEPARACION - t.w, dy: (o, t) => o.y + o.h / 2 - t.h / 2 },           // izquierda
  { dx: (o, t) => o.x - SEPARACION - t.w, dy: (o) => o.y + o.h + SEPARACION },               // abajo a la izquierda
  { dx: (o, t) => o.x + o.w / 2 - t.w / 2, dy: (o, t) => o.y - SEPARACION - t.h },           // arriba
  { dx: (o) => o.x + o.w + SEPARACION, dy: (o, t) => o.y - SEPARACION - t.h },               // arriba a la derecha
  { dx: (o, t) => o.x - SEPARACION - t.w, dy: (o, t) => o.y - SEPARACION - t.h },           // arriba a la izquierda
];

/** Hacia dónde queda `objetivo` visto desde la cara de Vigía en `caja`: al punto más cercano del objetivo (así, en
 *  diagonal señala la esquina y no el centro de una fila ancha); si la cara cae dentro, a su centro. */
export function dirHacia(caja: Caja, objetivo: Caja): Dir {
  const cara = { x: caja.x + caja.w / 2, y: caja.y + caja.h * ALTURA_CARA };
  const px = entre(cara.x, objetivo.x, objetivo.x + objetivo.w), py = entre(cara.y, objetivo.y, objetivo.y + objetivo.h);
  if (px === cara.x && py === cara.y) { const o = centro(objetivo); return dir8(o.x - cara.x, o.y - cara.y); }
  return dir8(px - cara.x, py - cara.y);
}

/** Posición de Vigía junto al objetivo y la dirección hacia la que tiene que señalar. Si nada cabe, la más cercana. */
export function junto(objetivo: Caja, vista: Vista, tam: typeof TAM = TAM): { caja: Caja; dir: Dir } {
  const candidatas = HUECOS.map((h) => ({ x: h.dx(objetivo, tam), y: h.dy(objetivo, tam), w: tam.w, h: tam.h }));
  const caja = candidatas.find((c) => cabe(c, vista)) ?? limitar(candidatas[0]!, vista);
  return { caja, dir: dirHacia(caja, objetivo) };
}

/** Rincón de inicio: abajo a la derecha, por encima del borde. */
export const inicio = (vista: Vista, tam: typeof TAM = TAM): Caja =>
  limitar({ x: vista.w - tam.w - 24, y: vista.h - tam.h - 24, w: tam.w, h: tam.h }, vista);

/** Centro de la ventana, un poco por debajo de la mitad (encima queda sitio para la burbuja): donde da la bienvenida. */
export const alCentro = (vista: Vista, tam: typeof TAM = TAM): Caja =>
  limitar({ x: vista.w / 2 - tam.w / 2, y: vista.h * 0.55 - tam.h / 2, w: tam.w, h: tam.h }, vista);

// ── Teletransporte: píxeles en que se deshace y rastro entre origen y destino (posiciones fijas, sin azar) ─────
export type Pixel = { x: number; y: number; dx: number; dy: number; t: number; d: number; tono: 'cian' | 'violeta' };
/** Pseudoazar fijo en [0, 1): el mismo dibujo en cada salto (y en las pruebas). */
const ruido = (i: number) => { const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };

/** `n` píxeles sobre la figura (x, y en % de la caja) que salen despedidos hacia fuera (dx, dy en px). t: lado en px;
 *  d: retraso en ms. */
export function pixeles(n: number): Pixel[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + ruido(i) * 0.6, r = 0.12 + ruido(i + 40) * 0.26, lejos = 34 + ruido(i + 80) * 40;
    return {
      x: +(50 + Math.cos(a) * r * 100).toFixed(1), y: +(46 + Math.sin(a) * r * 100).toFixed(1),
      dx: Math.round(Math.cos(a) * lejos), dy: Math.round(Math.sin(a) * lejos),
      t: 4 + Math.round(ruido(i + 120) * 5), d: Math.round(ruido(i + 160) * 70), tono: i % 3 === 1 ? 'violeta' : 'cian',
    };
  });
}

/** `n` píxeles en fila entre el centro de `a` y el de `b` (en px de la ventana), con un leve temblor a los lados; el
 *  retraso crece hacia el destino para que el rastro «viaje». Sin distancia, no hay rastro. */
export function rastro(a: Caja, b: Caja, n: number): Pixel[] {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const largo = Math.hypot(bx - ax, by - ay);
  if (largo < 1) return [];
  const nx = -(by - ay) / largo, ny = (bx - ax) / largo;     // normal a la línea
  return Array.from({ length: n }, (_, i) => {
    const k = (i + 0.5) / n, lado = (ruido(i + 200) - 0.5) * 22;
    return {
      x: Math.round(ax + (bx - ax) * k + nx * lado), y: Math.round(ay + (by - ay) * k + ny * lado),
      dx: 0, dy: 0, t: 3 + Math.round(ruido(i + 240) * 4), d: Math.round(k * 220), tono: i % 2 ? 'violeta' : 'cian',
    };
  });
}

export type LadoBurbuja = 'arriba' | 'abajo' | 'derecha' | 'izquierda';

/** Burbuja de texto junto a Vigía: arriba, abajo, a la derecha o a la izquierda, el primer lado que cabe en la ventana
 *  sin tapar `evitar` (el elemento señalado) ni a Vigía. Si ninguno lo consigue, el que menos tapa. Nunca se sale de la
 *  ventana. */
export function burbuja(vigia: Caja, vista: Vista, ancho: number, alto: number, evitar?: Caja | null): { x: number; y: number; lado: LadoBurbuja } {
  const cx = vigia.x + vigia.w / 2 - ancho / 2, cy = vigia.y + vigia.h / 2 - alto / 2;
  const lados: { lado: LadoBurbuja; x: number; y: number; cabe: boolean }[] = [
    { lado: 'arriba', x: cx, y: vigia.y - AIRE_BURBUJA - alto, cabe: vigia.y - AIRE_BURBUJA - alto >= MARGEN },
    { lado: 'abajo', x: cx, y: vigia.y + vigia.h + AIRE_BURBUJA, cabe: vigia.y + vigia.h + AIRE_BURBUJA + alto <= vista.h - MARGEN },
    { lado: 'derecha', x: vigia.x + vigia.w + AIRE_BURBUJA, y: cy, cabe: vigia.x + vigia.w + AIRE_BURBUJA + ancho <= vista.w - MARGEN },
    { lado: 'izquierda', x: vigia.x - AIRE_BURBUJA - ancho, y: cy, cabe: vigia.x - AIRE_BURBUJA - ancho >= MARGEN },
  ];
  const puestas = lados.map((l) => {
    const c = limitar({ x: l.x, y: l.y, w: ancho, h: alto }, vista);
    return { lado: l.lado, x: c.x, y: c.y, cabe: l.cabe, tapa: (evitar ? solape(c, evitar) : 0) + solape(c, vigia) };
  });
  const elegida = puestas.find((p) => p.cabe && !p.tapa) ?? [...puestas].sort((a, b) => a.tapa - b.tapa)[0]!;
  return { x: elegida.x, y: elegida.y, lado: elegida.lado };
}

export const esDir = (x: unknown): x is Dir => typeof x === 'string' && (DIRECCIONES as readonly string[]).includes(x);
