import { Hono, type Context } from 'hono';
import { AlertPrefs, AlertPrefsIn, CodeReview, CodeReviewConfig, CodeReviewPut, CodeReviewSaved, CodeReviewState,
  type NotificationStatus } from '@vanguard/contracts';
import { newWebhookSecret } from '@vanguard/core/crypto';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { olvidarClaveWebhook, sellarSecretoWebhook } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';
import { aGateConfig, aGateRevision, COLUMNAS_ESTADOS, COLUMNAS_GATE_CONFIG, COLUMNAS_GATE_REVISION, esRepoDelBloqueo }
  from './bloqueo.ts';

// Revisión de código en cada push (docs/plan_maestro_trabajo/asignaciones/revision-codigo.md §4.1). E45 y E48 los lee
// cualquier miembro (también el anónimo de la demo, sin URL ni secreto); E46 y E49 solo admins. El webhook (E47) y los
// pasos de la cola van aparte. Las tablas son solo del servidor (0013): todo con service_role y .eq('org_id').
export const revision = new Hono<AppEnv>();

const COLUMNAS_CONFIG = 'id, connection_id, enabled, branch, secret_last4, hook_events, last_ping_at, last_event_at, '
  + 'last_error, last_error_at';
const COLUMNAS_REVISION = 'id, event, branch, pr_number, base_sha, head_sha, status, error_code, partial, files_changed, '
  + 'lines_added, counts, max_severity, new_findings, alert_state, alert_reason, voice_pending, notified_at, created_at, '
  + 'finished_at';
const RAMA = /^[A-Za-z0-9._/-]{1,100}$/;
const INTERRUMPIDA_MS = 15 * 60_000;          // sin vigilante en P0: E45 la enseña como failed sin escribir
// El mejor estado de los WhatsApp de una revisión (§4.1, alert.delivery).
const RANGO: Record<string, number> = { read: 6, delivered: 5, sent: 4, queued: 3, failed: 2, skipped_cap: 1 };
const ERROR_ENTREGA = /^[A-Za-z0-9_.-]{1,40}$/;
const SEVERIDADES = ['critical', 'high', 'medium', 'low', 'info'] as const;

type Fila = Record<string, unknown>;
type Conexion = { id: string; status: string; meta: Fila };

const isoN = (v: unknown) => (typeof v === 'string' ? iso(v) : null);
const ms = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);

// La conexión GitHub de lectura de la org. Con connectionId, esa en cualquier estado (E46 la usa así). Sin él, la
// principal: la ACTIVA más antigua y, si ninguna lo está, la más antigua (varias-codebases.md B0): conectar un 2.º repo
// o usar «Reconectar» no cambia la que ve E45.
async function conexionGithub(c: Context<AppEnv>, connectionId?: string): Promise<Conexion | null> {
  let q = db(c.env).from('connections').select('id, status, meta').eq('org_id', c.get('orgId')).eq('provider', 'github')
    .eq('kind', 'read');
  if (connectionId) q = q.eq('id', connectionId);
  const { data, error } = await q.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(20);
  if (error) {
    log('error', 'revision.conexion_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer la conexión de GitHub');
  }
  const filas = (data as Fila[] | null) ?? [];
  const f = filas.find((x) => x.status === 'active') ?? filas[0];
  return f ? { id: String(f.id), status: String(f.status), meta: (f.meta ?? {}) as Fila } : null;
}

// state: off si está apagada; error si el último fallo es posterior al último ping y al último evento; waiting_ping sin
// ping ni eventos; si no, connected. webhook_url solo en producción y para owner/admin (en local APP_ORIGIN es la SPA
// en http y el contrato exige https; el anónimo de la demo no la ve).
function aConfig(c: Context<AppEnv>, f: Fila, repo: string, gate?: CodeReviewConfig['gate']): CodeReviewConfig {
  const ping = ms(f.last_ping_at), evento = ms(f.last_event_at), fallo = ms(f.last_error_at);
  const ultimo = Math.max(Number.isNaN(ping) ? -Infinity : ping, Number.isNaN(evento) ? -Infinity : evento);
  const state = !f.enabled ? 'off'
    : f.last_error && !Number.isNaN(fallo) && fallo > ultimo ? 'error'
    : ultimo === -Infinity ? 'waiting_ping' : 'connected';
  const rol = c.get('role');
  const origen = c.env.APP_ORIGIN ?? '';
  const verUrl = c.env.VG_ENV === 'production' && !c.get('isAnon') && (rol === 'owner' || rol === 'admin')
    && origen.startsWith('https://');
  return CodeReviewConfig.parse({ id: f.id, connection_id: f.connection_id, repo_full_name: repo, branch: f.branch,
    enabled: f.enabled === true, state,
    webhook_url: verUrl ? `${origen.replace(/\/+$/, '')}/webhooks/github/${String(f.id)}` : null,
    secret_last4: typeof f.secret_last4 === 'string' && f.secret_last4 ? f.secret_last4 : null,
    hook_events: Array.isArray(f.hook_events)
      ? f.hook_events.filter((e): e is string => typeof e === 'string' && e.length <= 40).slice(0, 30) : [],
    last_ping_at: isoN(f.last_ping_at), last_event_at: isoN(f.last_event_at),
    last_error: typeof f.last_error === 'string' ? f.last_error : null, ...(gate ? { gate } : {}) });
}

function aRevision(f: Fila, avisos: Fila[], ahora: number): CodeReview | null {
  const creada = ms(f.created_at);
  const viva = f.status === 'queued' || f.status === 'running';
  const interrumpida = viva && !Number.isNaN(creada) && ahora - creada > INTERRUMPIDA_MS;
  let delivery: NotificationStatus | null = null;
  for (const a of avisos) if ((RANGO[String(a.status)] ?? 0) > (delivery ? RANGO[delivery]! : 0)) delivery = a.status as NotificationStatus;
  const errorFila = delivery === 'failed' ? avisos.find((a) => a.status === 'failed' && typeof a.error === 'string')?.error : null;
  const notificada = ms(f.notified_at);
  const cuentas = (f.counts ?? {}) as Fila;
  const gate = aGateRevision(f);   // bloqueo de merge (0016): solo si alguna columna gate_* tiene algo
  const r = CodeReview.safeParse({ id: f.id, event: f.event, branch: f.branch, pr_number: f.pr_number ?? null,
    base_sha: f.base_sha, head_sha: f.head_sha,
    status: interrumpida ? 'failed' : f.status, error_code: interrumpida ? 'interrumpida' : f.error_code ?? null,
    partial: f.partial === true, files_changed: f.files_changed ?? 0, lines_added: f.lines_added ?? 0,
    counts: Object.fromEntries(SEVERIDADES.map((s) => [s, typeof cuentas[s] === 'number' ? cuentas[s] : 0])),
    max_severity: f.max_severity ?? null, findings: Array.isArray(f.new_findings) ? f.new_findings : [],
    alert: { state: f.alert_state, reason: f.alert_reason ?? null, delivery,
      delivery_error: typeof errorFila === 'string' && ERROR_ENTREGA.test(errorFila) ? errorFila : null,
      voice_pending: f.voice_pending === true, notified_at: isoN(f.notified_at),
      seconds: Number.isNaN(notificada) || Number.isNaN(creada) ? null : Math.max(0, (notificada - creada) / 1000) },
    created_at: iso(String(f.created_at)), finished_at: isoN(f.finished_at), ...(gate ? { gate } : {}) });
  return r.success ? r.data : null;
}

// E45 · GET /api/orgs/:org/code-review · user · P0 → CodeReviewState. ≤ 5 subpeticiones: conexión, config, revisiones y
// la conexión de acciones de GitHub del bloqueo de merge (en paralelo), y los WhatsApp de esas revisiones. Ninguna a
// GitHub. config.gate solo en el repo del bloqueo (bloqueo-merge-criticos.md §4.1; varias-codebases.md §2.6).
revision.get('/orgs/:org/code-review', async (c) => {
  const orgId = c.get('orgId');
  const admin = db(c.env);
  const [conn, cfg, revs, acc] = await Promise.all([
    conexionGithub(c),
    admin.from('code_review_configs').select(`${COLUMNAS_CONFIG}, ${COLUMNAS_GATE_CONFIG}`).eq('org_id', orgId)
      .order('created_at', { ascending: false }).limit(1),
    admin.from('code_reviews').select(`${COLUMNAS_REVISION}, ${COLUMNAS_GATE_REVISION}`).eq('org_id', orgId)
      .order('created_at', { ascending: false }).limit(10),
    admin.from('connections').select(COLUMNAS_ESTADOS).eq('org_id', orgId).eq('provider', 'github').eq('kind', 'action')
      .limit(1),
  ]);
  if (cfg.error || revs.error || acc.error) {
    log('error', 'revision.estado_error', { rid: c.get('rid'),
      code: cfg.error?.code ?? revs.error?.code ?? acc.error?.code ?? null });
    throw new ApiError('internal', 'No pudimos leer la revisión de código');
  }
  const estados = ((Array.isArray(acc.data) ? acc.data[0] : acc.data) ?? null) as Fila | null;
  if (!conn) return c.json(CodeReviewState.parse({ available: false, reason: 'sin_conexion', config: null, recent: [] }));
  const filaCfg = ((cfg.data ?? []) as unknown as Fila[]).find((f) => f.connection_id === conn.id) ?? null;
  const filas = (revs.data ?? []) as unknown as Fila[];
  const porRevision = new Map<string, Fila[]>();
  if (filas.length) {
    const { data, error } = await admin.from('notifications').select('code_review_id, status, error').eq('org_id', orgId)
      .eq('channel', 'whatsapp').in('code_review_id', filas.map((f) => f.id));
    if (error) log('warn', 'revision.avisos_error', { rid: c.get('rid'), code: error.code ?? null });
    for (const a of (data ?? []) as Fila[]) {
      const k = String(a.code_review_id);
      porRevision.set(k, [...(porRevision.get(k) ?? []), a]);
    }
  }
  const ahora = Date.now();
  const recent: CodeReview[] = [];
  for (const f of filas) {
    const r = aRevision(f, porRevision.get(String(f.id)) ?? [], ahora);
    if (r) recent.push(r);
    else log('warn', 'revision.fila_fuera_de_contrato', { rid: c.get('rid') });
  }
  const repo = typeof conn.meta.repo_full_name === 'string' ? conn.meta.repo_full_name : '';
  // Hoy E45 sirve siempre la conexión principal; con ?connection_id= (varias-codebases B6) el 3.er argumento dirá si lo es.
  const gate = filaCfg && esRepoDelBloqueo(conn.meta, estados, true) ? aGateConfig(filaCfg, estados) : undefined;
  return c.json(CodeReviewState.parse({ available: conn.status === 'active',
    reason: conn.status === 'active' ? null : 'conexion_inactiva',
    config: filaCfg ? aConfig(c, filaCfg, repo, gate) : null, recent }));
});

// E46 · PUT /api/orgs/:org/code-review · admin · P0 → CodeReviewSaved. Sin config: la crea con su secreto vgw_ sellado
// y lo devuelve UNA vez (201). Con config: cambia enabled; al pasar de false a true vuelve a copiar la rama por defecto.
// rotate_secret («Generar otro secreto», §4.1 P1): sella un vgw_ nuevo en la MISMA config (la URL no cambia), borra
// last_ping_at, hook_events y last_error (la tarjeta vuelve a «esperando el ping») y lo devuelve una vez (200). Sin config,
// el alta ya da un secreto: rotate_secret no cambia nada.
revision.put('/orgs/:org/code-review', requireAdmin, async (c) => {
  const b = await cuerpo(c, CodeReviewPut);
  if (b.rotate_secret) {
    const { success } = await c.env.RL_COSTLY.limit({ key: `u:${c.get('userId')}` });
    if (!success) throw new ApiError('rate_limited', 'Demasiados intentos; espera un minuto');
  }
  const orgId = c.get('orgId');
  const admin = db(c.env);
  const conn = await conexionGithub(c, b.connection_id);
  if (!conn) throw new ApiError('not_found', 'Conexión de GitHub no encontrada');
  if (conn.status !== 'active') {
    throw new ApiError('conflict', 'La conexión de GitHub no está activa: vuelve a probarla', { reason: 'conexion_inactiva' });
  }
  const repo = typeof conn.meta.repo_full_name === 'string' ? conn.meta.repo_full_name : '';
  const rama = () => {
    const r = conn.meta.default_branch;
    if (typeof r !== 'string' || !RAMA.test(r)) {
      throw new ApiError('conflict', 'No sabemos la rama por defecto: vuelve a probar la conexión de GitHub');
    }
    return r;
  };
  const { data: leida, error } = await admin.from('code_review_configs').select(`${COLUMNAS_CONFIG}, updated_at`)
    .eq('org_id', orgId).eq('connection_id', conn.id).maybeSingle();
  const previa = leida as unknown as Fila | null;
  if (error) {
    log('error', 'revision.config_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer la revisión de código');
  }

  if (!previa) {
    const id = crypto.randomUUID();
    const branch = rama();
    const secreto = newWebhookSecret();
    const sellado = await sellarSecretoWebhook(c.env, admin, orgId, id, secreto);
    const { data, error: ei } = await admin.from('code_review_configs').insert({ id, org_id: orgId, connection_id: conn.id,
      enabled: b.enabled, branch, secret_sealed: sellado.sealed, secret_kid: sellado.kid,
      secret_last4: sellado.last4 || null, created_by: c.get('userId') }).select(COLUMNAS_CONFIG).single();
    if (ei?.code === '23505') throw new ApiError('conflict', 'Ya está activada');
    if (ei || !data) {
      log('error', 'revision.config_alta_error', { rid: c.get('rid'), code: ei?.code ?? null });
      throw new ApiError('internal', 'No pudimos activar la revisión de código');
    }
    log('info', 'revision.config', { rid: c.get('rid'), enabled: b.enabled, rotado: false, alta: true });
    return c.json(CodeReviewSaved.parse({ config: aConfig(c, data as unknown as Fila, repo), webhook_secret: secreto }), 201);
  }

  const reactiva = b.enabled && previa.enabled !== true;
  const configId = String(previa.id);
  const secreto = b.rotate_secret ? newWebhookSecret() : null;
  const sellado = secreto ? await sellarSecretoWebhook(c.env, admin, orgId, configId, secreto) : null;
  // Al rotar, también last_event_at: con un push anterior la tarjeta seguiría «Conectada» (max de ping y evento) aunque
  // GitHub ya firme con el secreto viejo. Y CAS por updated_at: de dos rotaciones a la vez solo vale la que escribe; la
  // otra recibe 409 en vez de un secreto que nunca verificaría.
  let cambio = admin.from('code_review_configs')
    .update({ enabled: b.enabled, ...(reactiva ? { branch: rama() } : {}), updated_at: new Date().toISOString(),
      ...(sellado ? { secret_sealed: sellado.sealed, secret_kid: sellado.kid, secret_last4: sellado.last4 || null,
        last_ping_at: null, last_event_at: null, hook_events: [], last_error: null, last_error_at: null } : {}) })
    .eq('id', configId).eq('org_id', orgId);
  if (sellado) cambio = cambio.eq('updated_at', String(previa.updated_at));
  const { data, error: eu } = await cambio.select(COLUMNAS_CONFIG).maybeSingle();
  if (sellado && !eu && !data) throw new ApiError('conflict', 'Otro administrador acaba de cambiarlo: recarga la página');
  if (eu || !data) {
    log('error', 'revision.config_cambio_error', { rid: c.get('rid'), code: eu?.code ?? null });
    throw new ApiError('internal', 'No pudimos guardar la revisión de código');
  }
  if (sellado) olvidarClaveWebhook(configId);
  log('info', 'revision.config', { rid: c.get('rid'), enabled: b.enabled, rotado: !!sellado, alta: false });
  return c.json(CodeReviewSaved.parse({ config: aConfig(c, data as unknown as Fila, repo), webhook_secret: secreto }));
});

// E48/E49 · alert-prefs. Sin fila: high / critical y updated_at null. voice_available: false mientras no haya llamadas.
// whatsapp_ready_contacts = contactos con WhatsApp y verificados (los únicos que reciben algo).
async function prefs(c: Context<AppEnv>, fila: Fila | null): Promise<AlertPrefs> {
  // Una org tiene pocos contactos (prioridad 1–9): se cuentan los verificados aquí, sin un filtro «no nulo» más.
  const { data, error } = await db(c.env).from('contacts').select('verified_at').eq('org_id', c.get('orgId'))
    .eq('whatsapp', true).limit(50);
  if (error) log('warn', 'revision.contactos_error', { rid: c.get('rid'), code: error.code ?? null });
  const listos = ((data ?? []) as Fila[]).filter((f) => typeof f.verified_at === 'string').length;
  return AlertPrefs.parse({ review_whatsapp_min: fila?.review_whatsapp_min ?? 'high',
    review_voice_min: fila?.review_voice_min ?? 'critical', voice_available: false,
    whatsapp_ready_contacts: listos, updated_at: isoN(fila?.updated_at) });
}

revision.get('/orgs/:org/alert-prefs', async (c) => {
  const { data, error } = await db(c.env).from('alert_prefs').select('review_whatsapp_min, review_voice_min, updated_at')
    .eq('org_id', c.get('orgId')).maybeSingle();
  if (error) {
    log('error', 'revision.prefs_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer las preferencias de aviso');
  }
  return c.json(await prefs(c, data as Fila | null));
});

revision.put('/orgs/:org/alert-prefs', requireAdmin, async (c) => {
  const b = await cuerpo(c, AlertPrefsIn);
  const { data, error } = await db(c.env).from('alert_prefs').upsert({ org_id: c.get('orgId'), ...b,
    updated_by: c.get('userId'), updated_at: new Date().toISOString() }, { onConflict: 'org_id' })
    .select('review_whatsapp_min, review_voice_min, updated_at').single();
  if (error || !data) {
    log('error', 'revision.prefs_guardar_error', { rid: c.get('rid'), code: error?.code ?? null });
    throw new ApiError('internal', 'No pudimos guardar las preferencias de aviso');
  }
  return c.json(await prefs(c, data as Fila));
});
