// supabase-js solo para Auth y Realtime (L2). Los datos van siempre por /api/*.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { USA_FIXTURES } from './env';
import { dobleSupabase } from './supabase-doble';

function crear(): SupabaseClient {
  if (USA_FIXTURES) return dobleSupabase() as unknown as SupabaseClient;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Faltan VITE_SUPABASE_URL o VITE_SUPABASE_PUBLISHABLE_KEY');
  return createClient(url, key, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'vg-auth' },
  });
}

export const supabase = crear();
