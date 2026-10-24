import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SesionProvider } from './app/sesion';
import { router } from './app/router';
import { esApiError, type ApiError } from './lib/errores';
import { supabase } from './lib/supabase';
import './styles/globals.css';

// 401 tras el reintento de api(): si ya no queda sesión, se cierra y se vuelve a /login?next= (S14 §14.8).
async function alFallar(e: unknown) {
  if (!esApiError(e) || e.status !== 401) return;
  const { data } = await supabase.auth.getSession();
  if (data.session) return;
  await supabase.auth.signOut();
  const aqui = location.pathname + location.search;
  router.navigate(`/login?next=${encodeURIComponent(aqui)}`, { replace: true });
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
