import type { SupabaseClient } from '@supabase/supabase-js';
import type { ErrorCode } from '@vanguard/contracts';
import { assertAllowedUrl } from '@vanguard/core';
import { ErrorGithub, ErrorWiki } from '@vanguard/deepwiki';
import type { CodigoErrorGithub, Deps, Fetch, HallazgoBreve, Llm } from '@vanguard/deepwiki';
import { withSecret } from '../lib/credentials.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

// Deps de @vanguard/deepwiki en el Worker (packages/deepwiki/LEEME.md, «Integración en el BACK», puntos 1, 6 y 7).
// Lo usan E40 (estimar), E41 (generar) y los pasos 'wiki' de la cola vg-jobs. El PAT de GitHub solo vive dentro de
// conTokenGithub: nunca va al estado, a la respuesta, a un error ni a los logs.

// Workers Free: el equipo se fija <= 40 subpeticiones por invocación (el plan da 50, §15.3).
export const TOPE_SUBPETICIONES = 40;

export type SalidaGithub = {
  fetch: Fetch;
  usadas: () => number;      // subpeticiones que salieron de verdad (log y pruebas de presupuesto)
  bloqueadas: () => number;  // las que frenó la lista de salida o el tope: el motor las ve como github_red, así que la
                             // cola mira esto antes de reintentar (un bloqueo no se arregla reintentando)
};

// fetch envuelto para el motor: llamar al fetch global desde la clausura evita el «Illegal invocation» del fetch
// suelto. Antes de cada llamada, assertAllowedUrl (§06.3: https, host exacto de HOSTS_SALIDA, sin credenciales ni
// puerto) y el tope `max`; si no pasa, lanza sin llamar a fetch. redirect 'manual' siempre: 'follow' llevaría el
// Authorization a otro host. No reutiliza pedir() de lib/http.ts: sigue redirecciones por su cuenta (una llamada del
// motor serían hasta 4 subpeticiones fuera de su cupo) y un LFS de raw (otro host) sería error en vez de omitirse.
export function salidaGithub(max: number,
  base: Fetch = ((u: RequestInfo | URL, i?: RequestInit) => fetch(u, i)) as Fetch): SalidaGithub {
  let usadas = 0;
  let bloqueadas = 0;
  const envuelto = async (entrada: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: URL;
    try {
      url = assertAllowedUrl(entrada instanceof Request ? entrada.url : entrada);
    } catch (e) {
      bloqueadas++;
      // El log lleva el motivo, nunca la URL (puede traer un secreto en la query).
      const motivo = /^EGRESS_BLOCKED:(\w+)$/.exec((e as Error)?.message ?? '')?.[1] ?? 'url';
      log('warn', 'egress.bloqueado', { motivo, origen: 'deepwiki' });
      throw new Error('EGRESS_BLOCKED');
    }
    if (usadas >= max) {
      bloqueadas++;
      log('warn', 'wiki.tope_subpeticiones', { max });
      throw new Error('SUBREQUEST_BUDGET');
    }
    usadas++;
    return base(url.href, { ...init, redirect: 'manual' });
  };
  return { fetch: envuelto as Fetch, usadas: () => usadas, bloqueadas: () => bloqueadas };
}

// E40 no llama al modelo (LEEME, punto 1): si algo lo intentara, falla antes de gastar.
export const sinLlm: Llm = async () => {
  throw new ErrorWiki('sin_llm', 'Este paso no llama al modelo.');
};

export type OpcionesDeps = {
  fetch: Fetch;                  // el de salidaGithub
  githubToken?: string;          // solo dentro de conTokenGithub
  llm?: Llm;                     // E41 y la cola: enrutado por ia/claude.ts (topes, interruptor, ai_usage); si no, sinLlm
  hallazgos?: HallazgoBreve[];   // undefined = no hubo auditoría; [] = VanGUARD auditó y no encontró nada
  auditoria_at?: string;         // ISO de esa auditoría
};

export function depsWiki(o: OpcionesDeps): Deps {
  const d: Deps = { fetch: o.fetch, llm: o.llm ?? sinLlm };
  if (o.githubToken) d.githubToken = o.githubToken;
  if (o.hallazgos) d.hallazgos = o.hallazgos;
  if (o.auditoria_at) d.auditoria_at = o.auditoria_at;
  return d;
}

// connection_id del cuerpo → PAT descifrado solo mientras corre fn (withSecret de lib/credentials.ts). Tiene que ser
// una conexión GitHub de lectura, activa y de ESTA org (anti-IDOR, §15.3); si no, 404 con el mismo texto para todo.
// Sin connection_id: fn(undefined), repo público sin token. 2 subpeticiones (connections y connection_secrets) más
// vg_crypto_material si el keyring no está en caché.
export async function conTokenGithub<T>(env: CloudflareBindings, admin: SupabaseClient, orgId: string,
  connectionId: string | undefined, fn: (token: string | undefined) => Promise<T>): Promise<T> {
  if (connectionId === undefined) return fn(undefined);
  const { data: fila, error } = await admin.from('connections').select('id, provider, kind, status')
    .eq('id', connectionId).eq('org_id', orgId).eq('provider', 'github').eq('kind', 'read').eq('status', 'active')
    .maybeSingle();
  if (error) throw new ApiError('internal', 'No pudimos leer la conexión');
  if (!fila || typeof fila.id !== 'string' || fila.provider !== 'github' || fila.kind !== 'read' || fila.status !== 'active') {
    throw new ApiError('not_found', 'Conexión no encontrada');
  }
  // El id tal como está guardado (minúsculas): entra en el AAD del sellado (§05.7).
  return withSecret(env, admin, { orgId, connectionId: fila.id, provider: 'github', kind: 'read' }, (token) => fn(token));
}

// Errores esperados de GitHub → código de lib/errors.ts (§15.3). Textos propios: nunca err.message ni nada que venga
// de GitHub. Formato malo → 422; no existe → 404; límite → 429 con Retry-After; red, 5xx o respuesta rara → 502.
type Traduccion = [code: ErrorCode, texto: string, details?: Record<string, unknown>];
const TRADUCCION: Record<CodigoErrorGithub, (conToken: boolean) => Traduccion> = {
  repo_invalido: () => ['invalid_body', 'Revisa los campos marcados', { field_errors: { repo_full_name: ['Formato owner/repo'] } }],
  ref_invalida: () => ['invalid_body', 'Revisa los campos marcados', { field_errors: { ref: ['Nombre de rama o tag inválido'] } }],
  repo_no_encontrado: (t) => ['not_found', t
    ? 'Ese repo no existe o tu conexión de GitHub no tiene acceso a él.'
    : 'Ese repo no existe o es privado. Para un repo privado, conecta tu GitHub.'],
  ref_no_encontrada: () => ['not_found', 'Esa rama, tag o commit no existe en el repo.'],
  repo_vacio: () => ['conflict', 'El repositorio está vacío: todavía no hay nada que explicar.'],
  token_invalido: () => ['provider_rejected', 'El token de GitHub no es válido o venció. Vuelve a conectar tu GitHub.',
    { reason: 'unauthorized', missing_permissions: [] }],
  limite_github: (t) => ['rate_limited', t
    ? 'GitHub frenó las peticiones o tu token no tiene permiso para ese repo. Espera un poco o revisa tu conexión de GitHub.'
    : 'GitHub frenó las peticiones sin conexión (60 por hora). Espera un poco o conecta tu GitHub.'],
  github_error: () => ['provider_unavailable', 'GitHub no respondió como esperábamos. Vuelve a intentarlo en unos minutos.'],
  github_red: () => ['provider_unavailable', 'No pudimos contactar a GitHub. Vuelve a intentarlo en unos minutos.'],
  respuesta_invalida: () => ['provider_unavailable', 'GitHub devolvió una respuesta que no pudimos leer. Vuelve a intentarlo.'],
};

export type FalloGithub = { error: ApiError; codigo: CodigoErrorGithub; status: number | null; retryAfterS: number | null };

// null si no es un ErrorGithub (ErrorWiki u otro): no se traduce y sigue hasta el 500 genérico de mw/error.ts.
export function falloGithub(e: unknown, conToken: boolean): FalloGithub | null {
  if (!(e instanceof ErrorGithub)) return null;
  const [code, texto, details] = TRADUCCION[e.codigo](conToken);
  return {
    error: new ApiError(code, texto, { reason: e.codigo, ...details }),
    codigo: e.codigo,
    status: e.status,
    retryAfterS: e.codigo === 'limite_github' ? e.reintentarEnS ?? 60 : null,
  };
}
