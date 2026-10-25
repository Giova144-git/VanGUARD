// E45, E46, E48 y E49 (revisión de código, asignaciones/revision-codigo.md §4.1 y las pruebas de B3 en §8.2).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let estados: Record<string, unknown> | null;   // conexión GitHub kind 'action' (bloqueo de merge)

const filaConfig = (o: Record<string, unknown> = {}) => ({ id: CFG, connection_id: CONN, enabled: true, branch: 'main',
  secret_last4: 'Q7xk', hook_events: ['push', 'pull_request'], last_ping_at: '2026-10-24T18:20:03+00:00',
  last_event_at: null, last_error: null, last_error_at: null, ...o });

beforeEach(() => {
  rol = 'owner'; anon = false; sello.llamadas = []; sello.olvidadas = [];
  conexion = { id: CONN, status: 'active', meta: { repo_full_name: 'acme/tienda', default_branch: 'main' } };
  config = null; revisiones = []; avisos = []; tabla = () => undefined; estados = null;
  doble = dbDoble({
    tabla: (op) => {
      const propia = tabla(op);
      if (propia) return propia;
      if (op.table === 'org_members') return { data: { role: rol } };
      if (op.table === 'connections' && eqDe(op, 'kind') === 'action') return { data: estados ? [estados] : [] };
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

// Bloqueo de merge (asignaciones/bloqueo-merge-criticos.md §4.1 E45 y pruebas B4 de §10.5; anexo de cierre de PR).
describe('E45 · gate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const fetchCalls = () => fetchMock.mock.calls.length;   // E45 nunca llama a GitHub
  const accion =(o: Record<string, unknown> = {}) => ({ id: 'c0000000-0000-4000-8000-000000000006', status: 'active',
    last4: 'k9Qz', expires_at: '2026-11-23T20:00:00+00:00', capabilities: { statuses: true, pull_requests: true },
    meta: { repo_full_name: 'acme/tienda', branch: 'main' }, ...o });
  const gateDe = async (cfg: Record<string, unknown>) => {
    config = filaConfig(cfg);
    return CodeReviewState.parse(await (await pedir('code-review')).json()).config!.gate;
  };
  const revBase = { event: 'pull_request', branch: 'main', pr_number: 7, base_sha: SHA, head_sha: 'b'.repeat(40),
    error_code: null, partial: false, files_changed: 1, lines_added: 14, counts: { critical: 1 }, max_severity: 'critical',
    new_findings: [], alert_state: 'sent', alert_reason: null, voice_pending: false, notified_at: null, status: 'done',
    created_at: '2026-10-24T19:45:08+00:00', finished_at: '2026-10-24T19:45:12+00:00' };

  it('state: off, needs_token, unchecked y error; close_pr solo si el token puede cerrar PR', async () => {
    expect(await gateDe({ gate_enabled: false })).toMatchObject({ enabled: false, state: 'off', context: 'VanGUARD',
      statuses_connection: null, protection: null });
    expect(await gateDe({ enabled: false, gate_enabled: true })).toMatchObject({ state: 'off' });
    expect(await gateDe({ gate_enabled: true })).toMatchObject({ state: 'needs_token', can_close_pr: false, close_pr: false });
    estados = accion();
    expect(await gateDe({ gate_enabled: true, gate_min: 'high', gate_close_pr: true })).toMatchObject({ state: 'unchecked',
      min_severity: 'high', can_close_pr: true, close_pr: true,
      statuses_connection: { status: 'active', last4: 'k9Qz', expires_at: '2026-11-23T20:00:00.000Z' } });
    expect(await gateDe({ gate_enabled: true, gate_last_error: 'forbidden' })).toMatchObject({ state: 'error',
      last_error: 'forbidden' });
    estados = accion({ status: 'revoked' });
    expect(await gateDe({ gate_enabled: true, gate_last_error: 'token' })).toMatchObject({ state: 'needs_token',
      last_error: 'token' });
    estados = accion({ capabilities: { statuses: true } });
    expect(await gateDe({ gate_enabled: true, gate_close_pr: true })).toMatchObject({ can_close_pr: false, close_pr: false });
    expect(fetchCalls()).toBe(0);
  });

  it('el token de acciones es de otro repo → config sin gate (el FRONT no pinta la sección)', async () => {
    estados = accion({ meta: { repo_full_name: 'acme/otro', branch: 'main' } });
    expect(await gateDe({ gate_enabled: true })).toBeUndefined();
  });

  it('cada revisión lleva gate solo si alguna gate_* tiene algo; con pr_action y pr_close_error del anexo', async () => {
    config = filaConfig({ gate_enabled: true });
    revisiones = [
      { ...revBase, id: REV, gate_blocking: 1, gate_state: 'failure', gate_error: null, gate_published_at: '2026-10-24T19:45:12.7+00:00',
        gate_override_at: null, gate_pr_action: 'close_failed', gate_pr_error: 'forbidden',
        gate_findings: [{ finding_id: null, rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical', title: 'Clave live de Stripe',
          resource: 'src/lib/cobros.ts:3' }] },
      { ...revBase, id: 'c4000000-0000-4000-8000-000000000012', gate_blocking: null, gate_state: null, gate_error: null,
        gate_findings: [] },
      { ...revBase, id: 'c4000000-0000-4000-8000-000000000013', gate_blocking: null, gate_state: null, gate_error: 'sin_token',
        gate_findings: [] },
    ];
    const s = CodeReviewState.parse(await (await pedir('code-review')).json());
    expect(s.recent[0]!.gate).toEqual({ blocking: 1, state: 'failure', error: null, published_at: '2026-10-24T19:45:12.700Z',
      override_at: null, pr_action: 'close_failed', pr_close_error: 'forbidden', findings: [expect.objectContaining({
        rule_id: 'CB_SECRET_STRIPE_LIVE', finding_id: null })] });
    expect('gate' in s.recent[1]!).toBe(false);
    expect(s.recent[2]!.gate).toMatchObject({ blocking: null, state: null, error: 'sin_token' });
    const sel = doble.ops.find((o) => o.table === 'code_reviews')!;
    expect(sel.columns).toContain('gate_pr_action');
  });

  it('una org con el bloqueo apagado no tiene gate en ninguna revisión; ≤ 5 subpeticiones y la de acciones por org_id', async () => {
    config = filaConfig();
    revisiones = [{ ...revBase, id: REV, gate_blocking: null, gate_state: null, gate_error: null, gate_findings: [] }];
    const s = CodeReviewState.parse(await (await pedir('code-review')).json());
    expect(s.recent.every((r) => !('gate' in r))).toBe(true);
    const ops = doble.ops.filter((o) => o.table !== 'org_members' && o.table !== 'orgs');
    expect(ops.length).toBeLessThanOrEqual(5);
    const acc = ops.find((o) => o.table === 'connections' && eqDe(o, 'kind') === 'action')!;
    expect([eqDe(acc, 'org_id'), eqDe(acc, 'provider')]).toEqual([ORG, 'github']);
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
