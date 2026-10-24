// /o/:orgId/performance (S14 §14.13). P0: PantallaModulo con la última medición sembrada. P0-lite (RND-15a): histórico de
// solo lectura sobre E24, con medianas por medición; sin «Medir ahora». Con menos de 2 mediciones no se pinta.
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

const METRICAS: [Metrica, string][] = [['perf_score', 'Puntaje'], ['lcp_ms', 'LCP'], ['tbt_ms', 'TBT'], ['cls', 'CLS']];
const formato = (m: Metrica, v: number | null) => v == null ? '—' : m === 'cls' ? decimal(v, 2) : m === 'perf_score' ? String(v) : duracion(v);

// El texto de cada botón va en <bdi dir="ltr">: en el grupo «URL» es la URL del servidor (ya con sinBidi).
function Grupo<T extends string>({ valor, opciones, onCambio, etiqueta }: { valor: T; opciones: [T, string][]; onCambio: (v: T) => void; etiqueta: string }) {
  return (
    <div className="inline-flex w-fit rounded-lg bg-muted p-1" role="group" aria-label={etiqueta}>
      {opciones.map(([v, t]) => (
        <button key={v} type="button" aria-pressed={valor === v} onClick={() => onCambio(v)}
          className={cn('h-11 rounded-md px-3 text-sm font-medium', valor === v ? 'bg-card text-foreground' : 'text-muted-foreground')}><bdi dir="ltr">{t}</bdi></button>
      ))}
    </div>
  );
}

function Delta({ m, antes, ahora }: { m: Metrica; antes: Medicion | undefined; ahora: Medicion }) {
  if (!antes || antes[m] == null || ahora[m] == null) return <span className="text-texto-3">—</span>;
  const d = ahora[m]! - antes[m]!;
  if (d === 0) return <span className="text-texto-3">igual</span>;
  const peor = empeora(m, antes[m], ahora[m]);
  const txt = m === 'cls' ? decimal(Math.abs(d), 2) : m === 'perf_score' ? String(Math.abs(d)) : duracion(Math.abs(d));
  return <span className={peor ? 'font-semibold text-aviso' : 'text-muted-foreground'}>{d > 0 ? '+' : '−'}{txt}{peor ? ' · peor' : ''}</span>;
}

function Historico() {
  const org = useOrg();
  const q = usePerfRuns(org.id);
  const [estrategia, setEstrategia] = useState<Estrategia>('mobile');
  const [metrica, setMetrica] = useState<Metrica>('perf_score');
  const todas = useMemo(() => agrupar(q.data ?? []), [q.data]);
  const urls = useMemo(() => [...new Set(todas.map((m) => m.url))], [todas]);
  const [url, setUrl] = useState<string | null>(null);
  const actual = url ?? urls[0] ?? null;
  const serie = mismaSerie(todas.filter((m) => m.url === actual && m.strategy === estrategia));
  const nombre = METRICAS.find(([m]) => m === metrica)![1];
  const peorQueAntes = (i: number, k: Metrica) => i > 0 && empeora(k, serie[i - 1]![k], serie[i]![k]);

  // 404 = el histórico (E24) aún no existe en esta API: igual que sin mediciones, no se pinta; arriba ya dice
  // «Aún no medimos tu web». Un fallo de verdad sí va en rojo con su «Reintentar».
  if (q.isError && esApiError(q.error) && q.error.status === 404) return null;
  if (q.isError) return <ErrorBloque error={q.error} onReintentar={() => q.refetch()} />;
  if (!q.data || serie.length < 2) return null;                      // con < 2 mediciones no se pinta (S10 §10.10)
  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-labelledby="t-historico">
      <div className="flex flex-col gap-1">
        <h3 id="t-historico" className="text-[17px] font-semibold">Histórico</h3>
        <p className="text-sm text-muted-foreground">Mediana de cada medición (3 repeticiones de Lighthouse vía PageSpeed Insights). Solo lectura.</p>
      </div>
      {/* La URL, la versión y la de Lighthouse llegan del servidor: los controles bidi se ven (lib/bidi.ts). La URL cruda
          sigue como clave y estado del grupo; solo se sanea lo que se pinta. */}
      {urls.length > 1 ? <Grupo etiqueta="URL" valor={actual ?? ''} opciones={urls.map((u) => [u, sinBidi(u.replace(/^https?:\/\//, ''))])} onCambio={setUrl} />
        : <p className="font-mono text-[13px] text-muted-foreground">{actual ? <bdi dir="ltr">{sinBidi(actual)}</bdi> : null}</p>}
      <div className="flex flex-wrap gap-2">
        <Grupo etiqueta="Estrategia" valor={estrategia} opciones={[['mobile', 'Móvil'], ['desktop', 'Escritorio']]} onCambio={setEstrategia} />
        <Grupo etiqueta="Métrica" valor={metrica} opciones={METRICAS} onCambio={setMetrica} />
      </div>
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
    </section>
  );
}

export default function PaginaRendimiento() {
  return (
    <PantallaModulo modulo="performance" proveedor={null}>
      <Historico />
    </PantallaModulo>
  );
}
