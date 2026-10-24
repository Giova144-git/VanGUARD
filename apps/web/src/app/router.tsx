// Tabla de rutas (S14 §14.4), react-router 7.18.4 en modo data router. El router se crea una vez, fuera del árbol.
// La portada es la única página que no va en lazy: así no arrastra Recharts ni el cascarón (dogfooding de §10).
import { createBrowserRouter, type RouteObject } from 'react-router';
import type { IdNav } from '@/lib/nav';
import ErrorRuta from './ErrorRuta';
import Inicio from './paginas/Inicio';
import NoEncontrada from './paginas/NoEncontrada';     // estática: ya la importan ErrorRuta y guardas

const pagina = (cargar: () => Promise<{ default: React.ComponentType }>) =>
  async () => ({ Component: (await cargar()).default });

// Páginas de módulo que llegan en hitos siguientes (asignación del ORQUESTADOR, S14 §14.20).
const EN_CAMINO: [string, IdNav, string][] = [
  ['overview', 'overview', 'el hito 3 (Resumen)'],
  ['connections', 'connections', 'el hito 2 (Conexiones)'],
  ['connections/:provider', 'connections', 'el hito 2 (Conexiones)'],
  ['supabase', 'supabase', 'el hito 4 (PantallaModulo)'],
  ['cloudflare', 'cloudflare', 'el hito 4 (PantallaModulo)'],
  ['codebase', 'codebase', 'el hito 4 (PantallaModulo)'],
  ['performance', 'performance', 'el hito 7 (Rendimiento)'],
  ['audit', 'audit', 'el hito 4 (Auditoría)'],
  ['audit/:scanId', 'audit', 'el hito 4 (Auditoría)'],
  ['findings/:findingId', 'overview', 'el hito 4 (detalle de hallazgo)'],
  ['incidents', 'incidents', 'el hito 5 (Incidentes)'],
  ['incidents/:incidentId', 'incidents', 'el hito 5 (Incidentes)'],
  ['export', 'export', 'el hito 6 (Exportar)'],
  ['settings', 'settings', 'el hito 6 (Ajustes)'],
];

const rutas: RouteObject[] = [
  { path: '/', element: <Inicio />, errorElement: <ErrorRuta /> },
  { path: '/login', lazy: pagina(() => import('./paginas/Login')), errorElement: <ErrorRuta /> },
  { path: '/demo', lazy: pagina(() => import('./paginas/Demo')), errorElement: <ErrorRuta /> },
  {
    lazy: pagina(() => import('./paginas/ConSesion')), errorElement: <ErrorRuta />,
    children: [
      { path: '/start', lazy: pagina(() => import('./paginas/CrearOrg')) },
      {
        path: '/o/:orgId', lazy: pagina(() => import('./paginas/ConOrg')), errorElement: <ErrorRuta />,
        children: [
          { index: true, lazy: pagina(() => import('./paginas/RedireccionOrg')) },
          ...EN_CAMINO.map(([path, id, hito]): RouteObject => ({
            path, errorElement: <ErrorRuta />,
            lazy: async () => {
              const { default: PaginaEnCamino } = await import('./paginas/PaginaEnCamino');
              return { Component: () => <PaginaEnCamino key={path} id={id} hito={hito} /> };
            },
          })),
          { path: '*', element: <NoEncontrada /> },
        ],
      },
    ],
  },
  { path: '*', element: <NoEncontrada />, errorElement: <ErrorRuta /> },
];

export const router = createBrowserRouter(rutas);
