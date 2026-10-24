import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from './errors.ts';

// Cliente admin (sb_secret_, salta RLS): SOLO servidor. Uno por isolate; sin sesión ni refresco de tokens.
// Toda consulta sobre datos de una org lleva .eq('org_id', c.get('orgId')) (anti-IDOR, S15 15.3).
let cache: { url: string; key: string; client: SupabaseClient } | null = null;

export function db(env: CloudflareBindings): SupabaseClient {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new ApiError('internal', 'El servidor no tiene configurada la base de datos');
  if (cache?.url !== url || cache.key !== key) {
    cache = {
      url,
      key,
      client: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }),
    };
  }
  return cache.client;
}
