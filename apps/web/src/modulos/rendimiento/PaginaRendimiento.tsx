// /o/:orgId/performance (S14 §14.13). P0: PantallaModulo con la última medición sembrada. P0-lite (RND-15a): histórico de
// solo lectura sobre E24 (mediana si una medición trae varias pasadas). La gráfica y la tabla «frente a la anterior» piden
// >= 2 mediciones de la misma URL y estrategia; con menos, la última de cada estrategia y el aviso de que con la próxima
// llega la comparación (la medición base de una org es 1 de móvil + 1 de escritorio). Sin ninguna, no se pinta.
// F-17: «Medir ahora» arriba (MedirAhora.tsx, solo owner y admin), que lanza E11 con kind 'lighthouse' y lleva a la auditoría.
import { useMemo, useState } from 'react';
import { PantallaModulo } from '@/componentes/vg/PantallaModulo';
import { GraficaComparativa } from '@/componentes/vg/GraficaComparativa';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { usePerfRuns } from '@/lib/consultas';
import { esApiError } from '@/lib/errores';
import { cuando, decimal, duracion } from '@/lib/formato';
import { agrupar, empeora, mismaSerie, type Estrategia, type Medicion, type Metrica } from '@/lib/perf';
import { cn } from '@/lib/utils';
import { Grupo } from './Grupo';
import { MedirAhora } from './MedirAhora';

const METRICAS: [Metrica, string][] = [['perf_score', 'Puntaje'], ['lcp_ms', 'LCP'], ['tbt_ms', 'TBT'], ['cls', 'CLS']];
const ESTRATEGIAS: [Estrategia, string][] = [['mobile', 'Móvil'], ['desktop', 'Escritorio']];
const EN: Record<Estrategia, string> = { mobile: 'móvil', desktop: 'escritorio' };
const formato = (m: Metrica, v: number | null) => v == null ? '—' : m === 'cls' ? decimal(v, 2) : m === 'perf_score' ? String(v) : duracion(v);

function Delta({ m, antes, ahora }: { m: Metrica; antes: Medicion | undefined; ahora: Medicion }) {
  if (!antes || antes[m] == null || ahora[m] == null) return <span className="text-texto-3">—</span>;
  const d = ahora[m]! - antes[m]!;
  if (d === 0) return <span className="text-texto-3">igual</span>;
  const peor = empeora(m, antes[m], ahora[m]);
  const txt = m === 'cls' ? decimal(Math.abs(d), 2) : m === 'perf_score' ? String(Math.abs(d)) : duracion(Math.abs(d));
  return <span className={peor ? 'font-semibold text-aviso' : 'text-muted-foreground'}>{d > 0 ? '+' : '−'}{txt}{peor ? ' · peor' : ''}</span>;
}

// La etiqueta de versión y la de Lighthouse llegan del servidor: sinBidi y <bdi dir="ltr">.
const Rotulo = ({ m }: { m: Medicion }) =>
  m.version ? <bdi dir="ltr">{sinBidi(m.version)}</bdi> : <>Sin etiqueta</>;
const Lighthouse = ({ m }: { m: Medicion }) => (m.lighthouse ? <bdi dir="ltr">{sinBidi(m.lighthouse)}</bdi> : <>—</>);

// Con < 2 mediciones de la estrategia elegida: la última de cada estrategia que tenga alguna, sin comparación.
function Ultimas({ filas }: { filas: [Estrategia, string, Medicion][] }) {
  const titulo = 'Última medición de cada estrategia';
  return (
    <>
      <div className="hidden overflow-x-auto md:block" tabIndex={0} role="region" aria-label={titulo}>
        <table className="w-full min-w-[640px] text-left text-[15px] tabular-nums">
          <thead className="text-[12.5px] font-medium text-texto-3">
            <tr className="border-b"><th className="py-2 pr-3">Estrategia</th><th className="pr-3">Medición</th><th className="pr-3">Lighthouse</th>
              {METRICAS.map(([m, t]) => <th key={m} className="pr-3">{t}</th>)}</tr>
          </thead>
          <tbody>
            {filas.map(([s, t, m]) => (
              <tr key={s} className="h-12 border-b last:border-b-0">
                <td className="pr-3 font-medium">{t}</td>
                <td className="pr-3"><Rotulo m={m} /> <span className="text-[12.5px] text-texto-3">· {cuando(m.at)}</span></td>
                <td className="pr-3 font-mono text-[13px]"><Lighthouse m={m} /></td>
                {METRICAS.map(([k]) => <td key={k} className="pr-3">{formato(k, m[k])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-2 md:hidden" aria-label={titulo}>
        {filas.map(([s, t, m]) => (
          <li key={s} className="flex flex-col gap-2 rounded-lg border px-3 py-3">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[15px] font-medium">{t}</span>
              <span className="min-w-0 text-[12.5px] text-texto-3"><Rotulo m={m} /> · {cuando(m.at)} · Lighthouse <span className="font-mono"><Lighthouse m={m} /></span></span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[15px] tabular-nums">
              {METRICAS.map(([k, tm]) => (
                <div key={k} className="flex items-baseline justify-between gap-2">
                  <dt className="text-[12.5px] text-texto-3">{tm}</dt>
                  <dd>{formato(k, m[k])}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function Historico() {
  const org = useOrg();
  const q = usePerfRuns(org.id);
  const [elegida, setEstrategia] = useState<Estrategia | null>(null);   // null: sin tocar → la que tenga con qué comparar
  const [metrica, setMetrica] = useState<Metrica>('perf_score');
  const todas = useMemo(() => agrupar(q.data ?? []), [q.data]);
  const urls = useMemo(() => [...new Set(todas.map((m) => m.url))], [todas]);
  const [url, setUrl] = useState<string | null>(null);
  // Sin tocar, la URL de la medición más reciente (la que «Medir ahora» trae y la que se acaba de medir); una elegida que
  // ya no viene en E24 (solo trae las 30 últimas) vuelve a esa en vez de dejar el histórico vacío.
  const actual = (url !== null && urls.includes(url) ? url : todas[todas.length - 1]?.url) ?? null;
  // Otra URL: la estrategia vuelve a la que tenga con qué comparar (la elegida pudo no tener ninguna medición allí).
  const cambiarUrl = (u: string) => { setUrl(u); setEstrategia(null); };
  const series = useMemo(() => Object.fromEntries(ESTRATEGIAS.map(([s]) =>
    [s, mismaSerie(todas.filter((m) => m.url === actual && m.strategy === s))])) as Record<Estrategia, Medicion[]>, [todas, actual]);
  const comparables = ESTRATEGIAS.filter(([s]) => series[s].length >= 2).map(([s]) => s);
  const estrategia: Estrategia = elegida ?? comparables[0] ?? (series.mobile.length ? 'mobile' : 'desktop');
  const serie = series[estrategia];
  const ultimas = ESTRATEGIAS.flatMap(([s, t]): [Estrategia, string, Medicion][] => {
    const m = series[s][series[s].length - 1];
    return m ? [[s, t, m]] : [];
  });
  const nombre = METRICAS.find(([m]) => m === metrica)![1];
  const peorQueAntes = (i: number, k: Metrica) => i > 0 && empeora(k, serie[i - 1]![k], serie[i]![k]);

  // 404 = el histórico (E24) aún no existe en esta API: igual que sin mediciones, no se pinta; arriba ya dice
  // «Aún no medimos tu web». Un fallo de verdad sí va en rojo con su «Reintentar».
  if (q.isError && esApiError(q.error) && q.error.status === 404) return null;
  if (q.isError) return <ErrorBloque error={q.error} onReintentar={() => q.refetch()} />;
  if (!q.data || !ultimas.length) return null;                       // sin ninguna medición de esta URL, nada
  const conComparacion = serie.length >= 2;
  // Con comparación en alguna estrategia, el grupo deja cambiar de una a otra; sin ella, la tabla ya trae las dos.
  const aviso = !serie.length ? `Aún no hay mediciones en ${EN[estrategia]} de esta URL.`
    : `Con la próxima medición${comparables.length ? ` en ${EN[estrategia]}` : ''} verás la comparación con la anterior.`;
  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-labelledby="t-historico">
      <div className="flex flex-col gap-1" data-info="lighthouse">
        <h3 id="t-historico" className="text-[17px] font-semibold">Histórico</h3>
        <p className="text-sm text-muted-foreground">Cada medición de Lighthouse vía PageSpeed Insights (con varias pasadas, su mediana). Solo lectura.</p>
      </div>
      {/* La URL, la versión y la de Lighthouse llegan del servidor: los controles bidi se ven (lib/bidi.ts). La URL cruda
          sigue como clave y estado del grupo; solo se sanea lo que se pinta. */}
      {urls.length > 1 ? <Grupo etiqueta="URL" valor={actual ?? ''} opciones={urls.map((u) => [u, sinBidi(u.replace(/^https?:\/\//, ''))])} onCambio={cambiarUrl} />
        : <p className="break-all font-mono text-[13px] text-muted-foreground">{actual ? <bdi dir="ltr">{sinBidi(actual)}</bdi> : null}</p>}
      {comparables.length ? (
        <div className="flex flex-wrap gap-2">
          <Grupo etiqueta="Estrategia" valor={estrategia} opciones={ESTRATEGIAS} onCambio={setEstrategia} />
          {conComparacion ? <Grupo etiqueta="Métrica" valor={metrica} opciones={METRICAS} onCambio={setMetrica} /> : null}
        </div>
      ) : null}
      {conComparacion ? <Comparacion serie={serie} metrica={metrica} estrategia={estrategia} nombre={nombre} peorQueAntes={peorQueAntes} />
        : <><p className="text-[15px] text-muted-foreground">{aviso}</p><Ultimas filas={ultimas} /></>}
    </section>
  );
}

// >= 2 mediciones de la misma URL y estrategia: la gráfica y cada medición frente a la anterior.
function Comparacion({ serie, metrica, estrategia, nombre, peorQueAntes }: {
  serie: Medicion[]; metrica: Metrica; estrategia: Estrategia; nombre: string; peorQueAntes: (i: number, k: Metrica) => boolean;
}) {
  return (
    <>
      <GraficaComparativa mediciones={serie} metrica={metrica} estrategia={estrategia} />
      {/* Desde md, tabla; el contenedor que se desplaza toma el foco para moverlo con teclado. */}
      <div className="hidden overflow-x-auto md:block" tabIndex={0} role="region" aria-label="Histórico de mediciones">
        <table className="w-full min-w-[640px] text-left text-[15px] tabular-nums">
          <thead className="text-[12.5px] font-medium text-texto-3">
            <tr className="border-b"><th className="py-2 pr-3">Medición</th><th className="pr-3">Lighthouse</th>
              {METRICAS.map(([m, t]) => <th key={m} className="pr-3">{t}</th>)}<th>Frente a la anterior ({nombre})</th></tr>
          </thead>
          <tbody>
            {serie.map((m, i) => (
              <tr key={m.clave} className="h-12 border-b last:border-b-0">
                <td className="pr-3">{m.version ? <bdi dir="ltr">{sinBidi(m.version)}</bdi> : `Medición ${i + 1}`} <span className="text-[12.5px] text-texto-3">· {cuando(m.at)}</span></td>
                <td className="pr-3 font-mono text-[13px]">{m.lighthouse ? <bdi dir="ltr">{sinBidi(m.lighthouse)}</bdi> : '—'}</td>
                {METRICAS.map(([k]) => <td key={k} className={cn('pr-3', peorQueAntes(i, k) && 'text-aviso')}>{formato(k, m[k])}</td>)}
                <td><Delta m={metrica} antes={serie[i - 1]} ahora={m} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Por debajo de md, una tarjeta por medición con las mismas cifras (§14.6). */}
      <ul className="flex flex-col gap-2 md:hidden" aria-label="Histórico de mediciones">
        {serie.map((m, i) => (
          <li key={m.clave} className="flex flex-col gap-2 rounded-lg border px-3 py-3">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[15px] font-medium">{m.version ? <bdi dir="ltr">{sinBidi(m.version)}</bdi> : `Medición ${i + 1}`}</span>
              <span className="text-[12.5px] text-texto-3">{cuando(m.at)} · Lighthouse <span className="font-mono">{m.lighthouse ? <bdi dir="ltr">{sinBidi(m.lighthouse)}</bdi> : '—'}</span></span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[15px] tabular-nums">
              {METRICAS.map(([k, t]) => (
                <div key={k} className="flex items-baseline justify-between gap-2">
                  <dt className="text-[12.5px] text-texto-3">{t}</dt>
                  <dd className={cn(peorQueAntes(i, k) && 'text-aviso')}>{formato(k, m[k])}</dd>
                </div>
              ))}
            </dl>
            <p className="text-sm tabular-nums"><span className="text-texto-3">Frente a la anterior ({nombre}): </span><Delta m={metrica} antes={serie[i - 1]} ahora={m} /></p>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function PaginaRendimiento() {
  return (
    <PantallaModulo modulo="performance" proveedor={null} arriba={<MedirAhora />} data-info="modulo-rendimiento">
      <Historico />
    </PantallaModulo>
  );
}
