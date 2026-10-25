// E53 y E54 (bloqueo de merge, asignaciones/bloqueo-merge-criticos.md §4.1 y pruebas B4/B5 de §10.5; anexo
// bloqueo-merge-cierre-pr.md: permiso de Pull requests, interruptor close_pr y «Reabrir el PR»). Sin red: GitHub con fetch
// simulado, supabase-js con el doble, el sellado y las huellas con dobles.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, MergeGateSaved, RespuestaEscritura } from '@vanguard/contracts';
import { fingerprint } from '@vanguard/core/crypto';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const cred = vi.hoisted(() => ({ createConnectionWithSecret: vi.fn(), rotarSecretoConexion: vi.fn(), withSecret: vi.fn(),
  fingerprintsOfOrg: vi.fn() }));
vi.mock('../lib/credentials.ts', () => cred);
vi.mock('../lib/keyring.ts', () => {
  let llaves: Promise<{ kid: string; kek: CryptoKey; fpk: CryptoKey }> | null = null;
  return {
    activeKid: async () => 'v1',
    getKeys: () => (llaves ??= crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then((k) => ({ kid: 'v1', kek: k, fpk: k }))),
  };
});

const { app } = await import('../app.ts');
const { getKeys } = await import('../lib/keyring.ts');

// Tokens falsos armados en tiempo de ejecución: ningún literal con forma de secreto queda en el repo.
const t = (...p: string[]) => p.join('_');
const PAT = t('github', 'pat', 'e'.repeat(40));
const LECTURA = t('github', 'pat', 'l'.repeat(40));
const CLASICO = t('ghp', 'q'.repeat(36));

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const CONN = 'c0c00000-0000-4000-8000-000000000001';
const ACC = 'c0000000-0000-4000-8000-000000000006';
const CFG = 'c4000000-0000-4000-8000-000000000001';
const REV = 'c4000000-0000-4000-8000-000000000022';
const HEAD = 'b'.repeat(40);
const GH = 'https://api.github.com/repos/acme/tienda';
const PROD = { VG_ENV: 'production', APP_ORIGIN: 'https://officialvanguard.com' } as Partial<CloudflareBindings>;

type Fila = Record<string, unknown>;
let rol: string;
let anon: boolean;
let conexiones: Fila[];
let config: Fila | null;
let revision: Fila | null;
let doble: ReturnType<typeof dbDoble>;
let gh: Record<string, (auth: string) => Response>;
let fetchMock: ReturnType<typeof vi.fn>;
let entorno: ReturnType<typeof envDoble>;

const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) =>
  o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : o === 'is' ? (f[c] ?? null) === v : true);
const lectura = (o: Fila = {}): Fila => ({ id: CONN, org_id: ORG, provider: 'github', kind: 'read', status: 'active',
  meta: { repo_full_name: 'acme/tienda', repo_id: 42, default_branch: 'main', private: false }, capabilities: {}, ...o });
const accion = (o: Fila = {}): Fila => ({ id: ACC, org_id: ORG, provider: 'github', kind: 'action', status: 'active',
  last4: 'k9Qz', expires_at: '2026-11-23T20:00:00+00:00', capabilities: { statuses: true, pull_requests: true },
  meta: { repo_full_name: 'acme/tienda', repo_id: 42, branch: 'main', purpose: 'commit_statuses' }, ...o });

beforeEach(async () => {
  rol = 'owner'; anon = false;
  conexiones = [lectura()];
  config = { id: CFG, org_id: ORG, connection_id: CONN, enabled: true, branch: 'main', gate_enabled: false,
    gate_min: 'critical', gate_last_error: null, gate_close_pr: true };
  revision = null;
  doble = dbDoble({
    tabla: (op): Resp | undefined => {
      if (op.table === 'org_members') return { data: { role: rol } };
      if (op.table === 'connections') {
        if (op.action === 'update') return {};
        return { data: conexiones.filter((c) => cumple(c, op)) };
      }
      if (op.table === 'code_review_configs') {
        const hit = config && cumple(config, op) ? config : null;
        if (op.action === 'update' && hit) Object.assign(hit, op.payload);
        return { data: hit };
      }
      if (op.table === 'code_reviews') {
        const hit = revision && cumple(revision, op) ? revision : null;
        if (op.action === 'update' && hit) Object.assign(hit, op.payload);
        return { data: op.orden ? (hit ? [hit] : []) : hit };
      }
      return undefined;
    },
    claims: (tok) => (tok === 'ana' ? { sub: ANA, email: anon ? '' : 'ana@acme.dev', is_anonymous: anon } : null),
  });
  estado.client = doble.client;
  const huellaLectura = await fingerprint(await getKeys({} as CloudflareBindings, doble.client as never, 'v1'), ORG, LECTURA);
  cred.fingerprintsOfOrg.mockReset().mockResolvedValue(new Map([[huellaLectura, CONN]]));
  cred.withSecret.mockReset().mockImplementation(async (_e: unknown, _a: unknown, _ctx: unknown, fn: (x: string) => unknown) =>
    fn(LECTURA));
  cred.createConnectionWithSecret.mockReset().mockResolvedValue(undefined);
  cred.rotarSecretoConexion.mockReset().mockResolvedValue(undefined);
  // GitHub por método + URL; la función recibe el token del Authorization para distinguir lectura y acciones.
  gh = {
    [`GET ${GH}/branches/main`]: (auth) => (auth === LECTURA
      ? new Response(JSON.stringify({ name: 'main', commit: { sha: HEAD } }), { status: 200 })
      : new Response('{}', { status: 403 })),
    [`GET ${GH}/keys`]: () => new Response('{}', { status: 403 }),
    [`POST ${GH}/pulls`]: () => new Response('{"message":"Validation Failed"}', { status: 422 }),
    [`POST ${GH}/issues`]: () => new Response('{}', { status: 403 }),
    [`POST ${GH}/statuses/${HEAD}`]: () => new Response('{}', { status: 201,
      headers: { 'github-authentication-token-expiration': '2026-11-23 20:00:00 UTC' } }),
  };
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const auth = String((init.headers as Record<string, string>).Authorization ?? '').replace('Bearer ', '');
    const f = gh[`${init.method ?? 'GET'} ${url}`];
    if (!f) throw new Error(`sin respuesta para ${init.method ?? 'GET'} ${url}`);
    return f(auth);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const pedir = (ruta: string, body: unknown, extra: Partial<CloudflareBindings> = PROD, metodo = 'PUT') => {
  entorno = envDoble(extra);
  return app.request(`https://officialvanguard.com/api/orgs/${ORG}/${ruta}`, { method: metodo,
    headers: { authorization: 'Bearer ana', 'content-type': 'application/json', origin: 'https://officialvanguard.com' },
    body: JSON.stringify(body) }, entorno.env);
};
const gate = (body: unknown, extra?: Partial<CloudflareBindings>) => pedir('code-review/gate', body, extra);
const accionE54 = (body: unknown, extra?: Partial<CloudflareBindings>) =>
  pedir(`code-review/reviews/${REV}/gate`, body, extra, 'POST');
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;
const llamadas = () => fetchMock.mock.calls.map(([u, i]) => `${(i as RequestInit).method ?? 'GET'} ${String(u)}`);
const cuerpoDe = (k: string) => {
  const c = fetchMock.mock.calls.find(([u, i]) => `${(i as RequestInit).method ?? 'GET'} ${String(u)}` === k);
  return JSON.parse(String((c![1] as RequestInit).body)) as Record<string, unknown>;
};
const lineas = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');
const CON_TOKEN = { enabled: true, min_severity: 'critical', statuses_pat: PAT };

describe('E53 · guardas', () => {
  it('viewer y anónimo → 403 sin leer nada de GitHub', async () => {
    rol = 'viewer';
    expect((await gate(CON_TOKEN)).status).toBe(403);
    rol = 'owner'; anon = true;
    expect((await gate(CON_TOKEN)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin GitHub de lectura → 404; inactiva → 409 conexion_inactiva; sin config o revisión apagada → 409 sin_revision', async () => {
    conexiones = [];
    expect((await gate({ enabled: true, min_severity: 'critical' })).status).toBe(404);
    conexiones = [lectura({ status: 'revoked' })];
    expect((await error(await gate({ enabled: true, min_severity: 'critical' }))).details).toMatchObject({ reason: 'conexion_inactiva' });
    conexiones = [lectura()];
    config!.enabled = false;
    const r = await gate({ enabled: true, min_severity: 'critical' });
    expect([r.status, (await error(r)).details]).toEqual([409, { reason: 'sin_revision' }]);
    expect((await gate({ enabled: false, min_severity: 'critical' })).status).toBe(200);   // apagar sí se puede
    config = null;
    expect((await error(await gate({ enabled: false, min_severity: 'critical' }))).details).toEqual({ reason: 'sin_revision' });
  });

  it('el repo del producto → 409 repo_del_producto, con y sin token', async () => {
    conexiones = [lectura({ meta: { repo_full_name: 'Giova144-git/VanGUARD', repo_id: 7 } })];
    for (const body of [{ enabled: true, min_severity: 'critical' }, CON_TOKEN]) {
      const r = await gate(body);
      expect([r.status, (await error(r)).details]).toEqual([409, { reason: 'repo_del_producto' }]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con token fuera de producción → 409 solo_produccion; un token clásico → 422; sin github_pat_ → 400', async () => {
    let r = await gate(CON_TOKEN, { VG_ENV: 'local', APP_ORIGIN: 'http://localhost:5173' });
    expect([r.status, (await error(r)).details]).toEqual([409, { reason: 'solo_produccion' }]);
    r = await gate({ ...CON_TOKEN, statuses_pat: CLASICO });
    expect([r.status, (await error(r)).code]).toEqual([422, 'key_rejected']);
    r = await gate({ ...CON_TOKEN, statuses_pat: 'x'.repeat(40) });
    expect(r.status).toBe(400);
    expect((await error(r)).details).toMatchObject({ field_errors: { statuses_pat: expect.any(Array) } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el mismo token que el de lectura → 422 same_token sin llamar a GitHub', async () => {
    const r = await gate({ ...CON_TOKEN, statuses_pat: LECTURA });
    expect([r.status, (await error(r)).details]).toEqual([422, { reason: 'same_token' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('E53 · sondeos y prueba', () => {
  it('GET /keys 200 → 422 excess_scope sin POST de prueba ni nada guardado', async () => {
    gh[`GET ${GH}/keys`] = () => new Response('[]', { status: 200 });
    const r = await gate(CON_TOKEN);
    expect(r.status).toBe(422);
    expect((await error(r)).details).toEqual({ reason: 'excess_scope', excess_permissions: ['administration'] });
    expect(llamadas()).not.toContain(`POST ${GH}/statuses/${HEAD}`);
    expect(cred.createConnectionWithSecret).not.toHaveBeenCalled();
  });

  it('repo privado y GET /branches 200 con el token nuevo → excess_scope contents; en uno público ese GET no se hace', async () => {
    await gate(CON_TOKEN);
    expect(llamadas().filter((l) => l === `GET ${GH}/branches/main`)).toHaveLength(1);   // solo el de lectura
    fetchMock.mockClear();
    conexiones = [lectura({ meta: { repo_full_name: 'acme/tienda', repo_id: 42, private: true } })];
    gh[`GET ${GH}/branches/main`] = () => new Response(JSON.stringify({ commit: { sha: HEAD } }), { status: 200 });
    const r = await gate(CON_TOKEN);
    expect((await error(r)).details).toEqual({ reason: 'excess_scope', excess_permissions: ['contents'] });
  });

  it('sondeo 5xx → provider_unavailable sin guardar', async () => {
    gh[`GET ${GH}/keys`] = () => new Response('x', { status: 503 });
    const r = await gate(CON_TOKEN);
    expect((await error(r)).code).toBe('provider_unavailable');
    expect(cred.createConnectionWithSecret).not.toHaveBeenCalled();
  });

  it('POST de prueba 403 → 422 provider_rejected con statuses:write; 401 → unauthorized; nada guardado', async () => {
    gh[`POST ${GH}/statuses/${HEAD}`] = () => new Response('{}', { status: 403 });
    let r = await gate(CON_TOKEN);
    expect([r.status, (await error(r)).details]).toEqual([422, { missing_permissions: ['statuses:write'] }]);
    gh[`POST ${GH}/statuses/${HEAD}`] = () => new Response('{}', { status: 401 });
    r = await gate(CON_TOKEN);
    expect((await error(r)).details).toEqual({ reason: 'unauthorized' });
    expect(cred.createConnectionWithSecret).not.toHaveBeenCalled();
    expect(config!.gate_enabled).toBe(false);
  });

  it('sin revisión de ese commit → pending «Prueba de conexión», nunca success', async () => {
    const r = await gate(CON_TOKEN);
    expect(r.status).toBe(200);
    const b = cuerpoDe(`POST ${GH}/statuses/${HEAD}`);
    expect(b).toMatchObject({ state: 'pending', description: 'Prueba de conexión: VanGUARD aún no revisó este commit',
      context: 'VanGUARD', target_url: `https://officialvanguard.com/o/${ORG}/codebase` });
    expect(MergeGateSaved.parse(await r.json())).toMatchObject({ probe_sha: HEAD, probe_state: 'pending' });
  });

  it('revisión anterior a 0016 con max_severity critical → failure con counts; sin críticos → pending', async () => {
    revision = { id: REV, org_id: ORG, config_id: CFG, head_sha: HEAD, status: 'done', partial: false, error_code: null,
      max_severity: 'critical', counts: { critical: 1, high: 0 }, gate_blocking: null, gate_findings: [], gate_override_at: null,
      new_findings: [{ rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical', title: 't', resource: 'src/x.ts:1' }] };
    const r = await gate(CON_TOKEN);
    expect(cuerpoDe(`POST ${GH}/statuses/${HEAD}`)).toMatchObject({ state: 'failure',
      description: '1 crítico: clave o token en el código. Detalle en VanGUARD',
      target_url: `https://officialvanguard.com/o/${ORG}/codebase?revision=${REV}` });
    expect(MergeGateSaved.parse(await r.json()).probe_state).toBe('failure');
    Object.assign(revision, { max_severity: 'medium', counts: { critical: 0, medium: 1 } });
    fetchMock.mockClear();
    await gate(CON_TOKEN);
    expect(cuerpoDe(`POST ${GH}/statuses/${HEAD}`).state).toBe('pending');
    Object.assign(revision, { gate_blocking: 0, gate_findings: [] });   // revisada con el bloqueo y limpia: su ✓ real
    fetchMock.mockClear();
    await gate(CON_TOKEN);
    expect(cuerpoDe(`POST ${GH}/statuses/${HEAD}`).state).toBe('success');
  });
});

describe('E53 · guardar', () => {
  it('alta → conexión GitHub action con meta.branch, Pull requests detectado y config encendida; nunca registra el token', async () => {
    const r = await gate(CON_TOKEN);
    expect(r.status).toBe(200);
    const [, , c, token] = cred.createConnectionWithSecret.mock.calls[0] as [unknown, unknown, Fila, string];
    expect(token).toBe(PAT);
    expect(c).toMatchObject({ orgId: ORG, provider: 'github', kind: 'action', label: 'GitHub · estados · acme/tienda',
      meta: { repo_full_name: 'acme/tienda', repo_id: 42, branch: 'main', purpose: 'commit_statuses' },
      scopes: ['statuses:write', 'pull_requests:write'], capabilities: { statuses: true, pull_requests: true, issues: false },
      expiresAt: '2026-11-23T20:00:00.000Z' });
    expect(config).toMatchObject({ gate_enabled: true, gate_min: 'critical', gate_last_error: null });
    const b = MergeGateSaved.parse(await r.json());
    expect(b.gate).toMatchObject({ enabled: true, state: 'unchecked', context: 'VanGUARD', protection: null, last_error: null,
      close_pr: true, can_close_pr: true, statuses_connection: { status: 'active', last4: PAT.slice(-4) } });
    expect(b.checks).toEqual([{ permission: 'statuses:write', ok: true, required: true },
      { permission: 'pull_requests:write', ok: true, required: false }, { permission: 'issues:write', ok: false, required: false }]);
    expect(llamadas()).toContain(`POST ${GH}/pulls`);
    expect(lineas()).toContain('"event":"gate.config"');
    expect(lineas()).not.toContain(PAT);
    expect(lineas()).not.toContain(LECTURA);
  });

  it('token sin Pull requests (403 en la sonda) → can_close_pr false y close_pr false aunque el interruptor siga en true', async () => {
    gh[`POST ${GH}/pulls`] = () => new Response('{}', { status: 403 });
    const b = MergeGateSaved.parse(await (await gate(CON_TOKEN)).json());
    expect(b.gate).toMatchObject({ can_close_pr: false, close_pr: false });
    expect(config!.gate_close_pr).toBe(true);
  });

  it('segundo token → rotarSecretoConexion con el MISMO id (sin alta nueva)', async () => {
    conexiones = [lectura(), accion()];
    expect((await gate(CON_TOKEN)).status).toBe(200);
    expect(cred.createConnectionWithSecret).not.toHaveBeenCalled();
    const [, , ctx, token, extra] = cred.rotarSecretoConexion.mock.calls[0] as [unknown, unknown, Fila, string, Fila];
    expect(ctx).toEqual({ orgId: ORG, connectionId: ACC, provider: 'github', kind: 'action' });
    expect(token).toBe(PAT);
    expect(extra).toMatchObject({ capabilities: { statuses: true, pull_requests: true, issues: false } });
  });

  it('con token de acciones, la lectura del bloqueo es la de su repo; si no hay ninguna de ese repo → 409 otro_repo', async () => {
    conexiones = [lectura(), accion({ meta: { repo_full_name: 'acme/otro', repo_id: 99, branch: 'main' } })];
    const r = await gate({ enabled: true, min_severity: 'critical' });
    expect([r.status, (await error(r)).details]).toEqual([409, { reason: 'otro_repo' }]);
  });

  // varias-codebases.md §2.6, puntos 3 y 4: con parejas viejas de «Reconectar» del mismo repo, E53 elige la activa más
  // antigua (la pestaña que pinta el FRONT y la única con gate en E45), no la más antigua a secas.
  it('parejas viejas del mismo repo: la activa aunque haya una revocada más antigua; si ninguna, 409 conexion_inactiva',
    async () => {
      const VIEJA = 'c0c00000-0000-4000-8000-000000000009';
      conexiones = [lectura({ id: VIEJA, status: 'revoked' }), lectura(), accion()];
      const r = await gate({ enabled: true, min_severity: 'critical' });
      expect(r.status).toBe(200);
      const leida = doble.ops.find((o) => o.table === 'code_review_configs' && o.action === 'select')!;
      expect(eqDe(leida, 'connection_id')).toBe(CONN);
      expect(config).toMatchObject({ gate_enabled: true });

      conexiones = [lectura({ id: VIEJA, status: 'revoked' }), lectura({ status: 'error' }), accion()];
      expect((await error(await gate({ enabled: true, min_severity: 'critical' }))).details)
        .toEqual({ reason: 'conexion_inactiva' });
    });

  it('sin token: cambia enabled, umbral y close_pr con ≤ 4 subpeticiones y sin GitHub; probe null', async () => {
    conexiones = [lectura(), accion()];
    const r = await gate({ enabled: true, min_severity: 'high', close_pr: false });
    expect(r.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(doble.ops.filter((o) => o.table !== 'org_members').length).toBeLessThanOrEqual(4);
    const b = MergeGateSaved.parse(await r.json());
    expect(b).toMatchObject({ checks: [], probe_sha: null, probe_state: null });
    expect(b.gate).toMatchObject({ enabled: true, min_severity: 'high', state: 'unchecked', close_pr: false, can_close_pr: true });
    expect(config).toMatchObject({ gate_enabled: true, gate_min: 'high', gate_close_pr: false });
  });

  it('sin token y sin conexión de acciones → needs_token; con gate_last_error → error', async () => {
    let b = MergeGateSaved.parse(await (await gate({ enabled: true, min_severity: 'critical' })).json());
    expect(b.gate).toMatchObject({ state: 'needs_token', statuses_connection: null, can_close_pr: false });
    conexiones = [lectura(), accion()];
    config!.gate_last_error = 'forbidden';
    b = MergeGateSaved.parse(await (await gate({ enabled: true, min_severity: 'critical' })).json());
    expect(b.gate).toMatchObject({ state: 'error', last_error: 'forbidden' });
  });
});

describe('E54 · Dar por bueno, Deshacer y Reabrir el PR', () => {
  const rev = (o: Fila = {}) => ({ id: REV, org_id: ORG, config_id: CFG, status: 'done', partial: false, error_code: null,
    gate_blocking: 1, gate_override_at: null, event: 'pull_request', pr_number: 7, gate_pr_action: null, ...o });
  beforeEach(() => { config!.gate_enabled = true; });

  it('override sobre una revisión limpia → 409 nada_que_aprobar; sobre un ✗ → escribe y encola estado (202)', async () => {
    revision = rev({ gate_blocking: 0 });
    let r = await accionE54({ op: 'override', reason: 'clave de prueba documentada' });
    expect([r.status, (await error(r)).details]).toEqual([409, { reason: 'nada_que_aprobar' }]);
    revision = rev();
    r = await accionE54({ op: 'override', reason: 'clave de prueba documentada' });
    expect(r.status).toBe(202);
    expect(RespuestaEscritura.parse(await r.json())).toEqual({ ok: true, resultado: 'encolado' });
    expect(revision).toMatchObject({ gate_override_by: ANA, gate_override_reason: 'clave de prueba documentada' });
    expect(typeof revision!.gate_override_at).toBe('string');
    expect(entorno.enviados).toEqual([{ v: 1, kind: 'review', org_id: ORG, review_id: REV, paso: 'estado' }]);
    expect(lineas()).toContain('"event":"gate.override"');
    expect(lineas()).not.toContain('clave de prueba documentada');
  });

  it('override vale para failed y para parcial por diff_grande o binario; no para hallazgos_truncados limpio', async () => {
    for (const [o, status] of [[{ status: 'failed', gate_blocking: null }, 202],
      [{ gate_blocking: 0, partial: true, error_code: 'binario' }, 202],
      [{ gate_blocking: 0, partial: true, error_code: 'hallazgos_truncados' }, 409]] as const) {
      revision = rev(o);
      expect((await accionE54({ op: 'override', reason: 'revisado a mano' })).status).toBe(status);
    }
  });

  it('revert sin override → 409 sin_override; con override → lo borra y encola estado', async () => {
    revision = rev();
    let r = await accionE54({ op: 'revert' });
    expect([r.status, (await error(r)).details]).toEqual([409, { reason: 'sin_override' }]);
    revision = rev({ gate_override_at: '2026-10-24T20:00:00Z', gate_override_by: ANA, gate_override_reason: 'x y z' });
    r = await accionE54({ op: 'revert' });
    expect(r.status).toBe(202);
    expect(revision).toMatchObject({ gate_override_at: null, gate_override_by: null, gate_override_reason: null });
    expect(entorno.enviados).toHaveLength(1);
  });

  it('viewer 403; bloqueo apagado → 409 apagado; fuera de producción → 409; republish → 409 p1; ajena → 404', async () => {
    revision = rev();
    rol = 'viewer';
    expect((await accionE54({ op: 'revert' })).status).toBe(403);
    rol = 'owner';
    config!.gate_enabled = false;
    expect((await error(await accionE54({ op: 'override', reason: 'motivo largo' }))).details).toEqual({ reason: 'apagado' });
    config!.gate_enabled = true;
    expect((await error(await accionE54({ op: 'revert' }, { VG_ENV: 'local' })))).toMatchObject({ details: { reason: 'solo_produccion' } });
    expect((await error(await accionE54({ op: 'republish' })))).toMatchObject({ details: { reason: 'p1' } });
    revision = rev({ org_id: 'otra' });
    expect((await accionE54({ op: 'revert' })).status).toBe(404);
    expect(entorno.enviados).toEqual([]);
  });

  it('reopen_pr → PATCH state open con el token de acciones (200 hecho); si VanGUARD no lo cerró → 409 no_cerrado', async () => {
    conexiones = [lectura(), accion()];
    gh[`PATCH ${GH}/pulls/7`] = () => new Response('{}', { status: 200 });
    revision = rev({ gate_pr_action: null });
    let r = await accionE54({ op: 'reopen_pr' });
    expect([r.status, (await error(r)).details]).toEqual([409, { reason: 'no_cerrado' }]);
    revision = rev({ gate_pr_action: 'closed' });
    config!.gate_enabled = false;   // es el «Deshacer» de un cierre: vale con el bloqueo ya apagado
    r = await accionE54({ op: 'reopen_pr' });
    expect(r.status).toBe(200);
    expect(RespuestaEscritura.parse(await r.json())).toEqual({ ok: true, resultado: 'hecho' });
    expect(cuerpoDe(`PATCH ${GH}/pulls/7`)).toEqual({ state: 'open' });
    expect(revision!.gate_pr_action).toBe('reopened');
    expect(eqDe(doble.ops.find((o) => o.table === 'code_reviews' && o.action === 'update')!, 'org_id')).toBe(ORG);
  });
});
