import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textoCierrePr } from '@vanguard/core';
import type { MsgRevision } from '../jobs.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// Paso 'estado' sin red (asignaciones/bloqueo-merge-criticos.md §2.4 y pruebas B3 de §10.5; anexo bloqueo-merge-cierre-
// pr.md): GitHub con fetch simulado, supabase-js con el doble y el token de acciones con un doble de withSecret.
const estado = vi.hoisted(() => ({ client: null as unknown, ctx: null as unknown, sinSecreto: false }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
vi.mock('../lib/credentials.ts', async () => {
  const { ApiError } = await import('../lib/errors.ts');
  return {
    withSecret: async (_e: unknown, _a: unknown, ctx: unknown, fn: (t: string) => Promise<unknown>) => {
      estado.ctx = ctx;
      if (estado.sinSecreto) throw new ApiError('not_found', 'Esta conexión ya no tiene credencial.');
      return fn('tok-estados');
    },
  };
});

const { cierreEstadoDlq, pasoEstado, REINTENTOS_ESTADO } = await import('./estado.ts');
const { reabrirPr } = await import('./acciones-pr.ts');

const ORG = '0f6c0000-0000-4000-8000-000000000001';
const REV = 'c4000000-0000-4000-8000-000000000022';
const OTRA_REV = 'c4000000-0000-4000-8000-000000000023';
const CFG = 'c4000000-0000-4000-8000-000000000001';
const CONN = 'c0000000-0000-4000-8000-000000000001';
const ACC = 'c0000000-0000-4000-8000-000000000006';
const HEAD = 'a7d3c9e1f5b2048c6e9a1d3f5b7c9e0a2c4e6f81';
const GH = 'https://api.github.com/repos/Acme/Tienda';
const PROD = { VG_ENV: 'production', APP_ORIGIN: 'https://officialvanguard.com' } as Partial<CloudflareBindings>;
const URL_REV = `https://officialvanguard.com/o/${ORG}/codebase?revision=${REV}`;
const STRIPE = { finding_id: null, rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical',
  title: 'Clave live de Stripe en el código', resource: 'src/lib/cobros.ts:3' };

type Fila = Record<string, unknown>;
let fila: Fila;
let config: Fila | null;
let conexiones: Fila[];
let historial: Fila[];   // revisiones de ese PR, de la más nueva a la más vieja
let gh: Record<string, () => Response>;
let fetchMock: ReturnType<typeof vi.fn>;
let doble: ReturnType<typeof dbDoble>;
let entorno: ReturnType<typeof envDoble>;

const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) =>
  o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : o === 'is' ? (f[c] ?? null) === v : true);
// La config y las conexiones, comunes a los dobles de una y de varias revisiones.
const otrasTablas = (op: Op): Resp | undefined => {
  if (op.table === 'code_review_configs') {
    const hit = config && cumple(config, op) ? config : null;
    if (op.action === 'update' && hit) Object.assign(hit, op.payload);
    return { data: hit };
  }
  if (op.table === 'connections') {
    if (op.action === 'update') {
      const c = conexiones.find((x) => cumple(x, op));
      if (c) Object.assign(c, op.payload);
      return {};
    }
    return { data: conexiones.filter((c) => cumple(c, op)) };
  }
  return undefined;
};

beforeEach(() => {
  fila = { id: REV, org_id: ORG, config_id: CFG, event: 'pull_request', pr_number: 7, status: 'done', partial: false,
    error_code: null, head_sha: HEAD, counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, gate_blocking: 1,
    gate_findings: [STRIPE], gate_override_at: null, gate_state: null, gate_error: null, gate_pr_action: null,
    gate_pr_error: null, gate_pr_at: null };
  config = { id: CFG, org_id: ORG, connection_id: CONN, enabled: true, gate_enabled: true, gate_min: 'critical',
    gate_last_error: null, gate_close_pr: true };
  conexiones = [
    { id: CONN, org_id: ORG, provider: 'github', kind: 'read', status: 'active',
      meta: { repo_full_name: 'acme/tienda', repo_id: 42 } },
    { id: ACC, org_id: ORG, provider: 'github', kind: 'action', status: 'active',
      capabilities: { statuses: true, pull_requests: true },
      meta: { repo_full_name: 'Acme/Tienda', repo_id: 42, branch: 'main', purpose: 'commit_statuses' } },
  ];
  historial = [fila];
  estado.sinSecreto = false;
  estado.ctx = null;
  gh = {
    [`POST ${GH}/statuses/${HEAD}`]: () => new Response('{"id":1}', { status: 201 }),
    [`POST ${GH}/issues/7/comments`]: () => new Response('{"id":2}', { status: 201 }),
    [`PATCH ${GH}/pulls/7`]: () => new Response('{"state":"closed"}', { status: 200 }),
  };
  doble = dbDoble({
    tabla: (op): Resp | undefined => {
      if (op.table === 'code_reviews') {
        if (op.action === 'select' && op.orden) return { data: historial };   // el historial de ese PR
        const hit = cumple(fila, op) ? fila : null;
        if (op.action === 'select') return { data: hit };
        if (op.action === 'update') {
          if (hit) Object.assign(fila, op.payload);
          return { data: op.returning ? (hit ? [{ id: fila.id }] : []) : null };
        }
      }
      return otrasTablas(op);
    },
  });
  estado.client = doble.client;
  entorno = envDoble(PROD);
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const k = `${init.method ?? 'GET'} ${url}`;
    const f = gh[k];
    if (!f) throw new Error(`sin respuesta para ${k}`);
    return f();
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const msg: MsgRevision = { v: 1, kind: 'review', org_id: ORG, review_id: REV, paso: 'estado' };
const correr = (intento = 1, env = entorno.env) => pasoEstado(env, msg, intento);
const llamadas = () => fetchMock.mock.calls.map(([u, i]) => `${(i as RequestInit).method} ${String(u)}`);
const cuerpoDe = (k: string) => {
  const c = fetchMock.mock.calls.find(([u, i]) => `${(i as RequestInit).method} ${String(u)}` === k);
  return JSON.parse(String((c![1] as RequestInit).body)) as Record<string, unknown>;
};
const de = (tabla: string, action: Op['action']) => doble.ops.filter((o) => o.table === tabla && o.action === action);
const lineas = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');
const gateEscrito = () => de('code_reviews', 'update').some((o) => Object.keys(o.payload as object).some((k) => k.startsWith('gate_')));

describe('paso estado · publicar', () => {
  it('PR con un crítico nuevo → failure «VanGUARD» en el repo de meta del token, con su enlace y sin resource', async () => {
    expect(await correr()).toBe('ack');
    expect(llamadas()[0]).toBe(`POST ${GH}/statuses/${HEAD}`);
    const body = cuerpoDe(`POST ${GH}/statuses/${HEAD}`);
    expect(body).toEqual({ state: 'failure', description: '1 crítico: clave o token en el código. Detalle en VanGUARD',
      context: 'VanGUARD', target_url: URL_REV });
    expect(JSON.stringify(body)).not.toContain('cobros');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-estados');
    expect(estado.ctx).toEqual({ orgId: ORG, connectionId: ACC, provider: 'github', kind: 'action' });
    expect(fila).toMatchObject({ gate_state: 'failure', gate_error: null });
    expect(typeof fila.gate_published_at).toBe('string');
    expect(lineas()).toContain('"event":"gate.publicado"');
    expect(lineas()).not.toContain('tok-estados');
  });

  it('la URL sale de meta de la conexión de acciones aunque la de lectura diga otro nombre (mismo repo_id)', async () => {
    conexiones[0]!.meta = { repo_full_name: 'evil/otro', repo_id: 42 };
    expect(await correr()).toBe('ack');
    expect(llamadas()[0]).toBe(`POST ${GH}/statuses/${HEAD}`);
  });

  it('done limpio → success; failed → error; parcial binario → error con su texto; override → «Aprobado a mano»', async () => {
    const casos: [Fila, string, string][] = [
      [{ gate_blocking: 0, gate_findings: [], counts: {} }, 'success', 'Sin hallazgos críticos en lo añadido'],
      [{ status: 'failed', error_code: 'unauthorized', gate_blocking: null }, 'error',
        'No pudimos revisar este cambio. Reenvía la entrega o mira VanGUARD'],
      [{ gate_blocking: 0, partial: true, error_code: 'binario' }, 'error',
        'Hay archivos que no pudimos leer (binarios o rutas con acentos). Que decida un admin en VanGUARD'],
      [{ gate_override_at: '2026-10-24T20:00:00Z' }, 'success', 'Aprobado a mano en VanGUARD por un admin'],
    ];
    for (const [cambio, state, description] of casos) {
      Object.assign(fila, { status: 'done', partial: false, error_code: null, gate_blocking: 1, gate_findings: [STRIPE],
        gate_override_at: null, gate_pr_action: 'closed', counts: { critical: 1 } }, cambio);
      fetchMock.mockClear();
      expect(await correr()).toBe('ack');
      expect(cuerpoDe(`POST ${GH}/statuses/${HEAD}`)).toMatchObject({ state, description, context: 'VanGUARD' });
      expect(fila.gate_state).toBe(state);
    }
  });

  it('201 borra el gate_last_error de la config', async () => {
    config!.gate_last_error = 'forbidden';
    await correr();
    expect(config).toMatchObject({ gate_last_error: null, gate_last_error_at: null });
  });

  it('umbral high: un alto bloquea con el texto de «críticos o altos»', async () => {
    Object.assign(config!, { gate_min: 'high' });
    Object.assign(fila, { gate_findings: [{ ...STRIPE, rule_id: 'CB_SECRET_POSTGRES_URL', severity: 'high' }],
      counts: { critical: 0, high: 1 } });
    await correr();
    expect(cuerpoDe(`POST ${GH}/statuses/${HEAD}`).description).toBe('1 hallazgo crítico o alto: clave o token en el código. '
      + 'Detalle en VanGUARD');
  });
});

describe('paso estado · sin publicar', () => {
  it('bloqueo apagado, revisión apagada o sin config → ack sin escribir ninguna columna gate_* ni llamar a GitHub', async () => {
    for (const cambio of [{ gate_enabled: false }, { enabled: false }]) {
      Object.assign(config!, { enabled: true, gate_enabled: true }, cambio);
      expect(await correr()).toBe('ack');
    }
    config = null;
    expect(await correr()).toBe('ack');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gateEscrito()).toBe(false);
    expect(de('connections', 'select')).toEqual([]);   // ni siquiera lee la conexión: revisión 1 + config 1
  });

  it('queued o running → ack sin nada (el diff encola otro al cerrar); sin fila → ack', async () => {
    fila.status = 'running';
    expect(await correr()).toBe('ack');
    fila.org_id = 'otra';
    expect(await correr()).toBe('ack');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(de('code_review_configs', 'select')).toEqual([]);
  });

  it('fuera de producción → gate_error dry_run sin GitHub', async () => {
    expect(await correr(1, envDoble({ VG_ENV: 'local', APP_ORIGIN: 'http://localhost:5173' }).env)).toBe('ack');
    expect(fila.gate_error).toBe('dry_run');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('done sin gate_blocking (se encendió después) → sin_calculo', async () => {
    fila.gate_blocking = null;
    await correr();
    expect(fila.gate_error).toBe('sin_calculo');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin conexión de acciones activa → sin_token; sin secreto → sin_token; de otro repo → otro_repo', async () => {
    conexiones[1]!.status = 'revoked';
    await correr();
    expect(fila.gate_error).toBe('sin_token');
    conexiones[1]!.status = 'active';
    fila.gate_error = null;
    estado.sinSecreto = true;
    // withSecret lanza lo mismo si la base no pudo leer el secreto (08006): primero se reintenta, sin marcar nada.
    expect(await correr(1)).toEqual({ retry: 10 });
    expect(await correr(2)).toEqual({ retry: 20 });
    expect(fila.gate_error).toBeNull();
    expect(await correr(REINTENTOS_ESTADO + 1)).toBe('ack');
    expect(fila.gate_error).toBe('sin_token');
    estado.sinSecreto = false;
    conexiones[1]!.meta = { repo_full_name: 'acme/otro', repo_id: 99 };
    await correr();
    expect(fila.gate_error).toBe('otro_repo');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un SHA inválido no llama a GitHub', async () => {
    fila.head_sha = 'HEAD~1';
    await correr();
    expect(fila.gate_error).toBe('sha_invalido');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('paso estado · respuestas de GitHub', () => {
  const responde = (status: number, headers: Record<string, string> = {}) => {
    gh[`POST ${GH}/statuses/${HEAD}`] = () => new Response('{"message":"x"}', { status, headers });
  };
  it('401 → gate_error unauthorized, gate_last_error token y la conexión de acciones revoked', async () => {
    responde(401);
    expect(await correr()).toBe('ack');
    expect(fila).toMatchObject({ gate_error: 'unauthorized', gate_state: null });
    expect(config).toMatchObject({ gate_last_error: 'token' });
    expect(conexiones[1]).toMatchObject({ status: 'revoked', last_error: 'unauthorized' });
    expect(llamadas()).toHaveLength(1);   // ni comentario ni cierre
  });

  it('403 sin límite → forbidden en la revisión y en la config; 404 → not_found', async () => {
    responde(403);
    await correr();
    expect([fila.gate_error, config!.gate_last_error]).toEqual(['forbidden', 'forbidden']);
    responde(404);
    await correr();
    expect([fila.gate_error, config!.gate_last_error]).toEqual(['not_found', 'not_found']);
    expect(conexiones[1]!.status).toBe('active');
  });

  it('422 → solo gate_error limite: la config queda intacta', async () => {
    responde(422);
    expect(await correr()).toBe('ack');
    expect(fila.gate_error).toBe('limite');
    expect(de('code_review_configs', 'update')).toEqual([]);
  });

  it('5xx o 403 con límite → retry 10 y 20 s y a la 3.ª gate_error red', async () => {
    responde(502);
    expect(await correr(1)).toEqual({ retry: 10 });
    expect(await correr(2)).toEqual({ retry: 20 });
    expect(await correr(REINTENTOS_ESTADO + 1)).toBe('ack');
    expect(fila.gate_error).toBe('red');
    responde(403, { 'x-ratelimit-remaining': '0' });
    expect(await correr(1)).toEqual({ retry: 10 });
  });
});

describe('paso estado · cierre del PR con críticos (anexo)', () => {
  it('failure + crítico nuevo → comenta con texto fijo y cierra, en este orden; pr_action closed', async () => {
    expect(await correr()).toBe('ack');
    expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`, `POST ${GH}/issues/7/comments`, `PATCH ${GH}/pulls/7`]);
    expect(cuerpoDe(`POST ${GH}/issues/7/comments`)).toEqual({ body: textoCierrePr(1, 'critical', URL_REV) });
    expect(cuerpoDe(`PATCH ${GH}/pulls/7`)).toEqual({ state: 'closed' });
    expect(fila).toMatchObject({ gate_pr_action: 'closed', gate_pr_error: null });
    expect(typeof fila.gate_pr_at).toBe('string');
    expect(lineas()).toContain('"event":"gate.pr_cerrado"');
  });

  it('push con la misma clave a un PR que VanGUARD ya atendió (cerrado, reabierto, cierre fallido o aprobado) → NO cierra',
    async () => {
      fila.counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };   // 0013: la clave ya salió en la anterior
      const previas: Fila[] = [{ gate_pr_action: 'reopened_by_human' }, { gate_pr_action: 'reopened' },
        { gate_pr_action: 'closed' }, { gate_pr_action: 'close_failed' }, { gate_override_at: '2026-10-24T20:00:00Z' }];
      for (const previa of previas) {
        historial = [fila, { id: OTRA_REV, status: 'done', gate_pr_action: null, gate_override_at: null, ...previa }];
        fetchMock.mockClear();
        expect(await correr()).toBe('ack');
        expect(cuerpoDe(`POST ${GH}/statuses/${HEAD}`).state).toBe('failure');
        expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`]);
        expect(fila.gate_pr_action).toBeNull();
      }
      expect(lineas()).toContain('"motivo":"ya_atendido"');
    });

  it('dos pushes seguidos: la 1.ª cierra aunque la 2.ª ya esté en cola o en curso', async () => {
    for (const status of ['queued', 'running']) {
      Object.assign(fila, { gate_pr_action: null, gate_pr_at: null });
      historial = [{ id: OTRA_REV, status, gate_pr_action: null, gate_override_at: null }, fila];
      fetchMock.mockClear();
      expect(await correr()).toBe('ack');
      expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`, `POST ${GH}/issues/7/comments`, `PATCH ${GH}/pulls/7`]);
      expect(fila.gate_pr_action).toBe('closed');
    }
  });

  it('dos pushes seguidos: la 2.ª, sin nuevos (0013), cierra si nadie atendió aún el PR (la 1.ª se apartó)', async () => {
    fila.counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    historial = [fila, { id: OTRA_REV, status: 'done', gate_pr_action: null, gate_override_at: null }];
    expect(await correr()).toBe('ack');
    expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`, `POST ${GH}/issues/7/comments`, `PATCH ${GH}/pulls/7`]);
    // Sin nuevos, el comentario cuenta los bloqueantes de lo añadido (gate_blocking), nunca «0 hallazgos».
    expect(cuerpoDe(`POST ${GH}/issues/7/comments`)).toEqual({ body: textoCierrePr(1, 'critical', URL_REV) });
    expect(fila.gate_pr_action).toBe('closed');
  });

  it('push, interruptor apagado, token sin Pull requests o éxito → no cierra', async () => {
    const casos: (() => void)[] = [
      () => { fila.event = 'push'; fila.pr_number = null; },
      () => { config!.gate_close_pr = false; },
      () => { conexiones[1]!.capabilities = { statuses: true }; },
      () => { fila.gate_blocking = 0; fila.gate_findings = []; },
    ];
    for (const preparar of casos) {
      Object.assign(fila, { event: 'pull_request', pr_number: 7, gate_blocking: 1, gate_findings: [STRIPE] });
      config!.gate_close_pr = true;
      conexiones[1]!.capabilities = { statuses: true, pull_requests: true };
      preparar();
      fetchMock.mockClear();
      expect(await correr()).toBe('ack');
      expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`]);
    }
  });

  it('una más nueva del PR ya terminada → no cierra (una vieja que termina tarde); si la nueva falló, cierra', async () => {
    historial = [{ id: OTRA_REV, status: 'done', gate_pr_action: null, gate_override_at: null }, fila];
    expect(await correr()).toBe('ack');
    expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`]);
    expect(fila.gate_pr_at).toBeNull();
    expect(lineas()).toContain('"motivo":"no_es_la_ultima"');
    historial[0]!.status = 'failed';   // falla cerrado (D2): una revisión fallida no tapa el crítico de esta
    fetchMock.mockClear();
    expect(await correr()).toBe('ack');
    expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`, `POST ${GH}/issues/7/comments`, `PATCH ${GH}/pulls/7`]);
  });

  it('otro mensaje de la misma revisión anotó el cierre antes → no repite el aviso del PR cerrado', async () => {
    fila.gate_pr_at = '2026-10-24T20:00:00Z';   // lo reclamó el otro mensaje: este no comenta
    gh[`PATCH ${GH}/pulls/7`] = () => {
      fila.gate_pr_action = 'closed';           // y el otro termina mientras este cierra
      return new Response('{}', { status: 200 });
    };
    expect(await correr()).toBe('ack');
    expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`, `PATCH ${GH}/pulls/7`]);
    expect(lineas()).not.toContain('"event":"gate.pr_cerrado"');
    expect(lineas()).toContain('"event":"gate.pr_ya_anotado"');
  });

  it('el resultado del cierre no se pudo anotar → retry; agotados, ack sin aviso', async () => {
    const base = doble.client.from.bind(doble.client);
    let fallar = true;
    estado.client = { ...doble.client, from: (t: string) => {
      const q = base(t) as unknown as { update: (p: Fila) => unknown };
      const update = q.update.bind(q);
      q.update = (p: Fila) => (fallar && 'gate_pr_action' in p
        ? { eq: () => ({ eq: () => ({ is: () => ({ select: async () => ({ data: null, error: { code: '08006' } }) }) }) }) }
        : update(p));
      return q;
    } };
    expect(await correr(1)).toEqual({ retry: 10 });
    expect(fila.gate_pr_action).toBeNull();
    expect(await correr(REINTENTOS_ESTADO + 1)).toBe('ack');
    expect(lineas()).not.toContain('"event":"gate.pr_cerrado"');
    fallar = false;
    expect(await correr(2)).toBe('ack');
    expect(fila.gate_pr_action).toBe('closed');
    expect(lineas()).toContain('"event":"gate.pr_cerrado"');
  });

  it('ya cerrado o reabierto a mano: un estado repetido (p. ej. tras «Deshacer») no vuelve a cerrar', async () => {
    for (const accion of ['closed', 'reopened_by_human', 'reopened']) {
      fila.gate_pr_action = accion;
      fetchMock.mockClear();
      expect(await correr()).toBe('ack');
      expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`]);
      expect(fila.gate_pr_action).toBe(accion);
    }
  });

  it('el comentario falla → igual cierra', async () => {
    gh[`POST ${GH}/issues/7/comments`] = () => new Response('x', { status: 403 });
    expect(await correr()).toBe('ack');
    expect(llamadas()).toContain(`PATCH ${GH}/pulls/7`);
    expect(fila.gate_pr_action).toBe('closed');
  });

  it('cierre 403 → close_failed forbidden; 422 → close_failed rechazado; el ✗ se queda', async () => {
    gh[`PATCH ${GH}/pulls/7`] = () => new Response('x', { status: 403 });
    expect(await correr()).toBe('ack');
    expect(fila).toMatchObject({ gate_state: 'failure', gate_pr_action: 'close_failed', gate_pr_error: 'forbidden' });
    Object.assign(fila, { gate_pr_action: null, gate_pr_error: null, gate_pr_at: null });
    gh[`PATCH ${GH}/pulls/7`] = () => new Response('x', { status: 422 });
    await correr();
    expect(fila).toMatchObject({ gate_pr_action: 'close_failed', gate_pr_error: 'rechazado' });
  });

  it('cierre 5xx → retry; la reentrega NO repite el comentario y cierra', async () => {
    gh[`PATCH ${GH}/pulls/7`] = () => new Response('x', { status: 503 });
    expect(await correr(1)).toEqual({ retry: 10 });
    expect(fila).toMatchObject({ gate_state: 'failure', gate_pr_action: null });
    expect(typeof fila.gate_pr_at).toBe('string');
    gh[`PATCH ${GH}/pulls/7`] = () => new Response('{}', { status: 200 });
    fetchMock.mockClear();
    expect(await correr(2)).toBe('ack');
    expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`, `PATCH ${GH}/pulls/7`]);
    expect(fila.gate_pr_action).toBe('closed');
  });

  it('agotados los reintentos del cierre → close_failed red', async () => {
    gh[`PATCH ${GH}/pulls/7`] = () => new Response('x', { status: 503 });
    expect(await correr(REINTENTOS_ESTADO + 1)).toBe('ack');
    expect(fila).toMatchObject({ gate_pr_action: 'close_failed', gate_pr_error: 'red' });
  });
});

describe('paso estado · el estado de commit falla y el PR se cierra igual', () => {
  const responde = (status: number) => {
    gh[`POST ${GH}/statuses/${HEAD}`] = () => new Response('{"message":"x"}', { status });
  };
  const CIERRE = [`POST ${GH}/statuses/${HEAD}`, `POST ${GH}/issues/7/comments`, `PATCH ${GH}/pulls/7`];
  const cerrados = () => lineas().match(/"event":"gate\.pr_cerrado"/g) ?? [];

  it('422 → comenta y cierra; gate_error limite registrado como siempre y la config intacta', async () => {
    responde(422);
    expect(await correr()).toBe('ack');
    expect(llamadas()).toEqual(CIERRE);
    expect(cuerpoDe(`POST ${GH}/issues/7/comments`)).toEqual({ body: textoCierrePr(1, 'critical', URL_REV) });
    expect(fila).toMatchObject({ gate_error: 'limite', gate_state: null, gate_pr_action: 'closed', gate_pr_error: null });
    expect(de('code_review_configs', 'update')).toEqual([]);
    expect(lineas()).toContain('"event":"gate.no_publicado"');
    expect(cerrados()).toHaveLength(1);
  });

  it('403 sin límite → cierra igual; forbidden en la revisión y en la config', async () => {
    responde(403);
    expect(await correr()).toBe('ack');
    expect(llamadas()).toEqual(CIERRE);
    expect([fila.gate_error, config!.gate_last_error, fila.gate_pr_action]).toEqual(['forbidden', 'forbidden', 'closed']);
  });

  it('5xx → cierra en el 1.er intento y solo el estado se reintenta (sin otro comentario ni PATCH); a la 3.ª, red',
    async () => {
      responde(502);
      expect(await correr(1)).toEqual({ retry: 10 });
      expect(llamadas()).toEqual(CIERRE);
      expect(fila).toMatchObject({ gate_pr_action: 'closed', gate_error: null });
      fetchMock.mockClear();
      expect(await correr(2)).toEqual({ retry: 20 });
      expect(await correr(REINTENTOS_ESTADO + 1)).toBe('ack');
      expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`, `POST ${GH}/statuses/${HEAD}`]);
      expect(fila).toMatchObject({ gate_error: 'red', gate_pr_action: 'closed' });
      expect(cerrados()).toHaveLength(1);
    });

  it('5xx o sin respuesta en el último intento → cierra igual y queda gate_error red', async () => {
    const sinRed = () => { throw new TypeError('fetch failed'); };
    for (const fallar of [() => responde(503), () => { gh[`POST ${GH}/statuses/${HEAD}`] = sinRed; }]) {
      Object.assign(fila, { gate_error: null, gate_pr_action: null, gate_pr_at: null });
      fallar();
      fetchMock.mockClear();
      expect(await correr(REINTENTOS_ESTADO + 1)).toBe('ack');
      expect(llamadas()).toEqual(CIERRE);
      expect(fila).toMatchObject({ gate_error: 'red', gate_state: null, gate_pr_action: 'closed' });
    }
  });

  it('estado y cierre fallan de paso → un solo retry; la reentrega publica, cierra sin repetir el comentario y anota',
    async () => {
      responde(502);
      gh[`PATCH ${GH}/pulls/7`] = () => new Response('x', { status: 503 });
      expect(await correr(1)).toEqual({ retry: 10 });
      expect(fila).toMatchObject({ gate_state: null, gate_pr_action: null });
      expect(typeof fila.gate_pr_at).toBe('string');
      responde(201);
      gh[`PATCH ${GH}/pulls/7`] = () => new Response('{}', { status: 200 });
      fetchMock.mockClear();
      expect(await correr(2)).toBe('ack');
      expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`, `PATCH ${GH}/pulls/7`]);
      expect(fila).toMatchObject({ gate_state: 'failure', gate_pr_action: 'closed' });
    });

  it('presupuesto: el peor caso del paso cabe en las 40 subpeticiones (estado rechazado o aceptado, con el cierre)',
    async () => {
      // pedir sigue ≤ 3 saltos por escritura (4 fetch); withSecret (aquí un doble) lee el secreto 1 + llaves ≤ 2 en frío.
      const SALTOS = 4, SECRETO = 3;
      const medir = async (intento = 1) => {
        const ops = doble.ops.length, gets = fetchMock.mock.calls.length;
        await correr(intento);
        return { ops: doble.ops.length - ops, gh: fetchMock.mock.calls.length - gets,
          total: doble.ops.length - ops + (fetchMock.mock.calls.length - gets) * SALTOS + SECRETO };
      };
      // 403: revisión, config, conexiones, historial, reclamo, config marcada, gate_error y anotación del cierre.
      responde(403);
      const rechazado = await medir();
      expect([rechazado.ops, rechazado.gh]).toEqual([8, 3]);
      expect(rechazado.total).toBeLessThanOrEqual(40);
      // 201 con gate_last_error que limpiar: lo mismo con gate_state y la config limpia.
      Object.assign(fila, { gate_error: null, gate_pr_action: null, gate_pr_at: null });
      config!.gate_last_error = 'forbidden';
      responde(201);
      const aceptado = await medir();
      expect([aceptado.ops, aceptado.gh]).toEqual([8, 3]);
      expect(aceptado.total).toBeLessThanOrEqual(40);
      // Reintento de un cierre ya reclamado: sin reclamo ni comentario.
      Object.assign(fila, { gate_pr_action: null });
      const reintento = await medir(2);
      expect([reintento.ops, reintento.gh]).toEqual([6, 2]);
    });
});

describe('paso estado · un cierre reclamado (gate_pr_at) en dos revisiones del mismo PR', () => {
  const R1 = REV, R2 = OTRA_REV;
  const HEAD2 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4';
  const SIN_NUEVOS = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let filas: Fila[];   // revisiones del PR #7, de la más nueva a la más vieja
  let anotacionFalla: boolean;
  const rev = (id: string) => filas.find((f) => f.id === id)!;
  const correrDe = (id: string, intento = 1) => pasoEstado(entorno.env, { ...msg, review_id: id }, intento);
  const comentarios = () => llamadas().filter((l) => l === `POST ${GH}/issues/7/comments`);
  const admin = () => doble.client as unknown as Parameters<typeof reabrirPr>[1];

  beforeEach(() => {
    const base: Fila = { org_id: ORG, config_id: CFG, event: 'pull_request', pr_number: 7, partial: false,
      error_code: null, gate_blocking: 1, gate_findings: [STRIPE], gate_override_at: null, gate_state: null,
      gate_error: null, gate_pr_action: null, gate_pr_error: null, gate_pr_at: null };
    filas = [
      // 2.º push: ya no ve la clave como nueva (0013) y aún está en curso cuando la 1.ª cierra.
      { ...base, id: R2, status: 'running', head_sha: HEAD2, counts: SIN_NUEVOS },
      { ...base, id: R1, status: 'done', head_sha: HEAD, counts: { ...SIN_NUEVOS, critical: 1 } },
    ];
    anotacionFalla = false;
    gh[`POST ${GH}/statuses/${HEAD2}`] = () => new Response('{"id":3}', { status: 201 });
    doble = dbDoble({
      tabla: (op): Resp | undefined => {
        if (op.table !== 'code_reviews') return otrasTablas(op);
        const hits = filas.filter((f) => cumple(f, op));
        if (op.action === 'select') return { data: op.orden ? hits : hits[0] ?? null };
        if (op.action === 'update') {
          if (anotacionFalla && 'gate_pr_action' in (op.payload as Fila)) return { error: { code: '08006' } };
          for (const f of hits) Object.assign(f, op.payload);
          return { data: op.returning ? hits.map((f) => ({ id: f.id })) : null };
        }
        return undefined;
      },
    });
    estado.client = doble.client;
  });

  // R1 reclama, comenta y su PATCH da 503 (GitHub pudo cerrarlo igual: plazo); R2 termina sin nuevos con GitHub ya sano;
  // luego llega el reintento de R1.
  const r1CaeR2TerminaR1Reintenta = async () => {
    gh[`PATCH ${GH}/pulls/7`] = () => new Response('x', { status: 503 });
    expect(await correrDe(R1, 1)).toEqual({ retry: 10 });
    expect(rev(R1)).toMatchObject({ gate_state: 'failure', gate_pr_action: null });
    expect(typeof rev(R1).gate_pr_at).toBe('string');
    gh[`PATCH ${GH}/pulls/7`] = () => new Response('{}', { status: 200 });
    rev(R2).status = 'done';
    expect(await correrDe(R2)).toBe('ack');
    expect(await correrDe(R1, 2)).toBe('ack');
  };

  it('PATCH de R1 en 5xx: R2 sin nuevos no comenta ni cierra; el reintento de R1 cierra y anota closed aunque ya no sea '
    + 'la última', async () => {
    await r1CaeR2TerminaR1Reintenta();
    expect(llamadas()).toEqual([
      `POST ${GH}/statuses/${HEAD}`, `POST ${GH}/issues/7/comments`, `PATCH ${GH}/pulls/7`,   // R1: el PATCH da 503
      `POST ${GH}/statuses/${HEAD2}`,                                                       // R2: ya atendido
      `POST ${GH}/statuses/${HEAD}`, `PATCH ${GH}/pulls/7`,                                  // reintento de R1
    ]);
    expect(rev(R2)).toMatchObject({ gate_state: 'failure', gate_pr_action: null, gate_pr_at: null });
    expect(lineas()).toContain('"motivo":"ya_atendido"');
    expect(rev(R1)).toMatchObject({ gate_pr_action: 'closed', gate_pr_error: null });
    expect(lineas()).toContain(`"event":"gate.pr_cerrado","review":"${R1}"`);
  });

  it('R1 cierra pero no puede anotarlo: R2 sin nuevos no repite; el reintento de R1 lo anota por CAS y avisa una vez',
    async () => {
      anotacionFalla = true;
      expect(await correrDe(R1, 1)).toEqual({ retry: 10 });
      expect(rev(R1).gate_pr_action).toBeNull();
      rev(R2).status = 'done';
      expect(await correrDe(R2)).toBe('ack');
      anotacionFalla = false;
      expect(await correrDe(R1, 2)).toBe('ack');
      expect(comentarios()).toHaveLength(1);
      expect(llamadas().filter((l) => l === `PATCH ${GH}/pulls/7`)).toHaveLength(2);   // cerrar lo cerrado no cambia nada
      expect([rev(R1).gate_pr_action, rev(R2).gate_pr_action]).toEqual(['closed', null]);
      const anotacion = de('code_reviews', 'update').filter((o) => 'gate_pr_action' in (o.payload as Fila)).at(-1)!;
      expect(eqDe(anotacion, 'id')).toBe(R1);
      expect(anotacion.filters).toContainEqual(['gate_pr_action', 'is', null]);   // CAS: solo desde null
      expect(lineas().match(/"event":"gate\.pr_cerrado"/g)).toHaveLength(1);
    });

  it('E54 «Reabrir el PR» sobre la que cerró funciona tras el reintento (antes, 409 no_cerrado)', async () => {
    await r1CaeR2TerminaR1Reintenta();
    fetchMock.mockClear();
    expect(await reabrirPr(entorno.env, admin(), ORG, R1)).toEqual({ ok: true, numero: 7 });
    expect(cuerpoDe(`PATCH ${GH}/pulls/7`)).toEqual({ state: 'open' });
    expect(rev(R1).gate_pr_action).toBe('reopened');
  });

  it('reapertura a mano tras un reintento: E47 la reconoce desde closed, E54 responde ya_abierto y nada vuelve a cerrar',
    async () => {
      filas = [rev(R1)];   // R1 es la cabeza del PR: E47 busca ahí al reabrir sin commits nuevos
      anotacionFalla = true;
      expect(await correrDe(R1, 1)).toEqual({ retry: 10 });
      anotacionFalla = false;
      expect(await correrDe(R1, 2)).toBe('ack');
      expect(rev(R1).gate_pr_action).toBe('closed');
      // La escritura de E47 (webhooks-github.ts; la ruta entera la prueba webhooks-github.test.ts): CAS desde 'closed'.
      const { data } = await doble.client.from('code_reviews').update({ gate_pr_action: 'reopened_by_human' })
        .eq('id', R1).eq('org_id', ORG).eq('gate_pr_action', 'closed').select('id');
      expect(data).toEqual([{ id: R1 }]);
      expect(await reabrirPr(entorno.env, admin(), ORG, R1)).toEqual({ ok: false, motivo: 'ya_abierto' });
      fetchMock.mockClear();
      expect(await correrDe(R1, 1)).toBe('ack');   // p. ej. otro estado tras «Deshacer»
      expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`]);
    });

  it('el reintento de un cierre reclamado no cierra si una revisión MÁS NUEVA del PR consta reabierta o aprobada',
    async () => {
      rev(R1).gate_pr_at = '2026-10-24T22:00:00Z';   // el intento anterior comentó y cayó antes de anotar
      for (const nueva of [{ gate_pr_action: 'reopened_by_human' }, { gate_pr_action: 'reopened' },
        { gate_override_at: '2026-10-24T22:01:00Z' }]) {
        Object.assign(rev(R2), { status: 'done', gate_pr_action: null, gate_override_at: null }, nueva);
        fetchMock.mockClear();
        expect(await correrDe(R1, 2)).toBe('ack');
        expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`]);
        expect(rev(R1).gate_pr_action).toBeNull();
      }
      expect(lineas()).toContain('"motivo":"reabierto"');
      // Una reapertura MÁS VIEJA no lo frena: commits nuevos con un crítico nuevo vuelven a cerrar (punto 4).
      filas = [rev(R1), { ...rev(R2), id: 'c4000000-0000-4000-8000-000000000021', gate_pr_action: 'reopened_by_human',
        gate_override_at: null }];
      fetchMock.mockClear();
      expect(await correrDe(R1, 2)).toBe('ack');
      expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`, `PATCH ${GH}/pulls/7`]);
      expect(rev(R1).gate_pr_action).toBe('closed');
    });
});

describe('cierreEstadoDlq', () => {
  it('gate_error dlq solo si no había otro motivo, sobre la fila de esa org', async () => {
    expect(await cierreEstadoDlq(entorno.env, msg)).toBe('ack');
    const u = de('code_reviews', 'update')[0]!;
    expect(u.payload).toEqual({ gate_error: 'dlq' });
    expect([eqDe(u, 'id'), eqDe(u, 'org_id')]).toEqual([REV, ORG]);
    expect(u.filters).toContainEqual(['gate_error', 'is', null]);
    expect(fila.gate_error).toBe('dlq');
  });
});
