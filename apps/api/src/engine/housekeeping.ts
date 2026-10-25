import { ORDEN_REGLAS_EDGE, RESOLVER_SIN_EVENTOS_MS } from '@vanguard/core';
import { deshacerBloqueos, PERMANENTES } from '../actions/block-ip.ts';
import { deshacerEnSeco, esSimulada } from '../actions/sandbox.ts';
import { deshacerBajoAtaque, MAX_BARRIDO, retirarHuerfanaBajoAtaque } from '../actions/under-attack.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { SIN_AVANCE_MS } from '../wiki/corridas.ts';

// housekeeping del cron por minuto (S12 12.3, S15 15.7). P0: cierre automático de los incidentes CF_ sin peticiones de
// su IP en edge_hits desde hace 15 min, en UNA consulta acotada (RPC vg_resolve_idle_incidents, 0009). Mientras la 0009
// no esté aplicada (PGRST202), respaldo en un solo UPDATE por last_event_at: la última evaluación que vio la IP disparar
// una regla, que va hasta 60 s por detrás de su última petición; cierra igual a los ~15 min de un ataque que paró.
// Devuelve un resumen y onCron lo deja en su línea monitor.minuto.
// Caducidad de «Bloquear IP» (§08.8, S15 15.10): Cloudflare no caduca las access rules; aquí se deshacen las actions
// executed con expires_at < now(), como mucho LIMITE_CADUCIDAD por minuto (las más viejas primero), con deshacerBloqueos
// (un sobre por conexión, DELETE por regla, 404 = ya no estaba, previous.existed → no se toca Cloudflare). Un fallo
// permanente (permiso, token, credencial, otro 4xx) deja la fila failed con previous.deshacer_error (visible, y E22 puede
// reintentarla). Uno pasajero (red, 5xx, 429) la deja executed con previous.intentos y previous.reintento_en (espera de
// 1, 2, 4… min): mientras espera se salta, así unas filas atascadas no tapan las de otras orgs; al MAX_REINTENTOS pasa a
// failed. Solo con VG_ENV=production (cron sin petición, S15 15.3): en local y previews no se toca Cloudflare.
// Modo bajo ataque (modo-bajo-ataque.md §8): la misma caducidad lee también under_attack_on (con su target) y la retira
// con deshacerBajoAtaque (DELETE de la regla de configuración y barrido de las demás reglas de VanGUARD de ese host, ≤
// MAX_BARRIDO); de las ≤ 5 filas por minuto, ≤ 2 son de bajo ataque (con la caducidad dentro de la regla no corre prisa).
// Después, solo si la caducidad de este minuto gastó ≤ 15 subpeticiones (una función de deshacer que lanza cuenta su
// tope: lo gastado en Cloudflare no vuelve en su resultado), se trata UNA proposed de bajo ataque de > 2 min
// (retirarHuerfanaBajoAtaque, ≤ 6): la huérfana (el Worker murió entre el POST y el UPDATE) se busca por su ref, se borra
// y queda failed; la sin confirmar (previous.reconciliar: Cloudflare no respondió claro a E21) se busca igual y pasa a
// executed si está o a failed si no. Con Cloudflare caído, espera 1, 2, 4… min (previous.reintento_en) sin tapar a las
// demás.
// SB_DB_DOWN se cierra en su monitor (2 lecturas sanas seguidas), no aquí.
// Vigilante (0011, vg_vigilar_corridas): una corrida cuyo mensaje de vg-jobs se perdió (dev-node --watch reiniciado con
// la cola en memoria, un mensaje que no llegó ni a la DLQ) se quedaría queued/running para siempre. Una sola RPC acotada
// (LIMITE_VIGILANTE filas por tabla, las más viejas primero, for update skip locked) deja failed, con su texto corto y sin
// tocar cost_usd: las wiki_runs con updated_at (último avance o última espera, wiki/pasos.ts) de hace más de
// VIGILANTE_WIKI_MS (= SIN_AVANCE_MS de wiki/corridas.ts) y las scan_runs sin avance desde hace VIGILANTE_SCAN_MS
// (started_at o created_at, o un hallazgo de esa auditoría: scan_runs no tiene updated_at). El filtro de tiempo va en la
// misma sentencia que escribe: un paso que avanza a la vez gana. Corre en todos los entornos (solo toca la base). Mientras
// la 0011 no esté aplicada (PGRST202), respaldo en un solo UPDATE acotado (orden por id + limit), una tabla por minuto
// (wiki en los pares, auditorías en los impares) para no pasar de 2 subpeticiones; sin arreglar steps.
// Presupuesto del minuto (por subpeticiones contadas, no por filas): incidentes ≤ 2 + vigilante ≤ 2 + caducidad ≤ 28
// (1 lectura + por cada función de deshacer 2 por conexión, 1 por regla y ≤ 2 escrituras, + en bajo ataque 1 GET por
// conexión y ≤ MAX_BARRIDO, + 1 por fila no retirada; 5 filas en 5 conexiones) + huérfana ≤ 6 solo si la caducidad
// gastó ≤ 15 → peor caso ≤ 32 (tope del equipo: 40).

export const LIMITE_CIERRE = 200;
export const LIMITE_CADUCIDAD = 5;           // ≤ 5 reglas por minuto (§08.8), de los dos tipos
export const LIMITE_CADUCIDAD_BAJO_ATAQUE = 2;   // de ellas, ≤ 2 under_attack_on (la regla ya caduca sola)
export const PRESUPUESTO_HUERFANA = 15;      // la huérfana solo corre si la caducidad gastó ≤ 15 subpeticiones
export const CANDIDATOS_CADUCIDAD = 50;      // se leen más para saltar las que esperan su reintento
export const MAX_REINTENTOS = 6;             // ~1 h de esperas (1+2+4+8+16+32 min) antes de rendirse
export const VIGILANTE_WIKI_MS = SIN_AVANCE_MS;            // 10 min sin avanzar ni esperar
export const VIGILANTE_SCAN_MS = 15 * 60_000;              // una auditoría normal acaba en pocos minutos
export const LIMITE_VIGILANTE = 50;                        // filas por tabla y minuto
// Los mismos textos que pone la 0011 (su prueba lo comprueba).
export const ERROR_WIKI_INTERRUMPIDA = 'La corrida se interrumpió; vuelve a generarla';
export const ERROR_SCAN_INTERRUMPIDA = 'La auditoría se interrumpió; vuelve a lanzarla';
const SIN_RPC = new Set(['PGRST202', '42883']);
const esperaMs = (intentos: number) => Math.min(2 ** (intentos - 1), 60) * 60_000;
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
type Fila = { id: string; org_id: string; kind?: string; target?: string | null; provider_ref: string | null; previous: unknown };
// Lo más que gasta una función de deshacer con estas filas: 2 por conexión (el sobre), 1 por regla, 1 más por fila que
// busca (sin provider_ref, o de bajo ataque con target: el GET del barrido), MAX_BARRIDO si alguna barre y ≤ 2
// escrituras. Solo se usa cuando lanza, para no contar de menos.
const topeDeshacer = (xs: readonly Fila[], modo: boolean) => {
  const conexiones = new Set(xs.map((f) => `${f.org_id}|${String(obj(f.previous).connection_id)}`)).size;
  const barre = (f: Fila) => modo && !!f.target;
  return 2 * conexiones + xs.length + xs.filter((f) => !f.provider_ref || barre(f)).length
    + (xs.some(barre) ? MAX_BARRIDO : 0) + 2;
};

export type ResultadoHousekeeping = {
  resueltos: number;
  subpeticiones: number;
  modo: 'rpc' | 'respaldo' | null;
  error: string | null;       // código corto (de Postgres/PostgREST o nuestro), nunca un mensaje
  deshechos: number;          // bloqueos y modos bajo ataque caducados retirados de Cloudflare
  fallidos: number;           // los que no se pudieron retirar y quedan failed
  vigilante: 'rpc' | 'respaldo' | null;
  interrumpidas: { wiki: number; scans: number };   // corridas que el vigilante dejó failed
};

export async function housekeeping(env: CloudflareBindings, now = new Date()): Promise<ResultadoHousekeeping> {
  const r: ResultadoHousekeeping = { resueltos: 0, subpeticiones: 0, modo: null, error: null, deshechos: 0, fallidos: 0,
    vigilante: null, interrumpidas: { wiki: 0, scans: 0 } };
  const cierre = await cerrarIncidentes(env, now, r);
  await vigilar(env, now, cierre);
  await caducarBloqueos(env, now, cierre);
  return cierre;
}

async function cerrarIncidentes(env: CloudflareBindings, now: Date, r: ResultadoHousekeeping): Promise<ResultadoHousekeeping> {
  try {
    const admin = db(env);
    const { data, error } = await admin.rpc('vg_resolve_idle_incidents',
      { p_idle_seconds: RESOLVER_SIN_EVENTOS_MS / 1000, p_limit: LIMITE_CIERRE });
    r.subpeticiones++;
    if (!error) return { ...r, modo: 'rpc', resueltos: Array.isArray(data) ? data.length : 0 };
    if (!SIN_RPC.has(error.code ?? '')) return { ...r, modo: 'rpc', error: error.code ?? 'rpc' };

    const corte = new Date(now.getTime() - RESOLVER_SIN_EVENTOS_MS).toISOString();
    const res = await admin.from('incidents').update({ status: 'resolved', resolved_at: now.toISOString() })
      .in('status', ['open', 'ack', 'mitigated']).lt('last_event_at', corte).overlaps('rule_ids', [...ORDEN_REGLAS_EDGE])
      .select('id');
    r.subpeticiones++;
    if (res.error) return { ...r, modo: 'respaldo', error: res.error.code ?? 'update' };
    return { ...r, modo: 'respaldo', resueltos: Array.isArray(res.data) ? res.data.length : 0 };
  } catch (e) {
    return { ...r, error: e instanceof ApiError ? e.code : e instanceof Error ? e.name : 'desconocido' };
  }
}

// 1 subpetición con la 0011; 2 en el respaldo (la RPC que falta y el UPDATE). Nunca lanza: el error va al resumen.
async function vigilar(env: CloudflareBindings, now: Date, r: ResultadoHousekeeping) {
  try {
    const admin = db(env);
    const { data, error } = await admin.rpc('vg_vigilar_corridas', { p_wiki_seconds: VIGILANTE_WIKI_MS / 1000,
      p_scan_seconds: VIGILANTE_SCAN_MS / 1000, p_limit: LIMITE_VIGILANTE });
    r.subpeticiones++;
    r.vigilante = 'rpc';
    if (!error) return contarInterrumpidas(r, (Array.isArray(data) ? data : []) as Obj[]);
    if (!SIN_RPC.has(error.code ?? '')) {
      r.error ??= error.code ?? 'rpc';
      return;
    }

    r.vigilante = 'respaldo';
    const ahora = now.toISOString();
    const abiertas = ['queued', 'running'];
    const tabla = now.getUTCMinutes() % 2 === 0 ? 'wiki_runs' : 'scan_runs';
    const corteScan = corte(now, VIGILANTE_SCAN_MS);
    // Compare-and-set en el mismo UPDATE: si un paso tocó la fila después del corte, el filtro ya no la ve.
    const res = tabla === 'wiki_runs'
      ? await admin.from('wiki_runs').update({ status: 'failed', error: ERROR_WIKI_INTERRUMPIDA, finished_at: ahora,
        updated_at: ahora }).in('status', abiertas).lt('updated_at', corte(now, VIGILANTE_WIKI_MS))
        .order('id').limit(LIMITE_VIGILANTE).select('id, org_id')
      // created_at ≤ started_at: así se escribe «coalesce(started_at, created_at) < corte» sin la función.
      : await admin.from('scan_runs').update({ status: 'failed', error: ERROR_SCAN_INTERRUMPIDA, step: null, finished_at: ahora })
        .in('status', abiertas).lt('created_at', corteScan).or(`started_at.is.null,started_at.lt."${corteScan}"`)
        .order('id').limit(LIMITE_VIGILANTE).select('id, org_id');
    r.subpeticiones++;
    if (res.error) {
      r.error ??= res.error.code ?? 'update';
      return;
    }
    contarInterrumpidas(r, ((Array.isArray(res.data) ? res.data : []) as Obj[]).map((f) => ({ ...f, tabla })));
  } catch (e) {
    r.error ??= e instanceof ApiError ? e.code : e instanceof Error ? e.name : 'desconocido';
  }
}

const corte = (now: Date, ms: number) => new Date(now.getTime() - ms).toISOString();

function contarInterrumpidas(r: ResultadoHousekeeping, filas: Obj[]) {
  const ids = (tabla: string) => filas.filter((f) => f.tabla === tabla).map((f) => String(f.id));
  const wiki = ids('wiki_runs');
  const scans = ids('scan_runs');
  // 0022: auditorías con todos sus pasos terminados cuyo cierre se perdió; la RPC las cerró como finalizar (no cuentan
  // como interrumpidas).
  const cerradas = ids('scan_runs_cerradas');
  if (cerradas.length) log('info', 'vigilante.cerradas', { scans: cerradas.slice(0, 10), total: cerradas.length });
  r.interrumpidas = { wiki: wiki.length, scans: scans.length };
  // Solo ids de corridas (sin repos ni nombres), para seguir en los logs qué se cerró.
  if (wiki.length || scans.length) {
    log('warn', 'vigilante.interrumpidas', { modo: r.vigilante, wiki: wiki.slice(0, 10), scans: scans.slice(0, 10),
      total: wiki.length + scans.length });
  }
}

async function caducarBloqueos(env: CloudflareBindings, now: Date, r: ResultadoHousekeeping) {
  if (env.VG_ENV !== 'production') return;
  const antes = r.subpeticiones;
  await caducar(env, now, r);
  if (r.subpeticiones - antes <= PRESUPUESTO_HUERFANA) {
    const h = await retirarHuerfanaBajoAtaque(env, { rid: 'cron', ahora: now.getTime() });   // nunca lanza
    r.subpeticiones += h.subpeticiones;
  }
}

async function caducar(env: CloudflareBindings, now: Date, r: ResultadoHousekeeping) {
  try {
    const admin = db(env);
    const t = now.getTime();
    const { data, error } = await admin.from('actions').select('id, org_id, kind, target, provider_ref, previous')
      .eq('status', 'executed').in('kind', ['block_ip', 'under_attack_on']).lt('expires_at', now.toISOString())
      .order('expires_at').limit(CANDIDATOS_CADUCIDAD);
    r.subpeticiones++;
    if (error) {
      r.error ??= error.code ?? 'actions';
      return;
    }
    const modo = (f: Fila) => f.kind === 'under_attack_on';
    // Las más viejas primero, ≤ LIMITE_CADUCIDAD en total y ≤ LIMITE_CADUCIDAD_BAJO_ATAQUE de bajo ataque.
    const filas: Fila[] = [];
    let modos = 0;
    for (const f of (Array.isArray(data) ? data : []) as Fila[]) {
      if (filas.length >= LIMITE_CADUCIDAD) break;
      if (Date.parse(String(obj(f.previous).reintento_en ?? '')) > t) continue;
      if (modo(f) && modos++ >= LIMITE_CADUCIDAD_BAJO_ATAQUE) continue;
      filas.push(f);
    }
    if (!filas.length) return;
    // Acciones en seco de una sandbox de «Ver demo» (0026, previous.simulado): undone sin llamar a Cloudflare.
    const simuladas = filas.filter((f) => esSimulada(f.previous));
    const enSeco = simuladas.length
      ? await deshacerEnSeco(env, simuladas.map((f) => ({ id: String(f.id), org_id: String(f.org_id) })), 'cron') : new Set<string>();
    r.subpeticiones += simuladas.length;
    const reales = filas.filter((f) => !esSimulada(f.previous));
    r.deshechos = enSeco.size;
    if (!reales.length) return;
    const bloqueos = reales.filter((f) => !modo(f)), enModo = reales.filter(modo);
    // Cada función suma lo suyo nada más volver, y su tope si lanza (falla su escritura a undone): lo ya gastado en
    // Cloudflare no vuelve en su resultado y la huérfana no debe correr sobre un presupuesto falso.
    const contando = async <T extends { subpeticiones: number }>(xs: Fila[], fn: () => Promise<T>): Promise<T> => {
      try {
        const x = await fn();
        r.subpeticiones += x.subpeticiones;
        return x;
      } catch (e) {
        r.subpeticiones += topeDeshacer(xs, xs.some(modo));
        throw e;
      }
    };
    const opc = { rid: 'cron', ahora: t };
    const a = bloqueos.length ? await contando(bloqueos, () => deshacerBloqueos(env, bloqueos, opc)) : null;
    const b = enModo.length ? await contando(enModo, () => deshacerBajoAtaque(env, enModo, opc)) : null;
    const resultados = new Map([...(a?.resultados ?? []), ...(b?.resultados ?? [])]);
    r.deshechos += reales.filter((f) => resultados.get(f.id) === 'deshecho').length;
    // Una escritura por fila no retirada (≤ 5): cada una guarda su previous con el intento o el motivo.
    const pendientes = reales.filter((f) => resultados.get(f.id) !== 'deshecho');
    const escritas = await Promise.all(pendientes.map(async (f) => {
      const motivo = resultados.get(f.id) ?? 'caido';
      const prev = obj(f.previous);
      const intentos = (typeof prev.intentos === 'number' ? prev.intentos : 0) + 1;
      const rendida = PERMANENTES.has(motivo) || intentos >= MAX_REINTENTOS;
      const cambio = rendida ? { status: 'failed', previous: { ...prev, intentos, deshacer_error: motivo } }
        : { previous: { ...prev, intentos, reintento_en: new Date(t + esperaMs(intentos)).toISOString() } };
      const u = await admin.from('actions').update(cambio).eq('id', f.id).eq('org_id', f.org_id).eq('status', 'executed');
      if (u.error) r.error ??= u.error.code ?? 'update';
      // La regla puede seguir en Cloudflare: queda en el log de errores (sin la IP) y como failed en la app. Una regla de
      // bajo ataque con la caducidad dentro ya no actúa; E55 la enseña como retirada_fallida con los pasos para borrarla.
      else if (rendida) {
        log('error', modo(f) ? 'bajo_ataque.caducidad_fallida' : 'bloqueo.caducidad_fallida', { action_id: f.id, motivo, intentos });
      }
      return !u.error && rendida;
    }));
    r.subpeticiones += pendientes.length;
    r.fallidos = escritas.filter(Boolean).length;
    log(r.fallidos ? 'warn' : 'info', 'bloqueos.caducados', { deshechos: r.deshechos, fallidos: r.fallidos,
      reintentos: pendientes.length - r.fallidos, bajo_ataque: enModo.length });
  } catch (e) {
    r.error ??= e instanceof ApiError ? e.code : e instanceof Error ? e.name : 'desconocido';
  }
}
