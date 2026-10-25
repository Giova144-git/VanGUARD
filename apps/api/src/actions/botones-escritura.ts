import { Severity } from '@vanguard/contracts';
import {
  botonesAprobacion, codigoRevision, issueDeRevision, SEV_RANK, TEXTO_BAJO_ATAQUE_YA_RETIRADO, TEXTO_BOTON_VENCIDO,
  TEXTO_CONFIRMAR_ISSUE, TEXTO_YA_CONFIRMADO, textoBajoAtaqueActivo, textoConfirmarReabrir, textoIssueCreado,
  textoNoSePudo, textoPrReabierto, TEXTOS_CANCELADO, type MotivoNoSePudo,
} from '@vanguard/core';
import { db } from '../lib/db.ts';
import { log } from '../lib/log.ts';
import { cuerpoInteractivo, enviarKapso, KapsoError, kapsoConfigurado, type MensajeKapso } from '../notify/kapso.ts';
import { crearIssue, reabrirPr } from '../revision/acciones-pr.ts';
import {
  ACCION_APROBACION_ESCRITURA, COLUMNAS_INCIDENTE_BLOQUEO, esContactoVerificado, ETAPA_BOTON, hashNonce,
  leerIncidenteBloqueo, nuevoNonce, peorHallazgo, VIDA_BOTON_MS, type Boton, type ConfirmarEscritura,
  type ResultadoEscritura,
} from './approvals.ts';
import type { AprobacionCanjeada } from './block-ip.ts';
import {
  executeUnderAttack, leerParamsBajoAtaque, proponerBajoAtaque, type MotivoPropuestaBajoAtaque,
} from './under-attack.ts';

// Botones que ESCRIBEN en sistemas del cliente (asignaciones/avisos-whatsapp-botones.md, regla 2): «Crear issue» (iss)
// del aviso de revisión, «Reabrir el PR» (rpr) del aviso «VanGUARD cerró el PR» y «Modo bajo ataque» (uat) del 2.º
// mensaje del ataque. Van en DOS pasos, como «Bloquear IP»: el botón del aviso (fila de approvals con etapa 'proponer')
// → canje → guardas → dos filas ok/no nuevas del mismo group (etapa confirmar/cancelar, 10 min, solo sha256 del nonce) y
// el interactivo «Sí, crear|reabrir|activar» / «Cancelar» al remitente. ok → la acción real (crearIssue y reabrirPr de
// revision/acciones-pr.ts, executeUnderAttack de actions/under-attack.ts) y «Hecho: …» o «No se pudo: …»; no → las
// hermanas quedan usadas. El canje del ok/no lo hace canjearBotonBloqueo (un solo sitio para esos prefijos), que pasa aquí
// la fila canjeada (confirmarEscritura). Guardas de siempre: nonce de un solo uso (vg_redeem_approval), recipient =
// remitente, contacto VERIFICADO de la org de la fila (si no, no se le contesta: respeta su BAJA), el código del botón es
// el de su revisión o su incidente y fuera de producción no se canjea nada (dry_run). Ningún texto de terceros: los de
// core. Nunca lanzan; E31 manda `texto` (con RL_WA) si no es null.

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const REMITENTE = /^[1-9][0-9]{7,14}$/;
const MAX_PR = 2_147_483_647;
const prValido = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_PR;
const codigoDe = (id: string): string | null => { try { return codigoRevision(id); } catch { return null; } };
type Escritura = keyof typeof ACCION_APROBACION_ESCRITURA;
const ESCRITURA_DE_KIND: Readonly<Record<string, Escritura>> = {
  create_issue: 'iss', reopen_pr: 'rpr', under_attack_on: 'uat',
};

export type CanjeEscritura = { resultado: ResultadoEscritura; texto: string | null };
const r = (resultado: ResultadoEscritura, texto: string | null = null): CanjeEscritura => ({ resultado, texto });

/** Peor caso de subpeticiones de canjearBotonPropuesta (E31 lo reserva antes y suma aparte RL_WA y el envío de `texto`):
 *  iss/rpr: canje 1 + revisión y contacto 2 + insert ok/no 1 + interactivo 2 + borrado si falla 1 = 7 (sin canje: 1 +
 *  contacto en alguna org 1); uat: canje 1 + incidente y contacto 2 + proponerBajoAtaque por WhatsApp ≤ 13 = 16. */
export const COSTE_BOTON_PROPUESTA = 16;
/** Peor caso del ok/no de una escritura, contado desde el canje de canjearBotonBloqueo: canje 1 + revisión o incidente y
 *  contacto 2 + (iss: hermanas 1 + crearIssue ≤ 10 + marca 1 | rpr: hermanas 1 + reabrirPr ≤ 11 + marca 1 | uat:
 *  executeUnderAttack ≤ 16 | no: hermanas y la propia 1) ≤ 19, con 1 de margen. E31 reserva el mayor de este y
 *  COSTE_BOTON_BLOQUEO. */
export const COSTE_BOTON_CONFIRMACION = 20;

// Motivo corto de crearIssue / reabrirPr (acciones-pr.ts) → «No se pudo: …» (los de GitHub, por su código HTTP).
const MOTIVO_GH: Readonly<Record<string, MotivoNoSePudo>> = {
  dry_run: 'dry_run', no_encontrada: 'otra_revision', sin_token: 'sin_token', otro_repo: 'otro_repo',
  repo_invalido: 'otro_repo', sin_permiso_issues: 'sin_permiso_issues', sin_permiso_pr: 'sin_permiso_pr',
  sin_credencial: 'sin_credencial',
  unauthorized: 'gh_token', forbidden: 'gh_permiso', not_found: 'gh_no_encontrado', rechazado: 'gh_rechazo', red: 'gh_red',
  no_es_pr: 'no_es_pr', ya_abierto: 'ya_abierto', no_cerrado: 'no_cerrado', texto_rechazado: 'texto_rechazado',
};
// Rechazos de proponerBajoAtaque (la misma tabla de §5 que E56) → «No se pudo: …».
const MOTIVO_UAT: Readonly<Partial<Record<MotivoPropuestaBajoAtaque, MotivoNoSePudo>>> = {
  sin_cupo: 'cf_cupo', rechazada_por_cloudflare: 'cf_rechazo', no_action_connection: 'sin_conexion_cf',
  sin_permiso: 'cf_permiso', token_invalido: 'cf_token', sin_credencial: 'sin_credencial',
  already_active: 'bajo_ataque_activo', in_progress: 'bajo_ataque_en_curso', escrita: 'error',
};

/** El hallazgo nuevo más grave con su archivo y línea (para el issue) y cuántos más trae la revisión. */
type Peor = { rule_id: string; severity: Severity; resource: string | null };
function peorConRecurso(x: unknown): { h: Peor; otros: number } | null {
  let peor: Peor | null = null;
  let n = 0;
  for (const f of (Array.isArray(x) ? x : []).map(obj)) {
    const rule_id = str(f.rule_id), sev = Severity.safeParse(f.severity);
    if (!rule_id || !sev.success) continue;
    n++;
    if (!peor || SEV_RANK[sev.data] > SEV_RANK[peor.severity]) {
      peor = { rule_id, severity: sev.data, resource: str(f.resource) };
    }
  }
  return peor ? { h: peor, otros: n - 1 } : null;
}

async function enviar(env: CloudflareBindings, m: MensajeKapso, rid: string): Promise<boolean> {
  try {
    await enviarKapso(env, m);
    return true;
  } catch (e) {
    log('warn', 'kapso.confirmacion_envio_error', { rid,
      code: e instanceof KapsoError ? e.detalle ?? e.code : 'unavailable' });
    return false;
  }
}

/** E31 · iss y rpr (y uat, que delega en proponerBajoAtaque): canje del botón del aviso y, si todo casa, la confirmación
 *  ok/no al remitente. iss exige hallazgos nuevos; rpr, un PR que VanGUARD cerró y que nadie reabrió (gate_pr_action
 *  'closed': reabierto a mano o desde VanGUARD → «ya está abierto»). Canje sin filas → TEXTO_BOTON_VENCIDO solo a un
 *  contacto verificado de alguna org. */
export async function canjearBotonPropuesta(env: CloudflareBindings, b: Boton, remitente: string, rid: string,
  ahora = Date.now()): Promise<CanjeEscritura> {
  if (b.accion !== 'iss' && b.accion !== 'rpr' && b.accion !== 'uat') return r('tipo_distinto');
  if (!REMITENTE.test(remitente)) return r('remitente_invalido');
  if (env.VG_ENV !== 'production') return r('dry_run');   // S15 15.3: ni se canjea ni se propone fuera de producción
  let verificado = false;
  try {
    const admin = db(env);
    const { data, error } = await admin.rpc('vg_redeem_approval',
      { p_approval: null, p_nonce_hash: await hashNonce(b.nonce), p_recipient: remitente });
    if (error) {
      log('error', 'kapso.canje_error', { rid, code: error.code ?? null });
      return r('error');
    }
    const fila = obj(Array.isArray(data) ? data[0] : data);
    const org = str(fila.org_id);
    if (!org || !str(fila.id)) {
      return r('sin_canje', await esContactoVerificado(env, remitente, rid) ? TEXTO_BOTON_VENCIDO : null);
    }
    const uat = b.accion === 'uat';
    const origen = str(uat ? fila.incident_id : fila.code_review_id);
    const [o, c] = await Promise.all([
      !origen ? null : uat
        ? admin.from('incidents').select(COLUMNAS_INCIDENTE_BLOQUEO).eq('id', origen).eq('org_id', org).maybeSingle()
        : admin.from('code_reviews').select('id, event, pr_number, gate_pr_action, new_findings').eq('id', origen)
          .eq('org_id', org).maybeSingle(),
      admin.from('contacts').select('id, verified_at').eq('org_id', org).eq('phone_e164', `+${remitente}`).maybeSingle(),
    ]);
    if (o?.error || c.error) {
      log('error', 'kapso.boton_lectura_error', { rid, code: o?.error?.code ?? c.error?.code ?? null });
      return r('error');
    }
    if (!str(obj(c.data).verified_at)) return r('no_contacto');
    verificado = true;
    if (fila.channel !== 'whatsapp' || fila.action_kind !== ACCION_APROBACION_ESCRITURA[b.accion]
      || obj(fila.params).etapa !== ETAPA_BOTON.blk || !origen) {
      return r('tipo_distinto', textoNoSePudo('tipo_distinto'));
    }

    if (uat) {
      const inc = leerIncidenteBloqueo(o?.data);
      if (!inc || inc.code !== b.codigo) return r('otro_incidente', textoNoSePudo('otro_incidente'));
      const x = await proponerBajoAtaque(env, { orgId: org, incidente: inc, scope: 'host', entrega: 'whatsapp',
        telefono: remitente, rid, ahora });
      if (x.ok) return r('propuesto');                       // la respuesta es el propio interactivo «Sí, activar»
      if (x.motivo === 'sin_entrega') return r('sin_entrega');
      return r('rechazado', textoNoSePudo(MOTIVO_UAT[x.motivo] ?? 'bajo_ataque_no_aplica'));
    }

    const rev = obj(o?.data);
    const revId = str(rev.id);
    if (!revId || codigoDe(revId) !== b.codigo) return r('otra_revision', textoNoSePudo('otra_revision'));
    let cuerpo = TEXTO_CONFIRMAR_ISSUE;
    if (b.accion === 'iss') {
      if (!peorHallazgo(rev.new_findings)) return r('sin_hallazgos', textoNoSePudo('sin_hallazgos'));
    } else {
      const n = rev.pr_number;
      if (rev.event !== 'pull_request' || !prValido(n)) return r('no_es_pr', textoNoSePudo('no_es_pr'));
      // Respeto a la decisión humana (anexo, punto 4): reabierto a mano o ya reabierto desde VanGUARD → nada que hacer.
      if (rev.gate_pr_action === 'reopened' || rev.gate_pr_action === 'reopened_by_human') {
        return r('ya_abierto', textoNoSePudo('ya_abierto'));
      }
      if (rev.gate_pr_action !== 'closed') return r('no_cerrado', textoNoSePudo('no_cerrado'));
      cuerpo = textoConfirmarReabrir(n);
    }
    if (!kapsoConfigurado(env)) return r('sin_entrega');

    // Las dos filas ok/no del mismo group (cada una con su id, para borrarlas si el envío falla).
    const pide = b.accion;
    const group = crypto.randomUUID();
    const n = { ok: nuevoNonce(), no: nuevoNonce() };
    const botones = botonesAprobacion(b.codigo, n, pide);   // valida código y nonces antes de escribir nada
    const expires_at = new Date(ahora + VIDA_BOTON_MS).toISOString();
    const filas = await Promise.all((['ok', 'no'] as const).map(async (k) => ({ id: crypto.randomUUID(), org_id: org,
      code_review_id: revId, action_kind: ACCION_APROBACION_ESCRITURA[pide], channel: 'whatsapp', recipient: remitente,
      nonce_hash: await hashNonce(n[k]), expires_at, params: { group, etapa: ETAPA_BOTON[k] } })));
    const { error: ei } = await admin.from('approvals').insert(filas);
    if (ei) {
      log('error', 'kapso.confirmacion_insert_error', { rid, code: ei.code ?? null });
      return r('error', textoNoSePudo('error'));
    }
    const m = cuerpoInteractivo(`+${remitente}`, { header: pide === 'iss' ? 'Crear issue · GitHub' : 'Reabrir el PR · GitHub',
      body: cuerpo, footer: `Revisión #${b.codigo} · VanGUARD`, botones });
    if (!await enviar(env, m, rid)) {
      const { error: eb } = await admin.from('approvals').delete().in('id', filas.map((f) => f.id)).eq('org_id', org);
      if (eb) log('warn', 'kapso.confirmacion_borrado_error', { rid, code: eb.code ?? null });
      return r('sin_entrega');
    }
    return r('propuesto');
  } catch (e) {
    log('error', 'kapso.boton_escritura_error', { rid, name: e instanceof Error ? e.name : typeof e });
    return r('error', verificado ? textoNoSePudo('error') : null);
  }
}

/** ok/no de iss, rpr y uat: la fila ya viene canjeada por canjearBotonBloqueo (un solo uso, recipient = remitente, no
 *  vencida). Exige contacto verificado de su org, la etapa del botón y el código de su revisión o incidente. ok iss →
 *  crearIssue con el texto fijo de issueDeRevision y whatsapp_action issue_created; ok rpr → reabrirPr y pr_reopened; ok
 *  uat → executeUnderAttack (marca él las hermanas) con la hora de fin. no → las hermanas vivas y sin usar del group quedan
 *  usadas con canceled:true; si la confirmación ganó antes (no queda ninguna), lo dice en vez de «Cancelado». */
export const confirmarEscritura: ConfirmarEscritura = async (env, fila, b, remitente, rid, ahora) => {
  const accion = ESCRITURA_DE_KIND[String(fila.action_kind)];
  const org = str(fila.org_id), id = str(fila.id);
  if (!accion || !org || !id || (b.accion !== 'ok' && b.accion !== 'no')) return r('tipo_distinto');
  const uat = accion === 'uat';
  const origen = str(uat ? fila.incident_id : fila.code_review_id);
  const params = obj(fila.params);
  let verificado = false;
  try {
    const admin = db(env);
    const [o, c] = await Promise.all([
      !origen ? null : uat ? admin.from('incidents').select('id, code').eq('id', origen).eq('org_id', org).maybeSingle()
        : admin.from('code_reviews').select('id, new_findings').eq('id', origen).eq('org_id', org).maybeSingle(),
      admin.from('contacts').select('id, verified_at').eq('org_id', org).eq('phone_e164', `+${remitente}`).maybeSingle(),
    ]);
    if (o?.error || c.error) {
      log('error', 'kapso.boton_lectura_error', { rid, code: o?.error?.code ?? c.error?.code ?? null });
      return r('error');
    }
    if (!str(obj(c.data).verified_at)) return r('no_contacto');
    verificado = true;
    if (fila.channel !== 'whatsapp' || params.etapa !== ETAPA_BOTON[b.accion] || !origen) {
      return r('tipo_distinto', textoNoSePudo('tipo_distinto'));
    }
    const dato = obj(o?.data);
    const codigo = uat ? str(dato.code) : codigoDe(str(dato.id) ?? '');
    if (!codigo || codigo !== b.codigo) {
      return uat ? r('otro_incidente', textoNoSePudo('otro_incidente')) : r('otra_revision', textoNoSePudo('otra_revision'));
    }
    const t = new Date(ahora).toISOString();
    const group = str(params.group);

    if (b.accion === 'no') {
      const [g, p] = await Promise.all([
        group ? admin.from('approvals').update({ used_at: t, result: { canceled: true } }).eq('org_id', org)
          .eq('params->>group', group).is('used_at', null).gt('expires_at', t).select('id') : null,
        admin.from('approvals').update({ result: { canceled: true } }).eq('id', id).eq('org_id', org),
      ]);
      if (g?.error || p.error) {
        log('warn', 'kapso.cancelar_error', { rid, code: g?.error?.code ?? p.error?.code ?? null });
        return r('error', textoNoSePudo('error'));
      }
      // Sin hermana viva que cancelar: el «Sí, …» ya se canjeó (su acción sigue su curso).
      if (group && !(Array.isArray(g?.data) && g.data.length)) return r('ya_confirmado', TEXTO_YA_CONFIRMADO);
      return r('cancelado', TEXTOS_CANCELADO[accion]);
    }

    if (uat) {
      const host = leerParamsBajoAtaque(params)?.target ?? '';
      const x = await executeUnderAttack(env, fila as unknown as AprobacionCanjeada, { rid, ahora });
      if (x.tipo === 'ejecutado') {
        if (!x.repetido) return r('bajo_ataque_activo', textoBajoAtaqueActivo(host, x.expires_at ?? ahora));
        return r('ya_estaba', x.expires_at ? textoBajoAtaqueActivo(host, x.expires_at, true) : TEXTO_BAJO_ATAQUE_YA_RETIRADO);
      }
      // Los errores de executeUnderAttack son frases nuestras; aquí solo se elige el motivo fijo.
      if (x.tipo === 'rechazado') {
        return r('rechazado', textoNoSePudo(x.status === 403 ? 'cf_permiso' : x.status === 401 ? 'cf_token'
          : /reglas de configuración/.test(x.error) ? 'cf_cupo' : /token de acciones/.test(x.error) ? 'sin_credencial'
          : 'cf_rechazo'));
      }
      if (x.tipo === 'caido') return r('caido', textoNoSePudo('cf_red'));
      if (x.tipo === 'en_curso') return r('en_curso', textoNoSePudo('bajo_ataque_en_curso'));
      return r('error', textoNoSePudo('error'));
    }

    // iss / rpr: antes de GitHub, la hermana «Cancelar» queda usada (como E21 con las del bloqueo).
    if (group) {
      const { error: eh } = await admin.from('approvals').update({ used_at: t }).eq('org_id', org)
        .eq('params->>group', group).is('used_at', null);
      if (eh) log('warn', 'kapso.hermanas_error', { rid, code: eh.code ?? null });
    }
    const marcar = async (whatsapp_action: 'issue_created' | 'pr_reopened') => {
      const { error: e } = await admin.from('code_reviews').update({ whatsapp_action, whatsapp_action_at: t })
        .eq('id', origen).eq('org_id', org);
      if (e) log('warn', 'kapso.revision_marca_error', { rid, code: e.code ?? null });
    };
    if (accion === 'rpr') {
      const x = await reabrirPr(env, admin, org, origen, { rid, via: 'whatsapp' });
      if (!x.ok) return r('no_se_pudo', textoNoSePudo(MOTIVO_GH[x.motivo] ?? 'error'));
      await marcar('pr_reopened');
      return r('pr_reabierto', textoPrReabierto(x.numero));
    }
    const peor = peorConRecurso(dato.new_findings);
    if (!peor) return r('sin_hallazgos', textoNoSePudo('sin_hallazgos'));
    const origenApp = (env.APP_ORIGIN ?? '').replace(/\/+$/, '');
    const issue = issueDeRevision(peor.h, origenApp ? `${origenApp}/o/${org}/codebase?revision=${origen}` : '', peor.otros);
    const x = await crearIssue(env, admin, org, origen, issue, { rid, via: 'whatsapp' });
    if (!x.ok) return r('no_se_pudo', textoNoSePudo(MOTIVO_GH[x.motivo] ?? 'error'));
    await marcar('issue_created');
    return r('issue_creado', textoIssueCreado(x.numero, x.url));
  } catch (e) {
    log('error', 'kapso.confirmacion_error', { rid, name: e instanceof Error ? e.name : typeof e });
    return r('error', verificado ? textoNoSePudo('error') : null);
  }
};
