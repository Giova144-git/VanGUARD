import type { PermCheck, ProviderErrorCode } from '@vanguard/contracts';

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

// Una petición sin reintento (los sondeos son de un intento, §07.2): devuelve la respuesta o lanza ProviderError de red.
export async function pedir(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
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
