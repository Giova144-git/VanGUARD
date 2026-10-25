// Tabla de rutas (S14 §14.4), react-router 7.18.4 en modo data router. El router se crea una vez, fuera del árbol.
// La portada es la única página que no va en lazy: así no arrastra Recharts ni el cascarón (dogfooding de §10).
import { createBrowserRouter, type RouteObject } from 'react-router';
import { conRecarga } from '@/lib/recarga';
import ErrorRuta from './ErrorRuta';
import Inicio from './paginas/Inicio';
import NoEncontrada from './paginas/NoEncontrada';     // estática: ya la importan ErrorRuta y guardas

// conRecarga: si el chunk ya no existe tras un despliegue, recarga una vez en vez de caer en ErrorRuta.
const pagina = (cargar: () => Promise<{ default: React.ComponentType }>) =>
  async () => ({ Component: (await conRecarga(cargar)).default });

const rutas: RouteObject[] = [
  { path: '/', element: <Inicio />, errorElement: <ErrorRuta /> },
  { path: '/login', lazy: pagina(() => import('./paginas/Login')), errorElement: <ErrorRuta /> },
  { path: '/demo', lazy: pagina(() => import('./paginas/Demo')), errorElement: <ErrorRuta /> },
  { path: '/vigia', lazy: pagina(() => import('./paginas/VigiaGaleria')), errorElement: <ErrorRuta /> },
  {
    lazy: pagina(() => import('./paginas/ConSesion')), errorElement: <ErrorRuta />,
    children: [
      { path: '/start', lazy: pagina(() => import('./paginas/CrearOrg')) },
      {
        path: '/o/:orgId', lazy: pagina(() => import('./paginas/ConOrg')), errorElement: <ErrorRuta />,
        children: [
          { index: true, lazy: pagina(() => import('./paginas/RedireccionOrg')) },
          { path: 'overview', lazy: pagina(() => import('@/modulos/resumen/PaginaResumen')), errorElement: <ErrorRuta /> },
          { path: 'connections', lazy: pagina(() => import('@/modulos/conexiones/PaginaConexiones')), errorElement: <ErrorRuta /> },
          { path: 'connections/:provider', lazy: pagina(() => import('@/modulos/conexiones/Asistente')), errorElement: <ErrorRuta /> },
          { path: 'supabase', lazy: pagina(() => import('@/modulos/supabase/PaginaSupabase')), errorElement: <ErrorRuta /> },
          { path: 'cloudflare', lazy: pagina(() => import('@/modulos/cloudflare/PaginaCloudflare')), errorElement: <ErrorRuta /> },
          { path: 'codebase', lazy: pagina(() => import('@/modulos/codebase/PaginaCodebase')), errorElement: <ErrorRuta /> },
          { path: 'audit', lazy: pagina(() => import('@/modulos/auditoria/PaginaAuditoria')), errorElement: <ErrorRuta /> },
          { path: 'audit/:scanId', lazy: pagina(() => import('@/modulos/auditoria/PaginaAuditoria')), errorElement: <ErrorRuta /> },
          { path: 'evolution', lazy: pagina(() => import('@/modulos/evolucion/PaginaEvolucion')), errorElement: <ErrorRuta /> },
          { path: 'incidents', lazy: pagina(() => import('@/modulos/incidentes/PaginaIncidentes')), errorElement: <ErrorRuta /> },
          { path: 'incidents/:incidentId', lazy: pagina(() => import('@/modulos/incidentes/PaginaIncidente')), errorElement: <ErrorRuta /> },
          { path: 'wiki', lazy: pagina(() => import('@/modulos/wiki/PaginaWiki')), errorElement: <ErrorRuta /> },
          { path: 'performance', lazy: pagina(() => import('@/modulos/rendimiento/PaginaRendimiento')), errorElement: <ErrorRuta /> },
          { path: 'export', lazy: pagina(() => import('@/modulos/exportar/PaginaExportar')), errorElement: <ErrorRuta /> },
          { path: 'settings', lazy: pagina(() => import('@/modulos/ajustes/PaginaAjustes')), errorElement: <ErrorRuta /> },
          { path: 'findings/:findingId', lazy: pagina(() => import('@/modulos/hallazgos/PaginaHallazgo')), errorElement: <ErrorRuta /> },
          { path: '*', element: <NoEncontrada /> },
        ],
      },
    ],
  },
  { path: '*', element: <NoEncontrada />, errorElement: <ErrorRuta /> },
];

// Mientras llega el chunk de la primera ruta no se pinta nada (como hasta ahora), pero declarado: sin HydrateFallback
// react-router avisa en consola en cada carga, y es lo primero que ve quien abre DevTools.
const Nada = () => null;
const conEspera = (r: RouteObject): RouteObject =>
  ({ ...(r.lazy ? { HydrateFallback: Nada } : {}), ...r, ...(r.children ? { children: r.children.map(conEspera) } : {}) }) as RouteObject;

export const router = createBrowserRouter(rutas.map(conEspera));
