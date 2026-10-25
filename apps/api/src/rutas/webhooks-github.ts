import { Hono, type Context } from 'hono';
import type { Box } from '@vanguard/core/crypto';
import type { AppEnv } from '../env.ts';
import { claveWebhook } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { fail } from '../lib/errors.ts';
import { hexABytes } from '../lib/hmac.ts';
import { getKeys } from '../lib/keyring.ts';
import { log } from '../lib/log.ts';
import { esHostProduccion } from '../mw/prod-host.ts';

// E47 · POST /webhooks/github/:id · firma de GitHub (X-Hub-Signature-256) · P0 (asignaciones/revision-codigo.md §4.1).
// Orden: cuerpo crudo (≤ 1 MB, bodyLimit de /webhooks/* en app.ts) → config por :id → HMAC-SHA256 en tiempo constante
// sobre los bytes crudos ANTES de parsear (sin config, id ilegible o firma mala: verificación de relleno y el mismo 401)
// → host real (tras la firma, para no revelar nada) → RL_COSTLY con un cubo por clase de evento (gh: push y ping,
// ghpr: pull_request, ghx: el resto, + :<config>) → solo application/json → repository.id = el de la conexión → ping |
// push o pull_request (code_reviews + JOBS_Q; un PR de fork, con tope por hora) | otros. La org sale de la config del :id,
// nunca del payload; el diff lo pide el paso de la cola al repo de la CONEXIÓN con su PAT. Sin webhook_events:
// GitHub conserva X-GitHub-Delivery al reenviar y el unique de code_reviews ya impide revisar dos veces un commit.
// Respuestas sin datos de la org (como mucho el review_id). Logs: rid, config, evento, sha7, número de PR y conteos;
// nunca título, autor ni ramas del PR.
export const webhooksGithub = new Hono<AppEnv>();

type Obj = Record<string, unknown>;
type Config = { id: string; org_id: string; connection_id: string; enabled: boolean; branch: string; secret_sealed: Box };

const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;   // X-GitHub-Delivery
const FIRMA = /^sha256=([0-9a-fA-F]{64})$/;
const SHA = /^[0-9a-f]{40}$/;
const CERO = '0'.repeat(40);
const EVENTO = /^[a-z_*]{1,40}$/;   // nombres de evento de GitHub ('*' = todos)
const MAX_EVENTOS = 30;             // check de code_review_configs.hook_events
const MAX_COMMITS = 49;             // push_commits = los últimos 49 de `commits` + after (≤ 50, check de 0013)
const ATASCADA_MS = 2 * 60_000;     // una queued sin empezar tras 2 min se reabre con «Redeliver»
const ACCIONES_PR = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);
const DE_CASA = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);   // author_association que avisa aunque el PR venga de un fork
const MAX_PR = 2_147_483_647;      // pr_number es int en 0013: más, 400 en vez del 22003 de la base
// Revisiones de PR por config en la última hora con las que aún entra un PR de fork (las propias cuentan). Un PR de fork
// lo abre y lo empuja cualquier cuenta de GitHub: sin tope, 10 por minuto (RL_COSTLY) son ~14.400 mensajes y ~43.000
// operaciones de cola al día, más que las 10.000 del plan Free para todas las orgs. Con 10/h, ≤ 240 mensajes al día.
const TOPE_FORK_HORA = 10;
const SIN_FIRMA = new Uint8Array(32);
const KID_RELLENO = 'v1';           // el kid por defecto de activeKid: el de los secretos sellados hoy

// Relleno: sin config (o sin firma legible) se verifica igual contra una clave aleatoria del isolate, así un id
// inexistente y una firma mala cuestan lo mismo y responden lo mismo.
let relleno: Promise<CryptoKey> | null = null;
const claveRelleno = () => (relleno ??= crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']));

const noAutorizado = (c: Context<AppEnv>) => fail(c, 'unauthorized', 'Firma no válida');
function ignorado(c: Context<AppEnv>, cfg: Config, evento: string, motivo: string) {
  log('info', 'github.ignorado', { rid: c.get('rid'), config: cfg.id, evento, motivo });
  return c.json({ ok: true, ignorado: motivo }, 202);
}

// Config por id: es la credencial que se busca, como la conexión de E30 (la org sale de la fila). Lanza si la base falla.
async function leerConfig(env: CloudflareBindings, id: string): Promise<Config | null> {
  const { data, error } = await db(env).from('code_review_configs')
    .select('id, org_id, connection_id, enabled, branch, secret_sealed').eq('id', id).maybeSingle();
  if (error) throw Object.assign(new Error('config'), { name: 'ConfigError', code: error.code });
  return (data as Config | null) ?? null;
}

// Devuelve la config si la firma casa, o el motivo del rechazo (solo para el log: la respuesta no lo distingue). Solo
// X-Hub-Signature-256; la de SHA-1 (X-Hub-Signature) se ignora. La clave HMAC viene en caché por config + iv.
async function autenticar(c: Context<AppEnv>, crudo: ArrayBuffer): Promise<Config | string> {
  const id = (c.req.param('id') ?? '').toLowerCase();
  const cfg = UUID.test(id) ? await leerConfig(c.env, id) : null;
  const hex = FIRMA.exec((c.req.header('x-hub-signature-256') ?? '').trim())?.[1];
  const firma = hex ? hexABytes(hex, 32) : null;
  let clave: CryptoKey | null = null;
  if (cfg) {
    try {
      clave = await claveWebhook(c.env, db(c.env), cfg);
    } catch (e) {
      log('warn', 'github.clave_error', { rid: c.get('rid'), config: cfg.id, name: e instanceof Error ? e.name : typeof e });
    }
  } else if (UUID.test(id)) {
    // Mismo coste en frío: abrir secret_sealed pide las llaves (vg_crypto_material) si no están en caché; sin esto, un
    // uuid inexistente respondería con una subpetición menos. Queda la diferencia del AES-GCM de open (microsegundos).
    await getKeys(c.env, db(c.env), KID_RELLENO).catch(() => {});
  }
  const ok = await crypto.subtle.verify('HMAC', clave ?? await claveRelleno(), firma ?? SIN_FIRMA, crudo);
  if (!UUID.test(id)) return 'id';
  if (!cfg) return 'config';
  if (!clave) return 'clave';
  if (!firma) return 'cabecera';
  return ok ? cfg : 'firma';
}

// Id numérico de GitHub (entero o cadena de dígitos) como texto; si no, null.
const idGithub = (x: unknown): string | null =>
  ((typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) || (typeof x === 'string' && /^\d{1,20}$/.test(x))
    ? String(x) : null);

// repository.id = connections.meta.repo_id; sin repo_id, full_name en minúsculas. Un webhook de organización o de otro
// repo no trae este repositorio.
function mismoRepo(payload: Obj, meta: Obj): boolean {
  const repo = obj(payload.repository);
  const id = idGithub(meta.repo_id);
  if (id) return idGithub(repo.id) === id;
  const a = str(meta.repo_full_name), b = str(repo.full_name);
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** push_commits (0013): los últimos 49 ids de `commits` que son SHA (sin repetir) + after. Solo del payload firmado. */
export function commitsDelPush(commits: unknown, after: string): string[] {
  const ids = (Array.isArray(commits) ? commits : []).map((x) => obj(x).id)
    .filter((s): s is string => typeof s === 'string' && SHA.test(s) && s !== after);
  return [...[...new Set(ids)].slice(-MAX_COMMITS), after];
}

async function ping(c: Context<AppEnv>, cfg: Config, payload: Obj, mismo: boolean) {
  const eventos = [...new Set((Array.isArray(obj(payload.hook).events) ? obj(payload.hook).events as unknown[] : [])
    .filter((e): e is string => typeof e === 'string' && EVENTO.test(e)))].slice(0, MAX_EVENTOS);
  const error = !mismo ? 'otro_repo' : eventos.includes('push') || eventos.includes('*') ? null : 'sin_push';
  // E45 da «error» solo si last_error_at es POSTERIOR al último ping: el fallo de este ping va 1 ms detrás de él.
  const ahora = Date.now();
  const { error: eu } = await db(c.env).from('code_review_configs').update({ last_ping_at: new Date(ahora).toISOString(),
    hook_events: eventos, last_error: error, last_error_at: error ? new Date(ahora + 1).toISOString() : null })
    .eq('id', cfg.id).eq('org_id', cfg.org_id);
  if (eu) {
    log('error', 'github.ping_error', { rid: c.get('rid'), config: cfg.id, code: eu.code ?? null });
    return fail(c, 'internal', 'No pudimos registrar el ping');
  }
  log('info', 'github.ping', { rid: c.get('rid'), config: cfg.id, eventos: eventos.length, error });
  return mismo ? c.json({ ok: true }, 200) : ignorado(c, cfg, 'ping', 'otro_repo');
}

const encolar = (env: CloudflareBindings, cfg: Config, reviewId: string) =>
  env.JOBS_Q.send({ v: 1, kind: 'review', org_id: cfg.org_id, review_id: reviewId, paso: 'diff' });

// last_event_at: mejor esfuerzo (la tarjeta dice «último evento hace X»); la revisión ya está encolada.
async function marcarEvento(env: CloudflareBindings, cfg: Config, rid: string) {
  const { error } = await db(env).from('code_review_configs').update({ last_event_at: new Date().toISOString() })
    .eq('id', cfg.id).eq('org_id', cfg.org_id);
  if (error) log('warn', 'github.evento_sin_marca', { rid, config: cfg.id, code: error.code ?? null });
}

// Lo que E47 registra de un push o de un PR. pr = pull_request.number (null en el push); fork = PR de un fork de alguien
// de fuera: la fila nace con alert_reason 'fork' y el paso diff lo pasa como sin_aviso (0013: solo en la app).
// reabiertoAMano: un `reopened` cuyo sender es una persona (sender.type 'User'); solo cuenta si no trae commits nuevos
// (mismo head: cae en repetido) y VanGUARD había cerrado ese PR (anexo bloqueo-merge-cierre-pr.md, punto 4).
type Nueva = {
  event: 'push' | 'pull_request'; base: string; head: string; pr: number | null; commits: string[]; fork: boolean;
  reabiertoAMano?: boolean;
};
// Al reabrir con «Redeliver», la revisión vuelve a empezar también para el bloqueo de merge (0016): la tarjeta no enseña
// el error viejo, yaReclamada vuelve a ver «sin publicar» y un «Dar por bueno» anterior no sobrevive a la nueva revisión.
const GATE_LIMPIO = { gate_blocking: null, gate_findings: [], gate_state: null, gate_error: null, gate_published_at: null,
  gate_override_by: null, gate_override_at: null, gate_override_reason: null, gate_pr_action: null, gate_pr_error: null,
  gate_pr_at: null };
const LOG_EVENTO = { push: 'github.push', pull_request: 'github.pr' } as const;
const datosLog = (r: Nueva) => ({ sha7: r.head.slice(0, 7), ...(r.pr ? { pr: r.pr, fork: r.fork } : {}) });

// Mismo commit ya registrado (23505 del unique por config, evento, head_sha y PR). Una failed, o una queued que nunca
// empezó tras 2 min, se reabre con CAS (where status = el leído) y se reencola: así «Redeliver» repite una revisión
// fallida o atascada. Si no, repetido. alert_reason no se toca (un 'fork' sigue); si ESTA entrega es de un fork, 'fork'.
async function repetido(c: Context<AppEnv>, cfg: Config, r: Nueva, delivery: string | null) {
  const rid = c.get('rid');
  const admin = db(c.env);
  const sel = admin.from('code_reviews').select('id, status, started_at, created_at')
    .eq('config_id', cfg.id).eq('org_id', cfg.org_id).eq('event', r.event).eq('head_sha', r.head);
  const { data, error } = await (r.pr ? sel.eq('pr_number', r.pr) : sel.is('pr_number', null)).maybeSingle();
  const fila = obj(data);
  const id = str(fila.id);
  if (error || !id) {
    log('error', 'github.repetido_error', { rid, config: cfg.id, code: error?.code ?? null });
    return fail(c, 'internal', 'No pudimos registrar el evento');
  }
  const atascada = fila.status === 'queued' && !fila.started_at && Date.now() - Date.parse(String(fila.created_at)) > ATASCADA_MS;
  if (fila.status !== 'failed' && !atascada) {
    // Una persona reabrió sin commits nuevos el PR que cerró VanGUARD: se respeta (no se vuelve a cerrar; el ✗ se queda)
    // y la revisión lo dice. CAS desde 'closed': si lo reabrió VanGUARD («Reabrir el PR»), ya dice 'reopened'.
    if (r.reabiertoAMano) {
      const { data: marcada, error: em } = await admin.from('code_reviews').update({ gate_pr_action: 'reopened_by_human' })
        .eq('id', id).eq('org_id', cfg.org_id).eq('gate_pr_action', 'closed').select('id');
      if (em) log('warn', 'github.reabierto_sin_marca', { rid, config: cfg.id, code: em.code ?? null });
      if (Array.isArray(marcada) && marcada.length) return ignorado(c, cfg, r.event, 'reabierto_a_mano');
    }
    return ignorado(c, cfg, r.event, 'repetido');
  }
  // created_at = este encolado (no hay queued_at): la regla de 2 min, el «interrumpida» de E45 (15 min) y alert.seconds
  // miden desde aquí; si no, otra entrega inmediata vería atascada una failed antigua recién reabierta.
  let q = admin.from('code_reviews').update({ status: 'queued', error_code: null, started_at: null, finished_at: null,
    partial: false, delivery_id: delivery, created_at: new Date().toISOString(), ...GATE_LIMPIO,
    ...(r.fork ? { alert_reason: 'fork' } : {}) })
    .eq('id', id).eq('org_id', cfg.org_id).eq('status', String(fila.status));
  if (atascada) q = q.is('started_at', null);
  const { data: abiertas, error: eu } = await q.select('id');
  if (eu) {
    log('error', 'github.reabrir_error', { rid, config: cfg.id, code: eu.code ?? null });
    return fail(c, 'internal', 'No pudimos registrar el evento');
  }
  // Ninguna fila reabierta: otra entrega se adelantó.
  if (!Array.isArray(abiertas) || abiertas.length === 0) return ignorado(c, cfg, r.event, 'repetido');
  try {
    await encolar(c.env, cfg, id);
  } catch {
    // Reabierta y sin mensaje: queda failed/encolar para que el siguiente «Redeliver» vuelva a entrar.
    await admin.from('code_reviews').update({ status: 'failed', error_code: 'encolar', finished_at: new Date().toISOString() })
      .eq('id', id).eq('org_id', cfg.org_id).eq('status', 'queued');
    log('error', 'github.encolar_error', { rid, config: cfg.id, reintento: true });
    return fail(c, 'internal', 'No pudimos encolar la revisión');
  }
  await marcarEvento(c.env, cfg, rid);
  log('info', LOG_EVENTO[r.event], { rid, config: cfg.id, ...datosLog(r), resultado: 'reintento',
    previo: String(fila.status) });
  return c.json({ ok: true, review_id: id, reintento: true }, 202);
}

// Fila queued (delivery_id = X-GitHub-Delivery si es un GUID) → JOBS_Q diff → last_event_at → 202. Común a push y PR.
async function registrar(c: Context<AppEnv>, cfg: Config, r: Nueva, extra: Obj = {}) {
  const rid = c.get('rid');
  const cabecera = (c.req.header('x-github-delivery') ?? '').trim();
  const delivery = GUID.test(cabecera) ? cabecera : null;
  const admin = db(c.env);
  const { data, error } = await admin.from('code_reviews').insert({ org_id: cfg.org_id, config_id: cfg.id, event: r.event,
    branch: cfg.branch, base_sha: r.base, head_sha: r.head, push_commits: r.commits, ...(r.pr ? { pr_number: r.pr } : {}),
    ...(r.fork ? { alert_reason: 'fork' } : {}), ...(delivery ? { delivery_id: delivery } : {}) }).select('id').single();
  if (error?.code === '23505') return repetido(c, cfg, r, delivery);
  const id = str(obj(data).id);
  if (error || !id) {
    log('error', 'github.insert_error', { rid, config: cfg.id, code: error?.code ?? null });
    return fail(c, 'internal', 'No pudimos registrar el evento');
  }
  try {
    await encolar(c.env, cfg, id);
  } catch {
    // Sin mensaje no hay revisión: se borra la fila para que «Redeliver» vuelva a entrar (sin filas a medias).
    const { error: ed } = await admin.from('code_reviews').delete().eq('id', id).eq('org_id', cfg.org_id);
    log('error', 'github.encolar_error', { rid, config: cfg.id, borrada: !ed });
    return fail(c, 'internal', 'No pudimos encolar la revisión');
  }
  await marcarEvento(c.env, cfg, rid);
  log('info', LOG_EVENTO[r.event], { rid, config: cfg.id, ...datosLog(r), ...extra, resultado: 'encolada' });
  return c.json({ ok: true, review_id: id }, 202);
}

// push (§1.3): a la rama vigilada (de la config, nunca del payload), no borrada y con before de una rama que ya existía.
// Un merge de PR (merge, squash o rebase) llega como push a la rama: entra aquí.
async function push(c: Context<AppEnv>, cfg: Config, payload: Obj) {
  if (!cfg.enabled) return ignorado(c, cfg, 'push', 'desactivada');
  if (payload.ref !== `refs/heads/${cfg.branch}`) return ignorado(c, cfg, 'push', 'rama');
  const before = str(payload.before), after = str(payload.after);
  if (payload.deleted === true || after === CERO) return ignorado(c, cfg, 'push', 'borrado');
  if (!before || !after || !SHA.test(before) || !SHA.test(after)) {
    return fail(c, 'invalid_body', 'El push no trae before y after válidos', undefined, 400);
  }
  if (before === CERO) return ignorado(c, cfg, 'push', 'rama_nueva');
  const commits = commitsDelPush(payload.commits, after);
  return registrar(c, cfg, { event: 'push', base: before, head: after, pr: null, commits, fork: false },
    { commits: Array.isArray(payload.commits) ? payload.commits.length : 0 });
}

// Tope de los PR de fork: cuenta las revisiones de PR de la config creadas en la última hora (una subpetición, count
// head). No cuenta por alert_reason 'fork': 0013 lo borra al cerrar una revisión de fork vacía, y el contenido lo elige
// quien empuja. Devuelve la respuesta si corta (202 tope_fork, o 500 si la base falla) o null si el PR entra.
async function topeFork(c: Context<AppEnv>, cfg: Config) {
  const { count, error } = await db(c.env).from('code_reviews').select('id', { count: 'exact', head: true })
    .eq('org_id', cfg.org_id).eq('config_id', cfg.id).eq('event', 'pull_request')
    .gte('created_at', new Date(Date.now() - 3600_000).toISOString());
  if (error) {
    log('error', 'github.tope_error', { rid: c.get('rid'), config: cfg.id, code: error.code ?? null });
    return fail(c, 'internal', 'No pudimos registrar el evento');
  }
  return (count ?? 0) >= TOPE_FORK_HORA ? ignorado(c, cfg, 'pull_request', 'tope_fork') : null;
}

// pull_request (§1.3, D1): abierto, actualizado, reabierto o listo para revisar, hacia la rama vigilada (de la config).
// base y head salen del PR; el diff lo pide igual el paso al repo de la CONEXIÓN con su PAT, y el PR no escribe en
// findings. Avisa si el PR sale de este mismo repo (head.repo.id = repository.id) o lo abre alguien de casa (OWNER,
// MEMBER, COLLABORATOR) y la entrega la dispara ese mismo autor (sender.id = user.id: un COLLABORATOR puede abrir el
// PR con la rama del fork de un extraño, y cada push del extraño llega como synchronize con la asociación del autor y
// sender = quien empujó). Si no (fork de alguien de fuera, o head.repo null porque el fork se borró), alert_reason
// 'fork': se revisa solo en la app, con el tope por hora de TOPE_FORK_HORA. Del PR solo se leen acción, número, base,
// head (sha y repo.id), author_association, los ids numéricos de user y sender y sender.type (un `reopened` de una
// persona sin commits nuevos: el PR que cerró VanGUARD no se vuelve a cerrar); título, autor y ramas nunca.
async function pullRequest(c: Context<AppEnv>, cfg: Config, payload: Obj) {
  const accion = typeof payload.action === 'string' ? payload.action : '';
  if (!ACCIONES_PR.has(accion)) return ignorado(c, cfg, 'pull_request', 'evento');
  if (!cfg.enabled) return ignorado(c, cfg, 'pull_request', 'desactivada');
  const pr = obj(payload.pull_request), base = obj(pr.base), head = obj(pr.head);
  if (base.ref !== cfg.branch) return ignorado(c, cfg, 'pull_request', 'rama');
  const baseSha = str(base.sha), headSha = str(head.sha), n = pr.number;
  if (!baseSha || !headSha || !SHA.test(baseSha) || !SHA.test(headSha)
    || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > MAX_PR) {
    return fail(c, 'invalid_body', 'El pull request no trae base, head y número válidos', undefined, 400);
  }
  const origen = idGithub(obj(head.repo).id);
  const propio = origen !== null && origen === idGithub(obj(payload.repository).id);
  const autor = idGithub(obj(pr.user).id);
  const deCasa = typeof pr.author_association === 'string' && DE_CASA.has(pr.author_association)
    && autor !== null && autor === idGithub(obj(payload.sender).id);
  const fork = !propio && !deCasa;
  if (fork) {
    const corte = await topeFork(c, cfg);
    if (corte) return corte;
  }
  const reabiertoAMano = accion === 'reopened' && obj(payload.sender).type === 'User';
  return registrar(c, cfg, { event: 'pull_request', base: baseSha, head: headSha, pr: n, commits: [], fork, reabiertoAMano });
}

webhooksGithub.post('/github/:id', async (c) => {
  const rid = c.get('rid');
  const crudo = await c.req.arrayBuffer();
  let cfg: Config | string;
  try {
    cfg = await autenticar(c, crudo);
  } catch (e) {
    log('error', 'github.config_error', { rid, code: (e as { code?: unknown })?.code ?? null });
    return fail(c, 'internal', 'No pudimos comprobar el webhook');
  }
  if (typeof cfg === 'string') {
    log('warn', 'github.firma_rechazada', { rid, motivo: cfg });
    return noAutorizado(c);
  }
  // Una URL de versión de workers.dev comparte los bindings y encolaría en la cola de producción (requireColaPropia).
  if (c.env.VG_ENV !== 'local' && !esHostProduccion(c)) return fail(c, 'forbidden', 'Solo disponible en officialvanguard.com');
  const cabecera = (c.req.header('x-github-event') ?? '').trim();
  const evento = EVENTO.test(cabecera) ? cabecera : 'otro';
  // Un cubo por clase de evento: las entregas de PR (un fork de cualquier cuenta las provoca editando o empujando) y
  // los eventos que se ignoran no dejan en 429 un push a la rama vigilada, que solo hace quien tiene escritura.
  // X-GitHub-Event no va firmado, pero sin el secreto no hay entregas que pasen la firma.
  const cubo = evento === 'push' || evento === 'ping' ? 'gh' : evento === 'pull_request' ? 'ghpr' : 'ghx';
  const { success } = await c.env.RL_COSTLY.limit({ key: `${cubo}:${cfg.id}` });
  if (!success) {
    c.header('Retry-After', '60');
    return fail(c, 'rate_limited', 'Demasiados eventos seguidos. Espera un minuto.');
  }
  const tipo = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (tipo !== 'application/json') {
    return fail(c, 'invalid_body', 'Elige Content type: application/json en el webhook', undefined, 400);
  }
  let payload: Obj;
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(crudo));
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new SyntaxError('no es un objeto');
    payload = json as Obj;
  } catch {
    return fail(c, 'invalid_body', 'El cuerpo no es JSON válido', undefined, 400);
  }

  const { data: conn, error } = await db(c.env).from('connections').select('meta')
    .eq('id', cfg.connection_id).eq('org_id', cfg.org_id).maybeSingle();
  if (error) {
    log('error', 'github.conexion_error', { rid, config: cfg.id, code: error.code ?? null });
    return fail(c, 'internal', 'No pudimos comprobar el webhook');
  }
  const mismo = !!conn && mismoRepo(payload, obj(obj(conn).meta));
  if (evento === 'ping') return ping(c, cfg, payload, mismo);
  if (!mismo) return ignorado(c, cfg, evento, 'otro_repo');   // solo el ping escribe last_error
  if (evento === 'push') return push(c, cfg, payload);
  if (evento === 'pull_request') return pullRequest(c, cfg, payload);
  return ignorado(c, cfg, evento, 'evento');
});
