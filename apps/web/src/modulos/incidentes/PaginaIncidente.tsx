// /o/:orgId/incidents/:incidentId (S14 §14.16), el corazón de la demo: ataque → WhatsApp (< 30 s) → aprobación (botón
// del WhatsApp o código en el sitio) → bloqueo → «Deshacer». Dos columnas 60/40 desde 1280 px; apiladas por debajo.
import { useNavigate, useParams, Link } from 'react-router';
import { ArrowLeft, Bell, BellOff, Eye, MessageCircle, Phone, ShieldHalf } from 'lucide-react';
import type { Channel, IncidentDetail, NotificationPublic } from '@vanguard/contracts';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { BotonGrande } from '@/componentes/vg/BotonGrande';
import { Cronometro } from '@/componentes/vg/Cronometro';
import { ChapaSeveridad, Etiqueta } from '@/componentes/vg/Etiqueta';
import { FichaFila } from '@/componentes/vg/FichaFila';
import { GraficaTrafico, TablaTopIps } from '@/componentes/vg/GraficaTrafico';
import { LineaTiempo } from '@/componentes/vg/LineaTiempo';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import NoEncontrada from '@/app/paginas/NoEncontrada';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { useConexiones, useIncidente, useTrafico } from '@/lib/consultas';
import { esApiError, mensajeDe } from '@/lib/errores';
import { cuando } from '@/lib/formato';
import { useAccionIncidente } from '@/lib/mutaciones';
import { porQueImporta } from '@/lib/reglas-texto';
import { BloquearIp } from './BloquearIp';
import { finDe, hitosDe, restoDe, t0De } from './hitos';
import { ESTADO_INC } from './PaginaIncidentes';
import { BotonSimularWhatsApp } from './Simulacion';

const ICONO: Record<Channel, typeof MessageCircle> = { in_app: Bell, whatsapp: MessageCircle, voice: Phone };
const NOMBRE_CANAL: Record<Channel, string> = { in_app: 'En la app', whatsapp: 'WhatsApp', voice: 'Llamada' };

function estadoAviso(n: NotificationPublic): { texto: string; rol: 'bien' | 'aviso' | 'neutra' | 'mal' } {
  if (n.status === 'skipped_cap') return { texto: 'No enviado: tope por hora', rol: 'aviso' };
  if (n.status === 'failed' && n.error === 'dry_run') return { texto: 'Simulado (fuera de officialvanguard.com)', rol: 'neutra' };
  if (n.status === 'failed') return { texto: 'Falló', rol: 'mal' };
  if (n.status === 'read') return { texto: 'Leído', rol: 'neutra' };
  if (n.status === 'delivered') return { texto: 'Entregado', rol: 'neutra' };
  return { texto: n.status === 'sent' ? 'Enviado' : 'En cola', rol: 'neutra' };
}

function Acciones({ i, org, puedeEscribir }: { i: IncidentDetail; org: string; puedeEscribir: boolean }) {
  const navegar = useNavigate();
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
        : <BotonGrande icono={ShieldHalf} titulo="Activa el Modo blindaje para bloquear desde aquí"
            descripcion="Reconecta Cloudflare con el token de acciones" onClick={() => navegar(`/o/${org}/connections/cloudflare`)} />) : null}
      <BotonSimularWhatsApp org={org} incidentId={i.id} />
    </section>
  );
}

export default function PaginaIncidente() {
  const org = useOrg();
  const { incidentId = '' } = useParams();
  const q = useIncidente(org.id, incidentId);
  const trafico = useTrafico(org.id);
  if (q.isError && esApiError(q.error) && q.error.status === 404) return <NoEncontrada texto="Este incidente no existe o no es de esta organización" />;
  if (q.isError && !q.data) return <ErrorBloque error={q.error} onReintentar={() => q.refetch()} />;
  const i = q.data;
  if (!i) return <p className="text-texto-3" aria-busy="true">—</p>;
  const est = ESTADO_INC[i.status];
  const ip = i.resource.startsWith('ip:') ? i.resource.slice(3) : null;

  return (
    <div className="flex flex-col gap-6">
      <Link to={`/o/${org.id}/incidents`} className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />Incidentes
      </Link>
      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <div className="flex min-w-0 flex-col gap-6">
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <ChapaSeveridad severity={i.severity} />
              <span className="font-mono text-[13px] text-muted-foreground">{i.code}</span>
              <Etiqueta texto={est.texto} rol={est.rol} />
            </div>
            <h2 className="text-[22px] font-semibold">{i.title}</h2>
            {ip ? <p className="font-mono text-[15px]">{ip}</p> : <p className="font-mono text-[13px] text-muted-foreground">{i.resource}</p>}
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
          <section className="flex flex-col gap-3" aria-label="Tráfico">
            <h3 className="text-[17px] font-semibold">Tráfico (5 min)</h3>
            {trafico.data ? <>
              <GraficaTrafico buckets={trafico.data.buckets} />
              <TablaTopIps ips={trafico.data.top_ips} resaltar={ip} />
            </> : trafico.isError ? <ErrorBloque error={trafico.error} onReintentar={() => trafico.refetch()} /> : <div className="h-52 rounded-xl border bg-card" />}
          </section>
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
                  const Icono = ICONO[n.channel];
                  const e = estadoAviso(n);
                  return (
                    <li key={n.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <Icono className="size-4 text-muted-foreground" aria-label={NOMBRE_CANAL[n.channel]} />
                      <span className="font-mono text-[13px]">{n.recipient_masked}</span>
                      <Etiqueta texto={e.texto} rol={e.rol} />
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
                    <span className="font-medium">{a.kind === 'block_ip' ? 'Bloqueo de IP' : a.kind}</span>
                    <span className="font-mono text-[13px]">{a.target}</span>
                    <Etiqueta texto={a.status === 'executed' ? 'Activo' : a.status === 'undone' ? 'Deshecho' : a.status} rol={a.status === 'executed' ? 'bien' : 'neutra'} />
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
