// Vigía, el personaje (dibujo del concept art en SVG): una cabeza flotante con dos manos de cristal sueltas. Capas, de
// atrás hacia delante: esquirlas → eco cromático → melena (gira con la cabeza; se va hacia atrás al volar) → cabeza
// (cráneo, cara, flequillo y adornos) → manos (siempre delante) → taller de esquirlas al reparar.
// Convención de transformaciones: raíz, cabeza y manos llevan el pivote dentro del transform (transform-box: view-box;
// origin 0 0). La mirada y el parpadeo son imperativos (refs y element.style), sin re-renderizar.
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { apuntar, avanzar, haciaPuntero, reposo, sacada } from '@/app/mirada';
import { Adorno, Cara } from './Cara';
import {
  ACENTO, CENTRO, CRANEO, ESCALA_MANO, ESQUIRLAS, EXPRESION_DE_POSE, EXPRESIONES, FLEQUILLO, FORMAS_MANO, FRAGMENTOS, MELENA, MEJILLA,
  NUCA, PUNO_MANGA, ROMBO, TALLER, VIEWBOX, faceta, manoQueApunta, miradaDe, otraExpresion, postura, type Boca, type Dir,
  type IdExpresion, type Mano as DatosMano, type Mechon, type Pose,
} from './formas';
import './vigia.css';

export type Fase = 'entrar' | 'quieta' | 'salir';
export type PropsVigia = {
  pose?: Pose; dir?: Dir; expresion?: IdExpresion | 'auto'; hablando?: boolean; fase?: Fase;
  /** Grados extra de inclinación en pantalla (al volar hacia un lado: positivo = a la derecha). */
  inclinacion?: number; seguirPuntero?: boolean; className?: string; titulo?: string;
};

const rot = (deg: number, p: { x: number; y: number }) => `translate(${p.x}px, ${p.y}px) rotate(${deg}deg) translate(${-p.x}px, ${-p.y}px)`;
const calmado = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const entre = (a: number, b: number) => a + Math.random() * (b - a);
// La pupila recorre más lente que el isotipo original: el resorte de mirada.ts se amplía.
const GANANCIA_MIRADA = 1.8;

// Facetas y dirección de cada esquirla (para irradiar al celebrar, ensamblarse al entrar y romperse al salir).
const conFaceta = (l: readonly Mechon[]) => l.map((x) => ({ ...x, f: x.sombra ? faceta(x.d) : null }));
const MELENA_F = conFaceta(MELENA), FLEQUILLO_F = conFaceta(FLEQUILLO);
const rumbo = (x: number, y: number) => {
  const r = Math.hypot(x - CENTRO.x, y - CENTRO.y) || 1;
  return { '--dx': ((x - CENTRO.x) / r).toFixed(2), '--dy': ((y - CENTRO.y) / r).toFixed(2) };
};

function Mechones({ lista, primero = 0 }: { lista: typeof MELENA_F; primero?: number }) {
  return lista.map((x, i) => (
    // El primero de cada lista (coronilla y casquete) no se mece: es la raíz de la que cuelgan los demás.
    <g key={x.d} className={i ? 'vg-pelo' : undefined} style={{ '--i': i + primero } as CSSProperties}>
      <path d={x.d} fill={`var(--vg-${x.tono})`} />
      {x.f ? <path d={x.f} fill="var(--vg-pelo-sombra)" stroke="none" /> : null}
    </g>
  ));
}

// La posición va en .vg-mano (se desliza al cambiar de pose); el gesto de cada pose, en .vg-mano-gesto, gira desde la muñeca.
function Mano({ lado, m, apunta }: { lado: 'der' | 'izq'; m: DatosMano; apunta: boolean }) {
  const f = FORMAS_MANO[m.forma];
  return (
    <g className={`vg-mano vg-mano-${lado}${apunta ? ' vg-mano-apunta' : ''}`}
      style={{ transform: `translate(${m.x}px, ${m.y}px) rotate(${m.r}deg) scale(${ESCALA_MANO}, ${m.espejo ? -ESCALA_MANO : ESCALA_MANO})` }}>
      <g className="vg-mano-gesto">
        <path d={PUNO_MANGA} fill="var(--vg-cian)" stroke="var(--vg-borde)" strokeWidth={2} strokeLinejoin="round" paintOrder="stroke" />
        <path d={f.base} fill="var(--vg-traje)" stroke="var(--vg-contorno)" strokeWidth={2} strokeLinejoin="round" paintOrder="stroke" />
        <path d={f.luz} fill="var(--vg-placa)" />
        {f.una ? <path d={f.una} fill="var(--vg-cian)" /> : null}
      </g>
    </g>
  );
}

export function Vigia({ pose = 'reposo', dir = 'e', expresion = 'auto', hablando = false, fase = 'quieta', inclinacion = 0,
  seguirPuntero = true, className, titulo }: PropsVigia) {
  const raiz = useRef<SVGSVGElement>(null);
  const id = `vigia${useId().replace(/[^\w-]/g, '')}`;
  const p = postura(pose, dir);

  const preferida = expresion === 'auto' ? EXPRESION_DE_POSE[pose] : expresion;
  const [azar, setAzar] = useState<IdExpresion>('neutral');
  useEffect(() => {
    if (preferida || calmado()) return;
    let t = 0;
    const cambiar = () => { setAzar((e) => otraExpresion(e)); t = window.setTimeout(cambiar, entre(4200, 9000)); };
    t = window.setTimeout(cambiar, entre(2500, 5000));
    return () => clearTimeout(t);
  }, [preferida]);
  const idExp: IdExpresion = preferida ?? azar;
  const exp = EXPRESIONES[idExp];

  const [abierta, setAbierta] = useState(false);
  useEffect(() => {
    if (!hablando || calmado()) { setAbierta(false); return; }
    let t = 0;
    const paso = () => { setAbierta((a) => !a); t = window.setTimeout(paso, entre(90, 170)); };
    paso();
    return () => clearTimeout(t);
  }, [hablando]);
  const boca: Boca = abierta ? 'abierta' : exp.boca;

  const objetivo = useMemo(() => (pose === 'apuntar' ? miradaDe(dir) : pose === 'reparar' ? { x: 0, y: 1 } : exp.mirada ?? null), [pose, dir, exp.mirada]);
  useEffect(() => {
    const el = raiz.current;
    if (!el) return;
    const pupilas = { izq: el.querySelectorAll<SVGGElement>('[data-mirada="izq"]'), der: el.querySelectorAll<SVGGElement>('[data-mirada="der"]') };
    const m = reposo();
    const pintar = () => {
      const perfil = 1 - 0.1 * Math.min(1, Math.abs(m.x) / 17);
      const x = m.x * GANANCIA_MIRADA, y = m.y * GANANCIA_MIRADA;
      pupilas.der.forEach((g) => { g.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scaleX(${perfil.toFixed(3)})`; });
      pupilas.izq.forEach((g) => { g.style.transform = `translate(${(-x).toFixed(2)}px, ${y.toFixed(2)}px) scaleX(${perfil.toFixed(3)})`; });
    };
    const fijo = (x: number, y: number) => { apuntar(m, x, y); m.x = m.tx; m.y = m.ty; pintar(); };
    if (calmado()) { if (objetivo) fijo(objetivo.x, objetivo.y); else fijo(0, 0); return; }

    let cuadro = 0, reloj = 0, parpado = 0, vivo = true, ultimoPuntero = 0;
    const paso = () => { const sigue = avanzar(m); pintar(); cuadro = sigue ? requestAnimationFrame(paso) : 0; };
    const mover = () => { if (!cuadro) cuadro = requestAnimationFrame(paso); };

    if (objetivo) { apuntar(m, objetivo.x, objetivo.y); mover(); }
    else if (pose === 'pensar') {
      let lado = 1;
      const barrer = () => { apuntar(m, lado * 0.8, -0.7); lado = -lado; mover(); reloj = window.setTimeout(barrer, 1400); };
      barrer();
    } else if (pose === 'dormir') { apuntar(m, 0, 0.4); mover(); }
    else {
      const sacadas = () => {
        if (performance.now() - ultimoPuntero > 2200 && !document.hidden) { sacada(m); mover(); }
        reloj = window.setTimeout(sacadas, entre(900, 2800));
      };
      reloj = window.setTimeout(sacadas, 1200);
    }
    const puntero = (e: PointerEvent) => {
      if (!seguirPuntero || objetivo || pose === 'pensar' || pose === 'dormir') return;
      const c = el.getBoundingClientRect();
      if (!c.width) return;
      ultimoPuntero = performance.now();
      haciaPuntero(m, e.clientX, e.clientY, { x: c.left + c.width / 2, y: c.top + c.height * 0.52 }, { ancho: innerWidth, alto: innerHeight });
      mover();
    };
    window.addEventListener('pointermove', puntero, { passive: true });

    const ojos = el.querySelectorAll<SVGGElement>('[data-parpadeo]');
    const parpadear = () => {
      ojos.forEach((g) => g.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(0.08)', offset: 0.45 }, { transform: 'scaleY(1)' }],
        { duration: 170, easing: 'ease-in-out' }));
    };
    const programar = () => {
      parpado = window.setTimeout(() => {
        if (!vivo) return;
        if (!document.hidden && pose !== 'dormir') { parpadear(); if (Math.random() < 0.18) window.setTimeout(parpadear, 260); }
        programar();
      }, entre(2600, 6400));
    };
    programar();
    return () => {
      vivo = false;
      cancelAnimationFrame(cuadro);
      clearTimeout(reloj);
      clearTimeout(parpado);
      window.removeEventListener('pointermove', puntero);
    };
  }, [objetivo, pose, seguirPuntero]);

  // Al volar hacia la izquierda va en espejo: la melena y las esquirlas siempre quedan detrás de la marcha.
  const espejo = p.espejo || (pose === 'volar' && inclinacion < 0);
  const giro = p.inclinacion + (espejo ? -inclinacion : inclinacion);
  const raizTransform = `translate(${CENTRO.x}px, ${CENTRO.y}px)${espejo ? ' scaleX(-1)' : ''} rotate(${giro}deg) translate(${-CENTRO.x}px, ${-CENTRO.y}px)`;
  const cabeza = { transform: rot(p.cabeza, NUCA) };
  const apuntaCon = manoQueApunta(dir);
  const estilo = { '--vg-acento': ACENTO[pose] } as CSSProperties;

  return (
    <svg ref={raiz} viewBox={VIEWBOX} className={`vigia ${className ?? ''}`} data-pose={pose} data-fase={fase} data-expresion={idExp}
      style={estilo} role={titulo ? 'img' : undefined} aria-label={titulo} aria-hidden={titulo ? undefined : true}>
      <g className="vg-raiz" style={{ transform: raizTransform }}>
        <g className="vg-aparicion">
          <g className="vg-flota">
            <g className="vg-fragmentos">
              {FRAGMENTOS.map((f, i) => (
                <g key={i} transform={`translate(${f.x} ${f.y}) rotate(${f.r})`}>
                  <path d={f.d} className={`vg-fragmento vg-${f.tono}`} style={{ '--i': i, ...rumbo(f.x, f.y) } as CSSProperties} />
                </g>
              ))}
              {ESQUIRLAS.map((e, i) => (
                <g key={i} transform={`translate(${e.x} ${e.y})`}>
                  <path d={ROMBO} className={`vg-esquirla vg-${e.tono}`} style={{ '--i': i, ...rumbo(e.x, e.y) } as CSSProperties} />
                </g>
              ))}
            </g>

            <g className="vg-eco" fill="var(--vg-acento)"><path d={CRANEO} /></g>

            <g className="vg-cabeza" style={cabeza}>
              <g className="vg-melena" stroke="var(--vg-borde)" strokeWidth={2.4} strokeLinejoin="round" paintOrder="stroke">
                <Mechones lista={MELENA_F} />
              </g>
            </g>

            <g className="vg-cabeza" style={cabeza}>
              <path d={CRANEO} fill="var(--vg-cara)" stroke="var(--vg-contorno)" strokeWidth={2} strokeLinejoin="round" paintOrder="stroke" />
              <path d={MEJILLA} fill="var(--vg-cara-sombra)" />
              <Cara expresion={exp} boca={boca} id={id} />
              <g className="vg-flequillo" stroke="var(--vg-borde)" strokeWidth={2.4} strokeLinejoin="round" paintOrder="stroke">
                <Mechones lista={FLEQUILLO_F} primero={MELENA_F.length} />
              </g>
              <Adorno extra={exp.extra} />
            </g>

            <Mano lado="izq" m={p.manos.izq} apunta={pose === 'apuntar' && apuntaCon === 'izq'} />
            <Mano lado="der" m={p.manos.der} apunta={pose === 'apuntar' && apuntaCon === 'der'} />

            {pose === 'reparar' ? (
              <g className="vg-taller" transform={`translate(${TALLER.x} ${TALLER.y})`}>
                <g className="vg-taller-giro">
                  {[0, 120, 240].map((a, i) => (
                    <path key={a} transform={`rotate(${a}) translate(0 -17) rotate(90)`} d="M0 -5 L2 0 L0 5 L-2 1 Z"
                      className={i % 2 ? 'vg-violeta' : 'vg-cian'} />
                  ))}
                </g>
                <path className="vg-chispa vg-cian" d="M0 -6 L1.5 -1.5 L6 0 L1.5 1.5 L0 6 L-1.5 1.5 L-6 0 L-1.5 -1.5 Z" />
              </g>
            ) : null}
          </g>
        </g>
      </g>
    </svg>
  );
}
