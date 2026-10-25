import { Hono, type Context } from 'hono';
import { GATE_CONTEXT, Id, MergeGateAction, MergeGateConfig, MergeGateError, MergeGatePut, MergeGateReview,
  MergeGateSaved, RespuestaEscritura, type CommitStatusState, type PermCheck } from '@vanguard/contracts';
import { esRepoDelProducto, estadoCommit, guardKey, superaBloqueo, TEXTO_PRUEBA_E53, type EstadoCommit, type UmbralBloqueo }
  from '@vanguard/core';
import { fingerprint, last4 } from '@vanguard/core/crypto';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { createConnectionWithSecret, fingerprintsOfOrg, rotarSecretoConexion, withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { activeKid, getKeys } from '../lib/keyring.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';
import { esHostProduccion } from '../mw/prod-host.ts';
import { mismoRepoGh, NOMBRE_REPO, reabrirPr, TRANSITORIO_GH } from '../revision/acciones-pr.ts';
import { enlaceRevision, publicarEstado } from '../revision/estado.ts';
import { encolarEstado } from '../revision/pasos.ts';
import { leerRama, sondeoEscrituraPr, sondeoNegativoEstados } from '../scans/repo.ts';

// Bloqueo de merge con críticos (asignaciones/bloqueo-merge-criticos.md §4.1 y el anexo bloqueo-merge-cierre-pr.md).
// E53 guarda la configuración y el token de ACCIONES de GitHub (2.º token: Commit statuses y, con el anexo, Pull
// requests; opcional Issues para el botón «Crear issue»). E54 es el «Deshacer» por commit («Dar por bueno» y su
// «Deshacer») y «Reabrir el PR». Las dos solo para owner/admin (anonReadOnly ya corta al anónimo). Las tablas son solo
// del servidor: todo con service_role y .eq('org_id'). El token nunca se registra ni se devuelve.
export const bloqueo = new Hono<AppEnv>();

type Fila = Record<string, unknown>;
const obj = (x: unknown): Fila => (x && typeof x === 'object' && !Array.isArray(x) ? x as Fila : {});
const isoN = (v: unknown) => (typeof v === 'string' && v ? iso(v) : null);
const RAMA = /^[A-Za-z0-9._/-]{1,100}$/;

// ── Forma de E45 (rutas/revision.ts) y de E53 ──────────────────────────────────────────────────────────────────────
export const COLUMNAS_GATE_CONFIG = 'gate_enabled, gate_min, gate_last_error, gate_close_pr';
export const COLUMNAS_GATE_REVISION = 'gate_blocking, gate_findings, gate_state, gate_error, gate_published_at, '
  + 'gate_override_at, gate_pr_action, gate_pr_error';
export const COLUMNAS_ESTADOS = 'id, status, last4, expires_at, meta, capabilities';

/** ¿Es esta conexión de lectura la del bloqueo? Con token de acciones, la de su mismo repo (varias-codebases.md §2.6,
 *  punto 4); sin él, la principal. En los demás repos E45 no trae `gate` y el FRONT no pinta la sección. */
export const esRepoDelBloqueo = (lecturaMeta: Fila, estados: Fila | null, principal: boolean): boolean =>
  (estados ? mismoRepoGh(obj(estados.meta), lecturaMeta) : principal);

/** MergeGateConfig (E45 y E53). state: off (revisión o bloqueo apagados) · needs_token (sin conexión de acciones activa)
 *  · error (gate_last_error: 401, 403 o 404 del token) · unchecked (publica; P0 no lee la protección). close_pr = el
 *  interruptor, solo si el token puede cerrar PR (can_close_pr). */
export function aGateConfig(cfg: Fila, estados: Fila | null): MergeGateConfig {
  const enabled = cfg.gate_enabled === true;
  const activa = estados?.status === 'active';
  const err = MergeGateError.safeParse(cfg.gate_last_error);
  const last_error = err.success ? err.data : null;
  const state = cfg.enabled !== true || !enabled ? 'off' : !activa ? 'needs_token' : last_error ? 'error' : 'unchecked';
  const can_close_pr = activa && obj(estados?.capabilities).pull_requests === true;
  return MergeGateConfig.parse({ enabled, min_severity: cfg.gate_min === 'high' ? 'high' : 'critical', state,
    context: GATE_CONTEXT,
    statuses_connection: estados ? { id: estados.id, status: estados.status,
      last4: typeof estados.last4 === 'string' && estados.last4 ? estados.last4.slice(-4) : null,
      expires_at: isoN(estados.expires_at) } : null,
    protection: null, last_error, close_pr: can_close_pr && cfg.gate_close_pr !== false, can_close_pr });
}

/** CodeReview.gate: solo si alguna columna del bloqueo tiene algo (con el bloqueo apagado nunca se escriben). */
export function aGateRevision(f: Fila): MergeGateReview | undefined {
  if (f.gate_blocking == null && f.gate_state == null && f.gate_error == null && f.gate_pr_action == null) return undefined;
  const r = MergeGateReview.safeParse({ blocking: typeof f.gate_blocking === 'number' ? f.gate_blocking : null,
    findings: Array.isArray(f.gate_findings) ? f.gate_findings : [], state: f.gate_state ?? null,
    error: f.gate_error ?? null, published_at: isoN(f.gate_published_at), override_at: isoN(f.gate_override_at),
    pr_action: f.gate_pr_action ?? null, pr_close_error: f.gate_pr_error ?? null });
  return r.success ? r.data : undefined;
}

// ── E53 · PUT /api/orgs/:org/code-review/gate · admin · P0 → MergeGateSaved ────────────────────────────────────────
const MENSAJE_EXCESO = 'Ese token tiene permisos de más (Contents, Administration). Crea uno con solo Commit statuses '
  + 'y Pull requests: Read and write (Issues, opcional).';

// Lo que VanGUARD YA sabe del último commit de la rama (§4.1 paso 6): nunca un ✓ sobre un commit que no se revisó con el
// bloqueo. Una revisión con gate_blocking → su estado real; una anterior a 0016 con max_severity ≥ umbral → el ✗ armado
// con counts y las reglas de sus hallazgos nuevos; cualquier otra cosa → pending «Prueba de conexión».
function estadoDePrueba(f: Fila | null, umbral: UmbralBloqueo): EstadoCommit {
  const pendiente: EstadoCommit = { state: 'pending', description: TEXTO_PRUEBA_E53 };
  if (!f || f.status !== 'done') return pendiente;
  const reglasDe = (xs: unknown) => (Array.isArray(xs) ? xs : []).map((x) => obj(x))
    .filter((x) => typeof x.rule_id === 'string' && superaBloqueo(String(x.severity), umbral)).map((x) => String(x.rule_id));
  const base = { status: 'done', partial: f.partial === true,
    error_code: typeof f.error_code === 'string' ? f.error_code : null, gate_override_at: isoN(f.gate_override_at) };
  if (typeof f.gate_blocking === 'number') {
    return estadoCommit({ ...base, gate_blocking: f.gate_blocking, reglas: reglasDe(f.gate_findings) }, umbral);
  }
  if (typeof f.max_severity === 'string' && superaBloqueo(f.max_severity, umbral)) {
    const c = obj(f.counts);
    const n = (typeof c.critical === 'number' ? c.critical : 0)
      + (umbral === 'high' && typeof c.high === 'number' ? c.high : 0);
    return estadoCommit({ ...base, gate_override_at: null, gate_blocking: Math.max(1, n), reglas: reglasDe(f.new_findings) },
      umbral);
  }
  return pendiente;
}

const conflicto = (mensaje: string, reason: string) => new ApiError('conflict', mensaje, { reason });

bloqueo.put('/orgs/:org/code-review/gate', requireAdmin, async (c) => {
  const b = await cuerpo(c, MergeGatePut);
  const env = c.env, orgId = c.get('orgId'), rid = c.get('rid');
  const admin = db(env);

  // 1) Conexiones GitHub de la org (lectura y acciones) en una consulta. La de lectura del bloqueo: la del repo del token
  //    de acciones si lo hay; si no, la principal (activa más antigua, B0).
  const { data: conns, error: ecn } = await admin.from('connections')
    .select('id, kind, status, meta, capabilities, last4, expires_at').eq('org_id', orgId).eq('provider', 'github')
    .in('kind', ['read', 'action']).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(20);
  if (ecn) {
    log('error', 'gate.conexiones_error', { rid, code: ecn.code ?? null });
    throw new ApiError('internal', 'No pudimos leer tus conexiones');
  }
  const filas = ((Array.isArray(conns) ? conns : []) as Fila[]);
  const estados = filas.find((f) => f.kind === 'action') ?? null;
  const lecturas = filas.filter((f) => f.kind === 'read');
  const lectura = estados ? lecturas.find((l) => mismoRepoGh(obj(estados.meta), obj(l.meta)))
    : lecturas.find((l) => l.status === 'active') ?? lecturas[0];
  if (!lectura) {
    if (estados) throw conflicto('El token de estados es de otro repo: quítalo en Conexiones', 'otro_repo');
    throw new ApiError('not_found', 'Conecta primero tu repo de GitHub');
  }
  if (lectura.status !== 'active') {
    throw conflicto('La conexión de GitHub no está activa: vuelve a probarla', 'conexion_inactiva');
  }
  const meta = obj(lectura.meta);
  const repo = typeof meta.repo_full_name === 'string' ? meta.repo_full_name : '';

  // 2) La config de revisión de esa conexión.
  const { data: leida, error: ecf } = await admin.from('code_review_configs')
    .select(`id, connection_id, enabled, branch, ${COLUMNAS_GATE_CONFIG}`).eq('org_id', orgId)
    .eq('connection_id', String(lectura.id)).maybeSingle();
  if (ecf) {
    log('error', 'gate.config_error', { rid, code: ecf.code ?? null });
    throw new ApiError('internal', 'No pudimos leer la revisión de código');
  }
  const cfg = leida as unknown as Fila | null;
  if (!cfg || (b.enabled && cfg.enabled !== true)) throw conflicto('Activa primero «Revisar cada push»', 'sin_revision');

  // 3) Guardas, sin llamar todavía a GitHub.
  const pat = b.statuses_pat?.trim();
  if ((pat || b.enabled) && esRepoDelProducto(repo)) {
    throw conflicto('No actives el bloqueo en el repo desde el que se despliega VanGUARD: si VanGUARD falla, no podrías '
      + 'fusionar su propio arreglo', 'repo_del_producto');
  }
  let estadosNueva: Fila | null = estados;
  let probe: { sha: string; state: CommitStatusState } | null = null;
  let checks: PermCheck[] = [];
  if (pat) {
    if (!esHostProduccion(c)) throw conflicto('Solo se publica en GitHub desde officialvanguard.com', 'solo_produccion');
    const { success } = await env.RL_COSTLY.limit({ key: `gate:${c.get('userId')}` });
    if (!success) throw new ApiError('rate_limited', 'Demasiados intentos; espera un minuto');
    const motivo = guardKey('github', pat);   // nunca se registra el valor
    if (motivo) {
      throw new ApiError('key_rejected', motivo === 'classic_github_pat'
        ? 'Los tokens clásicos de GitHub dan acceso a todos tus repos. Usa un token fine-grained de un solo repo.'
        : 'Ese token no es válido: cópialo de nuevo.', { reason: motivo });
    }
    if (!pat.startsWith('github_pat_')) {
      throw new ApiError('invalid_body', 'Revisa los campos marcados',
        { field_errors: { statuses_pat: ['No parece un token fine-grained de GitHub (empieza por github_pat_).'] } }, 400);
    }
    if (!NOMBRE_REPO.test(repo)) throw conflicto('No sabemos el repo: vuelve a probar la conexión de GitHub', 'repo_invalido');
    const rama = String(cfg.branch ?? '');
    if (!RAMA.test(rama)) throw conflicto('No sabemos la rama vigilada: vuelve a guardar la revisión', 'sin_rama');
    const keys = await getKeys(env, admin, await activeKid(admin));
    const [huella, huellas] = await Promise.all([fingerprint(keys, orgId, pat), fingerprintsOfOrg(env, admin, orgId)]);
    const duena = huellas.get(huella);
    if (duena && duena !== estados?.id) {
      throw new ApiError('key_rejected', 'Usa un token nuevo, solo con Commit statuses y Pull requests',
        { reason: 'same_token' });
    }

    // 4) El último commit de la rama, con el token de LECTURA.
    const r = await withSecret(env, admin, { orgId, connectionId: String(lectura.id), provider: 'github', kind: 'read' },
      (t) => leerRama(t, repo, rama));
    if (r.tipo === 'sin_rama') throw conflicto(`La rama ${rama} no existe en GitHub`, 'sin_rama');
    if (r.tipo === 'token') throw conflicto('Vuelve a conectar GitHub: el token de lectura ya no ve el repo', 'token_lectura');
    if (r.tipo === 'caido') throw new ApiError('provider_unavailable', 'GitHub no respondió. Vuelve a intentarlo.');

    // 5) Sondeo negativo (permisos de más) y de escritura de PR e issues, en paralelo y ANTES de escribir nada.
    const [neg, esc] = await Promise.all([sondeoNegativoEstados(pat, repo, rama, meta.private === true),
      sondeoEscrituraPr(pat, repo)]);
    if (neg.sobra.length) {
      throw new ApiError('key_rejected', MENSAJE_EXCESO, { reason: 'excess_scope', excess_permissions: neg.sobra });
    }
    if (neg.caido || esc.caido) throw new ApiError('provider_unavailable', 'GitHub no respondió. Vuelve a intentarlo.');

    // 6) Estado de prueba en el head con lo que VanGUARD ya sabe de ese commit (1 lectura).
    const umbral: UmbralBloqueo = b.min_severity;
    const { data: revs, error: erv } = await admin.from('code_reviews')
      .select('id, status, partial, error_code, max_severity, counts, new_findings, gate_blocking, gate_findings, '
        + 'gate_override_at')
      .eq('org_id', orgId).eq('config_id', String(cfg.id)).eq('head_sha', r.sha).order('created_at', { ascending: false })
      .limit(1);
    if (erv) throw new ApiError('internal', 'No pudimos leer la revisión de ese commit');
    const conocida = (Array.isArray(revs) ? obj(revs[0]) : obj(revs));
    const e = estadoDePrueba(Object.keys(conocida).length ? conocida : null, umbral);
    const origen = (env.APP_ORIGIN ?? '').replace(/\/+$/, '');
    const url = typeof conocida.id === 'string' ? enlaceRevision(env, orgId, conocida.id)
      : origen.startsWith('https://') ? `${origen}/o/${orgId}/codebase` : '';
    const p = await publicarEstado(pat, repo, r.sha, { state: e.state, description: e.description, context: GATE_CONTEXT,
      ...(url ? { target_url: url } : {}) });
    if (!p.ok) {
      if (p.status === 401) {
        throw new ApiError('provider_rejected', 'El token no es válido o caducó', { reason: 'unauthorized' });
      }
      if (p.status === 403) {
        throw new ApiError('provider_rejected', 'Falta Commit statuses: Read and write, o el token espera la aprobación de '
          + 'la organización', { missing_permissions: ['statuses:write'] });
      }
      if (p.status === 404) {
        throw new ApiError('provider_rejected', `Ese token no ve ${repo}: márcalo en Only select repositories`,
          { reason: 'not_found' });
      }
      if (p.status === 422) throw new ApiError('provider_rejected', 'GitHub rechazó el estado de prueba', { reason: 'limite' });
      log('warn', 'gate.prueba_caida', { rid, status: p.status, transitorio: TRANSITORIO_GH.has(p.code) });
      throw new ApiError('provider_unavailable', 'GitHub no respondió. Vuelve a intentarlo.');
    }
    probe = { sha: r.sha, state: e.state };

    // 7) Guardar: rotar el secreto de la MISMA conexión (mismo id) o darla de alta.
    const capabilities = { statuses: true, pull_requests: esc.pull_requests, issues: esc.issues };
    const scopes = ['statuses:write', ...(esc.pull_requests ? ['pull_requests:write'] : []),
      ...(esc.issues ? ['issues:write'] : [])];
    const metaAccion = { repo_full_name: repo, ...(meta.repo_id !== undefined ? { repo_id: meta.repo_id } : {}), branch: rama,
      purpose: 'commit_statuses' };
    const label = `GitHub · estados · ${repo}`.slice(0, 80);
    const id = estados ? String(estados.id) : crypto.randomUUID();
    if (estados) {
      await rotarSecretoConexion(env, admin, { orgId, connectionId: id, provider: 'github', kind: 'action' }, pat,
        { scopes, capabilities, expiresAt: p.expira });
      const viejo = obj(estados.meta);
      if (viejo.branch !== rama || viejo.repo_full_name !== repo) {
        const { error: em } = await admin.from('connections').update({ meta: metaAccion, label }).eq('id', id)
          .eq('org_id', orgId);
        if (em) log('warn', 'gate.meta_sin_cambiar', { rid, code: em.code ?? null });
      }
    } else {
      try {
        await createConnectionWithSecret(env, admin, { orgId, connectionId: id, provider: 'github', kind: 'action', label,
          meta: metaAccion, scopes, capabilities, expiresAt: p.expira, createdBy: c.get('userId') }, pat);
      } catch (x) {
        if (x instanceof ApiError && x.code === 'conflict') {
          throw conflicto('Otro administrador acaba de guardar un token', 'carrera');
        }
        throw x;
      }
    }
    estadosNueva = { id, status: 'active', last4: last4(pat), expires_at: p.expira, capabilities, meta: metaAccion };
    checks = [{ permission: 'statuses:write', ok: true, required: true },
      { permission: 'pull_requests:write', ok: esc.pull_requests, required: false },
      { permission: 'issues:write', ok: esc.issues, required: false }];
  }

  // 8) Config del bloqueo.
  const { data: nueva, error: eu } = await admin.from('code_review_configs').update({ gate_enabled: b.enabled,
    gate_min: b.min_severity, ...(b.close_pr !== undefined ? { gate_close_pr: b.close_pr } : {}),
    ...(pat ? { gate_last_error: null, gate_last_error_at: null } : {}), updated_at: new Date().toISOString() })
    .eq('id', String(cfg.id)).eq('org_id', orgId).select(`id, enabled, ${COLUMNAS_GATE_CONFIG}`).maybeSingle();
  if (eu || !nueva) {
    log('error', 'gate.config_guardar_error', { rid, code: eu?.code ?? null });
    throw new ApiError('internal', 'No pudimos guardar el bloqueo');
  }
  const gate = aGateConfig(nueva as unknown as Fila, estadosNueva);
  log('info', 'gate.config', { rid, enabled: b.enabled, min: b.min_severity, token: !!pat, probe: probe?.state ?? null,
    cerrar_pr: gate.close_pr ?? null });
  return c.json(MergeGateSaved.parse({ gate, checks, probe_sha: probe?.sha ?? null, probe_state: probe?.state ?? null }));
});

// ── E54 · POST /api/orgs/:org/code-review/reviews/:id/gate · admin → RespuestaEscritura ─────────────────────────────
// override («Dar por bueno»: success «Aprobado a mano» en ESE commit; el siguiente push se revisa de nuevo) y revert
// («Deshacer»: vuelve el estado de la regla) escriben y encolan 'estado' (202). reopen_pr («Reabrir el PR», anexo) hace
// el PATCH en el momento (200) y vale aunque el bloqueo ya esté apagado: es el «Deshacer» de un cierre. republish → P1.
// Subpeticiones: revisión 1 + config 1 + override 1 + encolar 1 ≤ 4 (reopen_pr ≤ 11, ver reabrirPr).
const PARCIAL_APROBABLE = new Set(['diff_grande', 'binario']);
const MOTIVO_REABRIR: Record<string, [ApiError['code'], string]> = {
  no_encontrada: ['not_found', 'Revisión no encontrada'],
  no_es_pr: ['conflict', 'Esta revisión no es de un pull request'],
  no_cerrado: ['conflict', 'VanGUARD no cerró este pull request'],
  ya_abierto: ['conflict', 'El pull request ya está abierto'],
  sin_token: ['conflict', 'Falta el token de estados de GitHub'],
  sin_permiso_pr: ['conflict', 'El token de estados no tiene Pull requests: Read and write'],
  otro_repo: ['conflict', 'El token de estados es de otro repo'],
  repo_invalido: ['conflict', 'El token de estados no tiene un repo válido: vuelve a guardarlo'],
  unauthorized: ['provider_rejected', 'El token de estados caducó o se revocó'],
  forbidden: ['provider_rejected', 'El token de estados no puede reabrir pull requests'],
  not_found: ['provider_rejected', 'El token de estados no ve el pull request'],
  rechazado: ['provider_rejected', 'GitHub no dejó reabrir el pull request'],
  red: ['provider_unavailable', 'GitHub no respondió. Vuelve a intentarlo.'],
};

async function limite(c: Context<AppEnv>) {
  const { success } = await c.env.RL_COSTLY.limit({ key: `gate:${c.get('userId')}` });
  if (!success) throw new ApiError('rate_limited', 'Demasiados intentos; espera un minuto');
}

bloqueo.post('/orgs/:org/code-review/reviews/:id/gate', requireAdmin, async (c) => {
  const id = Id.safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError('not_found', 'Revisión no encontrada');
  const b = await cuerpo(c, MergeGateAction);
  const env = c.env, orgId = c.get('orgId'), rid = c.get('rid');
  const admin = db(env);
  if (b.op === 'republish') throw conflicto('«Publicar de nuevo» llega más adelante', 'p1');
  if (!esHostProduccion(c)) throw conflicto('Solo se publica en GitHub desde officialvanguard.com', 'solo_produccion');

  if (b.op === 'reopen_pr') {
    await limite(c);
    const r = await reabrirPr(env, admin, orgId, id.data, { rid, via: 'panel' });
    if (!r.ok) {
      const [code, mensaje] = MOTIVO_REABRIR[r.motivo] ?? ['internal', 'No pudimos reabrir el pull request'];
      throw new ApiError(code, mensaje, { reason: r.motivo });
    }
    return c.json(RespuestaEscritura.parse({ ok: true, resultado: 'hecho' }));
  }

  const { data: leida, error } = await admin.from('code_reviews')
    .select('id, config_id, status, partial, error_code, gate_blocking, gate_override_at').eq('id', id.data).eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new ApiError('internal', 'No pudimos leer la revisión');
  const rev = leida as Fila | null;
  if (!rev) throw new ApiError('not_found', 'Revisión no encontrada');
  const { data: cfg, error: ec } = await admin.from('code_review_configs').select('enabled, gate_enabled')
    .eq('id', String(rev.config_id)).eq('org_id', orgId).maybeSingle();
  if (ec) throw new ApiError('internal', 'No pudimos leer la revisión de código');
  if (!cfg || obj(cfg).enabled !== true || obj(cfg).gate_enabled !== true) {
    throw conflicto('El bloqueo está apagado', 'apagado');
  }
  await limite(c);

  let cambio: Fila;
  if (b.op === 'override') {
    const aprobable = (rev.status === 'done' && typeof rev.gate_blocking === 'number' && rev.gate_blocking > 0)
      || rev.status === 'failed'
      || (rev.status === 'done' && rev.partial === true && PARCIAL_APROBABLE.has(String(rev.error_code)));
    if (!aprobable) throw conflicto('Esta revisión no tiene nada que aprobar', 'nada_que_aprobar');
    cambio = { gate_override_by: c.get('userId'), gate_override_at: new Date().toISOString(), gate_override_reason: b.reason };
  } else {
    if (!rev.gate_override_at) throw conflicto('Esta revisión no se dio por buena', 'sin_override');
    cambio = { gate_override_by: null, gate_override_at: null, gate_override_reason: null };
  }
  const { error: eu } = await admin.from('code_reviews').update(cambio).eq('id', id.data).eq('org_id', orgId);
  if (eu?.code === '23514') {
    throw new ApiError('invalid_body', 'Revisa los campos marcados',
      { field_errors: { reason: ['Ese motivo no se puede guardar'] } });
  }
  if (eu) {
    log('error', 'gate.override_error', { rid, code: eu.code ?? null });
    throw new ApiError('internal', 'No pudimos guardar el cambio');
  }
  try {
    await encolarEstado(env, orgId, id.data);
  } catch {
    log('error', 'gate.override_sin_encolar', { rid, review: id.data });
    throw new ApiError('internal', 'Guardado, pero no pudimos publicarlo en GitHub: vuelve a intentarlo');
  }
  log('info', b.op === 'override' ? 'gate.override' : 'gate.revert', { rid, review: id.data,
    ...(b.op === 'override' ? { largo: b.reason.length } : {}) });
  return c.json(RespuestaEscritura.parse({ ok: true, resultado: 'encolado' }), 202);
});
