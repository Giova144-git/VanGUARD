import {
  botonesPrCerrado, codigoRevision, CONTEXTO_BLOQUEO, estadoCommit, fueraDeVentanaDemo, nuevosBloqueo, textoCierrePr,
  textoPrCerrado, TOPES_REVISION, type EstadoCommit, type UmbralBloqueo,
} from '@vanguard/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { filasBotonesRevision, nuevoNonce, peorHallazgo } from '../actions/approvals.ts';
import type { MsgRevision } from '../jobs.ts';
import { withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { ventanaAbierta } from '../lib/verificacion.ts';
import {
  cuerpoInteractivo, cuerpoTexto, enmascararTelefono, enviarKapso, KapsoError, kapsoConfigurado, type MensajeKapso,
} from '../notify/kapso.ts';
import type { RespuestaCola } from '../wiki/pasos.ts';
import { cambiarEstadoPr, comentarPr, conexionAccion, escribirGh, motivoGh, TRANSITORIO_GH, type Escrito }
  from './acciones-pr.ts';

// Paso 'estado' de la revisión de código (asignaciones/bloqueo-merge-criticos.md §2.4 y el anexo bloqueo-merge-cierre-
// pr.md): publica en GitHub el estado de commit «VanGUARD» de una revisión cerrada (✗ si lo añadido trae un crítico, o si
// no se pudo leer entero; ✓ si no) y, en un PR con hallazgos críticos nuevos (o con críticos que VanGUARD aún no atendió
// en ese PR), lo comenta con texto fijo y lo CIERRA (en repos privados gratuitos la protección de rama no exige checks: lo
// único que impide fusionar en cualquier plan es que el PR esté cerrado). Mensaje {kind:'review', paso:'estado'}: lo
// encola el paso diff al cerrar (y fallar(), yaReclamada, la DLQ y E54) solo con el bloqueo encendido. El repo sale de
// connections.meta del token de acciones, el SHA de la fila; nada sale de un payload. Nunca lanza sin decidir: ack o
// retry, como diff.
// Subpeticiones: revisión 1 + config 1 + conexiones 1 + secreto 1 + llaves ≤ 2 (en frío) + POST ≤ 4 (saltos) + cierre 1
// + config 1 (o, con 401, config y conexión 2) ≤ 13; con el cierre del PR, + historial del PR 1 + reclamo 1 + comentario
// ≤ 4 + PATCH ≤ 4 + resultado 1 ≤ 24; y el WhatsApp «VanGUARD cerró el PR» (avisoPrCerrado) ≤ 15 → ≤ 39 de 40. Bloqueo
// apagado: revisión 1 + config 1 y ack, sin escribir nada.

export const REINTENTOS_ESTADO = 2;
const SHA = /^[0-9a-f]{40}$/;
const MAX_PR = 2_147_483_647;
const COLUMNAS = 'id, config_id, event, pr_number, status, partial, error_code, head_sha, counts, gate_blocking, '
  + 'gate_findings, gate_override_at, gate_pr_action, gate_pr_at, branch, new_findings';
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
const HISTORIAL_PR = 100;

// Decide con el historial de ese PR (1 subpetición, las 100 más nuevas). Cierra la revisión TERMINADA (done) más nueva:
// una más vieja que termine tarde no cierra un PR que otra ya revisó, pero una más nueva aún en cola o en curso no la
// frena (con dos pushes seguidos la 1.ª se apartaba y la 2.ª, que ya no ve la clave como nueva por 0013, tampoco
// cerraba), ni una fallida (falla cerrado, D2). Con hallazgos NUEVOS ≥ umbral cierra siempre (punto 4: commits nuevos con
// un crítico nuevo); sin nuevos, solo si VanGUARD aún no hizo nada con ese PR: ninguna revisión suya tiene gate_pr_action
// (cerrado, reabierto a mano o desde VanGUARD, cierre fallido) ni «Dar por bueno». Así la misma clave no vuelve a cerrar
// lo que una persona reabrió o aprobó. Reclamo CAS por gate_pr_at: el comentario sale UNA vez por revisión aunque el paso
// se repita o lleguen dos mensajes; si un intento anterior reclamó y cayó antes de anotar el resultado, este solo vuelve
// a cerrar (cerrar un PR cerrado no cambia nada). Si el comentario falla, igual cierra.
async function cerrarConCritico(admin: SupabaseClient, m: MsgRevision, rev: Obj, token: string, repo: string, n: number,
  nuevos: number, umbral: UmbralBloqueo, url: string): Promise<Cierre> {
  const { data, error } = await admin.from('code_reviews').select('id, status, gate_pr_action, gate_override_at')
    .eq('org_id', m.org_id).eq('config_id', String(rev.config_id)).eq('event', 'pull_request').eq('pr_number', n)
    .order('created_at', { ascending: false }).limit(HISTORIAL_PR);
  if (error) return { tipo: 'fallo', code: 'base', transitorio: true };
  const historial = (Array.isArray(data) ? data : []).map(obj);
  if (historial.find((f) => f.status === 'done')?.id !== rev.id) return { tipo: 'omitido', motivo: 'no_es_la_ultima' };
  if (nuevos === 0 && historial.some((f) => f.gate_pr_action != null || f.gate_override_at != null)) {
    return { tipo: 'omitido', motivo: 'ya_atendido' };
  }
  // Sin nuevos, el número es el de bloqueantes de lo añadido (gate_blocking > 0: el estado es failure).
  const texto = textoCierrePr(nuevos > 0 ? nuevos : Number(rev.gate_blocking), umbral, url);
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

// ── WhatsApp «VanGUARD cerró el PR» (asignaciones/avisos-whatsapp-botones.md) ────────────────────────────────────────
/** Contactos del aviso del PR cerrado: ≤ 5 (como E26), y así el paso entero cabe en 40 subpeticiones. */
export const MAX_AVISO_PR = 5;
const E164 = /^\+[1-9][0-9]{7,14}$/;
export type DatosAvisoPr = {
  pr: number; comentado: boolean; rama: unknown; k: number; umbral: UmbralBloqueo; nuevos: unknown; silencio: unknown;
};

/** Aviso «VanGUARD cerró el PR #{n} hacia {rama}: {k} crítico(s) nuevo(s). Corrige, rota las claves y vuelve a
 *  abrirlo.» (texto FIJO de core: número y rama validados) con «Reabrir el PR» (rpr → confirmación, reabrirPr),
 *  «Enviarme el arreglo» (fix, si la revisión trae hallazgos nuevos) y «Silenciar repo 1 h» (rvs). Lo llama pasoEstado
 *  UNA vez por cierre: solo tras ganar el CAS que anota gate_pr_action 'closed' (una reentrega no repite; un fallo aquí
 *  no se reintenta: el aviso se pierde antes que salir dos veces). A los contactos con WhatsApp VERIFICADO y la ventana de
 *  24 h abierta (fuera de ella no se manda: queda en la app), ≤ MAX_AVISO_PR. Se calla si el repo está silenciado
 *  (code_review_configs.muted_until, botón rvs: el ✗ y el cierre ya ocurrieron), fuera de la ventana de avisos de la org
 *  de demo o con el cupo de avisos de revisión lleno (revisiones avisadas en la última hora sin contar ESTA: el aviso del
 *  cierre es de la misma revisión que el del paso 'aviso'). Sin fila en notifications: 0013 solo admite code_review_v1
 *  por revisión y destinatario (la del paso 'aviso'); el log lleva el resultado. Fuera de producción o sin Kapso, nada.
 *  Subpeticiones: contactos, org y cupo 3 + ventana de demo 1 + approvals 1 (todas en un insert) + envío·2 por contacto
 *  ≤ 15. Nunca lanza. */
export async function avisoPrCerrado(env: CloudflareBindings, admin: SupabaseClient, m: MsgRevision, d: DatosAvisoPr):
  Promise<void> {
  log('info', 'gate.pr_cerrado', { review: m.review_id, pr: d.pr, comentado: d.comentado });
  const registro = { review: m.review_id, pr: d.pr };
  try {
    if (env.VG_ENV !== 'production' || !kapsoConfigurado(env)) {
      log('info', 'gate.aviso_pr_omitido', { ...registro, motivo: env.VG_ENV !== 'production' ? 'dry_run' : 'sin_config' });
      return;
    }
    const ahora = Date.now();
    const silencio = Date.parse(typeof d.silencio === 'string' ? d.silencio : '');
    if (Number.isFinite(silencio) && silencio > ahora) {
      log('info', 'gate.aviso_pr_omitido', { ...registro, motivo: 'silenciado' });
      return;
    }
    const texto = textoPrCerrado(d.pr, d.rama, d.k, d.umbral);   // valida el número antes de leer nada más
    const [c, o, n] = await Promise.all([
      admin.from('contacts').select('id, phone_e164, whatsapp, priority, verified_at, wa_last_inbound_at')
        .eq('org_id', m.org_id).eq('whatsapp', true).order('priority').limit(10),
      admin.from('orgs').select('is_demo').eq('id', m.org_id).maybeSingle(),
      admin.from('code_reviews').select('id', { count: 'exact', head: true }).eq('org_id', m.org_id)
        .eq('alert_state', 'sent').neq('id', m.review_id).gte('notified_at', new Date(ahora - 3600_000).toISOString()),
    ]);
    if (c.error || o.error || n.error || !o.data) {
      log('warn', 'gate.aviso_pr_lectura_error', { ...registro,
        code: c.error?.code ?? o.error?.code ?? n.error?.code ?? null });
      return;
    }
    const demo = (o.data as Obj).is_demo === true;
    if (demo) {
      // M10 de §02.5.1: la ventana de alertas de la org de demo; si no se puede leer, cerrada (falla hacia no avisar).
      const { data: cfg } = await admin.from('app_config').select('value').eq('key', 'demo_alertas_hasta').maybeSingle();
      const hasta = obj(cfg).value;
      if (fueraDeVentanaDemo({ is_demo: true }, typeof hasta === 'string' ? hasta : null, new Date(ahora))) {
        log('info', 'gate.aviso_pr_omitido', { ...registro, motivo: 'fuera_de_ventana_demo' });
        return;
      }
    }
    if ((n.count ?? 0) >= (demo ? TOPES_REVISION.demo : TOPES_REVISION.normal)) {
      log('info', 'gate.aviso_pr_omitido', { ...registro, motivo: 'cap' });
      return;
    }
    const destinos = (Array.isArray(c.data) ? c.data : []).map(obj)
      .filter((x) => x.whatsapp === true && typeof x.verified_at === 'string' && typeof x.phone_e164 === 'string'
        && E164.test(x.phone_e164) && ventanaAbierta(env, x.wa_last_inbound_at, ahora))
      .sort((a, b) => Number(a.priority ?? 9) - Number(b.priority ?? 9)).slice(0, MAX_AVISO_PR)
      .map((x) => String(x.phone_e164));
    if (!destinos.length) {
      log('info', 'gate.aviso_pr_omitido', { ...registro, motivo: 'sin_contactos' });
      return;
    }

    // Un nonce por botón y contacto, y todas las filas en UN insert (cada fila con solo su sha256, 10 min).
    const code = codigoRevision(m.review_id);
    const conFix = peorHallazgo(d.nuevos) !== null;
    const porContacto = await Promise.all(destinos.map(async (tel) => {
      const nonces = { rpr: nuevoNonce(), fix: conFix ? nuevoNonce() : null, rvs: nuevoNonce() };
      const botones = botonesPrCerrado(code, nonces);   // valida código y nonces antes de escribir nada
      const filas = await filasBotonesRevision({ org_id: m.org_id, code_review_id: m.review_id, recipient: tel.slice(1),
        nonces, ahora });
      return { tel, botones, filas };
    }));
    const { error: ea } = await admin.from('approvals').insert(porContacto.flatMap((x) => x.filas));
    if (ea) log('warn', 'gate.aviso_pr_sin_botones', { ...registro, code: ea.code ?? null });
    // Si approvals falla, el aviso sale igual como texto: el aviso importa más que los botones.
    const res = await Promise.all(porContacto.map(async ({ tel, botones }) => {
      const mensaje: MensajeKapso = ea ? cuerpoTexto(tel, texto) : cuerpoInteractivo(tel, { body: texto, botones });
      const recipient_masked = enmascararTelefono(tel);
      try {
        await enviarKapso(env, mensaje);
        log('info', 'gate.aviso_pr_enviado', { ...registro, recipient_masked });
        return true;
      } catch (e) {
        log('warn', 'gate.aviso_pr_error', { ...registro, recipient_masked,
          code: e instanceof KapsoError ? e.detalle ?? e.code : 'unavailable' });
        return false;
      }
    }));
    log('info', 'gate.aviso_pr', { ...registro, enviados: res.filter(Boolean).length, contactos: res.length });
  } catch (e) {
    log('error', 'gate.aviso_pr_excepcion', { ...registro, name: e instanceof Error ? e.name : typeof e });
  }
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
    .select('id, connection_id, enabled, gate_enabled, gate_min, gate_last_error, gate_close_pr, muted_until')
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
  // Cierre del PR (anexo): failure en un PR, interruptor encendido, token con «Pull requests: write» y nada hecho aún con
  // ese PR en esta revisión; lo demás (la más nueva, nuevos o PR sin atender) lo decide cerrarConCritico con el historial.
  const n = rev.pr_number;
  const nuevos = nuevosBloqueo(rev.counts, umbral);
  const cerrar = e.state === 'failure' && rev.event === 'pull_request' && prValido(n) && cfg.gate_close_pr !== false
    && accion.caps.pull_requests === true && rev.gate_pr_action == null;

  let res: { estado: Escrito; cierre: Cierre | null };
  try {
    res = await withSecret(env, admin, { orgId: m.org_id, connectionId: accion.id, provider: 'github', kind: 'action' },
      async (token) => {
        const estado = await publicarEstado(token, accion.repo, sha, cuerpo);
        if (!estado.ok || !cerrar) return { estado, cierre: null };
        const cierre = await cerrarConCritico(admin, m, rev, token, accion.repo, n as number, nuevos, umbral, url);
        return { estado, cierre };
      });
  } catch (x) {
    if (!(x instanceof ApiError)) throw x;
    // withSecret lanza la MISMA ApiError('not_found') si falta el secreto y si falla la base (08006, plazo): como en el
    // paso diff, se reintenta y solo agotados los reintentos queda sin_token.
    if (intento <= REINTENTOS_ESTADO) {
      log('warn', 'gate.reintento', { review: m.review_id, code: 'sin_credencial', intento });
      return reintento();
    }
    return marcar('sin_token');
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
  const { data: anotada, error: ek } = await admin.from('code_reviews').update(cambio).eq('id', m.review_id)
    .eq('org_id', m.org_id).is('gate_pr_action', null).select('id');
  if (ek) {
    // Sin anotar, E47 no reconoce la reapertura a mano (casa desde 'closed') y otra revisión del PR volvería a cerrar:
    // otra entrega repite el estado y el PATCH (inofensivos; sin comentario, gate_pr_at ya está) y lo anota.
    log('error', 'gate.pr_sin_marca', { review: m.review_id, code: ek.code ?? null });
    return intento <= REINTENTOS_ESTADO ? reintento() : 'ack';
  }
  // El CAS no casó: otro mensaje de esta misma revisión (entrega al menos una vez, yaReclamada) ya lo anotó y avisó.
  if (!(Array.isArray(anotada) ? anotada.length : anotada)) {
    log('info', 'gate.pr_ya_anotado', { review: m.review_id });
    return 'ack';
  }
  if (k.tipo === 'cerrado') {
    // Sin nuevos, el número es el de bloqueantes de lo añadido (como el comentario de cerrarConCritico).
    await avisoPrCerrado(env, admin, m, { pr: n as number, comentado: k.comentado, rama: rev.branch, umbral,
      k: nuevos > 0 ? nuevos : Number(rev.gate_blocking), nuevos: rev.new_findings, silencio: cfg.muted_until });
  } else log('warn', 'gate.pr_cierre_error', { review: m.review_id, code: k.code });
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
