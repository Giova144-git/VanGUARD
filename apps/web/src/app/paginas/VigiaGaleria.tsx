// /vigia: galería pública de Vigía, la mascota guía. Personaje grande con controles (pose, expresión, dirección, fase y
// boca hablando), la rosa de las 8 direcciones de apuntar, todas las poses, todas las expresiones y el tamaño real de la
// app (112 × 128). Los controles viven en la URL (?pose=apuntar&dir=no&exp=feliz&fase=entrar&tema=claro) para poder
// enlazar y capturar una combinación concreta. ?pausa=1 congela las animaciones (capturas estáticas).
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button } from '@/componentes/ui/button';
import { DIRECCIONES, ID_EXPRESIONES, NOMBRE_DIR, POSES, type Dir, type IdExpresion, type Pose } from '@/componentes/vigia/formas';
import { Vigia, type Fase } from '@/componentes/vigia/Vigia';
import { aplicarTema } from '@/lib/tema';
import { Marca } from '../Marca';

const FASES: readonly Fase[] = ['entrar', 'quieta', 'salir'];
// La rosa en el orden de la cuadrícula 3×3; el centro (null) es Vigía en reposo.
const ROSA: readonly (Dir | null)[] = ['no', 'n', 'ne', 'o', null, 'e', 'so', 's', 'se'];

const de = <T extends string>(lista: readonly T[], v: string | null, porDefecto: T): T =>
  lista.includes(v as T) ? (v as T) : porDefecto;

function Ficha({ etiqueta, children, activa, alPulsar }: { etiqueta: string; children: ReactNode; activa?: boolean; alPulsar?: () => void }) {
  return (
    <button type="button" onClick={alPulsar} aria-pressed={activa}
      className={`flex flex-col items-center gap-1 rounded-lg border bg-card p-2 text-[12px] font-mono uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:bg-muted ${activa ? 'border-foreground text-foreground' : 'border-border'}`}>
      {children}
      <span>{etiqueta}</span>
    </button>
  );
}

function Selector<T extends string>({ titulo, valor, opciones, alCambiar }: { titulo: string; valor: T; opciones: readonly T[]; alCambiar: (v: T) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 font-mono text-[12px] uppercase tracking-[0.06em] text-muted-foreground">{titulo}</legend>
      <div className="flex flex-wrap gap-1.5">
        {opciones.map((o) => (
          <Button key={o} type="button" size="chico" variant={o === valor ? 'principal' : 'secundaria'} aria-pressed={o === valor}
            onClick={() => alCambiar(o)}>{o}</Button>
        ))}
      </div>
    </fieldset>
  );
}

export default function VigiaGaleria() {
  const [params, setParams] = useSearchParams();
  const pose = de<Pose>(POSES, params.get('pose'), 'reposo');
  const dir = de<Dir>(DIRECCIONES, params.get('dir'), 'e');
  const expresion = de<IdExpresion | 'auto'>(['auto', ...ID_EXPRESIONES], params.get('exp'), 'auto');
  const fase = de<Fase>(FASES, params.get('fase'), 'quieta');
  const hablando = params.get('hablando') === '1';
  const pausa = params.get('pausa') === '1';
  const tema = params.get('tema');
  // Cada cambio de fase vuelve a montar al personaje para repetir la animación de entrar o salir.
  const [vuelta, setVuelta] = useState(0);

  useEffect(() => {
    if (tema === 'claro' || tema === 'oscuro') document.documentElement.classList.toggle('dark', tema === 'oscuro');
  }, [tema]);

  const poner = (clave: string, valor: string | null) => {
    setParams((p) => { const n = new URLSearchParams(p); if (valor === null) n.delete(clave); else n.set(clave, valor); return n; }, { replace: true });
  };
  const cambiarTema = (t: 'claro' | 'oscuro') => { aplicarTema(t); poner('tema', t); };

  return (
    <div className={`mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-10 px-4 py-8 ${pausa ? 'vg-galeria-pausa' : ''}`}>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Link to="/" aria-label="Volver al inicio"><Marca /></Link>
        <div className="flex gap-1.5" role="group" aria-label="Tema">
          <Button size="chico" variant="secundaria" onClick={() => cambiarTema('claro')}>Claro</Button>
          <Button size="chico" variant="secundaria" onClick={() => cambiarTema('oscuro')}>Oscuro</Button>
        </div>
      </header>

      <section className="flex flex-col gap-2">
        <h1 className="text-[28px] font-semibold">Vigía</h1>
        <p className="max-w-2xl text-[15px] text-muted-foreground">
          La guía de VanGUARD: te acompaña por la app, señala lo importante y explica cada pantalla. Aquí puedes ver todas sus
          poses, direcciones y expresiones.
        </p>
      </section>

      <section className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" aria-label="Probador">
        <div className="flex min-h-[420px] items-center justify-center rounded-xl border border-border bg-card p-6">
          <Vigia key={`${fase}-${vuelta}`} pose={pose} dir={dir} expresion={expresion} fase={fase} hablando={hablando}
            className="h-[384px] w-[336px]" titulo={`Vigía: ${pose}${pose === 'apuntar' ? ` hacia el ${NOMBRE_DIR[dir]}` : ''}`} />
        </div>
        <div className="flex flex-col gap-6">
          <Selector titulo="Pose" valor={pose} opciones={POSES} alCambiar={(v) => poner('pose', v)} />
          <Selector titulo="Expresión" valor={expresion} opciones={['auto', ...ID_EXPRESIONES] as const} alCambiar={(v) => poner('exp', v === 'auto' ? null : v)} />
          <Selector titulo="Dirección (al apuntar)" valor={dir} opciones={DIRECCIONES} alCambiar={(v) => { poner('dir', v); if (pose !== 'apuntar') poner('pose', 'apuntar'); }} />
          <Selector titulo="Fase" valor={fase} opciones={FASES} alCambiar={(v) => { poner('fase', v); setVuelta((n) => n + 1); }} />
          <label className="flex items-center gap-2 text-[14px]">
            <input type="checkbox" checked={hablando} onChange={(e) => poner('hablando', e.target.checked ? '1' : null)} />
            Hablando (mueve la boca)
          </label>
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="t-direcciones">
        <h2 id="t-direcciones" className="text-[18px] font-semibold">Apuntar en 8 direcciones</h2>
        <div className="mx-auto grid w-full max-w-xl grid-cols-3 gap-2" data-prueba="rosa">
          {ROSA.map((d) => d
            ? <Ficha key={d} etiqueta={NOMBRE_DIR[d]} activa={pose === 'apuntar' && dir === d} alPulsar={() => { poner('pose', 'apuntar'); poner('dir', d); }}>
                <Vigia pose="apuntar" dir={d} expresion="neutral" seguirPuntero={false} className="h-[160px] w-[140px]" />
              </Ficha>
            : <Ficha key="centro" etiqueta="reposo" activa={pose === 'reposo'} alPulsar={() => poner('pose', 'reposo')}>
                <Vigia pose="reposo" expresion="neutral" seguirPuntero={false} className="h-[160px] w-[140px]" />
              </Ficha>)}
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="t-poses">
        <h2 id="t-poses" className="text-[18px] font-semibold">Poses</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-prueba="poses">
          {POSES.map((p) => (
            <Ficha key={p} etiqueta={p} activa={pose === p} alPulsar={() => poner('pose', p)}>
              <Vigia pose={p} dir="e" seguirPuntero={false} className="h-[160px] w-[140px]" />
            </Ficha>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="t-expresiones">
        <h2 id="t-expresiones" className="text-[18px] font-semibold">Expresiones</h2>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-prueba="expresiones">
          {ID_EXPRESIONES.map((e) => (
            <Ficha key={e} etiqueta={e} activa={expresion === e} alPulsar={() => poner('exp', e)}>
              <Vigia pose="reposo" expresion={e} seguirPuntero={false} className="h-[128px] w-[112px]" />
            </Ficha>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="t-real">
        <h2 id="t-real" className="text-[18px] font-semibold">Tamaño real en la app (112 × 128)</h2>
        <div className="flex flex-wrap gap-4 rounded-xl border border-border bg-background p-4">
          {(['reposo', 'saludar', 'hablar', 'pensar', 'reparar'] as const).map((p) => (
            <Vigia key={p} pose={p} seguirPuntero={false} className="h-[128px] w-[112px]" />
          ))}
          <Vigia pose="apuntar" dir="ne" seguirPuntero={false} className="h-[128px] w-[112px]" />
          <Vigia pose="apuntar" dir="o" seguirPuntero={false} className="h-[128px] w-[112px]" />
        </div>
      </section>
    </div>
  );
}
