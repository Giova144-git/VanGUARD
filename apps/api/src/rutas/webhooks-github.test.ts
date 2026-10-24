import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody } from '@vanguard/contracts';
import type { JobMsg } from '../jobs.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// E47 sin red (asignaciones/revision-codigo.md §4.1 y pruebas B4+B5 de §8.2): supabase-js con el doble y claveWebhook con
// la clave HMAC de un secreto conocido (abrir secret_sealed con las llaves se prueba con credentials.ts; `claveReal` usa
// la de verdad para medir el coste en frío). Secreto armado en tiempo de ejecución: ningún literal con forma de secreto.
const estado = vi.hoisted(() => ({ client: null as unknown, secreto: ['secreto', 'webhook', 'github', 'prueba'].join('-'),
  claveReal: false }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
vi.mock('../lib/credentials.ts', async (orig) => {
  const real = await orig<typeof import('../lib/credentials.ts')>();
  return {
    ...real,
    claveWebhook: (...a: Parameters<typeof real.claveWebhook>) => (estado.claveReal ? real.claveWebhook(...a)
      : crypto.subtle.importKey('raw', new TextEncoder().encode(estado.secreto), { name: 'HMAC', hash: 'SHA-256' }, false,
        ['verify'])),
  };
});

const { app } = await import('../app.ts');
const { commitsDelPush } = await import('./webhooks-github.ts');

const enc = new TextEncoder();
const SECRETO = estado.secreto;
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const CFG = 'c4000000-0000-4000-8000-000000000001';
const CONN = 'c0000000-0000-4000-8000-000000000001';
const OTRA = 'c4000000-0000-4000-8000-0000000000ff';
const REPO_ID = 424242;
const ANTES = '3b18e1a9c0d24f6e8a7b5c4d3e2f1a0b9c8d7e6f';
const HEAD = '9f1c2e7a4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a';
const MEDIO = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const CERO = '0'.repeat(40);
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const URL_PROD = 'https://officialvanguard.com/webhooks/github/';
const PROD = { VG_ENV: 'production' as const, APP_ORIGIN: 'https://officialvanguard.com' };

type Fila = Record<string, unknown>;
let config: Fila | null;
let conexion: Fila | null;
let revisiones: Fila[];
let errores: { insert?: Resp['error']; conexion?: Resp['error'] };
let doble: ReturnType<typeof dbDoble>;
let verify: ReturnType<typeof vi.spyOn>;

// Filtros eq / in / is del doble evaluados sobre una fila en memoria.
const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) =>
  o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : o === 'is' ? (f[c] ?? null) === v : true);

beforeEach(() => {
  config = { id: CFG, org_id: ORG, connection_id: CONN, enabled: true, branch: 'main',
    secret_sealed: { v: 1, kid: 'v1', iv: 'iv-1', ct: 'x', ivk: 'y', wdek: 'z' } };
  conexion = { meta: { repo_full_name: 'Acme/Tienda', repo_id: REPO_ID, default_branch: 'main' } };
  revisiones = [];
  errores = {};
  estado.claveReal = false;
  doble = dbDoble({
    tabla: (op): Resp | undefined => {
      if (op.table === 'code_review_configs' && op.action === 'select') return { data: eqDe(op, 'id') === CFG ? config : null };
      if (op.table === 'connections') {
        if (errores.conexion) return { error: errores.conexion };
        return { data: eqDe(op, 'id') === CONN && eqDe(op, 'org_id') === ORG ? conexion : null };
      }
      if (op.table !== 'code_reviews') return undefined;
      if (op.action === 'insert') {
        if (errores.insert) return { error: errores.insert };
        const f = op.payload as Fila;
        if (revisiones.some((r) => r.config_id === f.config_id && r.event === f.event && r.head_sha === f.head_sha)) {
          return { error: { code: '23505' } };
        }
        const fila = { id: `rev-${revisiones.length + 1}`, status: 'queued', started_at: null,
          created_at: new Date().toISOString(), ...f };
        revisiones.push(fila);
        return { data: { id: fila.id } };
      }
      const hits = revisiones.filter((r) => cumple(r, op));
      if (op.action === 'select') return { data: hits[0] ?? null };
      if (op.action === 'update') {
        for (const r of hits) Object.assign(r, op.payload);
        return { data: hits.map((r) => ({ id: r.id })) };
      }
      if (op.action === 'delete') { revisiones = revisiones.filter((r) => !hits.includes(r)); return {}; }
      return undefined;
    },
  });
  estado.client = doble.client;
  verify = vi.spyOn(crypto.subtle, 'verify');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

async function firmar(cuerpo: string, secreto = SECRETO): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return 'sha256=' + Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(cuerpo))),
    (b) => b.toString(16).padStart(2, '0')).join('');
}

type Opciones = { id?: string; firma?: string | null; secreto?: string; tipo?: string; base?: string; delivery?: string;
  env?: Partial<CloudflareBindings>; cabeceras?: Record<string, string> };
async function enviar(evento: string, payload: unknown, o: Opciones = {}) {
  const cuerpo = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': o.tipo ?? 'application/json', 'x-github-event': evento,
    'x-github-delivery': o.delivery ?? DELIVERY, 'user-agent': 'GitHub-Hookshot/abc123', 'cf-connecting-ip': '192.0.2.10',
    ...o.cabeceras };
  const firma = o.firma === undefined ? await firmar(cuerpo, o.secreto) : o.firma;
  if (firma !== null) headers['x-hub-signature-256'] = firma;
  const d = envDoble({ ...PROD, ...o.env });
  const r = await app.request((o.base ?? URL_PROD) + (o.id ?? CFG), { method: 'POST', headers, body: cuerpo }, d.env);
  return { r, enviados: d.enviados, json: await r.clone().json() as Record<string, unknown> };
}

const REPO = { id: REPO_ID, full_name: 'Acme/Tienda' };
const ping = (events: unknown[] = ['pull_request', 'push'], repository: unknown = REPO) =>
  ({ zen: 'Keep it logically awesome.', hook_id: 7, hook: { type: 'Repository', events, active: true }, repository });
const pushP = (extra: Fila = {}) => ({ ref: 'refs/heads/main', before: ANTES, after: HEAD, created: false, deleted: false,
  forced: false, repository: REPO, commits: [{ id: MEDIO, message: 'wip' }, { id: HEAD, message: 'feat: cobro con tarjeta' }],
  head_commit: { id: HEAD }, ...extra });
const de = (tabla: string, action: Op['action']) => doble.ops.filter((o) => o.table === tabla && o.action === action);
const sinRequestId = (j: Record<string, unknown>) => {
  const e = { ...(j.error as Record<string, unknown>) };
  delete e.request_id;
  return e;
};

describe('E47 · firma antes de todo', () => {
  it('id inexistente, ilegible o firma mala → el mismo 401 «Firma no válida», con verificación de relleno, sin escribir', async () => {
    const inexistente = await enviar('push', pushP(), { id: OTRA });
    const ilegible = await enviar('push', pushP(), { id: 'no-es-un-uuid' });
    const mala = await enviar('push', pushP(), { firma: 'sha256=' + 'ab'.repeat(32) });
    for (const x of [inexistente, ilegible, mala]) {
      expect(x.r.status).toBe(401);
      expect(ApiErrorBody.parse(x.json).error.code).toBe('unauthorized');
    }
    expect(sinRequestId(inexistente.json)).toEqual({ code: 'unauthorized', message: 'Firma no válida' });
    expect(sinRequestId(ilegible.json)).toEqual(sinRequestId(inexistente.json));
    expect(sinRequestId(mala.json)).toEqual(sinRequestId(inexistente.json));
    // Las tres pasan por crypto.subtle.verify (la de relleno en las dos primeras).
    expect(verify).toHaveBeenCalledTimes(3);
    expect(doble.ops.every((o) => o.action === 'select' && o.table === 'code_review_configs')).toBe(true);
    expect([...inexistente.enviados, ...ilegible.enviados, ...mala.enviados]).toEqual([]);
  });

  it('en frío, un id inexistente pide las llaves como una config existente con firma mala (mismo coste, mismo 401)', async () => {
    estado.claveReal = true;   // claveWebhook real: abrir secret_sealed pide vg_crypto_material si las llaves no están en caché
    const mala = await enviar('push', pushP(), { firma: 'sha256=' + 'ab'.repeat(32) });
    const conConfig = doble.rpcs.length;
    const inexistente = await enviar('push', pushP(), { id: OTRA });
    expect([mala.r.status, inexistente.r.status]).toEqual([401, 401]);
    expect(sinRequestId(mala.json)).toEqual(sinRequestId(inexistente.json));
    expect(conConfig).toBe(1);
    expect(doble.rpcs.length - conConfig).toBe(1);
    expect(doble.rpcs.map((r) => r.name)).toEqual(['vg_crypto_material', 'vg_crypto_material']);
  });

  it('solo X-Hub-Signature (SHA-1), sin firma, con otro secreto o con la firma de otro cuerpo → 401', async () => {
    const cuerpo = JSON.stringify(pushP());
    const sha1 = await enviar('push', cuerpo, { firma: null, cabeceras: { 'x-hub-signature': 'sha1=' + 'ab'.repeat(20) } });
    expect(sha1.r.status).toBe(401);
    expect((await enviar('push', cuerpo, { firma: null })).r.status).toBe(401);
    expect((await enviar('push', cuerpo, { secreto: 'otro-secreto' })).r.status).toBe(401);
    expect((await enviar('push', cuerpo, { firma: await firmar('{"otro":1}') })).r.status).toBe(401);
    expect((await enviar('push', cuerpo, { firma: (await firmar(cuerpo)).slice(7) })).r.status).toBe(401);   // sin «sha256=»
    expect(revisiones).toEqual([]);
  });

  it('host workers.dev → 403 tras la firma; con firma mala, 401 (no revela nada); en local, cualquier host', async () => {
    const base = 'https://vanguard.cuenta.workers.dev/webhooks/github/';
    const prueba = await enviar('push', pushP(), { base });
    expect(prueba.r.status).toBe(403);
    expect(ApiErrorBody.parse(prueba.json).error.code).toBe('forbidden');
    expect((await enviar('push', pushP(), { base, firma: 'sha256=' + 'cd'.repeat(32) })).r.status).toBe(401);
    expect(revisiones).toEqual([]);
    expect(prueba.enviados).toEqual([]);
    const local = await enviar('push', pushP(), { base: 'http://localhost:8787/webhooks/github/', env: { VG_ENV: 'local' } });
    expect(local.r.status).toBe(202);
  });

  it('RL_COSTLY con la clave gh:<config>, solo tras autenticar → 429', async () => {
    const claves: string[] = [];
    const lleno = { limit: vi.fn(async ({ key }: { key: string }) => { claves.push(key); return { success: false }; }) };
    expect((await enviar('push', pushP(), { firma: 'sha256=' + 'ab'.repeat(32), env: { RL_COSTLY: lleno } })).r.status).toBe(401);
    expect(claves).toEqual([]);
    const x = await enviar('push', pushP(), { env: { RL_COSTLY: lleno } });
    expect(x.r.status).toBe(429);
    expect(x.r.headers.get('retry-after')).toBe('60');
    expect(claves).toEqual([`gh:${CFG}`]);
    expect(revisiones).toEqual([]);
  });

  it('form-urlencoded → 400 «Elige Content type…»; JSON ilegible → 400 invalid_body; > 1 MB → 413 sin tocar la base', async () => {
    const form = await enviar('push', 'payload=%7B%7D', { tipo: 'application/x-www-form-urlencoded' });
    expect(form.r.status).toBe(400);
    expect(sinRequestId(form.json))
      .toEqual({ code: 'invalid_body', message: 'Elige Content type: application/json en el webhook' });
    const roto = await enviar('push', '{"ref":', {});
    expect(roto.r.status).toBe(400);
    expect(ApiErrorBody.parse(roto.json).error.code).toBe('invalid_body');
    doble.ops.length = 0;
    const grande = await enviar('push', 'x'.repeat(1024 * 1024 + 1), { firma: 'sha256=' + 'ab'.repeat(32) });
    expect(grande.r.status).toBe(413);
    expect(doble.ops).toHaveLength(0);
    expect(revisiones).toEqual([]);
  });
});

describe('E47 · ping', () => {
  it('ping con Pushes → 200, last_ping_at, hook_events y sin last_error («Conectada»), también con la revisión apagada', async () => {
    config!.enabled = false;
    const x = await enviar('ping', ping());
    expect(x.r.status).toBe(200);
    expect(x.json).toEqual({ ok: true });
    const u = de('code_review_configs', 'update')[0]!;
    expect(u.payload).toMatchObject({ hook_events: ['pull_request', 'push'], last_error: null, last_error_at: null });
    expect(typeof (u.payload as Fila).last_ping_at).toBe('string');
    expect(eqDe(u, 'id')).toBe(CFG);
    expect(eqDe(u, 'org_id')).toBe(ORG);
    expect(x.enviados).toEqual([]);
  });

  it('sin push ni * → last_error sin_push; con * → conectado; eventos raros fuera y como mucho 30', async () => {
    await enviar('ping', ping(['issues', 'pull_request']));
    expect(de('code_review_configs', 'update')[0]!.payload)
      .toMatchObject({ last_error: 'sin_push', hook_events: ['issues', 'pull_request'] });
    // E45 da «error» solo con last_error_at posterior al último ping.
    const u = de('code_review_configs', 'update')[0]!.payload as Fila;
    expect(Date.parse(String(u.last_error_at))).toBeGreaterThan(Date.parse(String(u.last_ping_at)));
    doble.ops.length = 0;
    await enviar('ping', ping(['*']));
    expect(de('code_review_configs', 'update')[0]!.payload).toMatchObject({ last_error: null, hook_events: ['*'] });
    doble.ops.length = 0;
    const muchos = [...Array.from({ length: 40 }, (_, i) => `evento_${String.fromCharCode(97 + (i % 26))}${i >= 26 ? 'x' : ''}`),
      'push', 'Push<script>', 'x'.repeat(41), 7];
    await enviar('ping', ping(muchos));
    const eventos = (de('code_review_configs', 'update')[0]!.payload as Fila).hook_events as string[];
    expect(eventos).toHaveLength(30);
    expect(eventos.every((e) => /^[a-z_*]{1,40}$/.test(e))).toBe(true);
  });

  it('ping de otro repositorio → 202 otro_repo y last_error otro_repo', async () => {
    const x = await enviar('ping', ping(['push'], { id: 999, full_name: 'Acme/Otro' }));
    expect(x.r.status).toBe(202);
    expect(x.json).toEqual({ ok: true, ignorado: 'otro_repo' });
    expect(de('code_review_configs', 'update')[0]!.payload).toMatchObject({ last_error: 'otro_repo' });
  });

  it('sin repo_id en meta compara full_name en minúsculas', async () => {
    conexion = { meta: { repo_full_name: 'Acme/Tienda' } };
    expect((await enviar('ping', ping(['push'], { id: 1, full_name: 'acme/TIENDA' }))).r.status).toBe(200);
    expect(de('code_review_configs', 'update')[0]!.payload).toMatchObject({ last_error: null });
  });
});

describe('E47 · push', () => {
  it('push a la rama vigilada → code_reviews queued + JOBS_Q diff + last_event_at → 202 {ok, review_id}', async () => {
    const x = await enviar('push', pushP());
    expect(x.r.status).toBe(202);
    expect(x.json).toEqual({ ok: true, review_id: 'rev-1' });   // nunca datos de la org
    const ins = de('code_reviews', 'insert')[0]!.payload as Fila;
    expect(ins).toEqual({ org_id: ORG, config_id: CFG, event: 'push', branch: 'main', base_sha: ANTES, head_sha: HEAD,
      push_commits: [MEDIO, HEAD], delivery_id: DELIVERY });
    expect(x.enviados).toEqual([{ v: 1, kind: 'review', org_id: ORG, review_id: 'rev-1', paso: 'diff' }] satisfies JobMsg[]);
    const u = de('code_review_configs', 'update')[0]!;
    expect(Object.keys(u.payload as Fila)).toEqual(['last_event_at']);
    expect(eqDe(u, 'org_id')).toBe(ORG);
  });

  it('la org sale de la config y el repo de la conexión: un payload con otra URL o nombre no entra en la fila', async () => {
    const x = await enviar('push', pushP({ repository: { id: REPO_ID, full_name: 'evil/otro', url: 'https://evil.example/r',
      compare: 'https://evil.example/c' }, compare: 'https://evil.example/compare', organization: { id: 1 } }));
    expect(x.r.status).toBe(202);
    const ins = JSON.stringify(de('code_reviews', 'insert')[0]!.payload);
    expect(ins).not.toContain('evil');
    expect(ins).toContain(ORG);
  });

  it('otra rama, rama borrada, rama nueva o revisión desactivada → 202 ignorado sin filas ni mensajes', async () => {
    const casos: [Fila, string][] = [
      [{ ref: 'refs/heads/dev' }, 'rama'],
      [{ ref: 'refs/tags/main' }, 'rama'],
      [{ deleted: true, after: CERO }, 'borrado'],
      [{ before: CERO, created: true }, 'rama_nueva'],
    ];
    for (const [extra, motivo] of casos) {
      const x = await enviar('push', pushP(extra));
      expect(x.r.status).toBe(202);
      expect(x.json).toEqual({ ok: true, ignorado: motivo });
      expect(x.enviados).toEqual([]);
    }
    config!.enabled = false;
    expect((await enviar('push', pushP())).json).toEqual({ ok: true, ignorado: 'desactivada' });
    expect(revisiones).toEqual([]);
  });

  it('push de otro repositorio → 202 otro_repo, sin filas y sin tocar last_error', async () => {
    const x = await enviar('push', pushP({ repository: { id: 1, full_name: 'Acme/Tienda' } }));
    expect(x.json).toEqual({ ok: true, ignorado: 'otro_repo' });
    expect(revisiones).toEqual([]);
    expect(de('code_review_configs', 'update')).toEqual([]);
  });

  it('pull_request → 202 pr_p1 (otro encargo); otros eventos → 202 evento', async () => {
    expect((await enviar('pull_request', { action: 'opened', repository: REPO })).json).toEqual({ ok: true, ignorado: 'pr_p1' });
    expect((await enviar('issues', { action: 'opened', repository: REPO })).json).toEqual({ ok: true, ignorado: 'evento' });
    expect(revisiones).toEqual([]);
  });

  it('mismo commit ya revisado → 202 repetido sin reencolar', async () => {
    await enviar('push', pushP());
    revisiones[0]!.status = 'done';
    const x = await enviar('push', pushP());
    expect(x.r.status).toBe(202);
    expect(x.json).toEqual({ ok: true, ignorado: 'repetido' });
    expect(x.enviados).toEqual([]);
    expect(revisiones).toHaveLength(1);
  });

  it('revisión failed → «Redeliver» la reabre con CAS y la reencola: 202 reintento', async () => {
    await enviar('push', pushP());
    Object.assign(revisiones[0]!, { status: 'failed', error_code: 'unavailable', started_at: '2026-10-24T19:20:12Z',
      finished_at: '2026-10-24T19:20:40Z', partial: true });
    doble.ops.length = 0;
    const otra = 'a1b2c3d4-0000-4000-8000-000000000999';
    const x = await enviar('push', pushP(), { delivery: otra });
    expect(x.r.status).toBe(202);
    expect(x.json).toEqual({ ok: true, review_id: 'rev-1', reintento: true });
    const u = de('code_reviews', 'update')[0]!;
    expect(u.filters).toContainEqual(['status', 'eq', 'failed']);
    expect(eqDe(u, 'org_id')).toBe(ORG);
    expect(revisiones[0]).toMatchObject({ status: 'queued', error_code: null, started_at: null, finished_at: null, partial: false,
      delivery_id: otra });
    expect(x.enviados).toEqual([{ v: 1, kind: 'review', org_id: ORG, review_id: 'rev-1', paso: 'diff' }]);
  });

  it('la reapertura renueva created_at: otra entrega inmediata de una failed antigua ya reabierta → repetido', async () => {
    await enviar('push', pushP());
    const antigua = new Date(Date.now() - 3600_000).toISOString();
    Object.assign(revisiones[0]!, { status: 'failed', error_code: 'not_found', created_at: antigua });
    const x = await enviar('push', pushP(), { delivery: 'a1b2c3d4-0000-4000-8000-000000000001' });
    expect(x.json).toEqual({ ok: true, review_id: 'rev-1', reintento: true });
    // La regla de 2 min, el «interrumpida» de E45 (15 min) y alert.seconds miden desde este encolado.
    expect(Date.now() - Date.parse(String(revisiones[0]!.created_at))).toBeLessThan(60_000);
    const y = await enviar('push', pushP(), { delivery: 'a1b2c3d4-0000-4000-8000-000000000002' });
    expect(y.json).toEqual({ ok: true, ignorado: 'repetido' });
    expect(y.enviados).toEqual([]);
  });

  it('queued sin empezar de más de 2 min → se reabre igual; de menos de 2 min → repetido', async () => {
    await enviar('push', pushP());
    expect((await enviar('push', pushP())).json).toEqual({ ok: true, ignorado: 'repetido' });
    revisiones[0]!.created_at = new Date(Date.now() - 3 * 60_000).toISOString();
    doble.ops.length = 0;
    const x = await enviar('push', pushP());
    expect(x.json).toEqual({ ok: true, review_id: 'rev-1', reintento: true });
    expect(de('code_reviews', 'update')[0]!.filters).toContainEqual(['started_at', 'is', null]);
    expect(Date.now() - Date.parse(String(revisiones[0]!.created_at))).toBeLessThan(60_000);
    expect(x.enviados).toHaveLength(1);
  });

  it('falla encolar → 500 y la fila recién insertada se borra (sin filas a medias); la reabierta, failed/encolar', async () => {
    const roto = { send: vi.fn(async () => { throw new Error('cola caída'); }) } as unknown as CloudflareBindings['JOBS_Q'];
    const x = await enviar('push', pushP(), { env: { JOBS_Q: roto } });
    expect(x.r.status).toBe(500);
    expect(ApiErrorBody.parse(x.json).error.code).toBe('internal');
    expect(revisiones).toEqual([]);
    expect(eqDe(de('code_reviews', 'delete')[0]!, 'org_id')).toBe(ORG);

    await enviar('push', pushP());
    revisiones[0]!.status = 'failed';
    const y = await enviar('push', pushP(), { env: { JOBS_Q: roto } });
    expect(y.r.status).toBe(500);
    expect(revisiones[0]).toMatchObject({ status: 'failed', error_code: 'encolar' });
  });

  it('otro error de la base al insertar → 500 sin mensaje en la cola', async () => {
    errores.insert = { code: '08006' };
    const x = await enviar('push', pushP());
    expect(x.r.status).toBe(500);
    expect(x.enviados).toEqual([]);
  });

  it('X-GitHub-Delivery que no es un GUID no se guarda; before o after ilegibles → 400', async () => {
    await enviar('push', pushP(), { delivery: 'no-guid' });
    expect(de('code_reviews', 'insert')[0]!.payload).not.toHaveProperty('delivery_id');
    expect((await enviar('push', pushP({ after: 'HEAD' }))).r.status).toBe(400);
  });
});

describe('commitsDelPush', () => {
  it('los últimos 49 SHA de commits, sin repetir ni ilegibles, más after (≤ 50)', () => {
    const sha = (i: number) => i.toString(16).padStart(40, '0');
    const commits = [...Array.from({ length: 60 }, (_, i) => ({ id: sha(i + 1) })), { id: sha(5) }, { id: 'HEAD' }, { id: 7 },
      { id: HEAD }];
    const r = commitsDelPush(commits, HEAD);
    expect(r).toHaveLength(50);
    expect(r.at(-1)).toBe(HEAD);
    expect(new Set(r).size).toBe(50);
    expect(r[0]).toBe(sha(12));
    expect(commitsDelPush(undefined, HEAD)).toEqual([HEAD]);
  });
});
