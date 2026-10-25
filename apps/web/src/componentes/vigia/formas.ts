// Vigía, la guía de VanGUARD: geometría, poses y expresiones (datos puros, sin React). Es una cabeza flotante del
// concept art (melena lacia de cuchillas blancas con mechas cian y violeta, gafas redondeadas en G con pupila en V cian,
// esquirlas alrededor) con dos manos de cristal sueltas, sin brazos: señalan, saludan y gesticulan como en los stickers.
// La cara es una capa independiente: cualquier expresión vale con cualquier pose. Unidades: el viewBox del personaje
// (VIEWBOX, centro en x = 120); los ojos viven en su propia caja local (el lente mide 148 × 112, centro 104, 53).

export const VIEWBOX = '-20 -40 280 256';

type Punto = [number, number];
const puntos = (d: string): Punto[] => [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const trazo = (p: Punto[]) => `M${p.map(([x, y]) => `${+x.toFixed(2)} ${+y.toFixed(2)}`).join(' L')} Z`;
/** Refleja un polígono en x (240 - x): el lado derecho sale del izquierdo. */
export const ESP = (d: string) => trazo(puntos(d).map(([x, y]) => [240 - x, y]));
/** Faceta en sombra de una cuchilla: la mitad interior, de la raíz (primer punto) a la punta (el punto más bajo). */
export function faceta(d: string): string {
  const p = puntos(d);
  const punta = p.reduce((m, q, i) => (q[1] > p[m]![1] ? i : m), 0);
  return trazo([p[0]!, ...p.slice(punta)]);
}

// ── Melena: cuchillas de cristal roto, anchas y facetadas, con las puntas hacia fuera y hacia abajo ─────────────
export type Tono = 'pelo' | 'cian' | 'violeta';
export type Mechon = { d: string; tono: Tono; sombra: boolean };
const m = (d: string, tono: Tono = 'pelo', sombra = tono === 'pelo'): Mechon => ({ d, tono, sombra });

/** Acorta una cuchilla por debajo de la raíz (y > 60): sin cuerpo, la melena flota bajo la barbilla. */
const corta = (d: string) => trazo(puntos(d).map(([x, y]) => [x, y > 60 ? 60 + (y - 60) * 0.7 : y]));
const ALA = 'M74 44 L46 50 L10 72 L50 76 L70 66 Z';                          // se abre hacia la sien
const LARGO_1 = corta('M80 40 L50 70 L20 120 L6 176 L40 134 L58 100 L72 76 Z');
const LARGO_2 = corta('M86 52 L64 94 L50 150 L54 214 L70 162 L78 112 L90 72 Z');
const LARGO_3 = corta('M96 62 L84 110 L84 184 L96 142 L100 96 Z');
const MECHA_CIAN = corta('M72 70 L46 118 L28 170 L58 134 L72 100 Z');
const MECHA_VIOLETA = corta('M88 100 L72 160 L76 222 L90 170 Z');
// El lado derecho no es un espejo exacto: más corto arriba y con una cuchilla que sale disparada hacia fuera.
const LARGO_1D = corta('M160 40 L192 66 L224 108 L236 160 L200 128 L182 98 L168 76 Z');
const ALA_D = 'M164 50 L196 46 L228 60 L194 70 L172 66 Z';
/** Detrás de la cara: la masa de la coronilla, púas arriba y las cuchillas largas (con las mechas entre ellas). */
export const MELENA: readonly Mechon[] = [
  m('M64 74 L70 40 L92 14 L120 4 L148 14 L170 40 L176 74 L150 52 L120 44 L90 52 Z', 'pelo', false),
  m('M92 28 L70 2 L106 16 Z'), m('M104 18 L96 -14 L120 10 Z'), m('M122 12 L136 -16 L140 14 Z'), m('M142 18 L172 -2 L160 32 Z'),
  m('M116 12 L112 -6 L126 8 Z', 'violeta'), m('M152 24 L176 14 L166 38 Z', 'cian'),
  m(ALA), m(ALA_D),
  m(LARGO_1), m(MECHA_CIAN, 'cian'), m(LARGO_2), m(LARGO_3), m(MECHA_VIOLETA, 'violeta'),
  m(LARGO_1D), m(ESP(MECHA_CIAN), 'violeta'), m(ESP(LARGO_2)), m(ESP(LARGO_3)), m(ESP(MECHA_VIOLETA), 'cian'),
];
const LADO = 'M80 56 L70 76 L64 114 L70 160 L78 120 L77 82 Z';
const LADO_D = 'M160 56 L170 76 L174 104 L168 134 L163 104 L163 80 Z';
/** Delante de la cara: el casquete, los mechones que la enmarcan y el flequillo, que barre en diagonal de derecha a
 *  izquierda y tapa ese lado de la frente (sus puntas se quedan por encima de las gafas). */
export const FLEQUILLO: readonly Mechon[] = [
  m('M72 70 L78 42 L96 22 L120 14 L144 22 L162 42 L168 70 L154 54 L120 46 L86 54 Z', 'pelo', false),
  m(LADO), m(LADO_D),
  m('M146 24 L156 40 L162 60 L166 80 L152 60 L140 40 Z'),
  m('M130 22 L134 38 L140 54 L146 72 L146 50 L142 32 Z'),
  m('M154 36 L162 52 L160 70 L152 52 Z', 'violeta'),
  m('M160 32 L134 40 L112 56 L100 78 L120 62 L144 50 Z'),
  m('M150 24 L120 32 L96 48 L84 64 L84 80 L100 60 L124 44 Z'),
  m('M132 30 L112 44 L104 58 L120 50 Z', 'cian'),
  m('M138 20 L104 28 L80 44 L66 68 L60 98 L76 72 L94 52 L116 36 Z'),
];
/** Punto de la coronilla desde el que la melena entera se va hacia atrás al volar. */
export const CORONILLA = { x: 120, y: 30 } as const;

// ── Cabeza ─────────────────────────────────────────────────────────────────────────────────────────────────
export const CRANEO = 'M76 66 L84 46 L104 32 L136 32 L156 46 L164 66 L164 100 L154 120 L136 134 L120 138 L104 134 L86 120 L76 100 Z';
export const MEJILLA = 'M136 112 L163 100 L154 120 L136 134 Z';     // faceta en sombra de la cara
/** Centro de la cara: de aquí sale el apunte, gira el cuerpo entero y se ensambla al aparecer. */
export const CENTRO = { x: 120, y: 88 } as const;
/** Pivote de la cabeza al inclinarse (algo por debajo del centro, como un cuello que no se ve). */
export const NUCA = { x: 120, y: 120 } as const;

// ── Esquirlas: fragmentos cian y violeta que flotan alrededor ──────────────────────────────────────────────────
export type Fragmento = { d: string; x: number; y: number; r: number; tono: 'cian' | 'violeta' };
const esquirla = (l: number) => `M0 ${-l} L${+(l * 0.32).toFixed(1)} ${+(-l * 0.1).toFixed(1)} L0 ${l} L${+(-l * 0.3).toFixed(1)} ${+(l * 0.22).toFixed(1)} Z`;
export const FRAGMENTOS: readonly Fragmento[] = [
  { x: 24, y: 58, r: 18, d: esquirla(16), tono: 'cian' },
  { x: 12, y: 118, r: -10, d: esquirla(12), tono: 'violeta' },
  { x: 34, y: 172, r: 24, d: esquirla(14), tono: 'cian' },
  { x: 214, y: 30, r: -20, d: esquirla(14), tono: 'violeta' },
  { x: 228, y: 108, r: 12, d: esquirla(16), tono: 'cian' },
  { x: 206, y: 170, r: -24, d: esquirla(13), tono: 'violeta' },
  { x: 70, y: 196, r: 30, d: esquirla(7), tono: 'violeta' },
  { x: 170, y: 196, r: -30, d: esquirla(7), tono: 'cian' },
];
/** Chispas pequeñas en rombo. */
export const ESQUIRLAS: readonly { x: number; y: number; tono: 'cian' | 'violeta' }[] = [
  { x: 46, y: 22, tono: 'violeta' }, { x: 196, y: 80, tono: 'cian' }, { x: 6, y: 154, tono: 'cian' }, { x: 230, y: 190, tono: 'violeta' },
];
export const ROMBO = 'M0 -4 L3 0 L0 4 L-3 0 Z';
/** Al reparar, las esquirlas giran alrededor de las manos juntas. */
export const TALLER = { x: 120, y: 166 } as const;

// ── Manos de cristal: sueltas, sin brazo. Dibujadas con los dedos hacia +x desde la muñeca (0, 0) ────────────────
// Negras como el traje del concept art (así se leen sobre la melena blanca) con la mitad de arriba en placa blanca.
// base: la mano; luz: su placa blanca; una: la punta del dedo, en cian. PUNO_MANGA: el puño de la manga, en cian.
export const FORMAS_MANO = {
  punta: {
    base: 'M-6 -7 L6 -10 L14 -9 L17 -5 L33 -4 L37 -1.5 L33 1 L17 1 L18 6 L12 10 L0 10 L-6 5 Z',
    luz: 'M-6 -7 L6 -10 L14 -9 L17 -5 L33 -4 L35 -2 L17 -1 L-6 0 Z',
    una: 'M32 -3.6 L37 -1.5 L32 0.6 Z',
  },
  abierta: {
    base: 'M-6 -7 L6 -9 L22 -19 L25 -17 L13 -6 L31 -9 L32 -6 L16 -2 L32 2 L31 5 L15 3 L27 12 L24 14 L11 7 L10 18 L6 19 L0 10 L-6 6 Z',
    luz: 'M-6 -7 L6 -9 L22 -19 L25 -17 L13 -6 L31 -9 L32 -6 L16 -2 L-6 0 Z',
    una: null,
  },
  puno: {
    base: 'M-6 -7 L4 -10 L12 -10 L17 -7.5 L20.5 -3 L21 3 L18 8 L11 10.5 L2 10 L-6 6 Z',
    luz: 'M-6 -7 L4 -10 L12 -10 L17 -7.5 L20.5 -3 L21 0 L-6 0 Z',
    una: null,
  },
} as const;
export const PUNO_MANGA = 'M-12 -6 L-5 -7.5 L-5 6 L-12 4.5 Z';
export const ESCALA_MANO = 1.4;
export type FormaMano = keyof typeof FORMAS_MANO;
/** Dónde flota cada mano: muñeca en (x, y), dedos girados r grados (0 = derecha, 90 = abajo). La izquierda va en
 *  espejo (espejo: true) para que el pulgar quede del lado correcto. */
export type Mano = { x: number; y: number; r: number; forma: FormaMano; espejo: boolean };
/** La muñeca que señala recorre esta elipse alrededor de la cara (más ancha que alta, como la cabeza con su melena). */
export const RADIO_APUNTE = { x: 86, y: 72 } as const;

// ── Ojos: gafas en G alargada (almendra afilada) con la pupila en V ─────────────────────────────────────────────
// Caja local del lente derecho: x baja = lado interior (nariz), x alta = sien. La punta exterior, afilada y más alta
// (mirada felina); el borde de abajo casi recto y el de arriba arqueado. La G se abre por arriba hacia la nariz y su
// barra entra desde ese lado. El izquierdo es el mismo en espejo.
export const OJO = { escala: 0.21, centro: { x: 113, y: 54 }, izq: { x: 99, y: 94 }, der: { x: 141, y: 94 } } as const;
/** Coloca cada lente en su sitio; el izquierdo va en espejo (x baja = lado interior en los dos). */
export function transformOjo(lado: 'izq' | 'der'): string {
  const s = OJO.escala, c = OJO[lado], sx = lado === 'izq' ? -s : s;
  return `translate(${(c.x - OJO.centro.x * sx).toFixed(2)} ${(c.y - OJO.centro.y * s).toFixed(2)}) scale(${sx} ${s})`;
}
/** Medio ancho y medio alto del lente (unidades locales): para que nada del pelo lo tape. */
export const RADIO_LENTE = { x: 94, y: 54 } as const;
export const LENTE = 'M208 16 C172 0 130 -4 90 0 C58 3 26 10 22 30 L20 82 C20 98 40 106 80 106 C134 106 180 72 208 16 Z';
/** La montura: el lente entero menos un hueco arriba, del lado de la nariz, y la barra que entra hacia el centro. */
export const MONTURA = 'M44 5 C58 2.5 74 1 90 0 C130 -4 172 0 208 16 C180 72 134 106 80 106 C40 106 20 98 20 82 L20 54 L62 54';
export const PUENTE = 'M117.5 102.5 Q120 100.5 122.5 102.5';
export const PUPILA_V = 'M80 30 L114 80 L148 30 L130 30 L114 54 L98 30 Z';
/** Pupila en O (sorpresa): un anillo. */
export const PUPILA_O = 'M84 54 A30 30 0 1 1 144 54 A30 30 0 1 1 84 54 Z M98 54 A16 16 0 1 0 130 54 A16 16 0 1 0 98 54 Z';
export const ARCO_FELIZ = 'M58 80 Q112 14 182 52';
/** Ojo en «<» (guiño): el vértice hacia la nariz. */
export const FLECHA = 'M164 26 L76 58 L164 88';
// Párpados en unidades locales del ojo (recortados al lente). El superior baja y gira; el inferior sube.
export const PARPADO_SUP = 'M-30 -120 L238 -120 L238 -3 L-30 -3 Z';
export const PARPADO_INF = 'M-30 30 Q104 0 238 30 L238 170 L-30 170 Z';
export const PARPADO_INF_REPOSO = 109;
export const LINEA_CERRADO = 'M44 64 Q112 84 192 32';

/** `arco`: ojo feliz (◠) en lugar de la pupila. `cerrado`: párpados juntos y una línea. `anillo`: pupila en O.
 *  `flecha`: ojo en «<» (el guiño). */
export type Ojo = { sup: { y: number; r: number }; inf: number; k: number; pupila: number; cerrado?: boolean; arco?: boolean; anillo?: boolean; flecha?: boolean };
const ABIERTO: Ojo = { sup: { y: 0, r: 0 }, inf: 0, k: 1, pupila: 1 };
const CERRADO: Ojo = { sup: { y: 56, r: 0 }, inf: 56, k: 1, pupila: 1, cerrado: true };
const FELIZ: Ojo = { ...ABIERTO, arco: true };
const FLECHA_OJO: Ojo = { ...ABIERTO, flecha: true };
const ojo = (o: Partial<Ojo> = {}): Ojo => ({ ...ABIERTO, ...o, sup: { ...ABIERTO.sup, ...o.sup } });

// Boca pequeña y fina. `risa`: abierta, con el hueco oscuro y la lengua violeta; `lengua`: la saca (pícara).
export const BOCAS = {
  neutral: 'M113 121 l3.5 -1.6 l3.5 1.6 l3.5 -1.6 l3.5 1.6',
  feliz: 'M110 118.5 Q120 125.5 130 118.5',
  risa: 'M113 117 L127 117 Q126.5 126 120 126 Q113.5 126 113 117 Z',
  lengua: 'M111 119 Q120 122 129 118.5',
  sorpresa: 'M117 116 L123 116 L121.8 124 L118.2 124 Z',
  enfado: 'M109 123 L113.5 119 L118 123 L122.5 119 L127 123 L131 120.5',
  preocupada: 'M111 122.5 l3.6 -2.2 l3.6 2.2 l3.6 -2.2 l3.6 2.2 l3.6 -2.2',
  picara: 'M110 121 L126 121 L132 116',
  dormida: 'M114 122 L126 122',
  curiosa: 'M113 122 l4.5 -2 l4.5 2 l4.5 -2',
  abierta: 'M112 117 L128 117 L124.5 126 L115.5 126 Z',
  timida: 'M115.5 121 Q120 123.5 124.5 121',
  triste: 'M111 124 Q120 118 129 124',
} as const;
export type Boca = keyof typeof BOCAS;
export const BOCAS_RELLENAS: ReadonlySet<Boca> = new Set(['sorpresa', 'abierta']);
/** Bocas abiertas por dentro (hueco oscuro con el borde lila). */
export const BOCAS_HUECAS: ReadonlySet<Boca> = new Set(['risa']);
/** Lengua violeta de las bocas que la enseñan. */
export const LENGUAS: Partial<Record<Boca, string>> = {
  risa: 'M115.6 123 Q120 119.8 124.4 123 Q123 126 120 126 Q117 126 115.6 123 Z',
  lengua: 'M116.5 120.6 L124.5 120.2 Q125 128 120.6 128 Q116.4 128 116.5 120.6 Z',
};

/** Adornos junto a la cabeza (arriba a la derecha): «!!», vena de enfado, «?», lista de concentrarse… */
export type Extra = 'gota' | 'zzz' | 'brillos' | 'exclamacion' | 'rubor' | 'pregunta' | 'lagrima' | 'vena' | 'lista';
export type Expresion = { izq: Ojo; der: Ojo; boca: Boca; extra?: Extra; mirada?: { x: number; y: number } };

const DEFINICION = {
  neutral: { izq: ojo(), der: ojo(), boca: 'neutral' },
  feliz: { izq: FELIZ, der: FELIZ, boca: 'risa' },
  guino: { izq: FELIZ, der: FLECHA_OJO, boca: 'feliz' },
  sorpresa: { izq: ojo({ k: 1.06, anillo: true }), der: ojo({ k: 1.06, anillo: true }), boca: 'sorpresa', extra: 'exclamacion' },
  enfado: { izq: ojo({ sup: { y: 34, r: -15 }, pupila: 0.9 }), der: ojo({ sup: { y: 34, r: -15 }, pupila: 0.9 }), boca: 'enfado', extra: 'vena' },
  preocupada: { izq: ojo({ sup: { y: 26, r: 12 }, inf: 8 }), der: ojo({ sup: { y: 26, r: 12 }, inf: 8 }), boca: 'preocupada', extra: 'gota' },
  picara: { izq: ojo({ sup: { y: 38, r: 0 } }), der: ojo({ sup: { y: 38, r: 0 } }), boca: 'lengua', mirada: { x: 0.85, y: 0.1 } },
  curiosa: { izq: ojo({ sup: { y: 24, r: -6 } }), der: ojo({ k: 1.1 }), boca: 'curiosa', extra: 'pregunta', mirada: { x: 0.4, y: -0.5 } },
  concentrada: { izq: ojo({ sup: { y: 34, r: -4 }, inf: 14 }), der: ojo({ sup: { y: 34, r: -4 }, inf: 14 }), boca: 'dormida', extra: 'lista' },
  dormida: { izq: CERRADO, der: CERRADO, boca: 'dormida', extra: 'zzz' },
  euforica: { izq: FELIZ, der: FELIZ, boca: 'risa', extra: 'brillos' },
  timida: { izq: ojo({ sup: { y: 28, r: 0 } }), der: ojo({ sup: { y: 28, r: 0 } }), boca: 'timida', extra: 'rubor', mirada: { x: -0.7, y: 0.4 } },
  confundida: { izq: ojo({ sup: { y: 30, r: 8 } }), der: ojo({ k: 1.08, pupila: 0.85 }), boca: 'curiosa', extra: 'pregunta', mirada: { x: -0.3, y: -0.6 } },
  triste: { izq: ojo({ sup: { y: 30, r: 14 }, pupila: 0.85 }), der: ojo({ sup: { y: 30, r: 14 }, pupila: 0.85 }), boca: 'triste', extra: 'lagrima', mirada: { x: 0, y: 0.5 } },
} satisfies Record<string, Expresion>;
export type IdExpresion = keyof typeof DEFINICION;
export const EXPRESIONES: Readonly<Record<IdExpresion, Expresion>> = DEFINICION;
export const ID_EXPRESIONES = Object.keys(EXPRESIONES) as IdExpresion[];

// ── Direcciones (8): ángulo en pantalla, con y hacia abajo (E = 0°, S = 90°) ────────────────────────────────
export const DIRECCIONES = ['n', 'ne', 'e', 'se', 's', 'so', 'o', 'no'] as const;
export type Dir = (typeof DIRECCIONES)[number];
export const ANGULO: Record<Dir, number> = { e: 0, se: 45, s: 90, so: 135, o: 180, no: -135, n: -90, ne: -45 };
export const NOMBRE_DIR: Record<Dir, string> = { n: 'norte', ne: 'noreste', e: 'este', se: 'sureste', s: 'sur', so: 'suroeste', o: 'oeste', no: 'noroeste' };

// ── Poses ─────────────────────────────────────────────────────────────────────────────────────────────────────
// manos: dónde flota cada una; cabeza: giro de la cabeza; inclinacion: de todo el personaje; espejo: todo en espejo.
export const POSES = ['reposo', 'apuntar', 'hablar', 'pensar', 'celebrar', 'alerta', 'dormir', 'volar', 'saludar', 'reparar', 'recordar'] as const;
export type Pose = (typeof POSES)[number];
export type Postura = { manos: { der: Mano; izq: Mano }; cabeza: number; inclinacion: number; espejo: boolean };

const normal = (g: number) => ((((g + 180) % 360) + 360) % 360) - 180;
const der = (x: number, y: number, r: number, forma: FormaMano = 'abierta'): Mano => ({ x, y, r: normal(r), forma, espejo: false });
/** La misma mano reflejada al otro lado de la cara (x = 240 - x). */
export const espejar = (m: Mano): Mano => ({ ...m, x: 240 - m.x, r: normal(180 - m.r), espejo: !m.espejo });
const par = (m: Mano, izq: Mano = espejar(m)) => ({ der: m, izq });
const REPOSO = der(168, 162, 110, 'puno');

const BASE: Record<Exclude<Pose, 'apuntar'>, Omit<Postura, 'espejo'>> = {
  reposo: { manos: par(REPOSO), cabeza: 0, inclinacion: 0 },
  hablar: { manos: par(der(184, 128, -50), espejar(REPOSO)), cabeza: -3, inclinacion: 0 },
  pensar: { manos: par(der(150, 164, -100, 'punta'), espejar(REPOSO)), cabeza: 7, inclinacion: 0 },          // dedo en la mejilla
  celebrar: { manos: par(der(192, 52, -60)), cabeza: 0, inclinacion: 0 },
  alerta: { manos: par(der(184, 140, -105)), cabeza: 0, inclinacion: 0 },                                     // manos a las mejillas
  dormir: { manos: par(der(164, 178, 100)), cabeza: 12, inclinacion: 4 },
  volar: { manos: par(der(52, 150, 168), { ...der(70, 174, 160), espejo: true }), cabeza: -4, inclinacion: 14 },  // detrás de la marcha
  saludar: { manos: par(der(194, 76, -70), espejar(REPOSO)), cabeza: -5, inclinacion: -2 },
  reparar: { manos: par(der(150, 168, -160, 'puno')), cabeza: 9, inclinacion: 0 },                            // puños juntos delante
  recordar: { manos: par(der(214, 104, -90, 'punta'), espejar(REPOSO)), cabeza: -6, inclinacion: 0 },         // el dedo en alto
};

export function postura(pose: Pose, dir: Dir = 'e'): Postura {
  if (pose !== 'apuntar') return { ...BASE[pose], espejo: false };
  // Señala la mano del lado del objetivo (al norte y al sur, la derecha); la otra descansa. La cabeza se ladea hacia él.
  const a = ANGULO[dir], rad = (a * Math.PI) / 180;
  const x = Math.round(CENTRO.x + RADIO_APUNTE.x * Math.cos(rad)), y = Math.round(CENTRO.y + RADIO_APUNTE.y * Math.sin(rad));
  const izquierda = Math.cos(rad) < -0.01;
  const apunta: Mano = { x, y, r: a, forma: 'punta', espejo: izquierda };
  return {
    manos: izquierda ? { der: REPOSO, izq: apunta } : { der: apunta, izq: espejar(REPOSO) },
    cabeza: Math.round(Math.cos(rad) * 6), inclinacion: 0, espejo: false,
  };
}

/** Qué mano señala al apuntar hacia `dir`. */
export const manoQueApunta = (dir: Dir): 'der' | 'izq' => (Math.cos((ANGULO[dir] * Math.PI) / 180) < -0.01 ? 'izq' : 'der');

/** Hacia dónde miran las pupilas (de -1 a 1) al apuntar: hacia el objetivo, en pantalla. */
export function miradaDe(dir: Dir): { x: number; y: number } {
  const a = (ANGULO[dir] * Math.PI) / 180;
  return { x: +Math.cos(a).toFixed(3) || 0, y: +Math.sin(a).toFixed(3) || 0 };
}

/** Expresión que cada pose prefiere; sin entrada = la que toque al azar. */
export const EXPRESION_DE_POSE: Partial<Record<Pose, IdExpresion>> = {
  celebrar: 'euforica', alerta: 'sorpresa', dormir: 'dormida', pensar: 'concentrada', saludar: 'feliz', reparar: 'concentrada',
  recordar: 'picara',
};
export const AZAR_REPOSO: readonly IdExpresion[] = ['neutral', 'neutral', 'neutral', 'feliz', 'curiosa', 'picara', 'guino', 'sorpresa'];

/** Otra expresión del conjunto, distinta de la actual (si se puede). */
export function otraExpresion(actual: IdExpresion, conjunto: readonly IdExpresion[] = AZAR_REPOSO, azar: () => number = Math.random): IdExpresion {
  const opciones = conjunto.filter((e) => e !== actual);
  if (!opciones.length) return actual;
  return opciones[Math.min(opciones.length - 1, Math.floor(azar() * opciones.length))]!;
}

/** Color del acento (eco cromático y adornos) según el ánimo de la pose; siempre de la paleta del personaje. */
export const ACENTO: Record<Pose, string> = {
  reposo: 'var(--vg-cian)', apuntar: 'var(--vg-cian)', hablar: 'var(--vg-cian)', pensar: 'var(--vg-violeta)', volar: 'var(--vg-cian)',
  saludar: 'var(--vg-cian)', reparar: 'var(--vg-violeta)', celebrar: 'var(--vg-cian)', alerta: 'var(--vg-violeta)', dormir: 'var(--vg-gris)',
  recordar: 'var(--vg-cian)',
};
