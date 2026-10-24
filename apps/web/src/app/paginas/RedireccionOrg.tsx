// /o/:orgId (S14 §14.4): sin conexiones activas → Conexiones; si no → Resumen.
import { Navigate } from 'react-router';
import { useConexiones } from '@/lib/consultas';
import { useOrg } from '../guardas';

export default function RedireccionOrg() {
  const org = useOrg();
  const q = useConexiones(org.id);
  if (q.isPending) return <div className="text-texto-3" aria-busy="true">—</div>;
  const activas = q.data?.filter((c) => c.status === 'active').length ?? 0;
  return <Navigate to={activas === 0 && org.puedeEscribir ? 'connections' : 'overview'} replace />;
}
