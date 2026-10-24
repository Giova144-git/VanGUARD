// Mirada del isotipo (gazeLoop, aim y saccade de brand/index.html): la pupila sigue al puntero con un resorte amortiguado
// y, si nadie la mueve, hace sacadas (saltos rápidos) a puntos al azar. Unidades del viewBox del símbolo (200 × 118).
export const RANGO = { x: 17, arriba: 8, abajo: 6 };
const SUAVE = { k: 0.07, amort: 0.74 };
const RAPIDO = { k: 0.22, amort: 0.6 };   // sacada

export type Mirada = { x: number; y: number; vx: number; vy: number; tx: number; ty: number; k: number; amort: number };

export const reposo = (): Mirada => ({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, ...SUAVE });

// nx y ny van de -1 a 1 desde el centro del ojo; lo que pasa de 1 se recorta a una elipse, no a un rectángulo.
export function apuntar(m: Mirada, nx: number, ny: number, rapido = false): void {
  const r = Math.hypot(nx, ny);
  if (r > 1) { nx /= r; ny /= r; }
  m.tx = nx * RANGO.x;
  m.ty = ny * (ny < 0 ? RANGO.arriba : RANGO.abajo);
  Object.assign(m, rapido ? RAPIDO : SUAVE);
}

// Un cuadro del resorte. false = ya llegó: no hace falta pedir otro requestAnimationFrame hasta que cambie el destino.
export function avanzar(m: Mirada): boolean {
  m.vx = (m.vx + (m.tx - m.x) * m.k) * m.amort;
  m.vy = (m.vy + (m.ty - m.y) * m.k) * m.amort;
  m.x += m.vx; m.y += m.vy;
  return Math.abs(m.vx) + Math.abs(m.vy) + Math.abs(m.tx - m.x) + Math.abs(m.ty - m.y) > 0.01;
}

// Al mirar de lado la pupila se ve un poco de perfil.
export function transformacion(m: Mirada): string {
  const perfil = 1 - 0.1 * Math.min(1, Math.abs(m.x) / RANGO.x);
  return `translate(${m.x.toFixed(2)}px, ${m.y.toFixed(2)}px) scaleX(${perfil.toFixed(3)})`;
}

// Un punto al azar dentro del ojo; tres de cada diez veces, el centro.
export function sacada(m: Mirada, azar: () => number = Math.random): void {
  const a = azar() * Math.PI * 2, r = azar() < 0.3 ? 0 : 0.35 + azar() * 0.55;
  apuntar(m, Math.cos(a) * r, Math.sin(a) * r * 0.8, true);
}

// Puntero → destino: la distancia al ojo en medias pantallas, ×2 (brand/index.html usa ×1,4) para que se note aunque el
// puntero ande cerca, como en /login: a un cuarto de pantalla ya mira al borde.
export const GANANCIA = 2;
export function haciaPuntero(m: Mirada, px: number, py: number, ojo: { x: number; y: number }, pantalla: { ancho: number; alto: number }): void {
  apuntar(m, ((px - ojo.x) / (pantalla.ancho / 2)) * GANANCIA, ((py - ojo.y) / (pantalla.alto / 2)) * GANANCIA);
}

// Parpadeo (blink de brand/index.html): cada cuadro es un d con los mismos comandos y otros números. Se separa una vez
// en plantilla + números y luego se interpola entre los dos cuadros vecinos, así el movimiento es continuo a cualquier
// frecuencia de pantalla.
const NUM = /-?\d+(?:\.\d+)?/g;
export type Cuadros = { plantilla: string[]; nums: number[][] };
export const preparar = (cuadros: string[]): Cuadros => ({
  plantilla: cuadros[0]!.split(NUM), nums: cuadros.map((c) => (c.match(NUM) ?? []).map(Number)),
});
export function entreCuadros({ plantilla, nums }: Cuadros, f: number): string {
  const pos = Math.min(1, Math.max(0, f)) * (nums.length - 1), i = Math.min(Math.floor(pos), nums.length - 2), a = pos - i;
  const A = nums[i]!, B = nums[i + 1]!;
  let d = plantilla[0]!;
  for (let j = 0; j < A.length; j++) d += (A[j]! + (B[j]! - A[j]!) * a).toFixed(2) + plantilla[j + 1];
  return d;
}
