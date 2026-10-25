// supabase-js solo para Auth y Realtime (L2). Los datos van siempre por /api/*.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { almacenNavegador, CLAVE_AUTH } from './almacen-auth';
import { USA_FIXTURES } from './env';
import { dobleSupabase } from './supabase-doble';

function crear(): SupabaseClient {
  if (USA_FIXTURES) return dobleSupabase() as unknown as SupabaseClient;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Faltan VITE_SUPABASE_URL o VITE_SUPABASE_PUBLISHABLE_KEY');
  // storage: la sesión del invitado de /demo va a sessionStorage y muere con el navegador; la de correo, a localStorage.
  return createClient(url, key, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: CLAVE_AUTH, storage: almacenNavegador() },
  });
}

export const supabase = crear();
