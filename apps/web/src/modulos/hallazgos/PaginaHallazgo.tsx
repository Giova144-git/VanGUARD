// /o/:orgId/findings/:findingId: el mismo DetalleHallazgo a ancho completo (enlace de WhatsApp y del export).
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { useOrg } from '@/app/guardas';
import { DetalleHallazgo } from './DetalleHallazgo';

export default function PaginaHallazgo() {
  const org = useOrg();
  const { findingId = '' } = useParams();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link to={`/o/${org.id}/overview`} className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />Resumen
      </Link>
      <DetalleHallazgo key={findingId} org={org.id} id={findingId} puedeEscribir={org.puedeEscribir} />
    </div>
  );
}
