// /o/:orgId/incidents/:incidentId (S14 §14.16), el corazón de la demo: ataque → WhatsApp (< 30 s) → aprobación (botón
// del WhatsApp o código en el sitio) → bloqueo → «Deshacer». Dos columnas 60/40 desde 1280 px; apiladas por debajo.
import type { ReactNode } from 'react';
import { useParams, Link } from 'react-router';
import { ArrowLeft, Bell, BellOff, Eye, MessageCircle, Phone, Send } from 'lucide-react';
import type { ActionKind, ActionStatus, Channel, IncidentDetail, NotificationPublic } from '@vanguard/contracts';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { Cronometro } from '@/componentes/vg/Cronometro';
import { ChapaSeveridad, Etiqueta } from '@/componentes/vg/Etiqueta';
import { FichaFila } from '@/componentes/vg/FichaFila';
import { GraficaTrafico, TablaTopIps } from '@/componentes/vg/GraficaTrafico';
import { LineaTiempo } from '@/componentes/vg/LineaTiempo';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import NoEncontrada from '@/app/paginas/NoEncontrada';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { useConexiones, useIncidente, useTrafico } from '@/lib/consultas';
import { esApiError, mensajeDe } from '@/lib/errores';
import { cuando } from '@/lib/formato';
import { esId } from '@/lib/ids';
import { useAccionIncidente } from '@/lib/mutaciones';
import { porQueImporta } from '@/lib/reglas-texto';
import { deMapa } from '@/lib/severidad';
import { ActivarBlindaje } from '@/modulos/conexiones/ActivarBlindaje';
import { BloquearIp } from './BloquearIp';
import { finDe, hitosDe, restoDe, t0De } from './hitos';
import { estadoInc } from './PaginaIncidentes';
import { BotonSimularWhatsApp } from './Simulacion';

// Un canal, tipo o estado fuera de contrato (api() en producción no corta el cuerpo), «__proto__» incluido, sale con icono
// genérico o su texto crudo y neutro (L3), no como TypeError: siempre deMapa, nunca `MAPA[k] ?? respaldo`.
const ICONO: Record<Channel, typeof MessageCircle> = { in_app: Bell, whatsapp: MessageCircle, voice: Phone };
const NOMBRE_CANAL: Record<Channel, string> = { in_app: 'En la app', whatsapp: 'WhatsApp', voice: 'Llamada' };
const TIPO_ACCION: Record<ActionKind, string> = {
  block_ip: 'Bloqueo de IP', unblock_ip: 'Desbloqueo de IP', under_attack_on: 'Under Attack activado',
  under_attack_off: 'Under Attack desactivado', rate_limit: 'Límite de peticiones',
};
const ESTADO_ACCION: Record<ActionStatus, string> = { executed: 'Activo', undone: 'Deshecho', proposed: 'En curso', failed: 'Falló' };
const crudo = (v: unknown) => (typeof v === 'string' && v ? v : '—');

// Sin acción al lado (no hay reenvío), así que todo va en neutro (L3): el texto ya dice qué pasó.
function estadoAviso(n: NotificationPublic): string {
  if (n.status === 'skipped_cap') return 'No enviado: tope por hora';
  if (n.status === 'failed' && n.error === 'dry_run') return 'Simulado (fuera de officialvanguard.com)';
  if (n.status === 'failed') return 'Falló';
  if (n.status === 'read') return 'Leído';
  if (n.status === 'delivered') return 'Entregado';
  return n.status === 'sent' ? 'Enviado' : 'En cola';
}

function Acciones({ i, org, puedeEscribir }: { i: IncidentDetail; org: string; puedeEscribir: boolean }) {
  const accion = useAccionIncidente(org);
  const conexiones = useConexiones(org);
  const blindaje = conexiones.data?.some((c) => c.provider === 'cloudflare' && c.kind === 'action' && c.status === 'active');
  const ejecutada = i.actions.find((a) => a.kind === 'block_ip' && a.status === 'executed');
  const silenciado = i.muted_until && Date.parse(i.muted_until) > Date.now();
  const esIp = i.resource.startsWith('ip:');
  const solo = puedeEscribir ? undefined : SOLO_LECTURA;
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-label="Acciones">
      <div className="flex flex-wrap items-start gap-3">
        {i.status === 'open' ? (
          <BotonAccion variante="principal" tam="grande" icono={Eye} disabled={!!solo} ayuda={solo}
            ocupado={accion.isPending && accion.variables?.que === 'ack'} onClick={() => accion.mutate({ id: i.id, que: 'ack' })}>Lo estoy viendo</BotonAccion>
        ) : null}
        {i.status !== 'resolved' ? (silenciado
          ? <Etiqueta texto={`Silenciado hasta ${cuando(i.muted_until)}`} icono={BellOff} className="mt-3" />
          : <BotonAccion icono={BellOff} tam="grande" disabled={!!solo} ayuda={solo}
              ocupado={accion.isPending && accion.variables?.que === 'mute'} onClick={() => accion.mutate({ id: i.id, que: 'mute' })}>Silenciar 1 h</BotonAccion>) : null}
      </div>
      {accion.isError ? <p role="alert" className="text-sm text-mal">{mensajeDe(accion.error)}</p> : null}
      {esIp ? (blindaje || ejecutada
        ? <BloquearIp key={i.id} org={org} incidentId={i.id} ip={i.resource.slice(3)} ejecutada={ejecutada} puedeEscribir={puedeEscribir} />
        : conexiones.isPending ? <div className="h-14" aria-busy="true" />   // sin saber si hay blindaje: hueco fijo, no el CTA equivocado (L7)
        : <ActivarBlindaje titulo="Activa el Modo blindaje para bloquear desde aquí" />) : null}
      <BotonSimularWhatsApp org={org} incidentId={i.id} />
    </section>
  );
}

// Solo se monta con el incidente cargado: un id inexistente no sondea el tráfico detrás de NoEncontrada.
function Trafico({ org, ip }: { org: string; ip: string | null }) {
  const trafico = useTrafico(org);
  return (
    <section className="flex flex-col gap-3" aria-label="Tráfico">
      <h3 className="text-[17px] font-semibold">Tráfico (5 min)</h3>
      {trafico.data ? <>
        <GraficaTrafico buckets={trafico.data.buckets} />
        <TablaTopIps ips={trafico.data.top_ips} resaltar={ip} />
      </> : trafico.isError ? <ErrorBloque error={trafico.error} onReintentar={() => trafico.refetch()} /> : <div className="h-52 rounded-xl border bg-card" />}
    </section>
  );
}

function Volver({ org }: { org: string }) {
  return (
    <Link to={`/o/${org}/incidents`} className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" />Incidentes
    </Link>
  );
}

const Bloque = ({ c }: { c: string }) => <span className={`rounded-lg bg-muted ${c}`} />;
const Caja = ({ titulo, children }: { titulo: string; children: ReactNode }) => (
  <div className="flex flex-col gap-2 rounded-xl border bg-card p-5"><h3 className="text-[15px] font-semibold">{titulo}</h3>{children}</div>
);

// Carga de un incidente que no está en caché (de A a B con «Ver ahora», por el key): la misma rejilla y alto aproximado
// con bloques, no una línea «—» que colapsa la página y la vuelve a estirar (L7). Sin consultas: solo useIncidente pide.
function Esqueleto({ org }: { org: string }) {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <Volver org={org} />
      <p className="sr-only">Cargando el incidente…</p>
      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]" aria-hidden="true">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2"><Bloque c="h-8 w-24" /><Bloque c="h-5 w-16" /><Bloque c="h-6 w-20" /></div>
            <Bloque c="h-8 w-3/4" />
            <Bloque c="h-5 w-44" />
          </div>
          <div className="flex flex-col gap-1 rounded-xl border bg-card p-5"><Bloque c="h-5 w-40" /><Bloque c="h-15 w-56" /></div>
          <div className="flex flex-col gap-3">
            <h3 className="text-[17px] font-semibold">Línea de tiempo</h3>
            <div className="flex flex-col">{[0, 1, 2, 3, 4, 5].map((k) => <Bloque key={k} c="mb-3 h-11" />)}<Bloque c="h-11 w-40" /></div>
          </div>
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
            <div className="flex flex-wrap gap-3"><Bloque c="h-14 w-48" /><Bloque c="h-14 w-40" /></div>
            <Bloque c="h-14 w-56" />
            <Bloque c="h-14 w-64" />
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-[17px] font-semibold">Tráfico (5 min)</h3>
            <span className="h-52 rounded-xl border bg-muted" />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Caja titulo="Reglas que dispararon"><Bloque c="h-6 w-32" /><Bloque c="h-56 w-full" /></Caja>
          <Caja titulo="Avisos enviados"><Bloque c="h-36 w-full" /></Caja>
          <Caja titulo="Acciones"><Bloque c="h-5 w-full" /></Caja>
          <Caja titulo="Detalles"><Bloque c="h-[21rem] w-full" /></Caja>
        </div>
      </div>
    </div>
  );
}

function Detalle({ incidentId }: { incidentId: string }) {
  const org = useOrg();
  const q = useIncidente(org.id, incidentId);
  if (!esId(incidentId) || (q.isError && esApiError(q.error) && q.error.status === 404)) return <NoEncontrada texto="Este incidente no existe o no es de esta organización" />;
  if (q.isError && !q.data) return <ErrorBloque error={q.error} onReintentar={() => q.refetch()} />;
  const i = q.data;
  if (!i) return <Esqueleto org={org.id} />;
  const est = estadoInc(i.status);
  const ip = i.resource.startsWith('ip:') ? i.resource.slice(3) : null;

  return (
    <div className="flex flex-col gap-6">
      <Volver org={org.id} />
      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <div className="flex min-w-0 flex-col gap-6">
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <ChapaSeveridad severity={i.severity} grande />
              <span className="font-mono text-[13px] text-muted-foreground">{i.code}</span>
              <Etiqueta texto={est.texto} rol={est.rol} />
            </div>
            <h2 className="text-[22px] font-semibold wrap-anywhere">{sinBidi(i.title)}</h2>
            {/* dir="ltr": un <bdi> sin dir vale dir=auto y una primera letra árabe o hebrea reordenaría la ruta o la IP. */}
            {ip ? <p className="font-mono text-[15px]"><bdi dir="ltr">{sinBidi(ip)}</bdi></p>
              : <p className="font-mono text-[13px] text-muted-foreground"><bdi dir="ltr">{sinBidi(i.resource)}</bdi></p>}
          </header>
          <section className="flex flex-col gap-1 rounded-xl border bg-card p-5" aria-label="Cronómetro">
            <span className="text-[12.5px] font-medium text-muted-foreground">{finDe(i) ? 'Del ataque al bloqueo' : 'Desde el primer ataque'}</span>
            <Cronometro desde={t0De(i)} hasta={finDe(i)} />
          </section>
          <section className="flex flex-col gap-3" aria-label="Línea de tiempo">
            <h3 className="text-[17px] font-semibold">Línea de tiempo</h3>
            <LineaTiempo hitos={hitosDe(i)} resto={restoDe(i)} />
          </section>
          <Acciones i={i} org={org.id} puedeEscribir={org.puedeEscribir} />
          <Trafico org={org.id} ip={ip} />
        </div>
        <aside className="flex min-w-0 flex-col gap-6">
          <section className="flex flex-col gap-2 rounded-xl border bg-card p-5" aria-label="Reglas que dispararon">
            <h3 className="text-[15px] font-semibold">Reglas que dispararon</h3>
            {i.rule_ids.map((r) => (
              <div key={r} className="flex flex-col gap-1">
                <Etiqueta texto={r} mono className="w-fit" />
                {porQueImporta(r) ? <p className="text-sm text-muted-foreground">{porQueImporta(r)}</p> : null}
              </div>
            ))}
          </section>
          <section className="flex flex-col gap-2 rounded-xl border bg-card p-5" aria-label="Avisos enviados">
            <h3 className="text-[15px] font-semibold">Avisos enviados</h3>
            {i.notifications.length === 0 ? <p className="text-sm text-muted-foreground">Aún no enviamos avisos.</p> : (
              <ul className="flex flex-col gap-2">
                {i.notifications.map((n) => {
                  const Icono = deMapa(ICONO, n.channel, Send);
                  return (
                    <li key={n.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <Icono className="size-4 text-muted-foreground" aria-label={deMapa(NOMBRE_CANAL, n.channel, 'Otro canal')} />
                      <span className="font-mono text-[13px]">{n.recipient_masked}</span>
                      <Etiqueta texto={estadoAviso(n)} />
                      <span className="ml-auto text-[12.5px] text-texto-3 tabular-nums">{cuando(n.created_at)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-2 rounded-xl border bg-card p-5" aria-label="Acciones registradas">
            <h3 className="text-[15px] font-semibold">Acciones</h3>
            {i.actions.length === 0 ? <p className="text-sm text-muted-foreground">Ninguna todavía.</p> : (
              <ul className="flex flex-col gap-2">
                {i.actions.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{deMapa(TIPO_ACCION, a.kind, crudo(a.kind))}</span>
                    <span className="font-mono text-[13px]"><bdi dir="ltr">{sinBidi(a.target)}</bdi></span>
                    <Etiqueta texto={deMapa(ESTADO_ACCION, a.status, crudo(a.status))} rol={a.status === 'executed' ? 'bien' : 'neutra'} />
                    {a.approval_id ? <span className="text-[12.5px] text-texto-3">aprobado</span> : null}
                    <span className="ml-auto text-[12.5px] text-texto-3 tabular-nums">{cuando(a.created_at)}{a.expires_at ? ` · caduca ${cuando(a.expires_at)}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-2 rounded-xl border bg-card p-5" aria-label="Detalles">
            <h3 className="text-[15px] font-semibold">Detalles</h3>
            {i.suspected_injection ? <Etiqueta rol="aviso" className="h-auto py-1 whitespace-normal"
              texto="La evidencia trae texto que intenta dar órdenes: lo mostramos como dato y la IA no lo obedece" /> : null}
            <FichaFila valor={i.details} rotulo="Dato no confiable, con secretos tapados" />
          </section>
        </aside>
      </div>
    </div>
  );
}

// key por id, como Corrida en PaginaAuditoria: al pasar de un incidente a otro no se pinta el anterior (keepPreviousData)
// bajo la URL del siguiente, con sus botones apuntando al id viejo.
export default function PaginaIncidente() {
  const { incidentId = '' } = useParams();
  return <Detalle key={incidentId} incidentId={incidentId} />;
}
