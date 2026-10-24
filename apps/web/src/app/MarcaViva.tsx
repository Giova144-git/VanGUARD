// Isotipo vivo (brand/README.md, paso 3): los mismos trazos que public/marca/*.svg, pero en línea para que la pupila (la
// V) siga al puntero, haga sacadas cuando el puntero se queda quieto y el ojo parpadee (gazeLoop, saccade y blink de
// brand/index.html). Marca lo carga en diferido y solo sin prefers-reduced-motion; hasta que llega se ve la máscara en la
// misma caja, así que no se mueve nada. La compacta no parpadea, como en brand/. Sin el trazado inicial.
import { useEffect, useId, useRef, type ReactNode, type SVGProps } from 'react';
import { apuntar, avanzar, entreCuadros, haciaPuntero, preparar, reposo, sacada, transformacion, type Cuadros } from './mirada';
import { COMPACTO, HUECO, NOMBRE, NORMAL, VIEWBOX, VIEWBOX_LOGO } from './trazos-marca';

export type Forma = 'nombre' | 'simbolo' | 'compacta';

const MIRADA = { transformBox: 'view-box', transformOrigin: '104px 60px' } as const;
const PUPILA = { transformBox: 'view-box', transformOrigin: '104px 100px' } as const;   // al reabrir se estrecha
const ANCHO_LOGO = Number(VIEWBOX_LOGO.split(' ')[2]);
const QUIETO_MS = 2500;         // sin puntero este rato, el ojo mira por su cuenta
const PRIMER_PARPADEO_MS = 3600;
const PARPADEAN = new Set(['lid-top', 'wing', 'lid-low']);
// Al reabrir, la pupila se estrecha un poco y se relaja, como al recibir luz (vg-react de brand/index.html).
const REACCION: Keyframe[] = [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0.84)', offset: 0.3 }, { transform: 'scaleX(1)' }];

export default function MarcaViva({ forma, onListo }: { forma: Forma; onListo: () => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const id = `vg${useId().replace(/[^\w-]/g, '')}`;
  const compacta = forma === 'compacta';
  const trazos = compacta ? COMPACTO : NORMAL;
  const iris = trazos.filter((t) => t.iris).map((t) => <path key={t.id} d={t.d} />);
  // La pupila y su hueco van igual: recorte del párpado (solo mientras parpadea) → reacción → mirada.
  const pupila = (contenido: ReactNode, trazo?: SVGProps<SVGGElement>) => (
    <g data-recorte><g data-pupila style={PUPILA}><g data-mirada style={MIRADA} {...trazo}>{contenido}</g></g></g>
  );

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    onListo();
    const miradas = el.querySelectorAll<SVGGElement>('[data-mirada]');
    const pupilas = el.querySelectorAll<SVGGElement>('[data-pupila]');
    const recortes = el.querySelectorAll<SVGGElement>('[data-recorte]');
    const calma = matchMedia('(prefers-reduced-motion: reduce)');
    const m = reposo();
    let vivo = true, cuadro = 0, espera = 0, ultimo = 0, parpado = 0, siguiente = 0, doble = 0;

    const paso = () => {
      const sigue = avanzar(m);
      const t = calma.matches ? '' : transformacion(m);
      miradas.forEach((g) => { g.style.transform = t; });
      cuadro = sigue && !calma.matches ? requestAnimationFrame(paso) : 0;
    };
    const mover = () => { if (!cuadro) cuadro = requestAnimationFrame(paso); };
    const puntero = (e: PointerEvent) => {
      ultimo = performance.now();
      const caja = el.getBoundingClientRect();
      if (!caja.width) return;   // oculto (barra lateral plegada en el móvil)
      // En el logo con nombre el símbolo ocupa los primeros 200 de 724,9: el ojo no es el centro de la caja.
      const ojo = { x: caja.left + caja.width * (forma === 'nombre' ? 100 / ANCHO_LOGO : 0.5), y: caja.top + caja.height / 2 };
      haciaPuntero(m, e.clientX, e.clientY, ojo, { ancho: innerWidth, alto: innerHeight });
      mover();
    };
    const fuera = () => { apuntar(m, 0, 0); mover(); };
    const quieto = () => performance.now() - ultimo > QUIETO_MS;
    const mirarSolo = () => {
      if (quieto() && !document.hidden) { sacada(m); mover(); }
      espera = window.setTimeout(mirarSolo, 900 + Math.random() * 2200);
    };

    // Parpadeo: los párpados y el recorte de la pupila recorren sus cuadros; en reposo vuelven a los trazos de siempre
    // (el recorte se quita: a ojo abierto le comería la punta a la V).
    let pistas: (Cuadros & { el: SVGPathElement; reposo: string | null })[] = [], duracion = 0;
    const parpadear = () => {
      if (!pistas.length || parpado || calma.matches || document.hidden) return;
      const t0 = performance.now();
      let miro = false;
      for (const p of pistas) p.el.setAttribute('d', entreCuadros(p, 0));   // el recorte, con forma antes de aplicarlo
      recortes.forEach((g) => g.setAttribute('clip-path', `url(#${id}-p)`));
      pupilas.forEach((g) => g.animate(REACCION, { duration: 1400, delay: 260, easing: 'cubic-bezier(.33,0,.2,1)' }));
      const cuadroParpado = (ahora: number) => {
        const f = Math.min(1, (ahora - t0) / duracion);
        for (const p of pistas) { const d = f < 1 ? entreCuadros(p, f) : p.reposo; if (d) p.el.setAttribute('d', d); }
        // A veces la mirada cambia con el ojo cerrado, como en un parpadeo de verdad.
        if (!miro && f > 0.3) { miro = true; if (quieto() && Math.random() < 0.5) { sacada(m); mover(); } }
        if (f < 1) { parpado = requestAnimationFrame(cuadroParpado); return; }
        parpado = 0;
        recortes.forEach((g) => g.removeAttribute('clip-path'));
      };
      parpado = requestAnimationFrame(cuadroParpado);
    };
    // Intervalos irregulares y, de vez en cuando, un parpadeo doble.
    const programar = (ms: number) => {
      siguiente = window.setTimeout(() => {
        parpadear();
        if (Math.random() < 0.2) doble = window.setTimeout(parpadear, duracion + 160);
        programar(3500 + Math.random() * 5500);
      }, ms);
    };
    if (!compacta) {
      siguiente = window.setTimeout(() => {
        import('./parpadeo-marca').then(({ DURACION_MS, PARPADOS, RECORTE }) => {
          if (!vivo) return;
          duracion = DURACION_MS;
          pistas = [...el.querySelectorAll<SVGPathElement>('[data-parpado]')].map((p) => {
            const cual = p.dataset.parpado!;
            return { el: p, reposo: p.getAttribute('d'), ...preparar(cual === 'clip' ? RECORTE : PARPADOS[cual]!) };
          });
          programar(0);
        }).catch(() => { /* sin el chunk, el ojo mira pero no parpadea */ });
      }, PRIMER_PARPADEO_MS);
    }

    window.addEventListener('pointermove', puntero, { passive: true });
    document.documentElement.addEventListener('pointerleave', fuera);
    espera = window.setTimeout(mirarSolo, QUIETO_MS);
    return () => {
      vivo = false;
      window.removeEventListener('pointermove', puntero);
      document.documentElement.removeEventListener('pointerleave', fuera);
      cancelAnimationFrame(cuadro);
      cancelAnimationFrame(parpado);
      clearTimeout(espera);
      clearTimeout(siguiente);
      clearTimeout(doble);
    };
  }, [forma, compacta, id, onListo]);

  return (
    <svg ref={svg} viewBox={forma === 'nombre' ? VIEWBOX_LOGO : VIEWBOX} aria-hidden className="absolute inset-0 size-full overflow-visible" fill="currentColor">
      <defs>
        {/* La V va encima de la G y le abre un hueco que se mueve con ella. */}
        <mask id={`${id}-h`} maskUnits="userSpaceOnUse" x="-20" y="-20" width="240" height="160">
          <rect x="-20" y="-20" width="240" height="160" fill="#fff" />
          {pupila(iris, { fill: '#000', stroke: '#000', strokeWidth: compacta ? HUECO * 1.3 : HUECO, strokeLinejoin: 'round' })}
        </mask>
        {compacta ? null : <clipPath id={`${id}-p`}><path data-parpado="clip" /></clipPath>}
      </defs>
      <g mask={`url(#${id}-h)`}>
        {trazos.filter((t) => !t.iris).map((t) => <path key={t.id} d={t.d} data-parpado={!compacta && PARPADEAN.has(t.id) ? t.id : undefined} />)}
      </g>
      {pupila(iris)}
      {forma === 'nombre' ? <g transform={NOMBRE.transform}><path d={NOMBRE.van} /><path d={NOMBRE.guard} /></g> : null}
    </svg>
  );
}
