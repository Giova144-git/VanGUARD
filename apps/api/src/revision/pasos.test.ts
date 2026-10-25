import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobMsg, MsgRevision } from '../jobs.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';
import { dedupeKey } from '@vanguard/core/crypto';

// Paso 'diff' de la revisión de código sin red (asignaciones/revision-codigo.md §2.2–2.5 y pruebas B4+B5 de §8.2):
// GitHub con fetch simulado, supabase-js con el doble, el token y las llaves con dobles. El paso 'aviso' se prueba en
// notify/revision.test.ts.
const estado = vi.hoisted(() => ({ client: null as unknown, ctx: null as unknown, sinSecreto: false, secretoReal: false }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
// withSecret real (secretoReal) para probar qué hace el paso con lo que lanza de verdad: ApiError('not_found') tanto si
// falta el secreto como si falla la base.
vi.mock('../lib/credentials.ts', async (orig) => {
  const real = await orig<typeof import('../lib/credentials.ts')>();
  const { ApiError } = await import('../lib/errors.ts');
  type Args = Parameters<typeof real.withSecret>;
  return {
    withSecret: async (e: Args[0], a: Args[1], ctx: Args[2], fn: (t: string) => Promise<unknown>) => {
      estado.ctx = ctx;
      if (estado.secretoReal) return real.withSecret(e, a, ctx, fn);
      if (estado.sinSecreto) throw new ApiError('not_found', 'Esta conexión ya no tiene credencial.');
      return fn('tok-de-prueba');
    },
  };
});
// Una sola fpk por archivo (como las llaves en caché del isolate): el mismo valor da la misma huella en dos revisiones.
vi.mock('../lib/keyring.ts', () => {
  let llaves: Promise<{ kid: string; kek: CryptoKey; fpk: CryptoKey }> | null = null;
  return {
    activeKid: async () => 'v1',
    getKeys: () => (llaves ??= crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then((k) => ({ kid: 'v1', kek: k, fpk: k }))),
  };
});
const aviso = vi.hoisted(() => ({ fn: vi.fn(async () => 'ack' as const) }));
vi.mock('../notify/revision.ts', () => ({ avisarRevision: aviso.fn }));
// Paso 'estado' (bloqueo de merge): aquí solo el enrutado; se prueba en revision/estado.test.ts.
const paso = vi.hoisted(() => ({ estado: vi.fn(async () => 'ack' as const), dlq: vi.fn(async () => 'ack' as const) }));
vi.mock('./estado.ts', () => ({ pasoEstado: paso.estado, cierreEstadoDlq: paso.dlq }));

const { cierreRevisionDlq, LIM_REVISION, ocultarRutas, pasoRevision } = await import('./pasos.ts');

const ORG = '0f6c0000-0000-4000-8000-000000000001';
const REV = 'c4000000-0000-4000-8000-000000000011';
const CFG = 'c4000000-0000-4000-8000-000000000001';
const CONN = 'c0000000-0000-4000-8000-000000000001';
const BASE = '3b18e1a9c0d24f6e8a7b5c4d3e2f1a0b9c8d7e6f';
const HEAD = '9f1c2e7a4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a';
// Valores con forma de secreto armados en tiempo de ejecución (como secrets/scan.test.ts): ningún literal en el repo.
const RICO = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv';
const STRIPE = 'sk' + '_live_' + RICO.slice(0, 24);
const CARPETA_GHP = 'x_' + 'ghp_' + RICO.slice(0, 22);

type Fila = Record<string, unknown>;
let fila: Fila;
let config: Fila | null;
let conexion: Fila | null;
let rpcAlerta: string;
let rpcError: (n: number) => Resp['error'];
let secretoError: Resp['error'];
let rpcs: Record<string, unknown>[];
let gh: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;
let doble: ReturnType<typeof dbDoble>;
let entorno: ReturnType<typeof envDoble>;
let ignorados: Fila[];                       // findings ignored de la org (bloqueo de merge)
let gateError: Resp['error'];                // error del update de gate_* (p. ej. 23514)

const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) =>
  o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : o === 'is' ? (f[c] ?? null) === v : true);
const proyectar = (f: Fila, cols?: string): Fila =>
  (cols ? Object.fromEntries(cols.split(',').map((c) => c.trim()).map((c) => [c, f[c] ?? null])) : { ...f });

beforeEach(() => {
  fila = { id: REV, org_id: ORG, config_id: CFG, event: 'push', base_sha: BASE, head_sha: HEAD, status: 'queued',
    alert_state: 'none', started_at: null };
  config = { id: CFG, connection_id: CONN, enabled: true };
  conexion = { id: CONN, status: 'active', meta: { repo_full_name: 'Acme/Tienda', repo_id: 42, default_branch: 'main' } };
  rpcAlerta = 'pending';
  rpcError = () => null;
  rpcs = [];
  estado.sinSecreto = false;
  estado.secretoReal = false;
  secretoError = null;
  estado.ctx = null;
  aviso.fn.mockClear();
  paso.estado.mockClear();
  paso.dlq.mockClear();
  ignorados = [];
  gateError = null;
  doble = dbDoble({
    tabla: (op): Resp | undefined => {
      if (op.table === 'code_review_configs' && op.action === 'select') return { data: eqDe(op, 'id') === CFG ? config : null };
      if (op.table === 'connections') return { data: eqDe(op, 'id') === CONN ? conexion : null };
      if (op.table === 'connection_secrets') return { error: secretoError };
      if (op.table === 'findings') return { data: ignorados };
      if (op.table !== 'code_reviews') return undefined;
      const hit = cumple(fila, op) ? fila : null;
      if (op.action === 'select') return { data: hit };
      if (op.action === 'update' && gateError && 'gate_findings' in (op.payload as object)
        && (op.payload as Fila & { gate_findings: unknown[] }).gate_findings.length) return { error: gateError };
      // Como PostgREST, un update().select(cols) devuelve solo esas columnas: el claim tiene que pedir lo que usa.
      if (op.action === 'update') {
        if (hit) Object.assign(fila, op.payload);
        return { data: hit && proyectar(hit, op.returning) };
      }
      return undefined;
    },
    // vg_review_findings (0013): CAS sobre la running de esa org; deja done y el alert_state que diga la prueba.
    rpc: (name, a) => {
      if (name !== 'vg_review_findings') return undefined;
      rpcs.push(a);
      const e = rpcError(rpcs.length);
      if (e) return { error: e };
      if (fila.status !== 'running' || a.p_org !== ORG || a.p_review !== REV) return { data: { applied: false } };
      Object.assign(fila, { status: 'done', alert_state: rpcAlerta });
      return { data: { applied: true, nuevos: (a.p_rows as unknown[]).length, alert_state: rpcAlerta } };
    },
  });
  estado.client = doble.client;
  entorno = envDoble();
  gh = () => new Response(diff(...nuevo('src/lib/pagos.ts', ['// cobro', 'import Stripe from "stripe";', `const k = '${STRIPE}';`])));
  fetchMock = vi.fn(async () => gh());
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const diff = (...ls: string[]) => ls.join('\n') + '\n';
const nuevo = (path: string, ls: readonly string[]) => [`diff --git a/${path} b/${path}`, 'new file mode 100644',
  'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${ls.length} @@`, ...ls.map((l) => '+' + l)];
const msg = (paso: 'diff' | 'aviso' = 'diff'): MsgRevision => ({ v: 1, kind: 'review', org_id: ORG, review_id: REV, paso });
const correr = (intento = 1, paso: 'diff' | 'aviso' = 'diff') => pasoRevision(entorno.env, msg(paso), intento);
const filas = (i = 0) => (rpcs[i]?.p_rows ?? []) as Fila[];
const de = (tabla: string, action: Op['action']) => doble.ops.filter((o) => o.table === tabla && o.action === action);
const lineas = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');
const avisoEncolado = (): JobMsg => ({ v: 1, kind: 'review', org_id: ORG, review_id: REV, paso: 'aviso' });

describe('paso diff · camino feliz', () => {
  it('clave live de Stripe en un push → compare del repo de meta con el PAT, fila github+sha, RPC con p_write y aviso', async () => {
    expect(await correr()).toBe('ack');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/Acme/Tienda/compare/${BASE}...${HEAD}`);
    const h = init.headers as Record<string, string>;
    expect(h.Accept).toBe('application/vnd.github.diff');
    expect(h.Authorization).toBe('Bearer tok-de-prueba');
    expect(h['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(estado.ctx).toEqual({ orgId: ORG, connectionId: CONN, provider: 'github', kind: 'read' });

    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]).toMatchObject({ p_org: ORG, p_review: REV, p_write: true,
      p_meta: { files_changed: 1, lines_added: 3, partial: false, error_code: null } });
    const [f] = filas();
    expect(f).toMatchObject({ rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical', resource: 'src/lib/pagos.ts:3',
      title: 'Clave live de Stripe en el código' });
    expect(f!.evidence).toMatchObject({ fuente: 'github', sha: HEAD, path: 'src/lib/pagos.ts', line: 3 });
    expect((f!.evidence as Fila).fingerprint_short).toMatch(/^[0-9a-f]{8}$/);
    expect(f!.dedupe_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rpcs)).not.toContain(STRIPE);
    expect(entorno.enviados).toEqual([avisoEncolado()]);
    expect(fila).toMatchObject({ status: 'done', alert_state: 'pending' });
    expect(lineas()).toContain('"event":"revision.fin"');
    expect(lineas()).not.toContain(STRIPE);
    expect(lineas()).not.toContain('pagos.ts');
  });

  it('claim CAS queued → running con started_at, sobre la fila de esa org', async () => {
    await correr();
    const claim = de('code_reviews', 'update')[0]!;
    expect(claim.payload).toMatchObject({ status: 'running' });
    expect(typeof (claim.payload as Fila).started_at).toBe('string');
    expect(eqDe(claim, 'org_id')).toBe(ORG);
    expect(claim.filters).toContainEqual(['status', 'in', ['queued']]);
  });

  it('sin hallazgos nuevos que pasen el umbral (alert_state none) → no encola aviso', async () => {
    rpcAlerta = 'none';
    gh = () => new Response(diff(...nuevo('src/a.ts', ['export const a = 1;'])));
    expect(await correr()).toBe('ack');
    expect(filas()).toEqual([]);
    expect(entorno.enviados).toEqual([]);
  });

  it('pasoRevision con paso aviso → notify/revision.ts', async () => {
    expect(await correr(2, 'aviso')).toBe('ack');
    expect(aviso.fn).toHaveBeenCalledWith(entorno.env, msg('aviso'), 2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('paso diff · idempotencia', () => {
  it('el CAS no deja correr dos diff: running con attempts 1 → ack sin GitHub; la reentrega (attempts > 1) la retoma', async () => {
    fila.status = 'running';
    expect(await correr(1)).toBe('ack');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpcs).toEqual([]);
    expect(await correr(2)).toBe('ack');
    expect(de('code_reviews', 'update')[1]!.filters).toContainEqual(['status', 'in', ['queued', 'running']]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fila.status).toBe('done');
  });

  it('done con el aviso pendiente → solo reencola el aviso; done sin aviso → ack sin nada', async () => {
    Object.assign(fila, { status: 'done', alert_state: 'pending' });
    expect(await correr(2)).toBe('ack');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(entorno.enviados).toEqual([avisoEncolado()]);
    fila.alert_state = 'sent';
    expect(await correr(3)).toBe('ack');
    expect(entorno.enviados).toHaveLength(1);
  });

  it('vg_review_findings responde applied:false (otra entrega la cerró) → ack sin aviso', async () => {
    rpcAlerta = 'pending';
    const rpcReal = doble.client.rpc;
    doble.client.rpc = async (name: string, a: Record<string, unknown>) => {
      fila.status = 'done';   // otra entrega cerró entre el claim y el cierre
      return rpcReal(name, a);
    };
    expect(await correr()).toBe('ack');
    expect(entorno.enviados).toEqual([]);
  });

  it('falla encolar el aviso tras cerrar → retry; la reentrega lo reencola sin repetir el diff', async () => {
    entorno.cola.send.mockRejectedValueOnce(new Error('cola caída'));
    expect(await correr(1)).toEqual({ retry: 10 });
    expect(fila).toMatchObject({ status: 'done', alert_state: 'pending' });
    expect(await correr(2)).toBe('ack');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entorno.enviados).toEqual([avisoEncolado()]);
  });
});

describe('paso diff · respuestas de GitHub (§2.2)', () => {
  it('401 y 403 sin límite → failed (unauthorized / forbidden) + config.last_error token con last_error_at', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden']] as const) {
      Object.assign(fila, { status: 'queued', error_code: null });
      doble.ops.length = 0;
      gh = () => new Response('{"message":"Bad credentials"}', { status });
      expect(await correr()).toBe('ack');
      expect(fila).toMatchObject({ status: 'failed', error_code: code });
      const u = de('code_review_configs', 'update')[0]!;
      expect(u.payload).toMatchObject({ last_error: 'token' });
      expect(typeof (u.payload as Fila).last_error_at).toBe('string');
      expect([eqDe(u, 'id'), eqDe(u, 'org_id')]).toEqual([CFG, ORG]);
      expect(rpcs).toEqual([]);
    }
  });

  it('403 con límite, 429 o 5xx → retry de la cola (10 s, 20 s) y a la 3.ª failed con su código, sin last_error', async () => {
    gh = () => new Response('x', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    expect(await correr(1)).toEqual({ retry: 10 });
    expect(fila.status).toBe('running');
    expect(await correr(2)).toEqual({ retry: 20 });
    expect(await correr(3)).toBe('ack');
    expect(fila).toMatchObject({ status: 'failed', error_code: 'rate_limited' });
    expect(de('code_review_configs', 'update')).toEqual([]);

    Object.assign(fila, { status: 'queued' });
    gh = () => new Response('x', { status: 502 });
    expect(await correr(1)).toEqual({ retry: 10 });
    expect(await correr(3)).toBe('ack');
    expect(fila).toMatchObject({ status: 'failed', error_code: 'unavailable' });
  });

  it('red caída → retry; 404 → failed not_found sin tocar el token', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'TypeError' }));
    expect(await correr(1)).toEqual({ retry: 10 });
    gh = () => new Response('Not Found', { status: 404 });
    expect(await correr(2)).toBe('ack');
    expect(fila).toMatchObject({ status: 'failed', error_code: 'not_found' });
    expect(de('code_review_configs', 'update')).toEqual([]);
  });

  it('406/422 (diff demasiado grande para GitHub) → RPC sin filas, partial y diff_grande: avisa como incompleta', async () => {
    for (const status of [406, 422]) {
      Object.assign(fila, { status: 'queued' });
      rpcs = [];
      gh = () => new Response('{"message":"too large"}', { status });
      expect(await correr()).toBe('ack');
      expect(rpcs[0]).toMatchObject({ p_rows: [], p_meta: { partial: true, error_code: 'diff_grande', files_changed: 0 } });
    }
  });

  it('Content-Length de 1,5 MB → lee y escanea el primer MB (no lo descarta entero) y queda partial', async () => {
    const relleno = Array.from({ length: 30_000 }, (_, i) => `linea ${i} ${'x'.repeat(40)}`);
    const texto = diff(...nuevo('src/lib/pagos.ts', [`const k = '${STRIPE}';`]), ...nuevo('docs/relleno.txt', relleno));
    expect(texto.length).toBeGreaterThan(1_500_000);
    gh = () => new Response(texto, { headers: { 'content-length': String(texto.length) } });
    expect(await correr()).toBe('ack');
    expect(filas().map((f) => f.rule_id)).toEqual(['CB_SECRET_STRIPE_LIVE']);
    expect(rpcs[0]).toMatchObject({ p_meta: { partial: true, error_code: 'diff_grande' } });
  });

  it('la URL del compare sale de meta y los SHA de la fila; un nombre de repo raro en meta no sale a la red', async () => {
    conexion = { ...conexion, meta: { repo_full_name: 'evil/../../x', repo_id: 42 } };
    expect(await correr()).toBe('ack');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fila).toMatchObject({ status: 'failed', error_code: 'repo_invalido' });
  });

  it('conexión no activa → failed conexion_inactiva; sin credencial → retry y, agotado, failed sin_credencial', async () => {
    conexion = { ...conexion, status: 'revoked' };
    await correr();
    expect(fila).toMatchObject({ status: 'failed', error_code: 'conexion_inactiva' });
    Object.assign(fila, { status: 'queued' });
    conexion = { ...conexion, status: 'active' };
    estado.sinSecreto = true;
    expect(await correr(1)).toEqual({ retry: 10 });
    expect(await correr(3)).toBe('ack');
    expect(fila).toMatchObject({ status: 'failed', error_code: 'sin_credencial' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('withSecret real con la base caída al leer el secreto → retry con la fila running, no sin_credencial a la 1.ª', async () => {
    estado.secretoReal = true;
    secretoError = { code: '08006' };
    expect(await correr(1)).toEqual({ retry: 10 });
    expect(fila.status).toBe('running');
    expect(await correr(2)).toEqual({ retry: 20 });
    secretoError = null;   // la base vuelve, pero la conexión no tiene secreto: a la 3.ª, failed sin_credencial
    expect(await correr(3)).toBe('ack');
    expect(fila).toMatchObject({ status: 'failed', error_code: 'sin_credencial' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpcs).toEqual([]);
  });

  it('config desactivada entre el webhook y el paso → failed desactivada, sin GitHub, sin findings ni aviso', async () => {
    config = { ...config, enabled: false };
    expect(await correr()).toBe('ack');
    expect(fila).toMatchObject({ status: 'failed', error_code: 'desactivada' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpcs).toEqual([]);
    expect(entorno.enviados).toEqual([]);
    expect(de('code_review_configs', 'select')[0]!.columns).toContain('enabled');
  });
});

describe('paso diff · diff y filas (§2.2–2.5)', () => {
  it('una ruta con x_ghp_… → resource oculto con hash, título sin ruta y evidencia tapada; el hallazgo sigue nuevo y avisa', async () => {
    const ruta = `lib/${CARPETA_GHP}/pagos.ts`;
    gh = () => new Response(diff(...nuevo(ruta, [`const k = '${STRIPE}';`])));
    expect(await correr()).toBe('ack');
    const [f] = filas();
    expect(f).toMatchObject({ rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical', title: 'Clave live de Stripe en el código',
      evidence: { redacted: true } });
    expect(f!.resource).toMatch(/^\[ruta oculta\]#[0-9a-f]{8}$/);
    expect(f!.dedupe_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rpcs)).not.toContain(CARPETA_GHP);
    expect(rpcs[0]).toMatchObject({ p_meta: { partial: false, error_code: 'tripwire' } });
    expect(entorno.enviados).toEqual([avisoEncolado()]);
  });

  it('ruta oculta: conserva fingerprint_short (8 hex): otro valor en la misma línea sigue siendo otro para la RPC', async () => {
    const ruta = `lib/${CARPETA_GHP}/pagos.ts`;
    const otra = 'sk' + '_live_' + RICO.slice(8, 32);
    gh = () => new Response(diff(...nuevo(ruta, [`const k = '${STRIPE}';`])));
    await correr();
    Object.assign(fila, { status: 'queued' });
    gh = () => new Response(diff(...nuevo(ruta, [`const k = '${otra}';`])));
    await correr();
    const [a, b] = [filas(0)[0]!, filas(1)[0]!];
    expect([a.dedupe_key, a.resource]).toEqual([b.dedupe_key, b.resource]);   // mismo sitio
    const fa = (a.evidence as Fila).fingerprint_short, fb = (b.evidence as Fila).fingerprint_short;
    expect(a.evidence).toEqual({ redacted: true, fingerprint_short: fa });
    expect(fa).toMatch(/^[0-9a-f]{8}$/);
    expect(fb).toMatch(/^[0-9a-f]{8}$/);
    expect(fa).not.toBe(fb);
    expect(JSON.stringify(rpcs)).not.toContain(otra);
  });

  it('.env subido → CB_ENV_COMMITTED sin gitignore_lo_lista', async () => {
    gh = () => new Response(diff(...nuevo('.env.production', ['DATABASE_HOST=db.interno', 'MODO=prod'])));
    await correr();
    const env = filas().find((f) => f.rule_id === 'CB_ENV_COMMITTED');
    expect(env).toMatchObject({ severity: 'critical', title: 'Archivo .env.production subido al repositorio' });
    expect(env!.evidence).not.toHaveProperty('gitignore_lo_lista');
  });

  it('binario que no es multimedia o ruta entre comillas → partial binario; un .png no corta', async () => {
    gh = () => new Response(diff('diff --git a/src/raro.ts b/src/raro.ts', 'new file mode 100644', 'index 0000000..7777777',
      'Binary files /dev/null and b/src/raro.ts differ'));
    await correr();
    expect(rpcs[0]).toMatchObject({ p_meta: { partial: true, error_code: 'binario' } });

    Object.assign(fila, { status: 'queued' });
    gh = () => new Response(diff('diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"', 'new file mode 100644',
      'index 0000000..1111111', '--- /dev/null', '+++ "b/caf\\303\\251.ts"', '@@ -0,0 +1 @@', '+x'));
    await correr();
    expect(rpcs[1]).toMatchObject({ p_meta: { partial: true, error_code: 'binario' } });

    Object.assign(fila, { status: 'queued' });
    gh = () => new Response(diff('diff --git a/public/logo.png b/public/logo.png', 'new file mode 100644',
      'index 0000000..7777777', 'Binary files /dev/null and b/public/logo.png differ'));
    await correr();
    expect(rpcs[2]).toMatchObject({ p_meta: { partial: false, error_code: null, files_changed: 1 } });
  });

  it('más de 128 KB añadidos → escanea lo que cabe, partial diff_grande y avisa como incompleta', async () => {
    expect(LIM_REVISION.bytesAnadidos).toBe(128_000);
    const relleno = Array.from({ length: 1400 }, (_, i) => `export const r${i} = '${'x'.repeat(80)}';`);
    gh = () => new Response(diff(...nuevo('src/lib/pagos.ts', [`const k = '${STRIPE}';`, ...relleno])));
    expect(await correr()).toBe('ack');
    expect(rpcs[0]).toMatchObject({ p_meta: { partial: true, error_code: 'diff_grande', files_changed: 1 } });
    expect(filas()).toEqual([expect.objectContaining({ rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical' })]);
    expect(entorno.enviados).toContainEqual(avisoEncolado());
  });

  it('más de 300 archivos → partial diff_grande', async () => {
    const ls: string[] = [];
    for (let i = 0; i <= LIM_REVISION.archivos; i++) ls.push(...nuevo(`src/f${i}.ts`, [`export const v${i} = ${i};`]));
    gh = () => new Response(diff(...ls));
    await correr();
    expect(rpcs[0]).toMatchObject({ p_meta: { partial: true, error_code: 'diff_grande', files_changed: LIM_REVISION.archivos } });
  });

  it('la base rechaza el lote (23514) → segundo intento con todas las filas ocultas y tripwire, sin descartar ninguna', async () => {
    rpcError = (n) => (n === 1 ? { code: '23514' } : null);
    expect(await correr()).toBe('ack');
    expect(rpcs).toHaveLength(2);
    expect(filas(1)).toHaveLength(1);
    expect(filas(1)[0]).toMatchObject({ evidence: { redacted: true }, title: 'Clave live de Stripe en el código' });
    expect(filas(1)[0]!.resource).toMatch(/^\[ruta oculta\]#/);
    expect(rpcs[1]).toMatchObject({ p_meta: { error_code: 'tripwire' } });
  });

  it('otro error del RPC → retry y a la 3.ª failed', async () => {
    rpcError = () => ({ code: '08006' });
    expect(await correr(1)).toEqual({ retry: 10 });
    expect(await correr(3)).toBe('ack');
    expect(fila).toMatchObject({ status: 'failed', error_code: 'unavailable' });
  });
});

describe('paso diff · pull_request (B7)', () => {
  it('PR del mismo repo → compare base...head de la fila en el repo de meta, p_write false, sin sin_aviso y aviso', async () => {
    Object.assign(fila, { event: 'pull_request', pr_number: 12, alert_reason: null });
    expect(await correr()).toBe('ack');
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://api.github.com/repos/Acme/Tienda/compare/${BASE}...${HEAD}`);
    expect(rpcs[0]).toMatchObject({ p_org: ORG, p_review: REV, p_write: false,
      p_meta: { files_changed: 1, lines_added: 3, partial: false, error_code: null } });
    expect(rpcs[0]!.p_meta).not.toHaveProperty('sin_aviso');
    expect(filas().map((f) => f.rule_id)).toEqual(['CB_SECRET_STRIPE_LIVE']);
    expect(entorno.enviados).toEqual([avisoEncolado()]);
  });

  it('push sin alert_reason → p_write true y sin sin_aviso, como antes', async () => {
    Object.assign(fila, { alert_reason: null });
    await correr();
    expect(rpcs[0]).toMatchObject({ p_write: true });
    expect(rpcs[0]!.p_meta).not.toHaveProperty('sin_aviso');
  });

  it('PR de un fork (alert_reason fork) → p_write false y sin_aviso fork, sin consultas de más que un push', async () => {
    await correr();   // push de referencia
    const consultas = doble.ops.length;
    doble.ops.length = 0;
    rpcs = [];
    Object.assign(fila, { status: 'queued', event: 'pull_request', pr_number: 31, alert_reason: 'fork',
      alert_state: 'none' });
    rpcAlerta = 'none';   // la 0013 deja none/fork: no hay paso aviso
    expect(await correr()).toBe('ack');
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]).toMatchObject({ p_write: false, p_meta: { sin_aviso: 'fork', partial: false } });
    expect(doble.ops.length).toBe(consultas);   // alert_reason sale del mismo claim
    expect(de('code_reviews', 'update')[0]!.returning).toMatch(/\balert_reason\b/);
    expect(entorno.enviados).toEqual([avisoEncolado()]);   // solo el del push
    expect(lineas()).toContain('"fork":true');
  });

  it('el rescate del 23514 también manda sin_aviso fork y p_write false', async () => {
    Object.assign(fila, { event: 'pull_request', pr_number: 31, alert_reason: 'fork' });
    rpcError = (n) => (n === 1 ? { code: '23514' } : null);
    expect(await correr()).toBe('ack');
    expect(rpcs.map((a) => [a.p_write, (a.p_meta as Fila).sin_aviso])).toEqual([[false, 'fork'], [false, 'fork']]);
    expect(rpcs[1]).toMatchObject({ p_meta: { error_code: 'tripwire' } });
  });

  it('un reintento (attempts > 1) de un PR de fork que retoma la running sigue mandando sin_aviso', async () => {
    Object.assign(fila, { status: 'running', event: 'pull_request', pr_number: 31, alert_reason: 'fork' });
    expect(await correr(2)).toBe('ack');
    expect(rpcs[0]).toMatchObject({ p_write: false, p_meta: { sin_aviso: 'fork' } });
  });
});

describe('ocultarRutas', () => {
  it('solo la evidencia casa con el cable trampa → evidence {redacted:true} y conserva título y recurso', async () => {
    const f = { rule_id: 'CB_SECRET_GENERIC', severity: 'medium', confirmed: false, origin: 'rule' as const,
      title: 'Posible credencial en el código', resource: 'src/a.ts:1', evidence: { snippet: `const t = '${CARPETA_GHP.slice(2)}'` },
      suspected_injection: false, dedupe_key: 'd'.repeat(64) };
    const r = await ocultarRutas([f]);
    expect(r.ocultas).toBe(1);
    expect(r.filas[0]).toEqual({ ...f, evidence: { redacted: true } });
    const limpia = { ...f, evidence: { path: 'src/a.ts' } };
    expect((await ocultarRutas([limpia])).filas[0]).toBe(limpia);
  });

  it('la huella (8 hex) sobrevive al tapar la evidencia o la ruta; lo que no es una huella, no', async () => {
    const f = { rule_id: 'CB_SECRET_GITHUB', severity: 'critical', confirmed: false, origin: 'rule' as const,
      title: 'Token de GitHub en el código', resource: 'src/a.ts:1', suspected_injection: false, dedupe_key: 'd'.repeat(64),
      evidence: { snippet: `const t = '${CARPETA_GHP.slice(2)}'`, fingerprint_short: 'ab12cd34' } };
    expect((await ocultarRutas([f])).filas[0]!.evidence).toEqual({ redacted: true, fingerprint_short: 'ab12cd34' });
    const ruta = { ...f, resource: `lib/${CARPETA_GHP}/a.ts:1` };
    expect((await ocultarRutas([ruta])).filas[0]!.evidence).toEqual({ redacted: true, fingerprint_short: 'ab12cd34' });
    const rara = { ...f, evidence: { ...f.evidence, fingerprint_short: CARPETA_GHP } };
    expect((await ocultarRutas([rara])).filas[0]!.evidence).toEqual({ redacted: true });
  });
});

// Bloqueo de merge (asignaciones/bloqueo-merge-criticos.md §2.5 y pruebas B3 de §10.5).
describe('paso diff · bloqueo de merge', () => {
  const estadoEncolado = (): JobMsg => ({ v: 1, kind: 'review', org_id: ORG, review_id: REV, paso: 'estado' });
  const gateUpdates = () => de('code_reviews', 'update').filter((o) => 'gate_blocking' in (o.payload as object));
  const encender = (o: Fila = {}) => { config = { id: CFG, connection_id: CONN, enabled: true, gate_enabled: true,
    gate_min: 'critical', ...o }; };

  it('apagado: ni ignorados, ni gate_*, ni estado (las mismas subpeticiones que antes); fallar() tampoco encola', async () => {
    expect(await correr()).toBe('ack');
    expect(de('findings', 'select')).toEqual([]);
    expect(gateUpdates()).toEqual([]);
    expect(entorno.enviados).toEqual([avisoEncolado()]);
    Object.assign(fila, { status: 'queued' });
    entorno.enviados.length = 0;
    gh = () => new Response('Not Found', { status: 404 });
    expect(await correr()).toBe('ack');
    expect(fila).toMatchObject({ status: 'failed', error_code: 'not_found' });
    expect(entorno.enviados).toEqual([]);
  });

  it('encendido: gate_blocking y gate_findings ANTES de la RPC (CAS running) y encola estado tras el aviso', async () => {
    encender();
    let alCerrar: unknown = 'sin llamar';
    const rpcReal = doble.client.rpc;
    doble.client.rpc = async (name: string, a: Record<string, unknown>) => { alCerrar = fila.gate_blocking; return rpcReal(name, a); };
    expect(await correr()).toBe('ack');
    expect(alCerrar).toBe(1);
    const q = de('findings', 'select')[0]!;
    expect(q.columns).toBe('dedupe_key, rule_id, fp:evidence->>fingerprint_short');
    expect(q.filters).toEqual([['org_id', 'eq', ORG], ['status', 'eq', 'ignored'], ['rule_id', 'in', ['CB_SECRET_STRIPE_LIVE']]]);
    const u = gateUpdates()[0]!;
    expect(u.payload).toEqual({ gate_blocking: 1, gate_findings: [{ finding_id: null, rule_id: 'CB_SECRET_STRIPE_LIVE',
      severity: 'critical', title: 'Clave live de Stripe en el código', resource: 'src/lib/pagos.ts:3' }] });
    expect(u.filters).toEqual([['id', 'eq', REV], ['org_id', 'eq', ORG], ['status', 'eq', 'running']]);
    expect(JSON.stringify(u.payload)).not.toContain(STRIPE);
    expect(entorno.enviados).toEqual([avisoEncolado(), estadoEncolado()]);
  });

  it('un ignored con el mismo valor en el mismo sitio tapa (gate_blocking 0); el estado se publica igual', async () => {
    encender();
    ignorados = [{ dedupe_key: await dedupeKey(ORG, 'CB_SECRET_STRIPE_LIVE', 'src/lib/pagos.ts:3'),
      rule_id: 'CB_SECRET_STRIPE_LIVE', fp: null }];
    await correr();
    expect(gateUpdates()[0]!.payload).toEqual({ gate_blocking: 0, gate_findings: [] });
    expect(entorno.enviados).toContainEqual(estadoEncolado());
  });

  it('PR con dos pushes y la misma clave: la RPC no ve nada nuevo pero gate_blocking = 1 y encola estado', async () => {
    encender();
    Object.assign(fila, { event: 'pull_request' });
    rpcAlerta = 'none';
    const rpcReal = doble.client.rpc;
    doble.client.rpc = async (name: string, a: Record<string, unknown>) => {
      const r = await rpcReal(name, a);
      return { ...r, data: { ...(r.data as object), nuevos: 0 } };   // reported_keys de la revisión anterior del PR
    };
    expect(await correr()).toBe('ack');
    expect(fila).toMatchObject({ status: 'done', gate_blocking: 1 });
    expect(entorno.enviados).toEqual([estadoEncolado()]);   // sin aviso repetido, con estado
  });

  it('sin candidatas ≥ umbral → no consulta ignorados y escribe 0', async () => {
    encender();
    gh = () => new Response(diff(...nuevo('src/a.ts', ['export const a = 1;'])));
    rpcAlerta = 'none';
    await correr();
    expect(de('findings', 'select')).toEqual([]);
    expect(gateUpdates()[0]!.payload).toEqual({ gate_blocking: 0, gate_findings: [] });
  });

  it('la base rechaza gate_findings (23514) → se repite con [] y solo el número', async () => {
    encender();
    gateError = { code: '23514' };
    expect(await correr()).toBe('ack');
    expect(gateUpdates().map((o) => o.payload)).toEqual([
      { gate_blocking: 1, gate_findings: expect.any(Array) }, { gate_blocking: 1, gate_findings: [] }]);
  });

  it('fallar() con el bloqueo ya leído encola estado; antes de leer la config (sha_invalido) no', async () => {
    encender();
    gh = () => new Response('Not Found', { status: 404 });
    expect(await correr()).toBe('ack');
    expect(fila).toMatchObject({ status: 'failed', error_code: 'not_found' });
    expect(entorno.enviados).toEqual([estadoEncolado()]);
    Object.assign(fila, { status: 'queued', head_sha: 'no-es-un-sha' });
    entorno.enviados.length = 0;
    expect(await correr()).toBe('ack');
    expect(fila.error_code).toBe('sha_invalido');
    expect(entorno.enviados).toEqual([]);
  });

  it('falla encolar estado tras cerrar → retry; la reentrega (yaReclamada) lo reencola sin repetir el diff', async () => {
    encender();
    rpcAlerta = 'none';
    entorno.cola.send.mockRejectedValueOnce(new Error('cola caída'));
    expect(await correr(1)).toEqual({ retry: 10 });
    expect(fila).toMatchObject({ status: 'done', gate_blocking: 1 });
    expect(await correr(2)).toBe('ack');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entorno.enviados).toEqual([estadoEncolado()]);
  });

  it('yaReclamada: done con gate_blocking y nada publicado → reencola estado; con gate_state o bloqueo apagado, no', async () => {
    encender();
    Object.assign(fila, { status: 'done', alert_state: 'sent', gate_blocking: 1, gate_state: null, gate_error: null });
    expect(await correr(2)).toBe('ack');
    expect(entorno.enviados).toEqual([estadoEncolado()]);
    fila.gate_state = 'failure';
    expect(await correr(3)).toBe('ack');
    fila.gate_state = null;
    config!.gate_enabled = false;
    expect(await correr(4)).toBe('ack');
    Object.assign(fila, { gate_blocking: null });   // done sin cálculo (se encendió después): tampoco
    config!.gate_enabled = true;
    expect(await correr(5)).toBe('ack');
    expect(entorno.enviados).toHaveLength(1);
  });

  it('pasoRevision con paso estado → revision/estado.ts con attempts', async () => {
    const m: MsgRevision = { ...msg(), paso: 'estado' };
    expect(await pasoRevision(entorno.env, m, 3)).toBe('ack');
    expect(paso.estado).toHaveBeenCalledWith(entorno.env, m, 3);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DLQ de la revisión', () => {
  it('estado agotado → cierreEstadoDlq; diff agotado → además encola estado (mejor esfuerzo)', async () => {
    const m: MsgRevision = { ...msg(), paso: 'estado' };
    expect(await cierreRevisionDlq(entorno.env, m)).toBe('ack');
    expect(paso.dlq).toHaveBeenCalledWith(entorno.env, m);
    fila.status = 'running';
    expect(await cierreRevisionDlq(entorno.env, msg('diff'))).toBe('ack');
    expect(entorno.enviados).toEqual([{ v: 1, kind: 'review', org_id: ORG, review_id: REV, paso: 'estado' }]);
    entorno.cola.send.mockRejectedValueOnce(new Error('cola caída'));
    expect(await cierreRevisionDlq(entorno.env, msg('diff'))).toBe('ack');
  });

  it('diff agotado → failed/dlq si sigue queued o running; done con aviso pendiente → not_sent/dlq', async () => {
    fila.status = 'running';
    expect(await cierreRevisionDlq(entorno.env, msg('diff'))).toBe('ack');
    expect(fila).toMatchObject({ status: 'failed', error_code: 'dlq' });
    expect(de('code_reviews', 'update').every((o) => eqDe(o, 'org_id') === ORG)).toBe(true);

    Object.assign(fila, { status: 'done', alert_state: 'pending', error_code: null });
    await cierreRevisionDlq(entorno.env, msg('diff'));
    expect(fila).toMatchObject({ status: 'done', alert_state: 'not_sent', alert_reason: 'dlq', error_code: null });
  });

  it('aviso agotado → alert_state not_sent con alert_reason dlq (la revisión sigue done); si no puede escribir, retry', async () => {
    Object.assign(fila, { status: 'done', alert_state: 'pending' });
    expect(await cierreRevisionDlq(entorno.env, msg('aviso'))).toBe('ack');
    expect(fila).toMatchObject({ status: 'done', alert_state: 'not_sent', alert_reason: 'dlq' });
    estado.client = dbDoble({ tabla: () => ({ error: { code: '08006' } }) }).client;
    expect(await cierreRevisionDlq(entorno.env, msg('aviso'))).toEqual({ retry: 10 });
  });
});
