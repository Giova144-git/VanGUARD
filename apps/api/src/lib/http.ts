import type { PermCheck, ProviderErrorCode } from '@vanguard/contracts';
import { assertAllowedUrl } from '@vanguard/core';
import { log } from './log.ts';

// Llamadas salientes (S15 15.3). Los errores se deciden por err.name y status, NUNCA interpolando err.message ni el
// cuerpo del proveedor (pueden llevar el token o datos del cliente).
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number | undefined;

  constructor(code: ProviderErrorCode, status?: number) {
    super(code);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

export const codigoHttp = (s: number): ProviderErrorCode => s === 401 ? 'unauthorized' : s === 403 ? 'forbidden'
  : s === 404 ? 'not_found' : s === 429 ? 'rate_limited' : s >= 500 ? 'unavailable' : 'invalid';

const deRed = (e: unknown): ProviderErrorCode => ((e as Error)?.name === 'TimeoutError' ? 'timeout' : 'unavailable');

// Lista de salida (S06 06.3): solo https a un host exacto de HOSTS_SALIDA. El log lleva el motivo, nunca la URL
// (puede traer un secreto en la query).
function permitida(url: string | URL, status?: number): URL {
  try {
    return assertAllowedUrl(url);
  } catch (e) {
    const motivo = /^EGRESS_BLOCKED:(\w+)$/.exec((e as Error)?.message ?? '')?.[1] ?? 'url';
    log('warn', 'egress.bloqueado', { motivo, status });
    throw new ProviderError('invalid', status);
  }
}

const SALTOS = 3;

// Una petición sin reintento (los sondeos son de un intento, §07.2): devuelve la respuesta o lanza ProviderError.
// Redirecciones a mano y con un solo plazo: 'follow' llevaría el Authorization a cualquier host. Se siguen hasta 3
// solo si el Location cae en el mismo host (los repos renombrados de GitHub dan 301); el cuerpo de cada 3xx se cancela.
export async function pedir(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let u = permitida(url);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let salto = 0; ; salto++) {
      const r = await fetch(u.href, { ...init, redirect: 'manual', signal });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (loc === null) return r;
      await r.body?.cancel();
      let sig: URL | null = null;
      try { sig = new URL(loc, u); } catch { /* Location ilegible: se rechaza abajo */ }
      if (!sig || sig.host !== u.host || salto === SALTOS) {
        log('warn', 'egress.redireccion_rechazada', { motivo: !sig ? 'location' : sig.host !== u.host ? 'host' : 'saltos',
          status: r.status });
        throw new ProviderError('invalid', r.status);
      }
      u = permitida(sig, r.status);
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(deRed(e));
  }
}

// Sondeo de un permiso: solo importa el código HTTP; el cuerpo se descarta sin leerlo (Workers: 6 conexiones a la vez).
export async function sondear(url: string, init: RequestInit, timeoutMs: number): Promise<number | ProviderErrorCode> {
  try {
    const r = await pedir(url, init, timeoutMs);
    await r.body?.cancel();
    return r.status;
  } catch (e) {
    return e instanceof ProviderError ? e.code : 'unavailable';
  }
}

export function check(permission: string, required: boolean, r: number | ProviderErrorCode, okSi404 = false): PermCheck {
  const ok = typeof r === 'number' && ((r >= 200 && r < 300) || (okSi404 && r === 404));
  if (ok) return { permission, ok: true, required };
  return { permission, ok: false, required, error_code: typeof r === 'number' ? codigoHttp(r) : r };
}
