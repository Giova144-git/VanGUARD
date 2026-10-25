import './lib/zod-sin-jit';                                  // primero: zod lee jitless al crear los schemas de contracts
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SesionProvider } from './app/sesion';
import { router } from './app/router';
import { nextDe } from './lib/aterrizaje';
import { esApiError, type ApiError } from './lib/errores';
import { confirmarCaducada, destinoAlCaducar, esCopiaRecordada, latirAlCargar, orgDeRuta } from './lib/sandbox';
import { supabase } from './lib/supabase';
import './styles/globals.css';

// Lo primero: si esta pestaña recarga una copia de la demo, su latido cancela el «cerrando» de pagehide (lib/sandbox.ts).
latirAlCargar();

// Dentro de una copia de la demo que caducó (la purga la borró, y quizá al invitado con ella), ni «No tienes acceso» ni
// /login: se prepara otra (/demo?caducada=1), una sola vez. Un 403/404 solo cuenta si el latido confirma que ya no está.
async function copiaCaducada(e: ApiError, sesion: { user?: { is_anonymous?: boolean } } | null): Promise<boolean> {
  const org = orgDeRuta(location.pathname);
  if (!esCopiaRecordada(org)) return false;
  const caducada = e.status === 401 ? !sesion || sesion.user?.is_anonymous === true : await confirmarCaducada(org!);
  if (!caducada) return false;
  // Sin cerrar aquí la sesión del invitado purgado: unirseADemo ve su 401 y entra como invitado nuevo. Cerrarla antes
  // haría que RequireSession mandase a /login antes de llegar a /demo.
  const destino = destinoAlCaducar(org);
  if (destino) await router.navigate(destino, { replace: true });
  return true;
}

// 401 tras el reintento de api(): si ya no queda sesión, se cierra y se vuelve a /login?next= (S14 §14.8).
async function alFallar(e: unknown) {
  if (!esApiError(e) || (e.status !== 401 && e.status !== 403 && e.status !== 404)) return;
  const { data } = await supabase.auth.getSession();
  if (await copiaCaducada(e, data.session).catch(() => false)) return;
  if (e.status !== 401 || data.session) return;
  await supabase.auth.signOut();
  router.navigate(`/login?next=${encodeURIComponent(nextDe(location.pathname, location.search))}`, { replace: true });
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: alFallar }),
  defaultOptions: {
    queries: {
      refetchIntervalInBackground: false,
      retry: (n, e) => (e as ApiError).status >= 500 && n < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SesionProvider>
        <RouterProvider router={router} />
      </SesionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
