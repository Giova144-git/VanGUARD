// Módulo Cloudflare (S14 §14.12): tráfico en vivo (la misma gráfica que Incidentes), Modo blindaje y tu zona.
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { GraficaTrafico, TablaTopIps } from '@/componentes/vg/GraficaTrafico';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { BotonRevisar } from '@/componentes/vg/BotonRevisar';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { PantallaModulo } from '@/componentes/vg/PantallaModulo';
import { useOrg } from '@/app/guardas';
import { ActivarBlindaje } from '@/modulos/conexiones/ActivarBlindaje';
import { useConexiones, useIncidentes, useTrafico } from '@/lib/consultas';

export default function PaginaCloudflare() {
  const org = useOrg();
  const cx = useConexiones(org.id);
  const lista = cx.data ?? [];
  const lectura = lista.find((c) => c.provider === 'cloudflare' && c.kind === 'read');
  const blindaje = lista.some((c) => c.provider === 'cloudflare' && c.kind === 'action' && c.status === 'active');
  const ingesta = lista.some((c) => c.provider === 'ingest' && c.status === 'active');
  const zona = typeof lectura?.meta.zone_name === 'string' ? lectura.meta.zone_name : null;
  const plan = typeof lectura?.meta.plan === 'string' ? lectura.meta.plan : null;
  const trafico = useTrafico(org.id);
  const abiertos = useIncidentes(org.id, 'open').data ?? [];
  // «Ver incidente» solo si hay un incidente abierto con resource = 'ip:'+ip; si no, sin acción ni color.
  const verIncidente = (ip: string) => {
    const i = abiertos.find((x) => x.resource === `ip:${ip}`);
    return i ? <Link to={`/o/${org.id}/incidents/${encodeURIComponent(i.id)}`} className="inline-flex h-11 items-center gap-1 rounded-lg border border-info bg-info-relleno px-4 text-sm font-medium text-info">
      Ver incidente<ChevronRight className="size-4" /></Link> : null;
  };
  return (
    <PantallaModulo modulo="cloudflare" proveedor="cloudflare">
      <section className="flex flex-col gap-3" aria-label="Tráfico en vivo">
        <h3 className="text-[17px] font-semibold">Tráfico en vivo (5 min)</h3>
        {ingesta ? null : (
          <Etiqueta className="h-auto w-fit py-1.5 whitespace-normal"
            texto="La detección en vivo necesita el sensor de ingesta de tu app; con solo el token de Cloudflare ves cifras cada 5 min" />
        )}
        {trafico.data ? <>
          <GraficaTrafico buckets={trafico.data.buckets} />
          <TablaTopIps ips={trafico.data.top_ips} accion={verIncidente} />
        </> : trafico.isError ? <ErrorBloque error={trafico.error} onReintentar={() => trafico.refetch()} /> : <div className="h-52 rounded-xl border bg-card" />}
      </section>
      <section className="flex flex-col gap-3" aria-label="Modo blindaje">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[17px] font-semibold">Modo blindaje</h3>
          <Etiqueta texto={cx.isPending ? '—' : blindaje ? 'Activo' : 'No configurado'} rol={blindaje ? 'info' : 'neutra'} />
        </div>
        {/* Mientras cargan las conexiones, un hueco de alto fijo: ni el CTA equivocado ni el salto (L7). */}
        {cx.isPending ? <div className="min-h-16" aria-busy="true" />
          : blindaje ? <p className="text-sm text-muted-foreground">Puedes bloquear una IP desde un incidente o desde el mismo WhatsApp, con simulación previa y «Deshacer».</p>
          : <ActivarBlindaje />}
      </section>
      {zona ? (
        <section className="flex flex-col gap-1" aria-label="Tu zona">
          <h3 className="text-[17px] font-semibold">Tu zona</h3>
          <p className="text-[15px]"><span className="font-mono">{zona}</span>{plan ? <span className="text-muted-foreground"> · plan {plan}</span> : null}</p>
        </section>
      ) : null}
      <BotonRevisar kind="cloudflare" titulo="Revisar Cloudflare ahora" descripcion="Tu zona: tráfico, IPs y configuración" />
    </PantallaModulo>
  );
}
