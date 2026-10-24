// ?finding=<uuid> abre el detalle sobre la página actual (S14 §14.4); la lista de detrás no se mueve.
import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { PanelDetalle } from '@/componentes/vg/PanelDetalle';
import { useOrg } from '@/app/guardas';
import { DetalleHallazgo } from './DetalleHallazgo';

export function DetalleEnPanel() {
  const org = useOrg();
  const [params, setParams] = useSearchParams();
  const id = params.get('finding');
  const cerrar = useCallback(() => {
    setParams((p) => { const n = new URLSearchParams(p); n.delete('finding'); return n; }, { replace: true });
  }, [setParams]);
  if (!id) return null;
  return (
    <PanelDetalle titulo="Hallazgo" onCerrar={cerrar}>
      <DetalleHallazgo key={id} org={org.id} id={id} puedeEscribir={org.puedeEscribir} />
    </PanelDetalle>
  );
}
