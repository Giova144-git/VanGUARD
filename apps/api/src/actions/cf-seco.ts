import { pedir } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { CF_API, PLAZO_CF_MS } from './block-ip.ts';

// Mutaciones de prueba de la Rulesets API (asignaciones/modo-bajo-ataque.md §1.4, D4): el ÚNICO camino de E56 y de la
// sonda de E8/E9. dry_run=true va puesto con URL.searchParams (no se puede olvidar ni escribir mal) y solo se da por
// buena una respuesta 2xx con result === null: Cloudflare valida permiso, plan, cupo y expresión sin publicar nada. Un
// 2xx con un ruleset en result es una escritura que se coló: se borra al instante la regla con nuestro ref. Ni el token
// ni el cuerpo de Cloudflare salen en los logs.

export type ResultadoSeco =
  | { tipo: 'valida' }                                              // 2xx con result === null
  | { tipo: 'sin_permiso' }                                         // 403
  | { tipo: 'token_invalido' }                                      // 401
  | { tipo: 'rechazada'; status: number; codigo: number | null }   // otro 4xx (codigo = errors[0].code de Cloudflare)
  | { tipo: 'sin_respuesta' }                                       // red, plazo, 429, 5xx o un 2xx ilegible
  | { tipo: 'escrita'; retirada: boolean };                         // 2xx con result NO nulo: Cloudflare escribió

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const ZONA = /^[a-f0-9]{32}$/;
// Solo las dos mutaciones que usa el modo bajo ataque: añadir una regla a un ruleset o crear el ruleset de la fase.
const RUTA = /^\/rulesets(?:\/[A-Za-z0-9]{1,64}\/rules)?$/;
const ID = /^[A-Za-z0-9]{1,64}$/;
const caidoHttp = (s: number) => s === 408 || s === 429 || s >= 500;
export const cabecerasCf = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json',
  accept: 'application/json' });
const leerJson = (t: string): unknown => { try { return JSON.parse(t); } catch { return undefined; } };

/** Única vía de las mutaciones de prueba (E56 y la sonda de E8/E9). Siempre POST a `${CF}/zones/${zoneId}${ruta}` con
 *  `dry_run=true` puesto con URL.searchParams.set. Un 2xx con result no nulo es una escritura colada: busca en
 *  result.rules la regla con `ref`, hace DELETE de esa regla en result.id, log('error', 'bajo_ataque.dry_run_escribio',
 *  {status, retirada}) sin cuerpo ni token, y devuelve 'escrita'. Nunca lanza. ≤ 2 subpeticiones. */
export async function mutarEnSeco(token: string, zoneId: string, ruta: string, cuerpo: unknown, ref: string)
  : Promise<ResultadoSeco> {
  if (!ZONA.test(zoneId) || !RUTA.test(ruta)) return { tipo: 'rechazada', status: 400, codigo: null };   // nunca sale
  const url = new URL(`${CF_API}/zones/${zoneId}${ruta}`);
  url.searchParams.set('dry_run', 'true');
  let r: Response;
  try {
    r = await pedir(url.href, { method: 'POST', headers: cabecerasCf(token), body: JSON.stringify(cuerpo) }, PLAZO_CF_MS);
  } catch {
    return { tipo: 'sin_respuesta' };
  }
  const j = leerJson(await r.text().catch(() => ''));
  if (r.status === 403) return { tipo: 'sin_permiso' };
  if (r.status === 401) return { tipo: 'token_invalido' };
  if (caidoHttp(r.status)) return { tipo: 'sin_respuesta' };
  if (!r.ok) {
    const codigo = (Array.isArray(obj(j).errors) ? obj(j).errors as unknown[] : []).map((e) => obj(e).code)[0];
    return { tipo: 'rechazada', status: r.status, codigo: typeof codigo === 'number' && Number.isInteger(codigo) ? codigo : null };
  }
  const o = obj(j);
  if ('result' in o && o.result === null) return { tipo: 'valida' };
  if (!o.result || typeof o.result !== 'object') return { tipo: 'sin_respuesta' };
  // Escritura colada: se borra la regla con nuestro ref del ruleset que devolvió Cloudflare (sin dry_run, a propósito).
  const rs = obj(o.result);
  const rulesetId = typeof rs.id === 'string' && ID.test(rs.id) ? rs.id : null;
  const regla = (Array.isArray(rs.rules) ? rs.rules : []).map(obj).find((x) => x.ref === ref);
  const reglaId = typeof regla?.id === 'string' && ID.test(regla.id) ? regla.id : null;
  let retirada = false;
  if (rulesetId && reglaId) {
    try {
      const d = await pedir(`${CF_API}/zones/${zoneId}/rulesets/${rulesetId}/rules/${reglaId}`,
        { method: 'DELETE', headers: cabecerasCf(token) }, PLAZO_CF_MS);
      await d.body?.cancel();
      retirada = (d.status >= 200 && d.status < 300) || d.status === 404;
    } catch { /* retirada = false: queda en el log de errores */ }
  }
  log('error', 'bajo_ataque.dry_run_escribio', { status: r.status, retirada });
  return { tipo: 'escrita', retirada };
}
