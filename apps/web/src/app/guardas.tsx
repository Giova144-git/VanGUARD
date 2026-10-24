// Guardas de ruta (S14 §14.4): RequireSession, RequireOrg y el contexto de la org actual.
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation, useParams } from 'react-router';
import type { Me, Role } from '@vanguard/contracts';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { ULTIMA_ORG } from '@/lib/aterrizaje';
import { useMe } from '@/lib/consultas';
import { useSesion } from './sesion';
import NoEncontrada from './paginas/NoEncontrada';

export function Cargando() {
  return <div className="flex min-h-svh items-center justify-center text-texto-3" aria-busy="true">—</div>;
}

export function RequireSession({ children }: { children?: ReactNode }) {
  const s = useSesion();
  const loc = useLocation();
  if (s.cargando) return <Cargando />;
  if (!s.activa) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return children ?? <Outlet />;
}

type OrgActual = { id: string; name: string; role: Role; is_demo: boolean; me: Me; puedeEscribir: boolean };
const OrgCtx = createContext<OrgActual | null>(null);

export function useOrg(): OrgActual {
  const o = useContext(OrgCtx);
  if (!o) throw new Error('useOrg fuera de RequireOrg');
  return o;
}

export function RequireOrg({ children }: { children?: ReactNode }) {
  const { orgId = '' } = useParams();
  const me = useMe();
  useEffect(() => {
    if (me.data?.orgs.some((o) => o.id === orgId)) try { localStorage.setItem(ULTIMA_ORG, orgId); } catch { /* sin almacenamiento */ }
  }, [me.data, orgId]);
  if (me.isPending) return <Cargando />;
  if (me.isError) return <div className="p-6"><ErrorBloque error={me.error} onReintentar={() => me.refetch()} /></div>;
  const org = me.data.orgs.find((o) => o.id === orgId);
  if (!org) return <NoEncontrada texto="No tienes acceso a esta organización" />;
  // El viewer y el anónimo ven los botones de escritura, pero deshabilitados con «Modo demo: solo lectura».
  const puedeEscribir = org.role !== 'viewer' && !me.data.user.is_anonymous;
  return (
    <OrgCtx.Provider value={{ ...org, me: me.data, puedeEscribir }}>
      {children ?? <Outlet />}
    </OrgCtx.Provider>
  );
}

export const SOLO_LECTURA = 'Modo demo: solo lectura';
