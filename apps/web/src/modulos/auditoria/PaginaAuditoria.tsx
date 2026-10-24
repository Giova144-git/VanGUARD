// /o/:orgId/audit[/:scanId] (S14 §14.14). Los cambios de scan_runs llegan por Realtime y useScan consulta de respaldo
// cada 10 s mientras queued|running. El puntaje se pinta en cuanto `score` no es null, aunque siga `running`.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ChevronRight, KeyRound, ShieldCheck } from 'lucide-react';
import type { Finding, Module, ScanRun } from '@vanguard/contracts';
import { BarraModulo } from '@/componentes/vg/BarraModulo';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { ChapaSeveridad, Etiqueta } from '@/componentes/vg/Etiqueta';
import { GuiaModulo } from '@/componentes/vg/GuiaModulo';
import { PuntajeBlindaje } from '@/componentes/vg/PuntajeBlindaje';
import { PuntoEstado } from '@/componentes/vg/PuntoEstado';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { DetalleEnPanel } from '@/modulos/hallazgos/DetalleEnPanel';
import { useHallazgos, useOverview, useScan } from '@/lib/consultas';
import { esApiError, mensajeDe } from '@/lib/errores';
import { cronometro, cuando } from '@/lib/formato';
import { useLanzarScan } from '@/lib/mutaciones';
import { ESTADO_SCAN, PINTA_PASO, TEXTO_PASO, estadoPaso } from './pasos';

const ORDEN_SEV = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
const PROVEEDOR: Partial<Record<Module, string>> = { supabase: 'supabase', cloudflare: 'cloudflare', codebase: 'github' };

function useLanzarYNavegar() {
  const org = useOrg();
  const navegar = useNavigate();
  const lanzar = useLanzarScan(org.id);
  const [error, setError] = useState<string | null>(null);
  const auditar = () => {
    setError(null);
    lanzar.mutate({ kind: 'full_audit' }, {
      onSuccess: (r) => navegar(`/o/${org.id}/audit/${r.scan_run_id}`),
      onError: (e) => {
        const enCurso = esApiError(e) && e.code === 'conflict' && typeof e.details?.scan_run_id === 'string' ? e.details.scan_run_id : null;
        if (enCurso) navegar(`/o/${org.id}/audit/${enCurso}`); else setError(mensajeDe(e));
      },
    });
  };
  return { auditar, ocupado: lanzar.isPending, error };
}

function Lanzar() {
  const org = useOrg();
  const overview = useOverview(org.id);
  const { auditar, ocupado, error } = useLanzarYNavegar();
  const ultima = overview.data?.last_scan;
  return (
    <div className="flex flex-col gap-6">
      <BarraModulo titulo="Auditoría" descripcion="Revisa todo el ecosistema con un botón." />
      <section className="flex flex-col items-start gap-3 rounded-xl border bg-card p-5">
        <BotonAccion variante="marca" tam="grande" icono={ShieldCheck} onClick={auditar} ocupado={ocupado}
          disabled={!org.puedeEscribir} ayuda={SOLO_LECTURA}>Auditar todo</BotonAccion>
        <p className="text-[15px] text-muted-foreground">Revisamos Supabase, Cloudflare y tu repo, y Claude resume lo más urgente. Tarda unos minutos.</p>
        {error ? <p role="alert" className="text-sm text-mal">{error}{ultima ? <> · <Link className="underline" to={`/o/${org.id}/audit/${ultima.id}`}>Mira la última</Link></> : null}</p> : null}
        {ultima ? <Link to={`/o/${org.id}/audit/${ultima.id}`} className="text-sm font-medium text-info underline underline-offset-4">Ver la última auditoría ({cuando(ultima.finished_at)})</Link> : null}
      </section>
      <GuiaModulo id="audit" />
    </div>
  );
}

function Transcurrido({ run }: { run: ScanRun }) {
  const corriendo = run.status === 'queued' || run.status === 'running';
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => { if (!corriendo) return; const t = setInterval(() => setAhora(Date.now()), 1000); return () => clearInterval(t); }, [corriendo]);
  if (!run.started_at) return <span className="font-mono tabular-nums text-texto-3">00:00</span>;
  const fin = run.finished_at ? new Date(run.finished_at).getTime() : ahora;
  return <span className="font-mono tabular-nums">{cronometro(fin - new Date(run.started_at).getTime())}</span>;
}

function Pasos({ run }: { run: ScanRun }) {
  const org = useOrg();
  return (
    <ol className="overflow-hidden rounded-xl border bg-card" aria-label="Pasos de la auditoría">
      {run.steps.map((s) => {
        const t = TEXTO_PASO[s.name];
        const e = estadoPaso(run, s);
        const p = PINTA_PASO[e];
        const prov = t.modulo ? PROVEEDOR[t.modulo] : undefined;
        return (
          <li key={s.name} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0">
            <PuntoEstado rol={p.rol} hueco={p.hueco} girando={p.girando} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-medium">{t.nombre}{s.findings != null && e === 'hecho' ? <span className="text-muted-foreground"> · {s.findings} hallazgos</span> : null}</span>
              <span className="text-[12.5px] text-texto-3">{t.detalle}</span>
            </div>
            <span className="text-sm text-muted-foreground">{p.texto}</span>
            {e === 'sin_mirar' && prov ? <Link to={`/o/${org.id}/connections/${prov}`} className="inline-flex items-center gap-1 text-sm font-medium text-info underline underline-offset-4"><KeyRound className="size-3.5" />Sin conexión · Conectar</Link> : null}
          </li>
        );
      })}
    </ol>
  );
}

function Resumen({ run, porId }: { run: ScanRun; porId: Map<string, Finding> }) {
  const s = run.summary;
  if (!s) return <p className="rounded-xl border bg-card px-4 py-4 text-[15px] text-muted-foreground">Resumen con IA en pausa: los hallazgos están completos.</p>;
  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-label="Resumen">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-[17px] font-semibold">Resumen</h3>
        {s.model === 'template' ? <Etiqueta texto="Plantilla · IA en pausa" rol="aviso" /> : null}
        {s.suspected_injection ? <Etiqueta texto="Filtramos instrucciones sospechosas" rol="aviso" /> : null}
      </div>
      {s.resumen.split('\n').filter(Boolean).map((p, i) => <p key={i} className="text-[15px] leading-relaxed">{p}</p>)}
      {s.top.length ? <>
        <h4 className="text-[15px] font-semibold">Lo más urgente</h4>
        <ol className="flex flex-col gap-2">
          {s.top.map((t) => (
            <li key={t.finding_id} className="flex flex-col gap-0.5">
              <Link to={`?finding=${t.finding_id}`} className="inline-flex w-fit items-center gap-1 text-[15px] font-medium text-info underline underline-offset-4">
                {porId.get(t.finding_id)?.title ?? 'Ver hallazgo'}<ChevronRight className="size-4" /></Link>
              <span className="text-sm text-muted-foreground">{t.por_que}</span>
            </li>
          ))}
        </ol>
      </> : null}
      {s.relaciones.length ? <>
        <h4 className="text-[15px] font-semibold">Cómo se relacionan</h4>
        <ul className="flex flex-col gap-3">
          {s.relaciones.map((r, i) => (
            <li key={i} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap gap-1.5">{r.finding_ids.map((id) => (
                <Link key={id} to={`?finding=${id}`} className="inline-flex h-6 items-center rounded-lg border px-2 text-[12.5px] font-medium hover:bg-muted">{porId.get(id)?.rule_id ?? 'hallazgo'}</Link>
              ))}</div>
              <span className="text-sm text-muted-foreground">{r.explicacion}</span>
            </li>
          ))}
        </ul>
      </> : null}
      {s.model === 'template' ? null : <p className="text-[12.5px] text-texto-3">Redactado por <span className="font-mono">{s.model}</span></p>}
    </section>
  );
}

function Corrida({ id }: { id: string }) {
  const org = useOrg();
  const q = useScan(org.id, id);
  const overview = useOverview(org.id);
  const hallazgos = useHallazgos(org.id, { status: 'open' });
  const { auditar, ocupado, error } = useLanzarYNavegar();
  const porId = useMemo(() => new Map((hallazgos.data ?? []).map((f) => [f.id, f])), [hallazgos.data]);
  const run = q.data;
  if (q.isError && !run) return <ErrorBloque error={q.error} onReintentar={() => q.refetch()} />;
  if (!run) return <p className="text-texto-3" aria-busy="true">—</p>;
  const est = ESTADO_SCAN[run.status];
  const actual = run.step && run.step in TEXTO_PASO ? TEXTO_PASO[run.step as keyof typeof TEXTO_PASO].nombre : run.step;
  const terminada = run.status === 'succeeded';
  const ordenados = [...(hallazgos.data ?? [])].sort((a, b) => ORDEN_SEV[a.severity] - ORDEN_SEV[b.severity]);

  return (
    <div className="flex flex-col gap-6">
      <BarraModulo titulo="Auditoría" descripcion={`Lanzada ${cuando(run.created_at)}`} extra={<Etiqueta texto={est.texto} rol={est.rol} />} />
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-label="Progreso">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="font-medium">{terminada ? 'Auditoría terminada' : actual ? `Paso actual: ${actual}` : 'Preparando…'}</span>
          <span className="text-muted-foreground">Tiempo: <Transcurrido run={run} /></span>
          <span className="ml-auto font-mono tabular-nums">{run.progress} %</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={run.progress} aria-label="Progreso de la auditoría">
          <div className="h-full bg-info transition-[width]" style={{ width: `${run.progress}%` }} />
        </div>
        <p className="sr-only" aria-live="polite">{actual ? `Paso actual: ${actual}` : ''} {est.texto}</p>
      </section>
      {run.score != null && run.coverage ? (
        // La banda la decide el servidor (L1): la de la corrida; si es vieja y no la trae, la del overview si es esta misma; si no, neutra.
        <section className="rounded-xl border bg-card p-5"><PuntajeBlindaje score={run.score}
          band={run.band ?? (overview.data?.last_scan?.id === run.id ? overview.data.band : null)}
          coverage={run.coverage} enlaceConectar={`/o/${org.id}/connections`} /></section>
      ) : null}
      {run.status === 'failed' ? (
        <div className="flex flex-col gap-3">
          <ErrorBloque error={new Error(run.error ?? 'La auditoría falló')} />
          <BotonAccion variante="principal" tam="grande" onClick={auditar} ocupado={ocupado} disabled={!org.puedeEscribir} ayuda={SOLO_LECTURA}>Reintentar auditoría</BotonAccion>
          {error ? <p role="alert" className="text-sm text-mal">{error}</p> : null}
        </div>
      ) : null}
      <Pasos run={run} />
      {terminada ? <Resumen run={run} porId={porId} /> : null}
      {terminada && ordenados.length ? (
        <section className="flex flex-col gap-3" aria-labelledby="hallazgos-abiertos">
          <h3 id="hallazgos-abiertos" className="text-[17px] font-semibold">Hallazgos abiertos</h3>
          <ul className="overflow-hidden rounded-xl border bg-card">
            {ordenados.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0">
                <ChapaSeveridad severity={f.severity} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[15px] font-medium">{f.title}</span>
                  <span className="truncate font-mono text-[13px] text-muted-foreground">{f.resource}</span>
                </div>
                <Link to={`?finding=${f.id}`} className="inline-flex h-11 items-center gap-1 rounded-lg border border-info bg-info-relleno px-4 text-sm font-medium text-info hover:bg-info/15">Ver y corregir<ChevronRight className="size-4" /></Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <DetalleEnPanel />
    </div>
  );
}

export default function PaginaAuditoria() {
  const { scanId } = useParams();
  return scanId ? <Corrida key={scanId} id={scanId} /> : <Lanzar />;
}
