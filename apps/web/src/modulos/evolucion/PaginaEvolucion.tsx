// /o/:orgId/evolution (asignaciones/evolucion-entre-revisiones.md §1.3 y §6.4). Cada versión es una auditoría terminada:
// con foto trae nuevos, corregidos y abiertos; las de antes del historial, solo el puntaje. Las cifras del periodo salen de
// `totals` (lib/evolucion.ts). Si E52 da 404 (aún sin desplegar): «La evolución llega pronto».
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronRight, ShieldCheck, TrendingUp } from 'lucide-react';
import type { Evolution, EvolutionPoint, EvolutionReview, PorSeveridad } from '@vanguard/contracts';
import { BarraModulo } from '@/componentes/vg/BarraModulo';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { GuiaModulo } from '@/componentes/vg/GuiaModulo';
import { ErrorBloque, Vacio } from '@/componentes/vg/Vacio';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { useConexiones, useEvolucion } from '@/lib/consultas';
import { esApiError, mensajeDe } from '@/lib/errores';
import {
  NOTA_FOTO_PUSH, SEVERIDADES, cifras, etiquetaVersion, horas, lineaFoto, porSeveridad, serieCambios, seriePuntaje, signo, tipoAuditoria,
  totalFila, totalMatriz,
} from '@/lib/evolucion';
import { cuando, miles } from '@/lib/formato';
import { useLanzarScan } from '@/lib/mutaciones';
import { entradaNav } from '@/lib/nav';
import { severidad } from '@/lib/severidad';
import { cn } from '@/lib/utils';
import { GraficaCambios, GraficaPuntaje, Leyenda } from './Graficas';

type Dias = 7 | 30 | 90;
const PERIODOS: [Dias, string][] = [[7, '7 días'], [30, '30 días'], [90, '90 días']];

// El grupo de botones de Rendimiento (PaginaRendimiento), con valores numéricos.
function Grupo<T extends string | number>({ valor, opciones, onCambio, etiqueta }: { valor: T; opciones: [T, string][]; onCambio: (v: T) => void; etiqueta: string }) {
  return (
    <div className="inline-flex w-fit rounded-lg bg-muted p-1" role="group" aria-label={etiqueta}>
      {opciones.map(([v, t]) => (
        <button key={String(v)} type="button" aria-pressed={valor === v} onClick={() => onCambio(v)}
          className={cn('h-11 rounded-md px-3 text-sm font-medium', valor === v ? 'bg-card text-foreground' : 'text-muted-foreground')}>{t}</button>
      ))}
    </div>
  );
}

// Como Cifra, pero con alto mínimo en rem: las etiquetas de §6.4 ocupan dos líneas y en modo presentación crecen.
function Dato({ etiqueta, valor, sub }: { etiqueta: string; valor: string; sub?: string }) {
  return (
    <div className="flex min-h-[6.5rem] flex-col justify-between gap-1 rounded-xl border bg-card px-4 py-3">
      <span className="font-mono text-[12.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{etiqueta}</span>
      <span className={cn('text-3xl font-semibold tabular-nums', valor === '—' ? 'text-texto-3' : 'text-foreground')}>{valor}</span>
      {sub ? <span className="text-[12.5px] text-texto-3">{sub}</span> : null}
    </div>
  );
}

function Cifras({ evo }: { evo: Evolution }) {
  const c = cifras(evo);
  const num = (n: number | null) => (n == null ? '—' : miles(n));
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
      <Dato etiqueta="Puntaje en la última auditoría" valor={num(c.puntaje)} sub={c.cambio == null ? undefined : `${signo(c.cambio)} desde la primera del periodo`} />
      <Dato etiqueta="Abiertos al cerrarla" valor={num(c.abiertos)} sub={c.criticos == null ? undefined : `${c.criticos} ${c.criticos === 1 ? 'crítico' : 'críticos'}`} />
      <Dato etiqueta={`Nuevos en ${evo.days} días`} valor={num(c.nuevos)} />
      <Dato etiqueta={`Corregidos en ${evo.days} días`} valor={num(c.corregidos)} sub={c.comprobados == null ? undefined : `${c.comprobados} ${c.comprobados === 1 ? 'comprobado' : 'comprobados'}`} />
      <Dato etiqueta="Tiempo hasta comprobar la corrección" valor={horas(c.mttr.media)}
        sub={c.mttr.n ? `mediana ${horas(c.mttr.mediana)} · ${c.mttr.n} ${c.mttr.n === 1 ? 'hallazgo' : 'hallazgos'}` : 'Aún ninguno comprobado'} />
    </div>
  );
}

// C · A · M · B (baja e info juntas) de los abiertos al cerrar cada versión.
function Abiertos({ p }: { p: EvolutionPoint }) {
  if (!p.snapshot || !p.open) return <span className="text-texto-3">—</span>;
  const s = porSeveridad(p.open);
  return (
    <span className="tabular-nums">
      <span className="font-medium">{totalMatriz(p.open)}</span>
      <span className="text-[12.5px] text-texto-3" title="Críticos · altos · medios · bajos"> · C {s.critical} · A {s.high} · M {s.medium} · B {s.low + s.info}</span>
    </span>
  );
}
const cambio = (p: EvolutionPoint, k: 'new' | 'fixed') => (p.snapshot && !p.first && p[k] ? miles(totalMatriz(p[k])) : '—');
function Marca({ p }: { p: EvolutionPoint }) {
  if (!p.snapshot) return <Etiqueta texto="Anterior al historial" />;
  return p.first ? <Etiqueta texto="Punto de partida" /> : null;
}

function Versiones({ points }: { points: EvolutionPoint[] }) {
  const org = useOrg();
  const filas = [...points].reverse();                         // la más reciente arriba
  const enlace = (p: EvolutionPoint) => (
    <Link to={`/o/${org.id}/audit/${encodeURIComponent(p.scan_run_id)}`} className="inline-flex h-11 items-center gap-1 text-sm font-medium text-foreground underline underline-offset-4">
      {p.snapshot ? 'Ver cambios' : 'Ver auditoría'}<ChevronRight className="size-4" /></Link>
  );
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-labelledby="t-versiones">
      <h3 id="t-versiones" className="text-[17px] font-semibold">Versiones</h3>
      {/* Desde md, tabla; el contenedor que se desplaza toma el foco para moverlo con teclado. */}
      <div className="hidden overflow-x-auto md:block" tabIndex={0} role="region" aria-label="Versiones">
        <table className="w-full min-w-[640px] text-left text-[15px] tabular-nums">
          <thead className="text-[12.5px] font-medium text-texto-3">
            <tr className="border-b"><th className="py-2 pr-3">Auditoría</th><th className="pr-3">Puntaje</th><th className="pr-3">Abiertos</th>
              <th className="pr-3">Nuevos</th><th className="pr-3">Corregidos</th><th><span className="sr-only">Enlace</span></th></tr>
          </thead>
          <tbody>
            {filas.map((p) => (
              <tr key={p.scan_run_id} className="h-12 border-b last:border-b-0">
                <td className="py-2 pr-3"><span className="flex flex-wrap items-center gap-2">{etiquetaVersion(p.at)}
                  <span className="text-[12.5px] text-texto-3">· {tipoAuditoria(p.kind)}</span><Marca p={p} /></span></td>
                <td className="pr-3">{p.score ?? '—'}</td>
                <td className="pr-3"><Abiertos p={p} /></td>
                <td className="pr-3">{cambio(p, 'new')}</td>
                <td className="pr-3">{cambio(p, 'fixed')}</td>
                <td className="text-right">{enlace(p)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Por debajo de md, una tarjeta por versión con las mismas cifras. */}
      <ul className="flex flex-col gap-2 md:hidden" aria-label="Versiones">
        {filas.map((p) => (
          <li key={p.scan_run_id} className="flex flex-col gap-2 rounded-lg border px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-medium">{etiquetaVersion(p.at)}</span>
              <span className="text-[12.5px] text-texto-3">{tipoAuditoria(p.kind)}</span><Marca p={p} />
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[15px] tabular-nums">
              <div className="flex items-baseline justify-between gap-2"><dt className="text-[12.5px] text-texto-3">Puntaje</dt><dd>{p.score ?? '—'}</dd></div>
              <div className="flex items-baseline justify-between gap-2"><dt className="text-[12.5px] text-texto-3">Nuevos</dt><dd>{cambio(p, 'new')}</dd></div>
              <div className="flex items-baseline justify-between gap-2"><dt className="text-[12.5px] text-texto-3">Corregidos</dt><dd>{cambio(p, 'fixed')}</dd></div>
              <div className="col-span-2 flex items-baseline justify-between gap-2"><dt className="text-[12.5px] text-texto-3">Abiertos</dt><dd><Abiertos p={p} /></dd></div>
            </dl>
            {enlace(p)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Seccion({ id, titulo, children }: { id: string; titulo: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-labelledby={id}>
      <h3 id={id} className="text-[17px] font-semibold">{titulo}</h3>
      {children}
    </section>
  );
}

function Contenido({ evo }: { evo: Evolution }) {
  const serie = seriePuntaje(evo.points);
  const cambios = serieCambios(evo.points);
  const recorte = evo.truncated ? ` · últimas ${evo.points.length} auditorías` : '';
  return (
    <>
      <Cifras evo={evo} />
      {cambios.length === 0 ? <p className="rounded-xl border bg-card px-4 py-3 text-[15px] text-muted-foreground">Con la próxima auditoría verás qué cambió.</p> : null}
      {serie.length > 1 ? <Seccion id="t-puntaje" titulo={`Puntaje por auditoría${recorte}`}><GraficaPuntaje serie={serie} /></Seccion> : null}
      {cambios.length ? (
        <Seccion id="t-cambios-evo" titulo={`Nuevos y corregidos${recorte}`}>
          <GraficaCambios serie={cambios} />
          <Leyenda items={[['Nuevos (hacia arriba)', 'var(--mal)'], ['Corregidos (hacia abajo)', 'var(--bien)']]} />
        </Seccion>
      ) : null}
      <Versiones points={evo.points} />
    </>
  );
}

// Pushes y PR del periodo, el más reciente arriba: sus nuevos y, en un push, la foto de Codebase (lineaFoto). «Ver» abre la
// fila en Codebase. El commit es hex validado por el contrato; aun así va saneado y en <bdi>.
const peor = (n: PorSeveridad) => SEVERIDADES.find((s) => (n[s] ?? 0) > 0) ?? null;
function Revisiones({ reviews }: { reviews: EvolutionReview[] }) {
  const org = useOrg();
  const conexiones = useConexiones(org.id);
  const variosRepos = (conexiones.data ?? []).filter((c) => c.provider === 'github' && c.kind === 'read').length >= 2;
  if (!reviews.length) return null;
  const filas = [...reviews].reverse();
  return (
    <Seccion id="t-revisiones" titulo="Revisiones de código">
      <ul aria-label="Revisiones de código">
        {filas.map((r) => {
          const n = totalFila(r.new);
          const s = severidad(peor(r.new));
          const linea = lineaFoto({ event: r.event, counts: r.new, delta: r.delta }, variosRepos);
          return (
            <li key={r.review_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-3 last:border-b-0">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2 text-[15px]">
                  <span className="tabular-nums">{cuando(r.at)}</span>
                  <span className="font-mono text-[13px]"><bdi dir="ltr">{sinBidi(r.head_sha7)}</bdi></span>
                  <span className="text-muted-foreground">{r.event === 'push' ? 'Push' : `PR #${r.pr_number ?? '—'}`}</span>
                  <Etiqueta texto={n ? `${n} ${n === 1 ? 'nuevo' : 'nuevos'} · peor: ${s.etiqueta}` : 'Limpio'} rol={n ? s.rol : 'bien'} />
                  {r.partial ? <Etiqueta texto="Parcial" rol="aviso" /> : null}
                </span>
                {linea ? <span className="text-[13px] text-muted-foreground">{linea}</span> : null}
              </div>
              <Link to={`/o/${org.id}/codebase?revision=${encodeURIComponent(r.review_id)}`} className="inline-flex h-11 items-center gap-1 text-sm font-medium text-foreground underline underline-offset-4">
                Ver<ChevronRight className="size-4" /></Link>
            </li>
          );
        })}
      </ul>
      {reviews.some((r) => r.event === 'push' && r.delta) ? <p className="text-[12.5px] text-texto-3">{NOTA_FOTO_PUSH}</p> : null}
    </Seccion>
  );
}

// 0 versiones en el periodo: «Auditar todo» (apagado para el viewer y el anónimo de la demo).
function SinAuditorias() {
  const org = useOrg();
  const navegar = useNavigate();
  const lanzar = useLanzarScan(org.id);
  const [error, setError] = useState<string | null>(null);
  const auditar = () => {
    setError(null);
    lanzar.mutate({ kind: 'full_audit' }, {
      onSuccess: (r) => navegar(`/o/${org.id}/audit/${encodeURIComponent(r.scan_run_id)}`),
      onError: (e) => {
        const enCurso = esApiError(e) && e.code === 'conflict' && typeof e.details?.scan_run_id === 'string' ? e.details.scan_run_id : null;
        if (enCurso) navegar(`/o/${org.id}/audit/${encodeURIComponent(enCurso)}`); else setError(mensajeDe(e));
      },
    });
  };
  return (
    <Vacio icono={TrendingUp} titulo="Aún no hay auditorías en este periodo" texto="Cada auditoría que termine queda aquí."
      accion={<div className="flex flex-col items-center gap-2">
        <BotonAccion variante="marca" tam="grande" icono={ShieldCheck} onClick={auditar} ocupado={lanzar.isPending}
          disabled={!org.puedeEscribir} ayuda={SOLO_LECTURA}>Auditar todo</BotonAccion>
        {error ? <p role="alert" className="text-sm text-mal">{error}</p> : null}
      </div>} />
  );
}

export default function PaginaEvolucion() {
  const org = useOrg();
  const [dias, setDias] = useState<Dias>(30);
  const q = useEvolucion(org.id, dias);
  const pronto = q.isError && esApiError(q.error) && q.error.status === 404;
  const evo = q.data;
  return (
    <div className="flex flex-col gap-6">
      <BarraModulo titulo="Evolución" descripcion={entradaNav('evolution')?.descripcion}
        extra={pronto ? null : <Grupo etiqueta="Periodo" valor={dias} opciones={PERIODOS} onCambio={setDias} />} />
      {pronto ? <Vacio icono={TrendingUp} titulo="La evolución llega pronto"
          texto="Aquí verás, auditoría tras auditoría, qué es nuevo, qué se mantiene y qué se corrigió, y cómo se mueve tu puntaje." />
        : q.isError && !evo ? <ErrorBloque error={q.error} onReintentar={() => q.refetch()} />
        : !evo ? <p className="text-texto-3" aria-busy="true">—</p>
        : <>
          {/* Datos viejos con un fallo al refrescar: se quedan, con el error encima. */}
          {q.isError ? <ErrorBloque error={q.error} onReintentar={() => q.refetch()} /> : null}
          {evo.points.length ? <Contenido evo={evo} /> : <SinAuditorias />}
          <Revisiones reviews={evo.reviews} />
        </>}
      {pronto ? null : (
        <div className="flex flex-col gap-1 text-[13px] text-texto-3">
          <p>Rendimiento no entra en las auditorías: su historia está en Rendimiento.</p>
          <p>El tiempo hasta comprobar solo cuenta lo que una auditoría dio por corregido; no cuenta lo marcado a mano (no guarda la hora) ni las claves (que ya no estén no prueba que se rotaron).</p>
        </div>
      )}
      <GuiaModulo id="evolution" />
    </div>
  );
}
