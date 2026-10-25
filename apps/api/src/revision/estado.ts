import { CONTEXTO_BLOQUEO, estadoCommit, nuevosBloqueo, textoCierrePr, type EstadoCommit, type UmbralBloqueo }
  from '@vanguard/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MsgRevision } from '../jobs.ts';
import { withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import type { RespuestaCola } from '../wiki/pasos.ts';
import { cambiarEstadoPr, comentarPr, conexionAccion, escribirGh, motivoGh, TRANSITORIO_GH, type Escrito }
  from './acciones-pr.ts';

// Paso 'estado' de la revisión de código (asignaciones/bloqueo-merge-criticos.md §2.4 y el anexo bloqueo-merge-cierre-
// pr.md): publica en GitHub el estado de commit «VanGUARD» de una revisión cerrada (✗ si lo añadido trae un crítico, o si
// no se pudo leer entero; ✓ si no) y, en un PR con hallazgos críticos NUEVOS, lo comenta con texto fijo y lo CIERRA (en
// repos privados gratuitos la protección de rama no exige checks: lo único que impide fusionar en cualquier plan es que
// el PR esté cerrado). Mensaje {kind:'review', paso:'estado'}: lo encola el paso diff al cerrar (y fallar(), yaReclamada,
// la DLQ y E54) solo con el bloqueo encendido. El repo sale de connections.meta del token de acciones, el SHA de la
// fila; nada sale de un payload. Nunca lanza sin decidir: ack o retry, como diff.
// Subpeticiones: revisión 1 + config 1 + conexiones 1 + secreto 1 + llaves ≤ 2 (en frío) + POST ≤ 4 (saltos) + cierre 1
// + config 1 (o, con 401, config y conexión 2) ≤ 13; con el cierre del PR, + última del PR 1 + reclamo 1 + comentario
// ≤ 4 + PATCH ≤ 4 + resultado 1 ≤ 24 de 40. Bloqueo apagado: revisión 1 + config 1 y ack, sin escribir nada.

export const REINTENTOS_ESTADO = 2;
const SHA = /^[0-9a-f]{40}$/;
const MAX_PR = 2_147_483_647;
const COLUMNAS = 'id, config_id, event, pr_number, status, partial, error_code, head_sha, counts, gate_blocking, '
  + 'gate_findings, gate_override_at, gate_pr_action, gate_pr_at';
const escalonado = (intento: number) => 10 * 2 ** Math.max(0, intento - 1);

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const prValido = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_PR;

export type CuerpoEstado = { state: EstadoCommit['state']; description: string; context: typeof CONTEXTO_BLOQUEO;
  target_url?: string };
/** POST /repos/{repo}/statuses/{sha} (Commit statuses: write). 201 = GitHub lo aceptó; el cuerpo se cancela sin leer.
 *  Publicar dos veces lo mismo no hace daño: el último estado del contexto manda. */
export const publicarEstado = (token: string, repo: string, sha: string, cuerpo: CuerpoEstado): Promise<Escrito> =>
  escribirGh(token, 'POST', `/repos/${repo}/statuses/${sha}`, cuerpo);

/** El mismo enlace del WhatsApp (pide sesión): en un repo público, quien lea el estado ve dos uuid que no abren nada. */
export function enlaceRevision(env: CloudflareBindings, orgId: string, reviewId: string): string {
  const origen = (env.APP_ORIGIN ?? '').replace(/\/+$/, '');
  return origen.startsWith('https://') ? `${origen}/o/${orgId}/codebase?revision=${reviewId}` : '';
}

// ── Cierre del PR con críticos (anexo, punto 3) ─────────────────────────────────────────────────────────────────────
type Cierre = { tipo: 'cerrado'; comentado: boolean } | { tipo: 'omitido'; motivo: string }
  | { tipo: 'fallo'; code: string; transitorio: boolean };

// Solo la revisión más nueva de ese PR (otra más vieja que termine tarde no cierra un PR ya arreglado). Reclamo CAS por
// gate_pr_at: el comentario sale UNA vez por revisión aunque el paso se repita o lleguen dos mensajes; si un intento
// anterior reclamó y cayó antes de anotar el resultado, este solo vuelve a cerrar (cerrar un PR cerrado no cambia nada).
// Si el comentario falla, igual cierra.
async function cerrarConCritico(admin: SupabaseClient, m: MsgRevision, rev: Obj, token: string, repo: string, n: number,
  texto: string): Promise<Cierre> {
  const { data, error } = await admin.from('code_reviews').select('id').eq('org_id', m.org_id)
    .eq('config_id', String(rev.config_id)).eq('event', 'pull_request').eq('pr_number', n)
    .order('created_at', { ascending: false }).limit(1);
  if (error) return { tipo: 'fallo', code: 'base', transitorio: true };
  const ultima = (Array.isArray(data) ? obj(data[0]) : obj(data)).id;
  if (ultima !== rev.id) return { tipo: 'omitido', motivo: 'no_es_la_ultima' };
  let comentar = false;
  if (rev.gate_pr_at == null) {
    const { data: c, error: ec } = await admin.from('code_reviews').update({ gate_pr_at: new Date().toISOString() })
      .eq('id', m.review_id).eq('org_id', m.org_id).is('gate_pr_at', null).is('gate_pr_action', null).select('id');
    if (ec) return { tipo: 'fallo', code: 'base', transitorio: true };
    if (!(Array.isArray(c) ? c.length : c)) return { tipo: 'omitido', motivo: 'reclamado' };
    comentar = true;
  }
  let comentado = false;
  if (comentar) {
    const k = await comentarPr(token, repo, n, texto);
    comentado = k.ok;
    if (!k.ok) log('warn', 'gate.pr_comentario_error', { review: m.review_id, status: k.status, code: k.code });
  }
  const r = await cambiarEstadoPr(token, repo, n, 'closed');
  if (r.ok) return { tipo: 'cerrado', comentado };
  return { tipo: 'fallo', code: motivoGh(r.code), transitorio: TRANSITORIO_GH.has(r.code) };
}

/** Punto de enganche del aviso «VanGUARD cerró el PR #{n}» con sus botones («Reabrir el PR», «Enviarme el arreglo»,
 *  «Silenciar repo 1 h»; asignaciones/avisos-whatsapp-botones.md). PENDIENTE de la confirmación de Giovanni: hoy solo
 *  deja constancia; el trabajo de los botones encolará aquí su aviso y su «Reabrir el PR» usará reabrirPr
 *  (acciones-pr.ts). El aviso de la revisión (paso 'aviso') sale igual, con o sin cierre. */
export function avisoPrCerrado(m: MsgRevision, pr: number, comentado: boolean): void {
  log('info', 'gate.pr_cerrado', { review: m.review_id, pr, comentado });
}

/** Entrada de la cola para el paso 'estado' (revision/pasos.ts lo enruta). `intento` = m.attempts. */
export async function pasoEstado(env: CloudflareBindings, m: MsgRevision, intento = 1): Promise<RespuestaCola> {
  const t0 = Date.now();
  const admin = db(env);
  const reintento = (): RespuestaCola => ({ retry: escalonado(intento) });
  const { data: leida, error } = await admin.from('code_reviews').select(COLUMNAS).eq('id', m.review_id)
    .eq('org_id', m.org_id).maybeSingle();
  if (error) return reintento();
  if (!leida) return 'ack';
  const rev = leida as unknown as Obj;
  if (rev.status === 'queued' || rev.status === 'running') return 'ack';   // P0 sin pending: el diff encola otro al cerrar
  const { data: c, error: ec } = await admin.from('code_review_configs')
    .select('id, connection_id, enabled, gate_enabled, gate_min, gate_last_error, gate_close_pr')
    .eq('id', String(rev.config_id)).eq('org_id', m.org_id).maybeSingle();
  if (ec) return reintento();
  const cfg = c as Obj | null;
  // Sin config, revisión apagada o bloqueo apagado: ack sin escribir NADA (E45 solo adjunta gate con alguna gate_*).
  if (!cfg || cfg.enabled !== true || cfg.gate_enabled !== true) {
    log('info', 'gate.apagado', { review: m.review_id });
    return 'ack';
  }

  const marcar = async (gate_error: string): Promise<RespuestaCola> => {
    const { error: e } = await admin.from('code_reviews').update({ gate_error }).eq('id', m.review_id).eq('org_id', m.org_id);
    if (e) {
      log('error', 'gate.marcar_error', { review: m.review_id, code: e.code ?? null });
      return intento <= REINTENTOS_ESTADO ? reintento() : 'ack';
    }
    log('warn', 'gate.no_publicado', { review: m.review_id, motivo: gate_error, intento });
    return 'ack';
  };
  // Ni un despliegue de prueba ni local escriben en GitHub.
  if (env.VG_ENV !== 'production') return marcar('dry_run');
  const override = typeof rev.gate_override_at === 'string' && rev.gate_override_at ? rev.gate_override_at : null;
  if (rev.status === 'done' && rev.gate_blocking == null && !override) return marcar('sin_calculo');   // se encendió después
  let con: Awaited<ReturnType<typeof conexionAccion>>;
  try { con = await conexionAccion(admin, m.org_id, String(cfg.connection_id)); } catch { return reintento(); }
  if (!con.ok) return marcar(con.motivo);
  const sha = String(rev.head_sha ?? '');
  if (!SHA.test(sha)) return marcar('sha_invalido');
  const accion = con.accion;
  const umbral: UmbralBloqueo = cfg.gate_min === 'high' ? 'high' : 'critical';
  const reglas = (Array.isArray(rev.gate_findings) ? rev.gate_findings : []).map((f) => obj(f).rule_id)
    .filter((x): x is string => typeof x === 'string');
  const e = estadoCommit({ status: String(rev.status), partial: rev.partial === true,
    error_code: typeof rev.error_code === 'string' ? rev.error_code : null,
    gate_blocking: typeof rev.gate_blocking === 'number' ? rev.gate_blocking : null, reglas, gate_override_at: override },
  umbral);
  const url = enlaceRevision(env, m.org_id, m.review_id);
  const cuerpo: CuerpoEstado = { state: e.state, description: e.description, context: CONTEXTO_BLOQUEO,
    ...(url ? { target_url: url } : {}) };
  // Cierre del PR (anexo): failure en un PR, interruptor encendido, token con «Pull requests: write», nada hecho aún con
  // ese PR en esta revisión y al menos un hallazgo NUEVO ≥ umbral. Con commits nuevos que mantienen la clave ya avisada no
  // hay nuevos: queda el ✗ y no se vuelve a cerrar un PR que alguien reabrió a mano.
  const n = rev.pr_number;
  const nuevos = nuevosBloqueo(rev.counts, umbral);
  const cerrar = e.state === 'failure' && rev.event === 'pull_request' && prValido(n) && cfg.gate_close_pr !== false
    && accion.caps.pull_requests === true && rev.gate_pr_action == null && nuevos > 0;

  let res: { estado: Escrito; cierre: Cierre | null };
  try {
    res = await withSecret(env, admin, { orgId: m.org_id, connectionId: accion.id, provider: 'github', kind: 'action' },
      async (token) => {
        const estado = await publicarEstado(token, accion.repo, sha, cuerpo);
        if (!estado.ok || !cerrar) return { estado, cierre: null };
        return { estado, cierre: await cerrarConCritico(admin, m, rev, token, accion.repo, n as number,
          textoCierrePr(nuevos, umbral, url)) };
      });
  } catch (x) {
    if (x instanceof ApiError) return marcar('sin_token');   // withSecret: la conexión ya no tiene secreto
    throw x;
  }

  const r = res.estado;
  if (!r.ok) {
    if (TRANSITORIO_GH.has(r.code)) {
      if (intento <= REINTENTOS_ESTADO) {
        log('warn', 'gate.reintento', { review: m.review_id, code: r.code, intento });
        return reintento();
      }
      return marcar('red');
    }
    const ahora = new Date().toISOString();
    // config.gate_last_error es del TOKEN (401, 403, 404); un 422 es de ese commit y solo va en la revisión.
    const delToken = r.status === 401 ? 'token' : r.status === 403 ? 'forbidden' : r.status === 404 ? 'not_found' : null;
    if (delToken) {
      const { error: eg } = await admin.from('code_review_configs')
        .update({ gate_last_error: delToken, gate_last_error_at: ahora }).eq('id', String(cfg.id)).eq('org_id', m.org_id);
      if (eg) log('warn', 'gate.config_sin_marca', { review: m.review_id, code: eg.code ?? null });
    }
    if (r.status === 401) {
      const { error: en } = await admin.from('connections').update({ status: 'revoked', last_error: 'unauthorized',
        last_checked_at: ahora }).eq('id', accion.id).eq('org_id', m.org_id);
      if (en) log('warn', 'gate.conexion_sin_marca', { review: m.review_id, code: en.code ?? null });
    }
    return marcar(r.status === 401 ? 'unauthorized' : r.status === 403 ? 'forbidden' : r.status === 404 ? 'not_found'
      : r.status === 422 ? 'limite' : r.status === null ? 'red' : 'rechazado');
  }

  const { error: ep } = await admin.from('code_reviews').update({ gate_state: e.state,
    gate_published_at: new Date().toISOString(), gate_error: null }).eq('id', m.review_id).eq('org_id', m.org_id);
  if (ep) {
    // Publicado y sin anotar: otra entrega lo vuelve a publicar (inofensivo) y lo anota.
    log('error', 'gate.publicado_sin_marca', { review: m.review_id, code: ep.code ?? null });
    if (intento <= REINTENTOS_ESTADO) return reintento();
  }
  if (cfg.gate_last_error) {
    const { error: eg } = await admin.from('code_review_configs').update({ gate_last_error: null, gate_last_error_at: null })
      .eq('id', String(cfg.id)).eq('org_id', m.org_id);
    if (eg) log('warn', 'gate.config_sin_limpiar', { review: m.review_id, code: eg.code ?? null });
  }
  log('info', 'gate.publicado', { review: m.review_id, state: e.state, sha7: sha.slice(0, 7), ms: Date.now() - t0, intento });

  const k = res.cierre;
  if (!k || k.tipo === 'omitido') {
    if (k) log('info', 'gate.pr_sin_cerrar', { review: m.review_id, motivo: k.motivo });
    return 'ack';
  }
  if (k.tipo === 'fallo' && k.transitorio && intento <= REINTENTOS_ESTADO) {
    log('warn', 'gate.pr_reintento', { review: m.review_id, code: k.code, intento });
    return reintento();
  }
  const cambio = k.tipo === 'cerrado' ? { gate_pr_action: 'closed', gate_pr_error: null }
    : { gate_pr_action: 'close_failed', gate_pr_error: k.code };
  const { error: ek } = await admin.from('code_reviews').update(cambio).eq('id', m.review_id).eq('org_id', m.org_id)
    .is('gate_pr_action', null);
  if (ek) log('error', 'gate.pr_sin_marca', { review: m.review_id, code: ek.code ?? null });
  if (k.tipo === 'cerrado') avisoPrCerrado(m, n as number, k.comentado);
  else log('warn', 'gate.pr_cierre_error', { review: m.review_id, code: k.code });
  return 'ack';
}

/** DLQ del paso 'estado': gate_error 'dlq' si aún no tenía otro motivo. En P0 el check queda en «Expected» (bloqueado,
 *  falla cerrado). Si no se puede escribir, retry. */
export async function cierreEstadoDlq(env: CloudflareBindings, m: MsgRevision): Promise<RespuestaCola> {
  const { error } = await db(env).from('code_reviews').update({ gate_error: 'dlq' }).eq('id', m.review_id)
    .eq('org_id', m.org_id).is('gate_error', null);
  if (error) {
    log('error', 'gate.dlq_error', { review: m.review_id, code: error.code ?? null });
    return { retry: 10 };
  }
  log('warn', 'gate.dlq', { review: m.review_id });
  return 'ack';
}
