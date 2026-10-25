// E45, E46, E48 y E49 (revisión de código, asignaciones/revision-codigo.md §4.1 y las pruebas de B3 en §8.2).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertPrefs, CodeReviewSaved, CodeReviewState } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const sello = vi.hoisted(() => ({ llamadas: [] as { org: string; id: string; secreto: string }[], olvidadas: [] as string[] }));
vi.mock('../lib/credentials.ts', () => ({
  sellarSecretoWebhook: async (_env: unknown, _admin: unknown, org: string, id: string, secreto: string) => {
    sello.llamadas.push({ org, id, secreto });
    return { sealed: { v: 1, kid: 'v1', iv: 'aXY=', ct: 'Y3Q=', ivk: 'aXZr', wdek: 'd2Rlaw==' }, kid: 'v1', last4: secreto.slice(-4) };
  },
  olvidarClaveWebhook: (id: string) => { sello.olvidadas.push(id); },
}));

const { app } = await import('../app.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const CONN = 'c0c00000-0000-4000-8000-000000000001';
const CFG = 'c4000000-0000-4000-8000-000000000001';
const REV = 'c4000000-0000-4000-8000-000000000011';
const SHA = 'a'.repeat(40);
let rol: string;
let anon: boolean;
let conexion: Record<string, unknown> | null;
let config: Record<string, unknown> | null;
let revisiones: Record<string, unknown>[];
let avisos: Record<string, unknown>[];
let tabla: (op: Op) => Resp | undefined;
let doble: ReturnType<typeof dbDoble>;

const filaConfig = (o: Record<string, unknown> = {}) => ({ id: CFG, connection_id: CONN, enabled: true, branch: 'main',
  secret_last4: 'Q7xk', hook_events: ['push', 'pull_request'], last_ping_at: '2026-10-24T18:20:03+00:00',
  last_event_at: null, last_error: null, last_error_at: null, ...o });

beforeEach(() => {
  rol = 'owner'; anon = false; sello.llamadas = []; sello.olvidadas = [];
  conexion = { id: CONN, status: 'active', meta: { repo_full_name: 'acme/tienda', default_branch: 'main' } };
  config = null; revisiones = []; avisos = []; tabla = () => undefined;
  doble = dbDoble({
    tabla: (op) => {
      const propia = tabla(op);
      if (propia) return propia;
      if (op.table === 'org_members') return { data: { role: rol } };
      if (op.table === 'connections') {
        const pideOtra = eqDe(op, 'id') !== undefined && eqDe(op, 'id') !== CONN;
        return { data: conexion && eqDe(op, 'org_id') === ORG && !pideOtra ? [conexion] : [] };
      }
      if (op.table === 'code_review_configs' && op.action === 'select') {
        if (eqDe(op, 'org_id') !== ORG) return { data: null };
        return { data: op.single ? config : config ? [config] : [] };
      }
      if (op.table === 'code_review_configs' && op.action === 'insert') return { data: { ...filaConfig(), ...(op.payload as object), last_ping_at: null } };
      if (op.table === 'code_review_configs' && op.action === 'update') return { data: { ...config, ...(op.payload as object) } };
      if (op.table === 'code_reviews') return { data: eqDe(op, 'org_id') === ORG ? revisiones : [] };
      if (op.table === 'notifications') return { data: avisos };
      return undefined;
    },
    claims: (t) => (t === 'ok' ? { sub: ANA, email: anon ? '' : 'ana@acme.dev', is_anonymous: anon } : null),
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const pedir = (ruta: string, init: { method?: string; body?: unknown } = {}, extra: Partial<CloudflareBindings> = {}) =>
  app.request(`https://officialvanguard.com/api/orgs/${ORG}/${ruta}`, { method: init.method ?? 'GET',
    headers: { authorization: 'Bearer ok', 'content-type': 'application/json', origin: 'https://officialvanguard.com' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }, envDoble(extra).env);
const PROD = { VG_ENV: 'production', APP_ORIGIN: 'https://officialvanguard.com' } as Partial<CloudflareBindings>;

describe('E45 · GET code-review', () => {
  it('sin conexión GitHub → available:false sin_conexion; inactiva → conexion_inactiva', async () => {
    conexion = null;
    expect(CodeReviewState.parse(await (await pedir('code-review')).json())).toMatchObject({ available: false, reason: 'sin_conexion', config: null });
    conexion = { id: CONN, status: 'revoked', meta: { repo_full_name: 'acme/tienda' } };
    expect(CodeReviewState.parse(await (await pedir('code-review')).json())).toMatchObject({ available: false, reason: 'conexion_inactiva' });
  });

  it('varias conexiones (B0): la ACTIVA más antigua es la principal; sin ninguna activa, la más antigua (inactiva)', async () => {
    const vieja = { id: CONN, status: 'revoked', meta: { repo_full_name: 'acme/vieja', default_branch: 'main' } };
    const activa = { id: 'c0c00000-0000-4000-8000-000000000002', status: 'active', meta: { repo_full_name: 'acme/tienda' } };
    const nueva = { id: 'c0c00000-0000-4000-8000-000000000003', status: 'active', meta: { repo_full_name: 'acme/segundo' } };
    let filas: unknown[] = [vieja, activa, nueva];   // como las devuelve la base: created_at e id ascendentes
    tabla = (op) => (op.table === 'connections' ? { data: filas } : undefined);
    expect(CodeReviewState.parse(await (await pedir('code-review')).json())).toMatchObject({ available: true, reason: null });
    const sel = doble.ops.find((o) => o.table === 'connections')!;
    expect(sel.orden).toEqual([['created_at', true], ['id', true]]);
    filas = [vieja, { ...activa, status: 'error' }];
    expect(CodeReviewState.parse(await (await pedir('code-review')).json())).toMatchObject({ available: false, reason: 'conexion_inactiva' });
  });

  it('webhook_url solo para owner/admin en producción: viewer, anónimo y local → null', async () => {
    config = filaConfig();
    const admin = CodeReviewState.parse(await (await pedir('code-review', {}, PROD)).json());
    expect(admin.config).toMatchObject({ state: 'connected', repo_full_name: 'acme/tienda',
      webhook_url: `https://officialvanguard.com/webhooks/github/${CFG}` });
    expect(CodeReviewState.parse(await (await pedir('code-review')).json()).config!.webhook_url).toBeNull();
    rol = 'viewer';
    expect(CodeReviewState.parse(await (await pedir('code-review', {}, PROD)).json()).config!.webhook_url).toBeNull();
    rol = 'viewer'; anon = true;
    const r = await pedir('code-review', {}, PROD);
    expect(r.status).toBe(200);
    expect(CodeReviewState.parse(await r.json()).config!.webhook_url).toBeNull();
  });

  it('nunca lleva el secreto ni columnas del sellado', async () => {
    config = filaConfig();
    await pedir('code-review', {}, PROD);
    const sel = doble.ops.find((o) => o.table === 'code_review_configs')!;
    expect(sel.columns).not.toMatch(/secret_sealed|secret_kid/);
  });

  it('state: off, error (fallo posterior al último ping), waiting_ping y connected', async () => {
    const estadoDe = async (o: Record<string, unknown>) => {
      config = filaConfig(o);
      return CodeReviewState.parse(await (await pedir('code-review')).json()).config!.state;
    };
    expect(await estadoDe({ enabled: false })).toBe('off');
    expect(await estadoDe({ last_error: 'sin_push', last_error_at: '2026-10-24T18:30:00+00:00' })).toBe('error');
    expect(await estadoDe({ last_error: 'sin_push', last_error_at: '2026-10-24T18:00:00+00:00' })).toBe('connected');
    expect(await estadoDe({ last_ping_at: null })).toBe('waiting_ping');
  });

  it('una revisión queued de más de 15 min sale failed/interrumpida; delivery = el mejor estado; 131047 en delivery_error', async () => {
    config = filaConfig();
    const base = { event: 'push', branch: 'main', pr_number: null, base_sha: SHA, head_sha: 'b'.repeat(40), error_code: null,
      partial: false, files_changed: 1, lines_added: 3, counts: { critical: 1 }, max_severity: 'critical', new_findings: [],
      alert_reason: null, voice_pending: false, finished_at: null };
    revisiones = [
      { ...base, id: REV, status: 'done', alert_state: 'sent', created_at: '2026-10-24T19:20:11+00:00',
        notified_at: '2026-10-24T19:20:17.4+00:00' },
      { ...base, id: 'c4000000-0000-4000-8000-000000000012', status: 'queued', alert_state: 'none', notified_at: null,
        created_at: new Date(Date.now() - 20 * 60_000).toISOString() },
      { ...base, id: 'c4000000-0000-4000-8000-000000000013', status: 'done', alert_state: 'sent', notified_at: null,
        created_at: '2026-10-24T19:00:00+00:00' },
    ];
    avisos = [{ code_review_id: REV, status: 'sent', error: null }, { code_review_id: REV, status: 'read', error: null },
      { code_review_id: 'c4000000-0000-4000-8000-000000000013', status: 'failed', error: '131047' }];
    const s = CodeReviewState.parse(await (await pedir('code-review')).json());
    expect(s.recent[0]!.alert).toMatchObject({ state: 'sent', delivery: 'read', delivery_error: null });
    expect(s.recent[0]!.alert.seconds).toBeCloseTo(6.4, 5);
    expect(s.recent[0]!.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 0, info: 0 });
    expect(s.recent[1]).toMatchObject({ status: 'failed', error_code: 'interrumpida' });
    expect(s.recent[2]!.alert).toMatchObject({ delivery: 'failed', delivery_error: '131047' });
    const sel = doble.ops.find((o) => o.table === 'notifications')!;
    expect(eqDe(sel, 'org_id')).toBe(ORG);
  });
});

// E45 por repo (asignaciones/varias-codebases.md §3, B6): ?connection_id= da el estado de ESE repo; sin él, la principal.
describe('E45 · ?connection_id= (varias-codebases B6)', () => {
  const CONN_2 = 'c0c00000-0000-4000-8000-000000000002';
  const CFG_2 = 'c4000000-0000-4000-8000-000000000002';
  const REV_2 = 'c4000000-0000-4000-8000-000000000012';
  let conexiones: Record<string, unknown>[];
  let configs: Record<string, unknown>[];
  const rev = (id: string, config_id: string) => ({ id, config_id, event: 'push', branch: 'main', pr_number: null, base_sha: SHA,
    head_sha: 'b'.repeat(40), status: 'done', error_code: null, partial: false, files_changed: 1, lines_added: 3, counts: {},
    max_severity: null, new_findings: [], alert_state: 'none', alert_reason: null, voice_pending: false, notified_at: null,
    created_at: '2026-10-24T19:20:11+00:00', finished_at: '2026-10-24T19:20:15+00:00' });
  // Como Postgres: cada consulta solo ve lo que casa con sus .eq() (org, id de la conexión, connection_id, config_id).
  beforeEach(() => {
    conexiones = [{ id: CONN, status: 'active', meta: { repo_full_name: 'acme/tienda', default_branch: 'main' } },
      { id: CONN_2, status: 'active', meta: { repo_full_name: 'acme/landing', default_branch: 'main' } }];
    configs = [filaConfig(), filaConfig({ id: CFG_2, connection_id: CONN_2, enabled: false })];
    revisiones = [rev(REV, CFG), rev(REV_2, CFG_2)];
    tabla = (op) => {
      const deOrg = eqDe(op, 'org_id') === ORG;
      if (op.table === 'connections') {
        const id = eqDe(op, 'id');
        return { data: deOrg ? conexiones.filter((c) => id === undefined || c.id === id) : [] };
      }
      if (op.table === 'code_review_configs' && op.action === 'select') {
        return { data: (deOrg && configs.find((f) => f.connection_id === eqDe(op, 'connection_id'))) || null };
      }
      if (op.table === 'code_reviews') return { data: deOrg ? revisiones.filter((r) => r.config_id === eqDe(op, 'config_id')) : [] };
      return undefined;
    };
  });
  const estadoDe = async (q: string) => {
    const r = await pedir(`code-review${q}`);
    expect(r.status).toBe(200);
    return CodeReviewState.parse(await r.json());
  };
  const TABLAS = ['connections', 'code_review_configs', 'code_reviews', 'notifications'];
  const propias = () => doble.ops.filter((o) => TABLAS.includes(o.table));

  it('por conexión: la config y SOLO las revisiones de ese repo, en ≤ 4 subpeticiones (conexión → config → revisiones → avisos)',
    async () => {
      const s = await estadoDe(`?connection_id=${CONN_2}`);
      expect(s).toMatchObject({ available: true, reason: null,
        config: { id: CFG_2, connection_id: CONN_2, repo_full_name: 'acme/landing', state: 'off' } });
      expect(s.recent.map((x) => x.id)).toEqual([REV_2]);
      const ops = propias();
      expect(ops.map((o) => o.table)).toEqual(TABLAS);
      expect(ops[0]!.filters).toEqual(expect.arrayContaining([['id', 'eq', CONN_2], ['provider', 'eq', 'github'],
        ['kind', 'eq', 'read']]));
      expect([eqDe(ops[1]!, 'connection_id'), eqDe(ops[2]!, 'config_id')]).toEqual([CONN_2, CFG_2]);
      for (const o of ops) expect(eqDe(o, 'org_id'), o.table).toBe(ORG);
    });

  it('sin parámetro (o vacío): la principal, la activa más antigua (B0), con su config y sus revisiones', async () => {
    for (const q of ['', '?connection_id=']) {
      const s = await estadoDe(q);
      expect(s.config).toMatchObject({ id: CFG, connection_id: CONN, repo_full_name: 'acme/tienda' });
      expect(s.recent.map((x) => x.id)).toEqual([REV]);
    }
  });

  it('malformado → 422 invalid_body sin leer nada; ajena o inexistente → sin_conexion, sin distinguir', async () => {
    const r = await pedir('code-review?connection_id=no-es-un-id');
    expect(r.status).toBe(422);
    const e = ((await r.json()) as { error: { code: string; details: unknown } }).error;
    expect(e).toMatchObject({ code: 'invalid_body', details: { field_errors: { connection_id: ['Id no válido'] } } });
    expect(propias()).toEqual([]);
    for (const id of ['c0c00000-0000-4000-8000-0000000000ff', CONN_2]) {
      if (id === CONN_2) conexiones = conexiones.slice(0, 1);   // la de otra org no sale en la consulta (.eq('org_id'))
      expect(await estadoDe(`?connection_id=${id}`)).toEqual({ available: false, reason: 'sin_conexion', config: null, recent: [] });
    }
  });

  it('repo sin config todavía: config null y recent vacío, sin leer revisiones ni avisos (no mezcla las de otro repo)', async () => {
    configs = [filaConfig()];
    const s = await estadoDe(`?connection_id=${CONN_2}`);
    expect(s).toEqual({ available: true, reason: null, config: null, recent: [] });
    expect(propias().map((o) => o.table)).toEqual(['connections', 'code_review_configs']);
  });

  it('una conexión no activa de ese repo → conexion_inactiva, con su config', async () => {
    conexiones[1] = { ...conexiones[1], status: 'revoked' };
    const s = await estadoDe(`?connection_id=${CONN_2}`);
    expect(s).toMatchObject({ available: false, reason: 'conexion_inactiva', config: { id: CFG_2 } });
  });
});

describe('E46 · PUT code-review', () => {
  it('el viewer y el anónimo reciben 403', async () => {
    rol = 'viewer';
    expect((await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true } })).status).toBe(403);
    anon = true;
    expect((await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true } })).status).toBe(403);
  });

  it('alta: 201 con el secreto vgw_ una sola vez, sellado con el id de ESA config; después, webhook_secret null', async () => {
    const r = await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true } }, PROD);
    expect(r.status).toBe(201);
    const b = CodeReviewSaved.parse(await r.json());
    expect(b.webhook_secret).toMatch(/^vgw_[A-Za-z0-9_-]{43}$/);
    const alta = doble.ops.find((o) => o.table === 'code_review_configs' && o.action === 'insert')!;
    const p = alta.payload as Record<string, unknown>;
    expect(sello.llamadas).toEqual([{ org: ORG, id: p.id, secreto: b.webhook_secret }]);
    expect(p).toMatchObject({ org_id: ORG, connection_id: CONN, branch: 'main', secret_kid: 'v1', created_by: ANA });
    expect(JSON.stringify(p)).not.toContain(b.webhook_secret!);
    expect(b.config).toMatchObject({ id: p.id, state: 'waiting_ping' });
    config = filaConfig();
    const otra = CodeReviewSaved.parse(await (await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: false } })).json());
    expect(otra.webhook_secret).toBeNull();
    expect(JSON.stringify(CodeReviewState.parse(await (await pedir('code-review', {}, PROD)).json()))).not.toContain('vgw_');
  });

  it('conexión de otra org → 404; no activa → 409 conexion_inactiva; sin rama por defecto → 409; carrera → 409', async () => {
    expect((await pedir('code-review', { method: 'PUT', body: { connection_id: 'c0c00000-0000-4000-8000-000000000009', enabled: true } })).status).toBe(404);
    conexion = { id: CONN, status: 'error', meta: { repo_full_name: 'acme/tienda', default_branch: 'main' } };
    const r = await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true } });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { details: unknown } }).error.details).toEqual({ reason: 'conexion_inactiva' });
    conexion = { id: CONN, status: 'active', meta: { repo_full_name: 'acme/tienda', default_branch: 'rama con espacios' } };
    expect((await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true } })).status).toBe(409);
    expect(sello.llamadas).toHaveLength(0);
    conexion = { id: CONN, status: 'active', meta: { repo_full_name: 'acme/tienda', default_branch: 'main' } };
    tabla = (op) => (op.table === 'code_review_configs' && op.action === 'insert' ? { error: { code: '23505' } } : undefined);
    expect((await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true } })).status).toBe(409);
  });

  it('reactivar vuelve a leer la rama por defecto; apagar no la toca', async () => {
    config = filaConfig({ enabled: false });
    conexion = { id: CONN, status: 'active', meta: { repo_full_name: 'acme/tienda', default_branch: 'develop' } };
    await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true } });
    const up = doble.ops.find((o) => o.table === 'code_review_configs' && o.action === 'update')!;
    expect(up.payload).toMatchObject({ enabled: true, branch: 'develop' });
    expect(eqDe(up, 'org_id')).toBe(ORG);
    config = filaConfig({ enabled: true });
    await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: false } });
    const ups = doble.ops.filter((o) => o.table === 'code_review_configs' && o.action === 'update');
    expect(ups[1]!.payload).not.toHaveProperty('branch');
  });

  it('rotate_secret: vgw_ nuevo en la MISMA config (URL igual), borra ping, eventos y error, olvida la clave; 200 una vez', async () => {
    config = filaConfig({ last_error: 'sin_push', last_error_at: '2026-10-24T18:30:00+00:00' });
    const r = await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true, rotate_secret: true } }, PROD);
    expect(r.status).toBe(200);
    const b = CodeReviewSaved.parse(await r.json());
    expect(b.webhook_secret).toMatch(/^vgw_[A-Za-z0-9_-]{43}$/);
    expect(sello.llamadas).toEqual([{ org: ORG, id: CFG, secreto: b.webhook_secret }]);
    const up = doble.ops.find((o) => o.table === 'code_review_configs' && o.action === 'update')!;
    expect(eqDe(up, 'id')).toBe(CFG);
    expect(eqDe(up, 'org_id')).toBe(ORG);
    expect(up.payload).toMatchObject({ secret_kid: 'v1', secret_last4: b.webhook_secret!.slice(-4), last_ping_at: null,
      hook_events: [], last_error: null, last_error_at: null });
    expect(JSON.stringify(up.payload)).not.toContain(b.webhook_secret!);
    expect(sello.olvidadas).toEqual([CFG]);
    expect(b.config).toMatchObject({ id: CFG, state: 'waiting_ping', last_error: null, hook_events: [],
      webhook_url: `https://officialvanguard.com/webhooks/github/${CFG}` });
    expect(doble.ops.some((o) => o.table === 'code_review_configs' && o.action === 'insert')).toBe(false);
  });

  it('rotate_secret: viewer y anónimo 403 sin sellar; RL_COSTLY agotado → 429 sin sellar; sin config, el alta (201)', async () => {
    config = filaConfig();
    rol = 'viewer';
    expect((await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true, rotate_secret: true } })).status).toBe(403);
    anon = true;
    expect((await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true, rotate_secret: true } })).status).toBe(403);
    rol = 'owner'; anon = false;
    const agotado = { RL_COSTLY: { limit: async () => ({ success: false }) } } as unknown as Partial<CloudflareBindings>;
    expect((await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true, rotate_secret: true } }, agotado)).status)
      .toBe(429);
    expect(sello.llamadas).toHaveLength(0);
    expect(sello.olvidadas).toHaveLength(0);
    config = null;
    const alta = await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true, rotate_secret: true } });
    expect(alta.status).toBe(201);
    expect(CodeReviewSaved.parse(await alta.json()).webhook_secret).toMatch(/^vgw_/);
  });

  it('rotate_secret tras pushes: last_event_at también a null (la tarjeta vuelve a waiting_ping); CAS por updated_at', async () => {
    config = filaConfig({ last_event_at: '2026-10-24T18:25:00+00:00', updated_at: '2026-10-24T18:00:00+00:00' });
    const b = CodeReviewSaved.parse(await (await pedir('code-review', { method: 'PUT',
      body: { connection_id: CONN, enabled: true, rotate_secret: true } })).json());
    expect(b.config).toMatchObject({ state: 'waiting_ping', last_event_at: null, last_ping_at: null });
    const up = doble.ops.find((o) => o.table === 'code_review_configs' && o.action === 'update')!;
    expect(up.payload).toMatchObject({ last_event_at: null });
    expect(eqDe(up, 'updated_at')).toBe('2026-10-24T18:00:00+00:00');
  });

  it('dos rotaciones a la vez: la que pierde el CAS (0 filas) recibe 409 y no un secreto que nunca verificaría', async () => {
    config = filaConfig({ updated_at: '2026-10-24T18:00:00+00:00' });
    tabla = (op) => (op.table === 'code_review_configs' && op.action === 'update' ? { data: null } : undefined);
    const r = await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: true, rotate_secret: true } });
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).not.toContain('vgw_');
    expect(sello.olvidadas).toHaveLength(0);
  });

  it('sin rotate_secret, cambiar enabled no toca el secreto ni el ping', async () => {
    config = filaConfig();
    const b = CodeReviewSaved.parse(await (await pedir('code-review', { method: 'PUT', body: { connection_id: CONN, enabled: false } })).json());
    expect(b.webhook_secret).toBeNull();
    const up = doble.ops.find((o) => o.table === 'code_review_configs' && o.action === 'update')!;
    expect(up.payload).not.toHaveProperty('secret_sealed');
    expect(up.payload).not.toHaveProperty('last_ping_at');
    expect(sello.olvidadas).toHaveLength(0);
  });
});

describe('E48/E49 · alert-prefs', () => {
  it('sin fila: high/critical, voice_available false y solo cuentan los contactos con WhatsApp verificados', async () => {
    tabla = (op) => (op.table === 'contacts'
      ? { data: [{ verified_at: '2026-10-24T10:00:00+00:00' }, { verified_at: null }] } : undefined);
    rol = 'viewer';
    const p = AlertPrefs.parse(await (await pedir('alert-prefs')).json());
    expect(p).toEqual({ review_whatsapp_min: 'high', review_voice_min: 'critical', voice_available: false,
      whatsapp_ready_contacts: 1, updated_at: null });
    const sel = doble.ops.find((o) => o.table === 'contacts')!;
    expect(eqDe(sel, 'org_id')).toBe(ORG);
    expect(eqDe(sel, 'whatsapp')).toBe(true);
  });

  it('PUT: admin hace upsert por org con updated_by; viewer 403; valores fuera del enum → 422', async () => {
    tabla = (op) => (op.table === 'alert_prefs' && op.action === 'upsert'
      ? { data: { review_whatsapp_min: 'medium', review_voice_min: 'off', updated_at: '2026-10-24T20:00:00+00:00' } } : undefined);
    const r = await pedir('alert-prefs', { method: 'PUT', body: { review_whatsapp_min: 'medium', review_voice_min: 'off' } });
    expect(r.status).toBe(200);
    expect(AlertPrefs.parse(await r.json())).toMatchObject({ review_whatsapp_min: 'medium', review_voice_min: 'off' });
    const up = doble.ops.find((o) => o.table === 'alert_prefs' && o.action === 'upsert')!;
    expect(up.payload).toMatchObject({ org_id: ORG, updated_by: ANA, review_whatsapp_min: 'medium' });
    expect((await pedir('alert-prefs', { method: 'PUT', body: { review_whatsapp_min: 'nunca', review_voice_min: 'off' } })).status).toBe(422);
    rol = 'viewer';
    expect((await pedir('alert-prefs', { method: 'PUT', body: { review_whatsapp_min: 'low', review_voice_min: 'off' } })).status).toBe(403);
  });
});
