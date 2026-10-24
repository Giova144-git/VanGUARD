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
// → host real (tras la firma, para no revelar nada) → RL_COSTLY gh:<config> → solo application/json → repository.id
// = el de la conexión → ping | push (code_reviews + JOBS_Q) | pull_request (P1) | otros. La org sale de la config del
// :id, nunca del payload; el diff lo pide el paso de la cola al repo de la CONEXIÓN con su PAT. Sin webhook_events:
// GitHub conserva X-GitHub-Delivery al reenviar y el unique de code_reviews ya impide revisar dos veces un commit.
// Respuestas sin datos de la org (como mucho el review_id). Logs: rid, config, evento, sha7 y conteos.
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

// repository.id = connections.meta.repo_id; sin repo_id, full_name en minúsculas. Un webhook de organización o de otro
// repo no trae este repositorio.
function mismoRepo(payload: Obj, meta: Obj): boolean {
  const repo = obj(payload.repository);
  const id = meta.repo_id;
  if ((typeof id === 'number' && Number.isSafeInteger(id)) || (typeof id === 'string' && /^\d{1,20}$/.test(id))) {
    return (typeof repo.id === 'number' || typeof repo.id === 'string') && String(repo.id) === String(id);
  }
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

// Mismo commit ya registrado (23505 del unique). Una failed, o una queued que nunca empezó tras 2 min, se reabre con CAS
// (where status = el leído) y se reencola: así «Redeliver» repite una revisión fallida o atascada. Si no, repetido.
async function repetido(c: Context<AppEnv>, cfg: Config, after: string, delivery: string | null) {
  const rid = c.get('rid');
  const admin = db(c.env);
  const { data, error } = await admin.from('code_reviews').select('id, status, started_at, created_at')
    .eq('config_id', cfg.id).eq('org_id', cfg.org_id).eq('event', 'push').eq('head_sha', after).maybeSingle();
  const fila = obj(data);
  const id = str(fila.id);
  if (error || !id) {
    log('error', 'github.repetido_error', { rid, config: cfg.id, code: error?.code ?? null });
    return fail(c, 'internal', 'No pudimos registrar el evento');
  }
  const atascada = fila.status === 'queued' && !fila.started_at && Date.now() - Date.parse(String(fila.created_at)) > ATASCADA_MS;
  if (fila.status !== 'failed' && !atascada) return ignorado(c, cfg, 'push', 'repetido');
  // created_at = este encolado (no hay queued_at): la regla de 2 min, el «interrumpida» de E45 (15 min) y alert.seconds
  // miden desde aquí; si no, otra entrega inmediata vería atascada una failed antigua recién reabierta.
  let q = admin.from('code_reviews').update({ status: 'queued', error_code: null, started_at: null, finished_at: null,
    partial: false, delivery_id: delivery, created_at: new Date().toISOString() })
    .eq('id', id).eq('org_id', cfg.org_id).eq('status', String(fila.status));
  if (atascada) q = q.is('started_at', null);
  const { data: abiertas, error: eu } = await q.select('id');
  if (eu) {
    log('error', 'github.reabrir_error', { rid, config: cfg.id, code: eu.code ?? null });
    return fail(c, 'internal', 'No pudimos registrar el evento');
  }
  if (!Array.isArray(abiertas) || abiertas.length === 0) return ignorado(c, cfg, 'push', 'repetido');   // otra entrega se adelantó
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
  log('info', 'github.push', { rid, config: cfg.id, sha7: after.slice(0, 7), resultado: 'reintento', previo: String(fila.status) });
  return c.json({ ok: true, review_id: id, reintento: true }, 202);
}

// push (§1.3): a la rama vigilada (de la config, nunca del payload), no borrada y con before de una rama que ya existía.
// Un merge de PR (merge, squash o rebase) llega como push a la rama: entra aquí.
async function push(c: Context<AppEnv>, cfg: Config, payload: Obj) {
  const rid = c.get('rid');
  if (!cfg.enabled) return ignorado(c, cfg, 'push', 'desactivada');
  if (payload.ref !== `refs/heads/${cfg.branch}`) return ignorado(c, cfg, 'push', 'rama');
  const before = str(payload.before), after = str(payload.after);
  if (payload.deleted === true || after === CERO) return ignorado(c, cfg, 'push', 'borrado');
  if (!before || !after || !SHA.test(before) || !SHA.test(after)) {
    return fail(c, 'invalid_body', 'El push no trae before y after válidos', undefined, 400);
  }
  if (before === CERO) return ignorado(c, cfg, 'push', 'rama_nueva');
  const cabecera = (c.req.header('x-github-delivery') ?? '').trim();
  const delivery = GUID.test(cabecera) ? cabecera : null;
  const admin = db(c.env);
  const { data, error } = await admin.from('code_reviews').insert({ org_id: cfg.org_id, config_id: cfg.id, event: 'push',
    branch: cfg.branch, base_sha: before, head_sha: after, push_commits: commitsDelPush(payload.commits, after),
    ...(delivery ? { delivery_id: delivery } : {}) }).select('id').single();
  if (error?.code === '23505') return repetido(c, cfg, after, delivery);
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
  log('info', 'github.push', { rid, config: cfg.id, sha7: after.slice(0, 7), commits: Array.isArray(payload.commits)
    ? payload.commits.length : 0, resultado: 'encolada' });
  return c.json({ ok: true, review_id: id }, 202);
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
  const { success } = await c.env.RL_COSTLY.limit({ key: `gh:${cfg.id}` });
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

  const cabecera = (c.req.header('x-github-event') ?? '').trim();
  const evento = EVENTO.test(cabecera) ? cabecera : 'otro';
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
  return ignorado(c, cfg, evento, evento === 'pull_request' ? 'pr_p1' : 'evento');   // el PR abierto va en otro encargo
});
