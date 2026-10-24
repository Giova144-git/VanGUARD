import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveKeys, type Keys } from '@vanguard/core/crypto';

// Literal de §05.7. KEK y FPK no extraíbles, en caché 10 min por isolate; jamás se registran.
// Sin VG_KEK_PEPPER/VG_FP_PEPPER, deriveKeys lanza CRYPTO_MATERIAL_BAD_LENGTH (nunca se deriva con una pimienta vacía).
const TTL_MS = 10 * 60_000;
const cache = new Map<string, { keys: Promise<Keys>; exp: number }>();   // se cachea la promesa: sin estampida

export function getKeys(env: CloudflareBindings, admin: SupabaseClient, kid: string): Promise<Keys> {
  const hit = cache.get(kid);
  if (hit && hit.exp > Date.now()) return hit.keys;
  const keys = (async () => {
    const { data, error } = await admin.rpc('vg_crypto_material', { p_version: Number(kid.slice(1)) });
    const row = Array.isArray(data) ? data[0] : null;
    if (error || !row?.kek_b64 || !row?.fp_pepper_b64) throw new Error('CRYPTO_MATERIAL_UNAVAILABLE');
    return deriveKeys({ kid, vaultKekB64: row.kek_b64, kekPepperB64: env.VG_KEK_PEPPER ?? '',
                        vaultFpB64: row.fp_pepper_b64, fpPepperB64: env.VG_FP_PEPPER ?? '' });
  })();
  cache.set(kid, { keys, exp: Date.now() + TTL_MS });
  keys.catch(() => cache.delete(kid));                                    // un fallo no se cachea
  return keys;
}

export async function activeKid(admin: SupabaseClient): Promise<string> {
  const { data } = await admin.from('app_config').select('value').eq('key', 'kek_active').maybeSingle();
  return typeof data?.value === 'string' ? data.value : 'v1';
}
