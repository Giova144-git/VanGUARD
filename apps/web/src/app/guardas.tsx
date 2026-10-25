// Guardas de ruta (S14 §14.4): RequireSession, RequireOrg y el contexto de la org actual.
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import type { Me, Role } from '@vanguard/contracts';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { esOrgDeDemo, nextDe, ULTIMA_ORG } from '@/lib/aterrizaje';
import { useMe } from '@/lib/consultas';
import { destinoAlCaducar, esCopiaRecordada } from '@/lib/sandbox';
import { useSesion } from './sesion';
import NoEncontrada from './paginas/NoEncontrada';

export function Cargando() {
  return <div className="flex min-h-svh items-center justify-center text-texto-3" aria-busy="true">—</div>;
}

export function RequireSession({ children }: { children?: ReactNode }) {
  const s = useSesion();
  const loc = useLocation();
  if (s.cargando) return <Cargando />;
  if (!s.activa) return <Navigate to={`/login?next=${encodeURIComponent(nextDe(loc.pathname, loc.search))}`} replace />;
  return children ?? <Outlet />;
}

export type OrgActual = { id: string; name: string; role: Role; is_demo: boolean; sandbox?: boolean; me: Me; puedeEscribir: boolean };

// Escribe todo el que no es viewer, también el invitado dueño de su sandbox: la API decide en cada petición.
export const puedeEscribirEn = (o: { role: Role }) => o.role !== 'viewer';
const OrgCtx = createContext<OrgActual | null>(null);

export function useOrg(): OrgActual {
  const o = useContext(OrgCtx);
  if (!o) throw new Error('useOrg fuera de RequireOrg');
  return o;
}

// Solo para tests (renderToStaticMarkup sin RequireOrg ni red): el mismo contexto con una org dada. La app no lo usa.
export function OrgDePrueba({ org, children }: { org: OrgActual; children: ReactNode }) {
  return <OrgCtx.Provider value={org}>{children}</OrgCtx.Provider>;
}

export function RequireOrg({ children }: { children?: ReactNode }) {
  const { orgId = '' } = useParams();
  const me = useMe();
  useEffect(() => {
    const actual = me.data?.orgs.find((o) => o.id === orgId);   // ULTIMA_ORG solo recuerda orgs propias
    if (actual && !esOrgDeDemo(actual)) try { localStorage.setItem(ULTIMA_ORG, orgId); } catch { /* sin almacenamiento */ }
  }, [me.data, orgId]);
  if (me.isPending) return <Cargando />;
  if (me.isError) return <div className="p-6"><ErrorBloque error={me.error} onReintentar={() => me.refetch()} /></div>;
  const org = me.data.orgs.find((o) => o.id === orgId);
  if (!org) return esCopiaRecordada(orgId) ? <CopiaCaducada org={orgId} /> : <NoEncontrada texto="No tienes acceso a esta organización" />;
  // El viewer ve los botones de escritura, pero deshabilitados con «Modo demo: solo lectura».
  const puedeEscribir = puedeEscribirEn(org);
  return (
    <OrgCtx.Provider value={{ ...org, me: me.data, puedeEscribir }}>
      {children ?? <Outlet />}
    </OrgCtx.Provider>
  );
}

// La copia de la demo de esta pestaña ya no está en /api/me: caducó. Nada de «No tienes acceso»: a preparar otra.
function CopiaCaducada({ org }: { org: string }) {
  const navegar = useNavigate();
  useEffect(() => { const d = destinoAlCaducar(org); if (d) void navegar(d, { replace: true }); }, [org, navegar]);
  return <Cargando />;
}

export const SOLO_LECTURA = 'Modo demo: solo lectura';
