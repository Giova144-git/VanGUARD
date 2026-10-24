// Único punto de salida a la API (S14 §14.8): rutas relativas al mismo origen, sin CORS.
import type { z } from 'zod';
import { supabase } from './supabase';
import { ApiError } from './errores';
import { caminoValido } from './ids';

type Opts<T> = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; esquema?: z.ZodType<T>; crudo?: boolean };
type CuerpoError = { error?: { code?: string; message?: string; request_id?: string; details?: Record<string, unknown> } } | null;

const aError = (status: number, b: CuerpoError) =>
  new ApiError(status, b?.error?.code ?? 'internal', b?.error?.message ?? 'Algo falló', b?.error?.request_id, b?.error?.details);

async function pedir(ruta: string, o: Opts<unknown>): Promise<Response> {
  const { data } = await supabase.auth.getSession();     // en el navegador sí; getSession() solo está prohibido en el servidor
  const h: Record<string, string> = { accept: 'application/json' };
  if (data.session) h.authorization = `Bearer ${data.session.access_token}`;
  if (o.body !== undefined) h['content-type'] = 'application/json';
  try { return await fetch(ruta, { method: o.method ?? 'GET', headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); }
  catch { throw new ApiError(0, 'network', 'Sin conexión con VanGUARD'); }
}

export async function api<T>(ruta: string, o: Opts<T> = {}): Promise<T> {
  // Toda lectura y escritura de datos va por la API del mismo origen (decisión (a): el navegador no lee tablas).
  if (!caminoValido(ruta)) throw new ApiError(0, 'internal', 'Ruta fuera de /api');
  // Condición escrita en línea (no USA_FIXTURES importado) para que Vite la reemplace por literales y el
  // import dinámico desaparezca del build de producción: los fixtures no entran en el bundle (F-03).
  if (import.meta.env.MODE === 'fixtures' || import.meta.env.VITE_USE_FIXTURES === '1') {
    const { fixtureFetch } = await import('./fixtures/router');
    return fixtureFetch<T>(ruta, o);
  }
  let res = await pedir(ruta, o);
  if (res.status === 401) {                               // un solo reintento tras refrescar la sesión
    const { data } = await supabase.auth.refreshSession().catch(() => ({ data: { session: null } }));
    if (data.session) res = await pedir(ruta, o);
  }
  if (o.crudo) { if (!res.ok) throw aError(res.status, await res.json().catch(() => null)); return res as unknown as T; } // antes del 204: DELETE connections necesita leer X-VG-Revoke-Url
  if (res.status === 204) return undefined as T;
  const cuerpo: unknown = await res.json().catch(() => null);
  if (!res.ok) throw aError(res.status, cuerpo as CuerpoError);
  if (!o.esquema) return cuerpo as T;
  const r = o.esquema.safeParse(cuerpo);
  if (r.success) return r.data;
  if (import.meta.env.DEV) throw new ApiError(200, 'contract_mismatch', `La respuesta de ${ruta} no cumple el contrato`);
  console.warn('contract_mismatch', ruta, r.error.issues.map((i) => i.path.join('.')));  // en producción no se deja la demo en blanco
  return cuerpo as T;
}
