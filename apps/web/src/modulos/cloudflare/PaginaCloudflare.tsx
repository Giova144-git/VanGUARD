// Módulo Cloudflare (S14 §14.12). «Tráfico en vivo» con la gráfica llega con Incidentes (hito 5), que la comparte.
import { useNavigate } from 'react-router';
import { ShieldHalf } from 'lucide-react';
import { BotonGrande } from '@/componentes/vg/BotonGrande';
import { BotonRevisar } from '@/componentes/vg/BotonRevisar';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { PantallaModulo } from '@/componentes/vg/PantallaModulo';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { useConexiones } from '@/lib/consultas';

export default function PaginaCloudflare() {
  const org = useOrg();
  const navegar = useNavigate();
  const lista = useConexiones(org.id).data ?? [];
  const lectura = lista.find((c) => c.provider === 'cloudflare' && c.kind === 'read');
  const blindaje = lista.some((c) => c.provider === 'cloudflare' && c.kind === 'action' && c.status === 'active');
  const ingesta = lista.some((c) => c.provider === 'ingest' && c.status === 'active');
  const zona = typeof lectura?.meta.zone_name === 'string' ? lectura.meta.zone_name : null;
  const plan = typeof lectura?.meta.plan === 'string' ? lectura.meta.plan : null;
  return (
    <PantallaModulo modulo="cloudflare" proveedor="cloudflare">
      {ingesta ? null : (
        <Etiqueta className="h-auto w-fit py-1.5 whitespace-normal"
          texto="La detección en vivo necesita el sensor de ingesta de tu app; con solo el token de Cloudflare ves cifras cada 5 min" />
      )}
      <section className="flex flex-col gap-3" aria-label="Modo blindaje">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[17px] font-semibold">Modo blindaje</h3>
          <Etiqueta texto={blindaje ? 'Activo' : 'No configurado'} rol={blindaje ? 'info' : 'neutra'} />
        </div>
        {blindaje ? <p className="text-sm text-muted-foreground">Puedes bloquear una IP desde un incidente o desde el mismo WhatsApp, con simulación previa y «Deshacer».</p>
          : <BotonGrande icono={ShieldHalf} titulo="Activar modo blindaje" descripcion="Reconecta Cloudflare con el token de lectura y el de acciones"
              deshabilitado={org.puedeEscribir ? undefined : SOLO_LECTURA} onClick={() => navegar(`/o/${org.id}/connections/cloudflare`)} />}
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
