// /o/:orgId/wiki «Wiki del repo» (DeepWiki, E40–E44): explica un repo a un directivo. Estimar antes de gastar; la
// caché del mismo commit es gratis. El viewer (y el «Ver demo» del jurado) solo ve historial y documento: nunca gasta IA.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { BookOpen, ChevronDown, Coins, FileText, RotateCw, Sparkles } from 'lucide-react';
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
import type { WikiDoc, WikiEstimate, WikiRun } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { BarraModulo } from '@/componentes/vg/BarraModulo';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { BotonCopiar } from '@/componentes/vg/BotonCopiar';
import { ConfirmarEnSitio } from '@/componentes/vg/ConfirmarEnSitio';
import { DiagramaWiki } from '@/componentes/vg/DiagramaWiki';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { CampoTexto } from '@/componentes/vg/FormToken';
import { GuiaModulo } from '@/componentes/vg/GuiaModulo';
import { PuntoEstado } from '@/componentes/vg/PuntoEstado';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { useConexiones, useWikiDoc, useWikiRun, useWikiRuns } from '@/lib/consultas';
import { ApiError, esApiError, mensajeDe } from '@/lib/errores';
import { esId } from '@/lib/ids';
import { cuando, hace, miles, usd } from '@/lib/formato';
import { Markdown } from '@/lib/markdown';
import { comoMarkdown, consultaHistorial, topeUsd, wikiAnterior } from './texto';
import { useEstancada } from './estancada';
import { useEstimarWiki, useGenerarWiki } from '@/lib/mutaciones';
import { extraerRepo, extraerRepoYRama } from '@/lib/pre-guardas';
import { deMapa } from '@/lib/severidad';
import { cn } from '@/lib/utils';

const PASO: Record<WikiRun['steps'][number]['name'], string> = {
  arbol: 'Árbol del repo', triage: 'Elegir los archivos que importan', area: 'Explicar cada área', sintesis: 'Resumen para el directivo', fin: 'Listo',
};
// Con los controles bidi a la vista (lib/bidi.ts): en producción api() no impone el formato de CommitSha.
const corto = (sha: string | null) => (sha ? sinBidi(sha.slice(0, 7)) : '—');
// El estado de cada paso también en texto: el color del punto no basta (§14.6).
const ESTADO_PASO: Record<WikiRun['steps'][number]['status'], string> = {
  done: 'Hecho', running: 'En curso', failed: 'Falló', pending: 'Pendiente', skipped: 'Omitido',
};

export function Estimacion({ e, alGenerar, alRegenerar, alVer, ocupado, anterior = null }: {   // exportada para el arnés de XSS
  e: WikiEstimate; alGenerar: (force: boolean) => void; alRegenerar: () => Promise<void>; alVer: (id: string) => void; ocupado: boolean;
  anterior?: WikiRun | null;   // wiki terminada del mismo repo, de otro commit (wikiAnterior)
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-label="Estimación">
      <div className="flex flex-wrap items-center gap-2">
        <Coins className="size-5 text-info" />
        <h3 className="flex-1 text-[17px] font-semibold">Estimación</h3>
        <span className="font-mono text-[13px] text-muted-foreground"><bdi dir="ltr">{sinBidi(`${e.repo_full_name}@${e.branch}`)}</bdi> · {corto(e.commit_sha)}</span>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[['Archivos en el repo', miles(e.files_total)], ['Candidatos', miles(e.files_candidatos)], ['A leer (máx.)', miles(e.files_a_leer_max)], ['Áreas (máx.)', miles(e.areas_max)]].map(([t, v]) => (
          <div key={t} className="flex flex-col gap-0.5 rounded-lg border px-3 py-2"><dt className="text-[12.5px] text-muted-foreground">{t}</dt><dd className="text-xl font-semibold tabular-nums">{v}</dd></div>
        ))}
      </dl>
      {e.truncado ? <Etiqueta texto="El repo es grande: leeremos solo una parte" rol="aviso" className="w-fit" /> : null}
      <div className="flex flex-col gap-2">
        <p className="text-[15px]">Costo estimado: <span className="font-semibold tabular-nums">~{usd(e.est.usd)}</span>
          <span className="text-muted-foreground"> · {miles(e.est.input_tokens)} tokens de entrada y {miles(e.est.output_tokens)} de salida</span></p>
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {e.est.desglose.map((d) => (
            <li key={d.paso} className="flex flex-wrap gap-x-2"><span className="font-medium text-foreground">{deMapa(PASO, d.paso, '—')}</span>
              <span className="font-mono text-[12.5px]"><bdi dir="ltr">{sinBidi(d.modelo)}</bdi></span><span>· {d.llamadas} {d.llamadas === 1 ? 'llamada' : 'llamadas'} · {usd(d.usd)}</span></li>
          ))}
        </ul>
        <p className="text-[12.5px] text-texto-3">Modelos: rápido <span className="font-mono"><bdi dir="ltr">{sinBidi(e.models.fast)}</bdi></span> · fino <span className="font-mono"><bdi dir="ltr">{sinBidi(e.models.smart)}</bdi></span></p>
      </div>
      {e.avisos.map((a) => <p key={a} className="rounded-lg border border-aviso-borde bg-aviso-relleno px-3 py-2 text-sm text-aviso">{sinBidi(a)}</p>)}
      {e.cached_run_id ? (
        <div className="flex flex-wrap items-start gap-3">
          {/* Texto largo: a 375 px parte en dos líneas en vez de desbordar (max-w-full por el shrink-0 de Button). */}
          <Button variant="principal" size="grande" className="h-auto min-h-14 max-w-full whitespace-normal py-2 text-left" onClick={() => alVer(e.cached_run_id!)}>
            <BookOpen />Ya existe la wiki de este commit · Ver (gratis)
          </Button>
          <ConfirmarEnSitio verbo="Regenerar" aviso={`Vuelve a gastar ~${usd(e.est.usd)} en IA.`} onConfirmar={alRegenerar} />
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          <BotonAccion variante="principal" tam="grande" icono={Sparkles} ocupado={ocupado} onClick={() => alGenerar(false)}>
            Generar wiki · ~{usd(e.est.usd)}
          </BotonAccion>
          {anterior ? (
            <Button variant="secundaria" size="grande" className="h-auto min-h-14 max-w-full whitespace-normal py-2 text-left" onClick={() => alVer(anterior.id)}>
              <BookOpen />{anterior.commit_sha === e.commit_sha ? 'Ver la wiki anterior de este commit'
                : <>Ver la wiki del commit <span className="font-mono">{corto(anterior.commit_sha)}</span></>}, de {hace(anterior.finished_at ?? anterior.created_at)} (gratis)
            </Button>
          ) : null}
        </div>
      )}
      <p className="text-[12.5px] text-texto-3">Tope que aceptas: {usd(topeUsd(e.est.usd))}. Si la IA se acerca al tope, se detiene y te avisa.</p>
    </section>
  );
}

export function Progreso({ run, alReintentar, puedeEscribir, estancada }: { run: WikiRun; alReintentar: () => void; puedeEscribir: boolean; estancada: boolean }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-label="Progreso de la wiki">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="font-medium">{run.status === 'failed' ? 'La wiki falló' : run.status === 'succeeded' ? 'Wiki lista' : 'Generando la wiki…'}</span>
        <span className="text-muted-foreground">Gastado: <span className="tabular-nums">{usd(run.cost_usd ?? 0)}</span>{run.est_usd != null ? ` de ~${usd(run.est_usd)}` : ''}</span>
        <span className="ml-auto font-mono tabular-nums">{run.progress} %</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={run.progress} aria-label="Progreso de la wiki">
        <div className="h-full bg-info transition-[width]" style={{ width: `${run.progress}%` }} />
      </div>
      <ol className="flex flex-col gap-2" aria-live="polite">
        {run.steps.map((s) => (
          <li key={s.name} className="flex flex-wrap items-center gap-3 text-sm">
            <PuntoEstado rol={s.status === 'done' ? 'bien' : s.status === 'running' ? 'info' : s.status === 'failed' ? 'aviso' : 'neutra'}
              hueco={s.status === 'pending' || s.status === 'skipped'} girando={s.status === 'running'} />
            <span className="font-medium">{deMapa(PASO, s.name, '—')}</span>
            <span className="text-sm text-muted-foreground">{deMapa(ESTADO_PASO, s.status, '—')}</span>
            {s.detalle ? <span className="text-muted-foreground">{sinBidi(s.detalle)}</span> : null}
          </li>
        ))}
      </ol>
      {estancada && run.status !== 'failed' ? (
        // Neutro (L3): no es un fallo seguro; quizá solo tarda. Reintentar crea otra corrida con force.
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted px-4 py-3" role="status">
          <span className="flex-1 text-sm">Se está tardando más de lo normal: lleva 3 minutos sin avanzar. Puedes esperar o reintentarla.</span>
          <BotonAccion icono={RotateCw} disabled={!puedeEscribir} ayuda={SOLO_LECTURA} onClick={alReintentar}>Reintentar</BotonAccion>
        </div>
      ) : null}
      {run.status === 'failed' ? (
        <div className="flex flex-col gap-2">
          {/* Como ApiError, para que ErrorBloque muestre el motivo que manda el BACK y no «Algo falló». */}
          <ErrorBloque error={new ApiError(0, 'run_failed', run.error ?? 'La wiki falló')} />
          <BotonAccion icono={RotateCw} disabled={!puedeEscribir} ayuda={SOLO_LECTURA} onClick={alReintentar}>Reintentar</BotonAccion>
        </div>
      ) : null}
    </section>
  );
}

function Documento({ d }: { d: WikiDoc }) {
  const mapa = (
    <div className="flex flex-col gap-2">
      {d.mermaid ? <DiagramaWiki fuente={d.mermaid} />
        : d.mermaid_descartado ? <Etiqueta texto="El diagrama se descartó por seguridad" rol="aviso" className="w-fit" /> : null}
    </div>
  );
  return (
    <article className="flex flex-col gap-5 rounded-xl border bg-card p-5" aria-label="Wiki del repo">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-[15px] font-semibold"><bdi dir="ltr">{sinBidi(`${d.repo_full_name}@${d.branch}`)}</bdi></span>
        <span className="font-mono text-[13px] text-muted-foreground">{corto(d.commit_sha)}</span>
        <span className="text-[12.5px] text-texto-3">{cuando(d.generated_at)} · <bdi dir="ltr">{sinBidi(d.models.fast)}</bdi> y <bdi dir="ltr">{sinBidi(d.models.smart)}</bdi> · {usd(d.stats.cost_usd)}</span>
        <span className="ml-auto"><BotonCopiar valor={comoMarkdown(d)} texto="Copiar como Markdown" /></span>
      </header>
      <p className="text-[12.5px] text-muted-foreground">Escrito por una IA a partir del código: es un dato no confiable, revísalo antes de decidir.</p>
      {/* El mapa va al final de la sección «## Mapa visual» (pura: StrictMode renderiza dos veces). */}
      <Markdown md={d.overview_md} despues={(t) => (/mapa/i.test(t) ? mapa : null)} />
      {/* Si el overview no trae la sección «Mapa visual», el mapa va al final del resumen. */}
      {!/^##\s+.*mapa/im.test(d.overview_md) ? mapa : null}
      <section className="flex flex-col gap-2" aria-label="Áreas del repo">
        <h3 className="text-[17px] font-semibold">Por áreas</h3>
        {d.paginas.map((p) => (
          <CollapsiblePrimitive.Root key={p.id} className="rounded-xl border">
            <CollapsiblePrimitive.Trigger className="group flex min-h-14 w-full items-center gap-3 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <FileText className="size-4 text-info" />
              <span className="flex flex-1 flex-col"><span className="text-[15px] font-semibold">{sinBidi(p.titulo)}</span><span className="text-[12.5px] text-texto-3"><bdi dir="ltr">{sinBidi(p.area)}</bdi></span></span>
              <ChevronDown className="size-5 text-texto-3 transition-transform group-data-[state=open]:rotate-180" />
            </CollapsiblePrimitive.Trigger>
            <CollapsiblePrimitive.Content className="flex flex-col gap-3 px-4 pb-4">
              <Markdown md={p.resumen_md} />
              <details className="text-sm">
                <summary className="cursor-pointer font-medium text-muted-foreground">Archivos ({p.archivos.length})</summary>
                <ul className="mt-2 flex flex-col gap-0.5">{p.archivos.map((a) => <li key={a} className="font-mono text-[12.5px] break-all"><bdi dir="ltr">{sinBidi(a)}</bdi></li>)}</ul>
              </details>
            </CollapsiblePrimitive.Content>
          </CollapsiblePrimitive.Root>
        ))}
      </section>
      {d.avisos.map((a) => <p key={a} className="rounded-lg border border-aviso-borde bg-aviso-relleno px-3 py-2 text-sm text-aviso">{sinBidi(a)}</p>)}
      <p className="text-[12.5px] text-texto-3 tabular-nums">
        Leímos {miles(d.stats.files_leidos)} de {miles(d.stats.files_total)} archivos en {miles(d.stats.areas)} áreas · {miles(d.stats.input_tokens)} tokens de entrada y {miles(d.stats.output_tokens)} de salida · {usd(d.stats.cost_usd)}
      </p>
    </article>
  );
}

function Historial({ runs, actual, alElegir }: { runs: WikiRun[]; actual: string | null; alElegir: (id: string) => void }) {
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">Aún no hay wikis de este repo.</p>;
  const ESTADO: Record<WikiRun['status'], string> = { queued: 'En cola', running: 'Generando', succeeded: 'Lista', failed: 'Falló' };
  return (
    <ul className="overflow-hidden rounded-xl border bg-card" aria-label="Historial de wikis">
      {runs.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => alElegir(r.id)} aria-current={r.id === actual || undefined}
            className={cn('flex min-h-12 w-full flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-left last:border-b-0 hover:bg-muted', r.id === actual && 'bg-info-relleno')}>
            <span className="font-mono text-[13px]">{corto(r.commit_sha)}</span>
            <span className="text-sm text-muted-foreground">{r.branch ? <bdi dir="ltr">{sinBidi(r.branch)}</bdi> : '—'}</span>
            <Etiqueta texto={deMapa(ESTADO, r.status, '—')} rol={r.status === 'failed' ? 'aviso' : 'neutra'} />
            {r.cached || r.cost_usd === 0 ? <Etiqueta texto="caché" rol="info" /> : null}
            <span className="ml-auto text-sm tabular-nums">{r.cost_usd == null ? '—' : usd(r.cost_usd)}</span>
            <span className="text-[12.5px] text-texto-3 tabular-nums">{cuando(r.created_at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function PaginaWiki() {
  const org = useOrg();
  const [params, setParams] = useSearchParams();
  const crudo = params.get('run');
  const runId = esId(crudo) ? crudo : null;
  const elegir = (id: string) => { const p = new URLSearchParams(params); p.set('run', id); setParams(p); };
  const gh = useConexiones(org.id).data?.find((c) => c.provider === 'github' && c.kind === 'read' && c.status === 'active');
  const repoConexion = typeof gh?.meta.repo_full_name === 'string' ? gh.meta.repo_full_name : '';
  const [repo, setRepo] = useState('');
  const [rama, setRama] = useState('');
  const [errorRepo, setErrorRepo] = useState<string | null>(null);
  useEffect(() => { if (repoConexion && !repo) setRepo(repoConexion); }, [repoConexion, repo]);
  const repoValido = useMemo(() => extraerRepo(repo), [repo]);
  // El historial espera 400 ms a que se deje de escribir y solo pregunta por un owner/repo válido (E43 da 422 si no).
  const [repoQuieto, setRepoQuieto] = useState(repo);
  useEffect(() => { const t = setTimeout(() => setRepoQuieto(repo), 400); return () => clearTimeout(t); }, [repo]);
  const consulta = useMemo(() => consultaHistorial(repoQuieto), [repoQuieto]);
  const cambiarRepo = (v: string) => {
    setRepo(v);
    const r = extraerRepoYRama(v)?.rama;   // una URL …/tree/<rama> rellena la rama si estaba vacía
    if (r && !rama.trim()) setRama(r);
  };

  const estimar = useEstimarWiki(org.id);
  const generar = useGenerarWiki(org.id);
  const historial = useWikiRuns(org.id, consulta.repo, consulta.consultar);
  const sinFormato = !consulta.consultar || (historial.isError && esApiError(historial.error) && historial.error.status === 422);
  const [lento, setLento] = useState(false);
  const run = useWikiRun(org.id, runId, lento);
  const estancada = useEstancada(run.data);
  useEffect(() => setLento(estancada), [estancada]);
  const doc = useWikiDoc(org.id, runId, run.data?.status === 'succeeded');
  // Repo de la conexión GitHub (privado: va con su connection_id) o texto libre para repos públicos.
  const e = { ref: rama.trim() || undefined, connection_id: repoValido && repoValido === repoConexion ? gh?.id : undefined };
  const pedirEstimacion = (ev: FormEvent) => {
    ev.preventDefault();
    if (!repoValido) { setErrorRepo('Escribe owner/repo o la URL del repo'); return; }
    setErrorRepo(null);
    estimar.mutate({ repo_full_name: repoValido, ...e });
  };
  const lanzar = (force: boolean) => {
    if (!estimar.data) return;
    generar.mutate({ repo_full_name: estimar.data.repo_full_name, ...e, max_usd: topeUsd(estimar.data.est.usd), ...(force ? { force: true } : {}) },
      { onSuccess: (r) => elegir(r.wiki_run_id) });
  };
  // Reintentar sale de la propia corrida, no de la estimación: así también funciona tras recargar con ?run=. Sin
  // est_usd no se manda max_usd y el servidor usa su tope por defecto.
  const reintentar = (r: WikiRun) => {
    generar.mutate({ repo_full_name: r.repo_full_name, ...(r.branch ? { ref: r.branch } : {}),
      connection_id: r.repo_full_name === repoConexion ? gh?.id : undefined,
      ...(r.est_usd != null ? { max_usd: topeUsd(r.est_usd) } : {}), force: true }, { onSuccess: (x) => elegir(x.wiki_run_id) });
  };
  // «Regenerar» espera la promesa: ConfirmarEnSitio pinta el resultado o el error en su sitio (L6).
  const regenerar = async () => {
    if (!estimar.data) return;
    const r = await generar.mutateAsync({ repo_full_name: estimar.data.repo_full_name, ...e, max_usd: topeUsd(estimar.data.est.usd), force: true });
    elegir(r.wiki_run_id);
  };

  return (
    <div className="flex flex-col gap-6">
      <BarraModulo titulo="Wiki del repo" descripcion="Tu repo explicado para un directivo: qué es, cómo funciona, sus piezas, el mapa y los riesgos." />

      <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-label="Repositorio">
        {org.puedeEscribir ? (
          <form onSubmit={pedirEstimacion} className="flex flex-col gap-4" noValidate>
            <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
              <CampoTexto id="wiki-repo" etiqueta="Repositorio" valor={repo} onCambio={cambiarRepo} mono placeholder="owner/repo" error={errorRepo}
                ayuda={repo.trim() && !repoValido ? 'Formato owner/repo, o pega la URL del repo en GitHub.'
                  : repoConexion ? 'Por defecto, el repo de tu conexión con GitHub. También puedes escribir uno público.' : 'Escribe un repo público, o conecta GitHub para uno privado.'} />
              <CampoTexto id="wiki-rama" etiqueta="Rama (opcional)" valor={rama} onCambio={setRama} mono placeholder="main" />
            </div>
            <div><BotonAccion variante="principal" tam="grande" icono={Coins} ocupado={estimar.isPending} type="submit">Estimar costo</BotonAccion></div>
            {estimar.isError ? <ErrorBloque error={estimar.error} /> : null}
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">Modo demo: solo lectura. Puedes leer las wikis ya generadas; generar una nueva gasta IA y lo hace un administrador.</p>
        )}
      </section>

      {org.puedeEscribir && estimar.data ? <Estimacion e={estimar.data} ocupado={generar.isPending} alGenerar={lanzar} alRegenerar={regenerar} alVer={elegir}
        anterior={wikiAnterior(historial.data ?? [], estimar.data)} /> : null}
      {generar.isError ? <p role="alert" className="text-sm text-mal">{mensajeDe(generar.error)}</p> : null}

      {run.data && run.data.status !== 'succeeded' ? <Progreso run={run.data} puedeEscribir={org.puedeEscribir} estancada={estancada} alReintentar={() => reintentar(run.data!)} /> : null}
      {(crudo && !runId) || (run.isError && esApiError(run.error) && run.error.status === 404)
        ? <p className="text-[15px] text-muted-foreground">Esta wiki no existe o no es de esta organización.</p>
        : run.isError ? <ErrorBloque error={run.error} onReintentar={() => run.refetch()} /> : null}
      {doc.data ? <Documento d={doc.data} /> : run.data?.status === 'succeeded' && doc.isPending ? <p className="text-texto-3" aria-busy="true">—</p> : null}
      {doc.isError ? <ErrorBloque error={doc.error} onReintentar={() => doc.refetch()} /> : null}

      <section className="flex flex-col gap-3" aria-labelledby="t-historial">
        <h3 id="t-historial" className="text-[17px] font-semibold">Historial{consulta.repo ? <span className="font-mono text-[13px] font-normal text-muted-foreground"> · {consulta.repo}</span> : null}</h3>
        {sinFormato ? <p className="text-sm text-muted-foreground">Escribe el repo como owner/repo (o pega su URL de GitHub) para ver su historial.</p>
          : historial.isError ? <ErrorBloque error={historial.error} onReintentar={() => historial.refetch()} />
          : historial.data ? <Historial runs={historial.data} actual={runId} alElegir={elegir} /> : <p className="text-texto-3">—</p>}
      </section>

      <GuiaModulo id="wiki" />
    </div>
  );
}
