// /o/:orgId/overview (S14 §14.11). Orden fijo: barra → puntaje + «Auditar todo» → barra por severidad → cifras →
// «Ahora» → tarjetas por vertical. La API decide (L1): aquí no se recuenta nada, solo se pinta `overview`.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronRight, Cloud, Database, GitBranch, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { AhoraItem, ConnectionPublic, Module } from '@vanguard/contracts';
import { BarraModulo } from '@/componentes/vg/BarraModulo';
import { BarraSegmentada } from '@/componentes/vg/BarraSegmentada';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { BotonGrande } from '@/componentes/vg/BotonGrande';
import { Cifra, FilaCifras } from '@/componentes/vg/Cifra';
import { ChapaSeveridad, Etiqueta } from '@/componentes/vg/Etiqueta';
import { ChipRepo } from '@/componentes/vg/ChipRepo';
import { GuiaModulo } from '@/componentes/vg/GuiaModulo';
import { MarcasContador } from '@/componentes/vg/MarcasContador';
import { PuntajeBlindaje } from '@/componentes/vg/PuntajeBlindaje';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { chapaEstado, chapaGithub } from '@/modulos/conexiones/TarjetaConexion';
import { DetalleEnPanel } from '@/modulos/hallazgos/DetalleEnPanel';
import { BotonEnviarAMiIA, EstadoEnvioIA } from '@/modulos/hallazgos/EnviarAMiIA';
import { DesdeAnterior } from '@/modulos/evolucion/DesdeAnterior';
import { useConexiones, useEnvioIA, useEstadoModulo, useOverview } from '@/lib/consultas';
import { repoParaArreglar } from '@/lib/mcp';
import { esApiError, mensajeDe } from '@/lib/errores';
import { cuando } from '@/lib/formato';
import { useLanzarScan } from '@/lib/mutaciones';
import { entradaNav } from '@/lib/nav';
import { deMapa } from '@/lib/severidad';
import { sinBidi } from '@/lib/bidi';
import { reposGithub, useRepoDeConexion } from '@/lib/repos';

// Un módulo de overview.ahora fuera de contrato (o «__proto__») sale «—» neutro: deMapa, no NOMBRE[k].
const NOMBRE: Record<Module, string> = { supabase: 'Supabase', cloudflare: 'Cloudflare', codebase: 'Codebase', performance: 'Rendimiento' };

// `repo`: el de su conexión, si la org tiene 2 o más (varias-codebases §6.4); los incidentes no llevan.
function FilaAhora({ item, org, repo }: { item: AhoraItem; org: string; repo: string | null }) {
  const id = encodeURIComponent(item.id);
  const href = item.kind === 'incident' ? `/o/${org}/incidents/${id}` : `?finding=${id}`;   // el detalle se abre encima
  // «Enviar a mi IA» en la fila: con un envío abierto, su distintivo en lugar del botón.
  const { puedeEscribir } = useOrg();
  const conexiones = useConexiones(org);
  const envio = useEnvioIA(org, item.kind === 'finding' ? item.id : null);
  const abierto = envio?.status === 'enviado' || envio?.status === 'arreglando';
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3 last:border-b-0">
      <Etiqueta texto={deMapa(NOMBRE, item.module, '—')} />
      <ChapaSeveridad severity={item.severity} />
      <ChipRepo repo={repo} />
      <div className="flex min-w-0 flex-1 basis-full flex-col sm:basis-auto" title={item.rule_id}>
        <span className="text-[15px] font-medium wrap-anywhere">{sinBidi(item.title)}</span>
        <span className="truncate font-mono text-[13px] text-muted-foreground"><bdi dir="ltr">{sinBidi(item.resource)}</bdi></span>
      </div>
      {item.kind === 'finding' ? (abierto ? <EstadoEnvioIA envio={envio} />
        : <BotonEnviarAMiIA org={org} findingId={item.id} repo={repoParaArreglar(item.connection_id ?? null, conexiones.data)} puedeEscribir={puedeEscribir} compacto />) : null}
      <Link to={href} className="inline-flex h-11 items-center gap-1 rounded-full border border-foreground px-4 font-mono text-[13px] font-medium uppercase tracking-[0.06em] text-foreground hover:bg-muted">
        {item.kind === 'incident' ? 'Ver incidente' : 'Ver y corregir'}<ChevronRight className="size-4" />
      </Link>
    </li>
  );
}

function TarjetaVertical({ org, modulo, proveedor, icono: Icono, conexiones, puedeEscribir }: {
  org: string; modulo: Module; proveedor: 'supabase' | 'cloudflare' | 'github'; icono: LucideIcon; conexiones: ConnectionPublic[] | undefined;
  puedeEscribir: boolean;
}) {
  const navegar = useNavigate();
  const estado = useEstadoModulo(org, modulo);
  const c = conexiones?.find((x) => x.provider === proveedor && x.kind === 'read');
  const e = entradaNav(modulo)!;
  // Codebase con varios repos (varias-codebases §6.1): «N repos» o el peor estado, con la regla de PantallaModulo.
  if (conexiones && !c) return (
    // El viewer no puede conectar nada: el botón va apagado con su motivo, como en PantallaModulo.
    <BotonGrande icono={Icono} titulo={`Conectar ${NOMBRE[modulo]}`} descripcion={e.descripcion}
      deshabilitado={puedeEscribir ? undefined : SOLO_LECTURA} onClick={() => navegar(`/o/${org}/connections/${proveedor}`)} />
  );
  const chapa = proveedor === 'github' ? chapaGithub(reposGithub(conexiones)) : c ? chapaEstado(c) : null;
  // Cloudflare conectado por URL (cloudflare-por-url.md): «Cloudflare · sitio» y, sin token de cuenta, «solo HTTP».
  // Sale del meta de la conexión (E7): Coverage del contrato no trae detail.
  const sitio = proveedor === 'cloudflare' && c?.meta.mode === 'url';
  return (
    // La chapa («Conectado · probado 24-10 17:41») va en su propia fila: en 3 columnas (lg, ~318 px) no cabe al lado del
    // nombre, el contador y «Abrir», y partida en la fila de 24 px se montaba encima del nombre.
    <Link to={`/o/${org}/${modulo}`} className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-3 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground"><Icono className="size-6" strokeWidth={1.5} /></span>
      <span className="min-w-0 flex-1 text-base font-semibold">{sitio ? 'Cloudflare · sitio' : NOMBRE[modulo]}</span>
      <MarcasContador contador={estado.data?.contador} grande />
      <span className="text-sm font-medium text-info">Abrir</span>
      <span className="flex basis-full">
        {chapa ? <Etiqueta texto={chapa.texto} rol={chapa.rol} className="h-auto min-h-6 w-fit max-w-full py-1 whitespace-normal" /> : <span className="text-texto-3">—</span>}
      </span>
      {sitio && c.meta.config_read !== true ? <span className="basis-full text-[12.5px] text-muted-foreground">Solo HTTP: sin token de cuenta no leemos la configuración del proyecto</span> : null}
    </Link>
  );
}

export default function PaginaResumen() {
  const org = useOrg();
  const navegar = useNavigate();
  const q = useOverview(org.id);
  const conexiones = useConexiones(org.id);
  const repoDe = useRepoDeConexion(org.id);
  const lanzar = useLanzarScan(org.id);
  const [errorAuditar, setErrorAuditar] = useState<string | null>(null);
  const o = q.data;
  const e = entradaNav('overview')!;
  // «24-10 22:35» no cabe en la cifra: la hora va de valor y la fecha, si no es de hoy, de sub.
  const [diaAud, horaAud] = o?.last_scan ? cuando(o.last_scan.finished_at).split(' ') : [];

  const auditar = () => {
    setErrorAuditar(null);
    lanzar.mutate({ kind: 'full_audit' }, {
      onSuccess: (r) => navegar(`/o/${org.id}/audit/${encodeURIComponent(r.scan_run_id)}`),
      onError: (err) => {
        const enCurso = esApiError(err) && err.code === 'conflict' && typeof err.details?.scan_run_id === 'string' ? err.details.scan_run_id : null;
        if (enCurso) navegar(`/o/${org.id}/audit/${encodeURIComponent(enCurso)}`);   // ya hay una del mismo tipo corriendo
        else setErrorAuditar(mensajeDe(err));                               // 429 budget_exceeded: el mensaje del servidor
      },
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <BarraModulo titulo="Resumen" descripcion={e.descripcion}
        extra={q.dataUpdatedAt ? <span className={`text-[12.5px] tabular-nums ${q.isError ? 'text-mal' : 'text-texto-3'}`}>revisado {cuando(q.dataUpdatedAt)}</span> : null} />
      {q.isError ? <ErrorBloque error={q.error} onReintentar={() => q.refetch()} /> : null}

      <section className="flex flex-wrap items-end justify-between gap-6 rounded-xl border bg-card p-5" aria-label="Puntaje">
        {/* Sin `o` pinta la misma estructura con «—»: la sección no crece al llegar el dato (L7). */}
        <PuntajeBlindaje score={o?.score} band={o?.band} coverage={o?.coverage} enlaceConectar={org.puedeEscribir ? `/o/${org.id}/connections` : undefined} />
        <div className="flex flex-col items-start gap-2">
          <BotonAccion variante="marca" tam="grande" icono={ShieldCheck} onClick={auditar} ocupado={lanzar.isPending}
            disabled={!org.puedeEscribir} ayuda={SOLO_LECTURA} data-info="auditar-todo">Auditar todo</BotonAccion>
          {errorAuditar ? <span role="alert" className="max-w-xs text-sm text-mal">{errorAuditar}</span> : null}
          {o?.last_scan ? (
            <span className="text-[12.5px] text-texto-3">Última auditoría {cuando(o.last_scan.finished_at)} ·{' '}
              <Link to={`/o/${org.id}/audit/${encodeURIComponent(o.last_scan.id)}`} className="font-medium text-foreground underline underline-offset-4">Ver</Link></span>
          ) : null}
          <DesdeAnterior org={org.id} ultima={o?.last_scan ?? null} />
        </div>
      </section>

      <BarraSegmentada data-info="barra-severidad" tramos={[
        { etiqueta: 'Crítica', n: o?.counts.critical ?? null, rol: 'mal', fuerte: true }, { etiqueta: 'Alta', n: o?.counts.high ?? null, rol: 'mal' },
        { etiqueta: 'Media', n: o?.counts.medium ?? null, rol: 'aviso' }, { etiqueta: 'Baja', n: o?.counts.low ?? null, rol: 'cola' },
      ]} />

      <FilaCifras>
        <Cifra data-info="cifra-criticos" etiqueta="Críticos abiertos" n={o?.counts.critical ?? null} rol="mal" href={o?.counts.critical ? '#ahora' : undefined} />
        <Cifra data-info="cifra-altos" etiqueta="Altos" n={o?.counts.high ?? null} rol="mal" href={o?.counts.high ? '#ahora' : undefined} />
        <Cifra data-info="cifra-incidentes" etiqueta="Incidentes abiertos" n={o?.open_incidents ?? null} rol="mal" href={o?.open_incidents ? `/o/${org.id}/incidents` : undefined} />
        <Cifra data-info="cifra-fuentes" etiqueta="Fuentes" n={o?.coverage.seen ?? null} de={o?.coverage.total}
          rol={o && o.coverage.seen === o.coverage.total ? 'bien' : 'neutra'} />
        <Cifra data-info="cifra-ultima-auditoria" etiqueta="Última auditoría" n={o?.last_scan ? 1 : null} valor={horaAud ?? diaAud} sub={horaAud ? diaAud : undefined} />
      </FilaCifras>

      <section id="ahora" className="flex flex-col gap-3 scroll-mt-20" aria-labelledby="titulo-ahora">
        <h3 id="titulo-ahora" className="text-[17px] font-semibold" data-info="ahora">Ahora</h3>
        {!o ? <div className="rounded-xl border bg-card px-4 py-6 text-texto-3">—</div>
          : o.ahora.length === 0
            ? <div className="rounded-xl border bg-card px-4 py-6 text-[15px] text-muted-foreground">0 ✓ Nada que atender · revisado {cuando(q.dataUpdatedAt)}</div>
            : <ul className="overflow-hidden rounded-xl border bg-card">{o.ahora.map((a) => <FilaAhora key={`${a.kind}-${a.id}`} item={a} org={org.id} repo={a.kind === 'finding' ? repoDe(a.connection_id) : null} />)}</ul>}
      </section>

      <section className="flex flex-col gap-3" aria-label="Tu ecosistema">
        <h3 className="text-[17px] font-semibold">Tu ecosistema</h3>
        <div className="grid gap-3 lg:grid-cols-3">
          <TarjetaVertical org={org.id} modulo="supabase" proveedor="supabase" icono={Database} conexiones={conexiones.data} puedeEscribir={org.puedeEscribir} />
          <TarjetaVertical org={org.id} modulo="cloudflare" proveedor="cloudflare" icono={Cloud} conexiones={conexiones.data} puedeEscribir={org.puedeEscribir} />
          <TarjetaVertical org={org.id} modulo="codebase" proveedor="github" icono={GitBranch} conexiones={conexiones.data} puedeEscribir={org.puedeEscribir} />
        </div>
      </section>

      <GuiaModulo id="overview" />
      <DetalleEnPanel />
    </div>
  );
}
