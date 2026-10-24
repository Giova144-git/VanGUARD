// «Revisión automática de código» (asignaciones/revision-codigo.md §6.1): el webhook de GitHub manda cada push a la rama
// vigilada y VanGUARD revisa lo añadido. Bandera: si E45 da 404 (aún sin desplegar), la tarjeta no se pinta (§8.0).
// El secreto `vgw_` del alta (E46) se ve UNA vez: vive en el estado de este componente, la mutación va con gcTime 0 y
// reset() en cuanto llega (lib/mutaciones.ts), y nunca toca storage, la URL ni la caché de consultas.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronDown, ExternalLink, GitCommitHorizontal, GitPullRequest } from 'lucide-react';
import type { CodeReview, CodeReviewConfig, ConnectionPublic } from '@vanguard/contracts';
import { BotonCopiar } from '@/componentes/vg/BotonCopiar';
import { ChapaSeveridad, Etiqueta } from '@/componentes/vg/Etiqueta';
import { Interruptor } from '@/componentes/vg/Interruptor';
import { SectorPlegable } from '@/componentes/vg/SectorPlegable';
import { useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { usePrefsAvisos, useRevisionCodigo } from '@/lib/consultas';
import { esApiError, mensajeDe } from '@/lib/errores';
import { cuando } from '@/lib/formato';
import { esId } from '@/lib/ids';
import { tomarSecreto, useGuardarRevision } from '@/lib/mutaciones';
import { chipAviso, chipHook, chipParcial, chipRevision, textoErrorHook, umbralWhatsapp } from '@/lib/revision';
import { severidad } from '@/lib/severidad';
import { cn } from '@/lib/utils';

const RAPIDO_MS = 180_000;            // 5 s durante 3 min tras montar o volver a la pestaña
const TRAS_ACTIVAR_MS = 600_000;      // y durante 10 min tras activar desde aquí (esperando el ping de GitHub)
const REPO_VALIDO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;   // solo así se arma el enlace a github.com

export function TarjetaRevisionCodigo({ conexion }: { conexion: ConnectionPublic }) {
  const org = useOrg();
  const [params, setParams] = useSearchParams();
  const [rapidoHasta, setRapidoHasta] = useState(() => Date.now() + RAPIDO_MS);
  useEffect(() => {
    const volver = () => { if (!document.hidden) setRapidoHasta((h) => Math.max(h, Date.now() + RAPIDO_MS)); };
    document.addEventListener('visibilitychange', volver);
    return () => document.removeEventListener('visibilitychange', volver);
  }, []);
  const q = useRevisionCodigo(org.id, rapidoHasta);
  const prefs = usePrefsAvisos(org.id);
  const guardar = useGuardarRevision(org.id);
  const [secreto, setSecreto] = useState<string | null>(() => tomarSecreto(org.id));   // un alta de antes de desmontar
  const [error, setError] = useState<string | null>(null);
  const abierta = params.get('revision');

  // ?revision=<id> (el enlace del WhatsApp): la fila abierta baja a la vista en cuanto existe.
  const hayAbierta = !!abierta && !!q.data?.recent.some((r) => r.id === abierta);
  // «Ahora» (encima) puede llegar después y empujarla: se repite unas veces en 1,5 s, salvo que el usuario ya se mueva.
  useEffect(() => {
    if (!hayAbierta || !esId(abierta)) return;
    const bajar = () => document.getElementById(`revision-${abierta}`)?.scrollIntoView({ block: 'center' });
    const ts = [0, 300, 800, 1500].map((ms) => setTimeout(bajar, ms));
    const parar = () => ts.forEach(clearTimeout);
    window.addEventListener('wheel', parar, { once: true, passive: true });
    window.addEventListener('touchstart', parar, { once: true, passive: true });
    return () => { parar(); window.removeEventListener('wheel', parar); window.removeEventListener('touchstart', parar); };
  }, [hayAbierta, abierta]);

  if (q.isError && esApiError(q.error) && q.error.status === 404) return null;
  if (!q.data) return null;   // hasta saber si la ruta existe no se promete nada
  const s = q.data;
  const c = s.config;
  const rama = c?.branch ?? (typeof conexion.meta.default_branch === 'string' ? conexion.meta.default_branch : null);
  const ramaVista = rama ? <bdi dir="ltr" className="font-mono text-foreground">{sinBidi(rama)}</bdi> : 'la rama por defecto';

  const cambiar = (enabled: boolean) => {
    setError(null);
    guardar.mutate({ connection_id: conexion.id, enabled }, {
      onSuccess: () => {
        const s = tomarSecreto(org.id);                        // lo dejó ahí el onSuccess de opcionesGuardarRevision
        if (s) setSecreto(s);
        guardar.reset();                                       // fuera del MutationCache ya (gcTime 0)
        if (enabled) setRapidoHasta(Date.now() + TRAS_ACTIVAR_MS);
      },
      onError: (e) => { setError(mensajeDe(e)); guardar.reset(); },
    });
  };
  // El hallazgo se abre encima sin perder la revisión abierta (al cerrar el panel se vuelve a ella).
  const conHallazgo = (id: string) => { const p = new URLSearchParams(params); p.set('finding', id); return `?${p}`; };
  const alternar = (id: string) => {
    const p = new URLSearchParams(params);
    if (abierta === id) p.delete('revision'); else p.set('revision', id);
    setParams(p, { replace: true });
  };

  return (
    <section id="revision-codigo" className="flex scroll-mt-20 flex-col gap-4 rounded-xl border bg-card p-5" aria-labelledby="t-revision">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="t-revision" className="flex-1 text-[17px] font-semibold">Revisión automática de código</h3>
        <Etiqueta {...chipHook(c ?? { state: 'off', last_event_at: null, last_ping_at: null }, (t) => cuando(t))} />
        {org.puedeEscribir && s.available ? (
          <label className="flex items-center gap-2 text-sm font-medium">
            <Interruptor activo={!!c?.enabled} etiqueta="Revisar cada push" ocupado={guardar.isPending} onCambio={cambiar} />
            Revisar cada push
          </label>
        ) : null}
      </div>
      {/* D1 de Giovanni: los pull requests entran ya (antes, «Pull requests abiertos: próximamente»). */}
      <p className="text-[15px] text-muted-foreground">
        Revisamos cada push y merge a {ramaVista} y cada pull request hacia {ramaVista}.
      </p>
      <p className="text-[15px]">
        Buscamos en lo que se añadió claves y tokens, y archivos .env subidos. Solo te avisamos de lo nuevo. Leemos el cambio con tu
        token de solo lectura y no guardamos tu código.
      </p>
      {s.reason === 'conexion_inactiva'
        ? <p className="text-sm font-medium">La conexión de GitHub no está activa: <Link to={`/o/${org.id}/connections/github`} className="underline underline-offset-4">reconéctala</Link> para revisar los pushes.</p>
        : null}
      <Umbral org={org.id} prefs={prefs.data} puedeEscribir={org.puedeEscribir} />
      {/* Línea reservada: el error de activar aparece sin empujar nada (L7). */}
      <p role="alert" className="min-h-5 text-sm text-mal">{error ?? ''}</p>
      {c?.state === 'error' ? <p className="text-[15px] font-medium text-mal">{textoErrorHook(c.last_error)}</p> : null}
      {org.puedeEscribir && c?.enabled ? <PasosGithub key={c.state === 'connected' ? 'plegado' : 'abierto'} c={c} secreto={secreto} /> : null}
      <Recientes recientes={s.recent} abierta={abierta} alternar={alternar} conHallazgo={conHallazgo} />
    </section>
  );
}

// Los enlaces «Cambiar» y «añade uno en Ajustes» solo para owner y admin: el viewer no puede tocar ni los avisos ni los
// contactos, así que ve el mismo dato en neutro.
function Umbral({ org, prefs, puedeEscribir }: { org: string; prefs: ReturnType<typeof usePrefsAvisos>['data']; puedeEscribir: boolean }) {
  if (!prefs) return null;   // E48 sin desplegar o cargando: sin promesa de aviso
  const u = umbralWhatsapp(prefs);
  if (prefs.whatsapp_ready_contacts === 0) {
    return puedeEscribir
      ? <p className="text-[15px]">Ningún contacto con WhatsApp verificado: <Link to={`/o/${org}/settings`} className="font-medium underline underline-offset-4">añade uno en Ajustes</Link></p>
      : <p className="text-[15px]">Aún no hay contactos con WhatsApp verificado</p>;
  }
  return (
    <p className="text-[15px]">
      {u ? <>Te avisamos por WhatsApp desde <span className="font-semibold">{severidad(u).etiqueta}</span></> : 'No te avisamos por WhatsApp'}
      {puedeEscribir ? <> · <Link to={`/o/${org}/settings#avisos`} className="font-medium underline underline-offset-4">Cambiar</Link></> : null}
    </p>
  );
}

function PasosGithub({ c, secreto }: { c: CodeReviewConfig; secreto: string | null }) {
  const repo = REPO_VALIDO.test(c.repo_full_name) ? c.repo_full_name : null;
  const paso = 'flex flex-col gap-2 border-b px-5 py-3 last:border-b-0';
  return (
    <SectorPlegable titulo="Pasos en GitHub" defaultOpen={c.state !== 'connected'}>
      <ol className="flex flex-col text-[15px]" aria-label="Pasos para crear el webhook en GitHub">
        <li className={paso}>
          <span><span className="font-semibold">1.</span> Abre {repo
            ? <a href={`https://github.com/${repo}/settings/hooks/new`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono underline underline-offset-4">
                github.com/{repo}/settings/hooks/new<ExternalLink className="size-3.5" /></a>
            : 'Settings → Webhooks → Add webhook en tu repositorio'}</span>
        </li>
        <li className={paso}>
          <span><span className="font-semibold">2.</span> <span className="font-medium">Payload URL:</span></span>
          {c.webhook_url ? (
            <span className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 font-mono text-[13px] break-all">{c.webhook_url}</code>
              <BotonCopiar valor={c.webhook_url} />
            </span>
          ) : <span className="text-muted-foreground">La URL solo existe en officialvanguard.com</span>}
        </li>
        <li className={paso}><span><span className="font-semibold">3.</span> <span className="font-medium">Content type:</span> <code className="font-mono">application/json</code></span></li>
        <li className={paso}>
          <span><span className="font-semibold">4.</span> <span className="font-medium">Secret:</span></span>
          {secreto ? (
            <>
              <span className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 font-mono text-[13px] break-all">{secreto}</code>
                <BotonCopiar valor={secreto} />
              </span>
              <span className="text-sm font-medium">Cópialo ahora: no lo volveremos a mostrar</span>
            </>
          ) : <span className="text-muted-foreground">{c.secret_last4 ? <>Termina en ••<span className="font-mono">{sinBidi(c.secret_last4)}</span></> : 'Ya está guardado'}</span>}
        </li>
        <li className={paso}><span><span className="font-semibold">5.</span> <span className="font-medium">Which events…:</span> «Let me select individual events» → marca «Pushes» y «Pull requests»</span></li>
        <li className={paso}><span><span className="font-semibold">6.</span> <span className="font-medium">Active</span> marcado → «Add webhook». GitHub manda un ping y aquí cambia a «Conectada».</span></li>
      </ol>
    </SectorPlegable>
  );
}

function Recientes({ recientes, abierta, alternar, conHallazgo }: {
  recientes: CodeReview[]; abierta: string | null; alternar: (id: string) => void; conHallazgo: (id: string) => string;
}) {
  if (!recientes.length) return <p className="text-[15px] text-muted-foreground">Aún no hay revisiones: llegan con el próximo push.</p>;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[15px] font-semibold">Revisiones recientes</h4>
      <ul className="overflow-hidden rounded-xl border" aria-label="Revisiones recientes">
        {recientes.map((r) => {
          const abiertaEsta = abierta === r.id;
          const chips = [chipRevision(r), chipParcial(r), chipAviso(r.alert)].filter((x) => x !== null);
          return (
            <li key={r.id} id={`revision-${r.id}`} className="scroll-mt-20 border-b last:border-b-0">
              <button type="button" onClick={() => alternar(r.id)} aria-expanded={abiertaEsta} aria-controls={`revision-${r.id}-detalle`}
                className="flex min-h-14 w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
                {r.event === 'pull_request'
                  ? <GitPullRequest className="size-4 text-muted-foreground" aria-label="Pull request" />
                  : <GitCommitHorizontal className="size-4 text-muted-foreground" aria-label="Push" />}
                <span className="font-mono text-[13px]">
                  {r.event === 'pull_request' && r.pr_number ? `PR #${r.pr_number} · ` : ''}<bdi dir="ltr">{sinBidi(r.branch)}</bdi> · {r.head_sha.slice(0, 7)}
                </span>
                <span className="text-[12.5px] text-texto-3">{cuando(r.created_at)}</span>
                <span className="flex flex-1 flex-wrap justify-end gap-2">{chips.map((x) => <Etiqueta key={x.texto} {...x} />)}</span>
                <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', abiertaEsta && 'rotate-180')} aria-hidden />
              </button>
              {abiertaEsta ? <Detalle r={r} conHallazgo={conHallazgo} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Detalle({ r, conHallazgo }: { r: CodeReview; conHallazgo: (id: string) => string }) {
  const pr = r.event === 'pull_request';
  return (
    <div id={`revision-${r.id}-detalle`} className="flex flex-col gap-3 border-t bg-background px-4 py-3">
      {r.findings.length ? (
        <>
          <ul className="flex flex-col gap-2" aria-label="Hallazgos nuevos de esta revisión">
            {r.findings.map((f, i) => (
              <li key={`${f.rule_id}-${f.resource}-${i}`} className="flex flex-wrap items-center gap-2">
                <ChapaSeveridad severity={f.severity} />
                {f.finding_id && esId(f.finding_id)
                  ? <Link to={conHallazgo(f.finding_id)} className="text-[15px] font-medium underline underline-offset-4">{sinBidi(f.title)}</Link>
                  : <span className="text-[15px] font-medium">{sinBidi(f.title)}</span>}
                <span className="font-mono text-[13px] text-muted-foreground break-all"><bdi dir="ltr">{sinBidi(f.resource)}</bdi></span>
              </li>
            ))}
          </ul>
          {/* Un PR no escribe en findings (0013, p_write false): no hay nada que marcar como arreglado. */}
          {pr ? null : <p className="text-sm text-muted-foreground">Estos hallazgos se cierran con “Marcar arreglado”: la auditoría no los cierra sola</p>}
        </>
      ) : <p className="text-sm text-muted-foreground">Sin hallazgos nuevos en este {pr ? 'pull request' : 'push'}</p>}
      {r.alert.voice_pending ? <p className="text-sm text-muted-foreground">
        {r.alert.state === 'sent' && r.alert.delivery !== 'failed' ? 'Llamada: aún no disponible; te avisamos por WhatsApp' : 'Llamada: aún no disponible'}
      </p> : null}
    </div>
  );
}
