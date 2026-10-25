// Cara de Vigía: capa independiente de la pose del cuerpo. Los ojos son el isotipo dentro de unas gafas en G alargada
// (almendra afilada hacia la sien): la montura blanca es la G y la pupila, una V cian con un leve brillo. Las
// expresiones mueven párpados del color de la cara recortados al lente (la montura queda siempre a la vista), cambian
// la pupila por un arco (◠), un anillo (O) o un «<», o cierran el ojo.
// Las pupilas van en grupos [data-mirada] y [data-parpadeo]: Vigia.tsx las mueve y las hace parpadear sin re-renderizar.
import type { CSSProperties, ReactNode } from 'react';
import {
  ARCO_FELIZ, BOCAS, BOCAS_HUECAS, BOCAS_RELLENAS, FLECHA, LENGUAS, LENTE, LINEA_CERRADO, MONTURA, PARPADO_INF,
  PARPADO_INF_REPOSO, PARPADO_SUP, PUENTE, PUPILA_O, PUPILA_V, transformOjo, type Boca, type Expresion, type Extra, type Ojo as OjoExp,
} from './formas';

const enCaja: CSSProperties = { transformBox: 'fill-box', transformOrigin: 'center' };

function Ojo({ lado, o, id }: { lado: 'izq' | 'der'; o: OjoExp; id: string }) {
  const recorte = `${id}-lente-${lado}`;
  const pupila = !o.arco && !o.cerrado && !o.flecha;
  const v = pupila && !o.anillo;
  return (
    <g transform={transformOjo(lado)}>
      <defs><clipPath id={recorte}><path d={LENTE} /></clipPath></defs>
      <g className="vg-suave" style={{ ...enCaja, transform: `scale(${o.k})` }}>
        <path d={LENTE} fill="var(--vg-cristal)" />
        <g clipPath={`url(#${recorte})`}>
          <g data-parpadeo={lado} style={enCaja}>
            <g className="vg-suave" style={{ ...enCaja, transform: `scale(${o.pupila})`, opacity: pupila ? 1 : 0 }}>
              <g data-mirada={lado}>
                <path d={PUPILA_V} fill="none" stroke="var(--vg-cian)" strokeWidth={16} strokeOpacity={0.28} strokeLinejoin="round" opacity={v ? 1 : 0} />
                <path d={PUPILA_V} fill="var(--vg-cian)" opacity={v ? 1 : 0} />
                {o.anillo ? <path d={PUPILA_O} fill="var(--vg-cian)" fillRule="evenodd" stroke="var(--vg-cian)" strokeWidth={10} strokeOpacity={0.28} /> : null}
              </g>
            </g>
          </g>
          <g fill="var(--vg-cara)">
            <path d={PARPADO_SUP} className="vg-suave" style={{ ...enCaja, transform: `translateY(${o.sup.y}px) rotate(${o.sup.r}deg)` }} />
            <path d={PARPADO_INF} className="vg-suave" style={{ ...enCaja, transform: `translateY(${PARPADO_INF_REPOSO - o.inf}px)` }} />
          </g>
          <path d={ARCO_FELIZ} fill="none" stroke="var(--vg-cian)" strokeWidth={15} strokeLinecap="round"
            className="vg-suave" style={{ opacity: o.arco ? 1 : 0 }} />
          <path d={FLECHA} fill="none" stroke="var(--vg-cian)" strokeWidth={15} strokeLinecap="round" strokeLinejoin="round"
            className="vg-suave" style={{ opacity: o.flecha ? 1 : 0 }} />
          <path d={LINEA_CERRADO} fill="none" stroke="var(--vg-lente)" strokeWidth={11} strokeLinecap="round"
            className="vg-suave" style={{ opacity: o.cerrado ? 1 : 0 }} />
        </g>
        <path d={MONTURA} fill="none" stroke="var(--vg-lente)" strokeWidth={14} strokeLinejoin="round" strokeLinecap="round" />
      </g>
    </g>
  );
}

function Boca({ boca }: { boca: Boca }) {
  const lengua = LENGUAS[boca];
  return (
    <g>
      {BOCAS_RELLENAS.has(boca)
        ? <path d={BOCAS[boca]} fill="var(--vg-boca)" />
        : <path d={BOCAS[boca]} fill={BOCAS_HUECAS.has(boca) ? 'var(--vg-boca-dentro)' : 'none'} stroke="var(--vg-boca)" strokeWidth={1.8}
            strokeLinejoin="round" strokeLinecap="round" />}
      {lengua ? <path d={lengua} fill="var(--vg-violeta)" /> : null}
    </g>
  );
}

const ESTRELLA = 'M0 -8 L2 -2 L8 0 L2 2 L0 8 L-2 2 L-8 0 L-2 -2 Z';
const Z = (x: number, y: number, s: number, i: number) => (
  <path key={i} className="vg-zeta" style={{ '--i': i } as CSSProperties} transform={`translate(${x} ${y}) scale(${s})`}
    d="M0 0 L10 0 L0 10 L10 10" fill="none" stroke="var(--vg-lente)" strokeWidth={2.6 / s} strokeLinejoin="miter" />
);
export function Adorno({ extra }: { extra?: Extra }): ReactNode {
  switch (extra) {
    case 'zzz': return <g aria-hidden>{[Z(170, 50, 0.8, 0), Z(186, 28, 1, 1), Z(204, 4, 1.25, 2)]}</g>;
    case 'gota': return <path className="vg-gota" d="M166 72 Q175 86 168 93 Q159 89 166 72 Z" fill="var(--vg-cian)" />;
    case 'exclamacion': return (
      <g className="vg-exclamacion" fill="var(--vg-lente)" stroke="var(--vg-borde)" strokeWidth={2.4} paintOrder="stroke">
        {[0, 15].map((dx) => (
          <g key={dx} transform={`translate(${dx} ${dx ? 3 : 0}) rotate(${dx ? 12 : 6} 196 40)`}>
            <path d="M188 14 L199 14 L196 42 L191 42 Z" /><path d="M190.5 47 L196.5 47 L196.5 53 L190.5 53 Z" />
          </g>
        ))}
      </g>
    );
    case 'vena': return (
      <g className="vg-exclamacion" fill="none" stroke="var(--vg-vena)" strokeWidth={3.6} strokeLinecap="round" aria-hidden>
        <path d="M184 30 Q192 32 193 24 M206 24 Q198 26 197 18 M206 34 Q198 32 197 40 M184 28 Q192 26 193 34" transform="translate(-2 4)" />
      </g>
    );
    case 'lista': return (
      <g className="vg-exclamacion" stroke="var(--vg-cian)" strokeWidth={3.4} strokeLinecap="round" aria-hidden>
        {[16, 26, 36].map((y, i) => (
          <g key={y}><path d={`M186 ${y} L188 ${y}`} /><path d={`M194 ${y} L${i === 1 ? 206 : 212} ${y}`} /></g>
        ))}
      </g>
    );
    case 'rubor': return (
      <g fill="none" stroke="var(--vg-boca)" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
        {[88, 94, 100, 140, 146, 152].map((x) => <path key={x} d={`M${x} 114 L${x + 4} 108`} />)}
      </g>
    );
    case 'pregunta': return (
      <g className="vg-exclamacion">
        <path d="M188 24 Q188 10 199 10 Q210 10 210 21 Q210 29 201 33 L201 41" fill="none" stroke="var(--vg-cian)" strokeWidth={5} strokeLinecap="round" />
        <path d="M198 47 L204 47 L204 53 L198 53 Z" fill="var(--vg-cian)" />
      </g>
    );
    case 'lagrima': return <path className="vg-gota" d="M146 106 Q152 116 147 121 Q141 117 146 106 Z" fill="var(--vg-cian)" />;
    case 'brillos': return (
      <g>
        {[[30, 40, 0], [210, 70, 1], [120, -8, 2], [20, 118, 3], [196, 6, 4]].map(([x, y, i]) => (
          <path key={i} className="vg-brillo" fill={i! % 2 ? 'var(--vg-lente)' : 'var(--vg-cian)'} style={{ '--i': i } as CSSProperties}
            transform={`translate(${x} ${y})`} d={ESTRELLA} />
        ))}
      </g>
    );
    default: return null;
  }
}

export function Cara({ expresion, boca, id }: { expresion: Expresion; boca: Boca; id: string }) {
  return (
    <g>
      <Ojo lado="izq" o={expresion.izq} id={id} />
      <Ojo lado="der" o={expresion.der} id={id} />
      <path d={PUENTE} fill="none" stroke="var(--vg-lente)" strokeWidth={2.6} strokeLinecap="round" />
      <Boca boca={boca} />
    </g>
  );
}
