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
// Aviso «VanGUARD cerró el PR» por WhatsApp: solo con Kapso configurado (las pruebas de arriba no lo tienen).
let contactos: Fila[];
let org: Fila;
let ventanaDemo: Fila | null;
let avisadas: number;          // revisiones avisadas en la última hora (cupo de avisos de revisión)
let errorApprovals: { code: string } | null;

const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) =>
  o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : o === 'is' ? (f[c] ?? null) === v : true);

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
  contactos = [];
  org = { is_demo: false };
  ventanaDemo = null;
  avisadas = 0;
  errorApprovals = null;
  estado.sinSecreto = false;
  estado.ctx = null;
  gh = {
    [`POST ${GH}/statuses/${HEAD}`]: () => new Response('{"id":1}', { status: 201 }),
    [`POST ${GH}/issues/7/comments`]: () => new Response('{"id":2}', { status: 201 }),
    [`PATCH ${GH}/pulls/7`]: () => new Response('{"state":"closed"}', { status: 200 }),
  };
  doble = dbDoble({
    tabla: (op): Resp | undefined => {
      if (op.table === 'contacts') return { data: contactos };
      if (op.table === 'orgs') return { data: org };
      if (op.table === 'app_config') return { data: ventanaDemo };
      if (op.table === 'approvals') return errorApprovals ? { error: errorApprovals } : {};
      if (op.table === 'code_reviews') {
        if (op.action === 'select' && op.head) return { count: avisadas };   // el cupo de avisos de revisión
        if (op.action === 'select' && op.orden) return { data: historial };   // el historial de ese PR
        const hit = cumple(fila, op) ? fila : null;
        if (op.action === 'select') return { data: hit };
        if (op.action === 'update') {
          if (hit) Object.assign(fila, op.payload);
          return { data: op.returning ? (hit ? [{ id: fila.id }] : []) : null };
        }
      }
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

// WhatsApp «VanGUARD cerró el PR» (asignaciones/avisos-whatsapp-botones.md): texto fijo y sus 3 botones, UNA vez por
// cierre (tras el CAS de gate_pr_action), solo a verificados con la ventana de 24 h abierta; silencio, cupo de revisión y
// ventana de la demo lo callan, pero el ✗ y el cierre siguen.
describe('paso estado · WhatsApp «VanGUARD cerró el PR»', () => {
  const KAPSO = 'POST https://api.kapso.ai/meta/whatsapp/v24.0/1234567890/messages';
  const TEL_A = '+58' + '4141234567';
  const TEL_B = '+58' + '4241112233';
  const TEXTO = 'VanGUARD cerró el PR #7 hacia main: 1 crítico nuevo. Corrige, rota las claves y vuelve a abrirlo.';
  const hace = (ms: number) => new Date(Date.now() - ms).toISOString();
  type Enviado = { to: string; type: string; text?: { body: string };
    interactive?: { body: { text: string }; action: { buttons: { reply: { id: string; title: string } }[] } } };
  const enviados = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('https://api.kapso.ai/'))
    .map(([, i]) => JSON.parse(String((i as RequestInit).body)) as Enviado);

  beforeEach(() => {
    entorno = envDoble({ ...PROD, KAPSO_API_KEY: ['clave', 'kapso'].join('-'), KAPSO_PHONE_NUMBER_ID: '1234567890' });
    Object.assign(fila, { branch: 'main', new_findings: [STRIPE] });
    contactos = [
      { id: 'c1', phone_e164: TEL_A, whatsapp: true, priority: 1, verified_at: hace(86_400_000),
        wa_last_inbound_at: hace(3600_000) },
      { id: 'c2', phone_e164: TEL_B, whatsapp: true, priority: 2, verified_at: hace(86_400_000),
        wa_last_inbound_at: hace(30 * 3600_000) },                 // ventana de 24 h cerrada
      { id: 'c3', phone_e164: '+58' + '4129990000', whatsapp: true, priority: 3, verified_at: null,
        wa_last_inbound_at: hace(60_000) },                        // sin verificar
    ];
    let k = 0;
    gh[KAPSO] = () => new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.P${++k}` }] }));
  });

  it('cierre → texto fijo con «Reabrir el PR», «Enviarme el arreglo» y «Silenciar repo 1 h» al verificado con ventana; una vez',
    async () => {
      expect(await correr()).toBe('ack');
      // Primero GitHub (✗, comentario, cierre); el WhatsApp, después y solo al contacto verificado con la ventana abierta.
      expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`, `POST ${GH}/issues/7/comments`, `PATCH ${GH}/pulls/7`, KAPSO]);
      const [m] = enviados();
      expect(m!.to).toBe(TEL_A.slice(1));
      expect(m!.interactive!.body.text).toBe(TEXTO);
      const botones = m!.interactive!.action.buttons.map((b) => b.reply);
      expect(botones.map((b) => b.title)).toEqual(['Reabrir el PR', 'Enviarme el arreglo', 'Silenciar repo 1 h']);
      expect(botones.map((b) => b.id.split(':').slice(0, 2).join(':'))).toEqual(['rpr:C40000', 'fix:C40000', 'rvs:C40000']);
      // Un insert con las 3 filas: rpr es la de PEDIR (etapa proponer); solo el sha256 de cada nonce.
      const ins = de('approvals', 'insert');
      expect(ins).toHaveLength(1);
      const filasAp = ins[0]!.payload as Fila[];
      expect(filasAp.map((f) => [f.action_kind, (f.params as Fila).etapa ?? null])).toEqual([['reopen_pr', 'proponer'],
        ['send_fix', null], ['mute_repo', null]]);
      for (const f of filasAp) {
        expect(f).toMatchObject({ org_id: ORG, code_review_id: REV, channel: 'whatsapp', recipient: TEL_A.slice(1) });
      }
      expect(JSON.stringify(filasAp)).not.toContain(botones[0]!.id.split(':')[2]);
      // El cupo cuenta las OTRAS revisiones avisadas en la hora (el aviso del cierre es de esta misma revisión).
      const cupo = doble.ops.find((o) => o.table === 'code_reviews' && o.head)!;
      expect(cupo.filters).toEqual(expect.arrayContaining([['org_id', 'eq', ORG], ['alert_state', 'eq', 'sent'],
        ['id', 'neq', REV]]));
      expect(lineas()).not.toContain('4141234567');

      // Otra entrega del mismo paso: el PR ya está anotado como cerrado → ni cierre ni WhatsApp otra vez.
      fetchMock.mockClear();
      expect(await correr()).toBe('ack');
      expect(enviados()).toEqual([]);
    });

  it('repo silenciado (rvs) → el ✗ y el cierre siguen, el WhatsApp no; demo fuera de ventana o cupo lleno → tampoco', async () => {
    const casos: (() => void)[] = [
      () => { config!.muted_until = new Date(Date.now() + 30 * 60_000).toISOString(); },
      () => { org = { is_demo: true }; ventanaDemo = null; },
      () => { avisadas = 3; },
    ];
    for (const preparar of casos) {
      Object.assign(fila, { gate_pr_action: null, gate_pr_at: null });
      config!.muted_until = null;
      org = { is_demo: false };
      avisadas = 0;
      preparar();
      fetchMock.mockClear();
      expect(await correr()).toBe('ack');
      expect(llamadas()).toEqual([`POST ${GH}/statuses/${HEAD}`, `POST ${GH}/issues/7/comments`, `PATCH ${GH}/pulls/7`]);
      expect(fila.gate_pr_action).toBe('closed');
    }
    expect(lineas()).toContain('"motivo":"silenciado"');
    expect(lineas()).toContain('"motivo":"fuera_de_ventana_demo"');
    expect(lineas()).toContain('"motivo":"cap"');
    // La org de demo con la ventana abierta sí avisa (tope 10).
    Object.assign(fila, { gate_pr_action: null, gate_pr_at: null });
    org = { is_demo: true };
    ventanaDemo = { value: new Date(Date.now() + 45 * 60_000).toISOString() };
    avisadas = 5;
    fetchMock.mockClear();
    await correr();
    expect(enviados()).toHaveLength(1);
  });

  it('rama hostil → «la rama vigilada»; sin hallazgos nuevos → sin «Enviarme el arreglo»; approvals falla → texto sin botones',
    async () => {
      Object.assign(fila, { branch: 'pagos.evil.com/login', new_findings: [] });
      await correr();
      const [m] = enviados();
      expect(m!.interactive!.body.text).toBe(TEXTO.replace('hacia main', 'hacia la rama vigilada'));
      expect(m!.interactive!.action.buttons.map((b) => b.reply.title)).toEqual(['Reabrir el PR', 'Silenciar repo 1 h']);

      Object.assign(fila, { branch: 'main', gate_pr_action: null, gate_pr_at: null });
      errorApprovals = { code: '57014' };
      fetchMock.mockClear();
      await correr();
      expect(enviados()).toEqual([{ messaging_product: 'whatsapp', to: TEL_A.slice(1), type: 'text', text: { body: TEXTO } }]);
    });

  it('sin Kapso (el resto de pruebas del paso) o sin contactos con ventana → ni lecturas de contactos ni envío', async () => {
    entorno = envDoble(PROD);
    await correr();
    expect(doble.ops.some((o) => o.table === 'contacts')).toBe(false);
    expect(lineas()).toContain('"motivo":"sin_config"');
    entorno = envDoble({ ...PROD, KAPSO_API_KEY: ['clave', 'kapso'].join('-'), KAPSO_PHONE_NUMBER_ID: '1234567890' });
    Object.assign(fila, { gate_pr_action: null, gate_pr_at: null });
    contactos = contactos.slice(1);
    fetchMock.mockClear();
    await correr();
    expect(enviados()).toEqual([]);
    expect(lineas()).toContain('"motivo":"sin_contactos"');
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
