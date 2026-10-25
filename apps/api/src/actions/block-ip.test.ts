import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/errors.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const cred = vi.hoisted(() => ({ withSecret: vi.fn(), ctxs: [] as unknown[] }));
vi.mock('../lib/credentials.ts', () => ({ withSecret: cred.withSecret }));

const { deshacerBloqueos, executeBlock, ERROR_SIN_PERMISO, errorModo, leerParams, MENSAJE_DESHACER, notasBloqueo } = await import('./block-ip.ts');

// Valores falsos armados en tiempo de ejecución: ningún literal con forma de secreto ni IP entera de un cliente.
const TOKEN = ['tok', 'acciones', 'x'.repeat(20)].join('-');
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const INC = '9e0b0000-0000-4000-8000-000000000001';
const APR = 'a9900000-0000-4000-8000-000000000001';
const HERMANA = 'a9900000-0000-4000-8000-000000000002';
const CONN = 'c0aa0000-0000-4000-8000-000000000002';
const ACT = 'ac700000-0000-4000-8000-000000000001';
const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ZONA = '023e105f4ecef8ad9ca31a8372d0c353';
const IP = ['186', '92', '14', '7'].join('.');
const AHORA = Date.parse('2026-10-24T19:01:00.000Z');
const REGLAS = `https://api.cloudflare.com/client/v4/zones/${ZONA}/firewall/access_rules/rules`;

type Fila = Record<string, unknown>;
const params = (o: Fila = {}) => ({ target: IP, target_kind: 'ip', incident_id: INC, group: APR, connection_id: CONN, zone_id: ZONA,
  zone_name: 'officialvanguard.com', mode: 'block', ttl_s: 3600, incident_code: 'A1F3C9', regla: 'CF_UA_TOOL', requested_by: ANA, ...o });
const aprobacion = (o: Fila = {}) => ({ id: APR, org_id: ORG, incident_id: INC, action_kind: 'block_ip', channel: 'in_app',
  recipient: ANA, params: params(), ...o });

let previas: Fila[];
let errorInsert: { code: string } | null;
let errorExecuted: { code: string } | null;
let doble: ReturnType<typeof dbDoble>;
let fetchMock: ReturnType<typeof vi.fn>;
let logs: { mock: { calls: unknown[][] } };

beforeEach(() => {
  previas = [];
  errorInsert = null;
  errorExecuted = null;
  doble = dbDoble({
    tabla: (op: Op): Resp | undefined => {
      if (op.table === 'actions' && op.action === 'select' && op.single) return { data: previas.find((f) => f.approval_id === eqDe(op, 'approval_id')) ?? null };
      if (op.table === 'actions' && op.action === 'select') return { data: previas };
      if (op.table === 'actions' && op.action === 'insert') return errorInsert ? { error: errorInsert } : { data: { id: ACT } };
      if (op.table === 'actions' && op.action === 'update' && (op.payload as Fila).status === 'executed' && errorExecuted) return { error: errorExecuted };
      return undefined;
    },
  });
  estado.client = doble.client;
  cred.ctxs = [];
  cred.withSecret.mockReset().mockImplementation(async (_e: unknown, _a: unknown, ctx: unknown, fn: (t: string) => Promise<unknown>) => {
    cred.ctxs.push(ctx);
    return fn(TOKEN);
  });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { id: 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6' } })));
  vi.stubGlobal('fetch', fetchMock);
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ejecutar = (a: Fila = aprobacion()) =>
  executeBlock(envDoble().env, a as Parameters<typeof executeBlock>[1], { rid: 'rid-1', ahora: AHORA });
const de = (tabla: string, action: Op['action']) => doble.ops.filter((o) => o.table === tabla && o.action === action);
const lineas = () => logs.mock.calls.map((c) => String(c[0])).join('\n');
const llamada = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(String(init.body)) as Fila : null };
};

describe('params y notas (§08.8)', () => {
  it('leerParams exige IP canónica con su target_kind, conexión uuid y zona de 32 hex; mode solo block', () => {
    expect(leerParams(params())).toMatchObject({ target: IP, target_kind: 'ip', connection_id: CONN, ttl_s: 3600 });
    expect(leerParams(params({ target: '2800:3F0::1', target_kind: 'ip6' }))?.target).toBe('2800:3f0::1');
    for (const malo of [{ target: 'hola' }, { target_kind: 'ip6' }, { connection_id: 'x' }, { zone_id: 'zona' },
      { mode: 'managed_challenge' }]) expect(leerParams(params(malo))).toBeNull();
  });

  it('notas: «VanGUARD #<code> · <regla> · hasta <ISO>» sin milisegundos ni datos personales', () => {
    expect(notasBloqueo('A1F3C9', 'CF_UA_TOOL', new Date(AHORA + 3600_000))).toBe('VanGUARD #A1F3C9 · CF_UA_TOOL · hasta 2026-10-24T20:01:00Z');
    expect(notasBloqueo('<b>', 'x y', new Date(AHORA))).toBe('VanGUARD #------ · manual · hasta 2026-10-24T19:01:00Z');
  });
});

describe('executeBlock (S15 15.10)', () => {
  it('proposed → POST de la access rule con el token action → executed con provider_ref, previous y +1 h; incidente mitigated', async () => {
    const r = await ejecutar();
    expect(r).toEqual({ tipo: 'ejecutado', action_id: ACT, en: '2026-10-24T19:01:00.000Z', resultado: 'IP bloqueada 1 h',
      existia: false, repetido: false });

    expect(de('actions', 'insert')[0]!.payload).toEqual({ org_id: ORG, incident_id: INC, approval_id: APR, kind: 'block_ip',
      target: IP, status: 'proposed', requested_by: ANA });
    expect(cred.ctxs).toEqual([{ orgId: ORG, connectionId: CONN, provider: 'cloudflare', kind: 'action' }]);
    const { url, init, body } = llamada();
    expect(url).toBe(REGLAS);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(body).toEqual({ mode: 'block', configuration: { target: 'ip', value: IP },
      notes: 'VanGUARD #A1F3C9 · CF_UA_TOOL · hasta 2026-10-24T20:01:00Z' });

    const [ejecutada] = de('actions', 'update');
    expect(ejecutada!.payload).toEqual({ status: 'executed', provider_ref: 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6',
      previous: { connection_id: CONN, zone_id: ZONA, existed: false }, expires_at: '2026-10-24T20:01:00.000Z' });
    expect([eqDe(ejecutada!, 'id'), eqDe(ejecutada!, 'org_id')]).toEqual([ACT, ORG]);
    const [inc] = de('incidents', 'update');
    expect(inc!.payload).toEqual({ status: 'mitigated', mitigated_at: '2026-10-24T19:01:00.000Z' });
    expect(inc!.filters).toContainEqual(['status', 'in', ['open', 'ack']]);
    // Las hermanas del group quedan usadas ANTES de llamar a Cloudflare.
    const [hermanas] = de('approvals', 'update');
    expect(hermanas!.payload).toEqual({ used_at: '2026-10-24T19:01:00.000Z' });
    expect([eqDe(hermanas!, 'org_id'), eqDe(hermanas!, 'params->>group')]).toEqual([ORG, APR]);
    expect(doble.ops.indexOf(hermanas!)).toBeLessThan(doble.ops.indexOf(ejecutada!));
    expect(lineas()).not.toContain(IP);
    expect(lineas()).not.toContain(TOKEN);
  });

  it('IPv6 → target ip6', async () => {
    await ejecutar(aprobacion({ params: params({ target: '2800:3f0::1', target_kind: 'ip6' }) }));
    expect(llamada().body).toMatchObject({ configuration: { target: 'ip6', value: '2800:3f0::1' } });
  });

  it('idempotente por approval_id: una segunda ejecución devuelve la misma acción sin Cloudflare ni insert', async () => {
    previas = [{ id: ACT, approval_id: APR, incident_id: INC, status: 'executed', previous: { existed: false },
      expires_at: '2026-10-24T20:01:00+00:00', created_at: '2026-10-24T19:00:00+00:00' }];
    expect(await ejecutar()).toMatchObject({ tipo: 'ejecutado', action_id: ACT, repetido: true, resultado: 'IP bloqueada 1 h' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(de('actions', 'insert')).toHaveLength(0);
  });

  it('aprobación hermana (WhatsApp ok tras el código de la app): executed vigente del mismo incidente e IP → esa, sin Cloudflare', async () => {
    previas = [{ id: ACT, approval_id: APR, incident_id: INC, status: 'executed', previous: { existed: false },
      expires_at: '2026-10-24T20:01:00+00:00', created_at: '2026-10-24T19:00:00+00:00' }];
    const ok = aprobacion({ id: HERMANA, channel: 'whatsapp', recipient: '584141234567', params: params({ etapa: 'confirmar' }) });
    expect(await ejecutar(ok)).toMatchObject({ tipo: 'ejecutado', action_id: ACT, repetido: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(eqDe(de('approvals', 'update')[0]!, 'params->>group')).toBe(APR);
    // Vencida o de otro incidente: no cuenta, se bloquea de nuevo.
    previas = [{ ...previas[0], approval_id: APR, expires_at: '2026-10-24T18:00:00+00:00' }];
    expect(await ejecutar(ok)).toMatchObject({ tipo: 'ejecutado', repetido: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('carrera por el unique de approval_id (23505) → devuelve la fila ganadora', async () => {
    errorInsert = { code: '23505' };
    let leidas = 0;
    const base = doble.client.from;
    doble.client.from = (t: string) => {
      if (t === 'actions') leidas++;
      if (t === 'actions' && leidas === 3) previas = [{ id: 'otra', approval_id: APR, status: 'proposed' }];
      return base(t);
    };
    expect(await ejecutar()).toEqual({ tipo: 'en_curso', action_id: 'otra' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Cloudflare 403 → rechazado con el permiso que falta, actions failed y approvals.result cf_403', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 }));
    expect(await ejecutar()).toEqual({ tipo: 'rechazado', action_id: ACT, status: 403, error: ERROR_SIN_PERMISO });
    expect(de('actions', 'update')[0]!.payload).toEqual({ status: 'failed' });
    const resultado = de('approvals', 'update').find((o) => eqDe(o, 'id') === APR);
    expect(resultado!.payload).toEqual({ result: { error: 'cf_403' } });
    expect(de('incidents', 'update')).toHaveLength(0);
    expect(lineas()).not.toContain('Authentication error');
  });

  it('5xx, 429 o error de red → caido (502 en E21), failed y cf_<status>', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }));
    expect(await ejecutar()).toEqual({ tipo: 'caido', action_id: ACT, status: 503 });
    expect(de('approvals', 'update').find((o) => eqDe(o, 'id') === APR)!.payload).toEqual({ result: { error: 'cf_503' } });
    fetchMock.mockImplementation(async () => { throw new TypeError('fetch failed'); });
    expect(await ejecutar()).toMatchObject({ tipo: 'caido', status: null });
  });

  const REF = 'aaaabbbbccccddddeeeeffff00001111';
  const dup = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10009, message: 'firewallaccessrules.api.duplicate_of_existing' }] }), { status: 400 });
  const lista = (notes: string, mode = 'block') => new Response(JSON.stringify({ success: true, result: [
    { id: REF, mode, configuration: { target: 'ip', value: IP }, notes }] }));
  const vacia = () => new Response(JSON.stringify({ success: true, result: [] }));
  const ejecutadas = () => de('actions', 'update').filter((o) => (o.payload as Fila).status === 'executed');

  it('duplicate_of_existing: regla block con marca VanGUARD → se adopta; regla block del cliente → existed:true y «Ya estaba bloqueada»', async () => {
    fetchMock.mockImplementationOnce(async () => dup()).mockImplementationOnce(async () => lista('VanGUARD #B2C3D4 · CF_IP_FLOOD · hasta …'));
    expect(await ejecutar()).toMatchObject({ tipo: 'ejecutado', existia: false, resultado: 'IP bloqueada 1 h' });
    expect(llamada(1).url).toBe(`${REGLAS}?configuration.target=ip&configuration.value=${IP}&per_page=20`);
    expect(ejecutadas()[0]!.payload).toMatchObject({ provider_ref: REF, previous: { existed: false } });

    fetchMock.mockImplementationOnce(async () => dup()).mockImplementationOnce(async () => lista('regla manual'));
    expect(await ejecutar()).toMatchObject({ tipo: 'ejecutado', existia: true, resultado: 'Ya estaba bloqueada por una regla tuya' });
    expect(ejecutadas()[1]!.payload).toMatchObject({ previous: { connection_id: CONN, zone_id: ZONA, existed: true } });
  });

  it('regla adoptada: la otra fila executed con ese provider_ref queda undone ANTES de que esta pase a executed (un solo dueño)', async () => {
    fetchMock.mockImplementationOnce(async () => dup()).mockImplementationOnce(async () => lista('VanGUARD #B2C3D4 · CF_IP_FLOOD · hasta …'));
    await ejecutar();
    const traspaso = de('actions', 'update').find((o) => (o.payload as Fila).status === 'undone')!;
    expect(traspaso.payload).toEqual({ status: 'undone', undone_at: '2026-10-24T19:01:00.000Z' });
    expect(traspaso.filters).toEqual([['org_id', 'eq', ORG], ['provider_ref', 'eq', REF], ['status', 'eq', 'executed']]);
    expect(doble.ops.indexOf(traspaso)).toBeLessThan(doble.ops.indexOf(ejecutadas()[0]!));
    // Regla del cliente o creada ahora: no hay traspaso.
    doble.ops.length = 0;
    fetchMock.mockImplementationOnce(async () => dup()).mockImplementationOnce(async () => lista('regla manual'));
    await ejecutar();
    await ejecutar();
    expect(de('actions', 'update').some((o) => (o.payload as Fila).status === 'undone')).toBe(false);
  });

  it('la IP tiene una regla del cliente en whitelist o challenge → rechazado, failed, cf_modo y el incidente NO pasa a mitigated', async () => {
    for (const mode of ['whitelist', 'managed_challenge']) {
      doble.ops.length = 0;
      fetchMock.mockImplementationOnce(async () => dup()).mockImplementationOnce(async () => lista('oficina', mode));
      expect(await ejecutar()).toEqual({ tipo: 'rechazado', action_id: ACT, status: null, error: errorModo(mode) });
      expect(de('actions', 'update').map((o) => o.payload)).toEqual([{ status: 'failed' }]);
      expect(de('approvals', 'update').find((o) => eqDe(o, 'id') === APR)!.payload).toEqual({ result: { error: 'cf_modo' } });
      expect(de('incidents', 'update')).toHaveLength(0);
    }
    // Una regla «VanGUARD…» en otro modo tampoco se adopta.
    fetchMock.mockImplementationOnce(async () => dup()).mockImplementationOnce(async () => lista('VanGUARD #B2C3D4', 'challenge'));
    expect(await ejecutar()).toMatchObject({ tipo: 'rechazado', error: errorModo('challenge') });
    // Duplicado que la lista no trae → rechazado sin dar la IP por bloqueada.
    fetchMock.mockImplementationOnce(async () => dup()).mockImplementationOnce(async () => vacia());
    expect(await ejecutar()).toMatchObject({ tipo: 'rechazado', error: expect.stringContaining('no pudimos leerla') });
  });

  it('POST sin respuesta (plazo, red o 5xx) → reconcilia con la lista: si la regla block ya está, executed con su provider_ref', async () => {
    fetchMock.mockImplementationOnce(async () => { throw new DOMException('plazo', 'TimeoutError'); })
      .mockImplementationOnce(async () => lista(notasBloqueo('A1F3C9', 'CF_UA_TOOL', new Date(AHORA + 3600_000))));
    expect(await ejecutar()).toMatchObject({ tipo: 'ejecutado', existia: false, repetido: false });
    expect(llamada(1).init.method).toBe('GET');
    expect(ejecutadas()[0]!.payload).toMatchObject({ provider_ref: REF, previous: { existed: false } });

    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 503 })).mockImplementationOnce(async () => vacia());
    expect(await ejecutar()).toEqual({ tipo: 'caido', action_id: ACT, status: 503 });
    // La lista también cae: sigue caído (502), nunca un «ya estaba».
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 502 }))
      .mockImplementationOnce(async () => new Response('{}', { status: 502 }));
    expect(await ejecutar()).toMatchObject({ tipo: 'caido', status: 502 });
  });

  it('aprobación hermana canjeada a la vez: proposed reciente del mismo incidente → en_curso sin Cloudflare ni insert; vieja no cuenta', async () => {
    previas = [{ id: 'otra', approval_id: HERMANA, incident_id: INC, status: 'proposed', created_at: '2026-10-24T19:00:30+00:00' }];
    expect(await ejecutar()).toEqual({ tipo: 'en_curso', action_id: 'otra' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(de('actions', 'insert')).toHaveLength(0);
    previas = [{ ...previas[0], created_at: '2026-10-24T18:50:00+00:00' }];
    expect(await ejecutar()).toMatchObject({ tipo: 'ejecutado', repetido: false });
  });

  it('si el UPDATE a executed falla tras crear la regla → se borra la regla (no queda huérfana) y ApiError internal', async () => {
    errorExecuted = { code: '57014' };
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, result: { id: REF } })))
      .mockImplementationOnce(async () => new Response('{}', { status: 200 }));
    await expect(ejecutar()).rejects.toMatchObject({ code: 'internal' });
    expect([llamada(1).url, llamada(1).init.method]).toEqual([`${REGLAS}/${REF}`, 'DELETE']);
    expect(lineas()).toContain('"bloqueo.huerfana"');
    expect(lineas()).not.toContain(IP);
  });

  it('params ilegibles o acción que no es block_ip → invalido sin tocar base ni Cloudflare', async () => {
    expect(await ejecutar(aprobacion({ params: { target: IP } }))).toEqual({ tipo: 'invalido' });
    expect(await ejecutar(aprobacion({ action_kind: 'ack' }))).toEqual({ tipo: 'invalido' });
    expect(doble.ops).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin credencial (conexión borrada) → rechazado sin 502', async () => {
    cred.withSecret.mockImplementation(async () => { throw new ApiError('not_found', 'Esta conexión ya no tiene credencial.'); });
    expect(await ejecutar()).toMatchObject({ tipo: 'rechazado', status: null });
    expect(de('approvals', 'update').find((o) => eqDe(o, 'id') === APR)!.payload).toEqual({ result: { error: 'cf_credencial' } });
  });
});

describe('deshacerBloqueos (E22, E10 y caducidad)', () => {
  const accion = (id: string, o: Fila = {}) => ({ id, org_id: ORG, provider_ref: 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6',
    previous: { connection_id: CONN, zone_id: ZONA, existed: false }, ...o });

  it('DELETE con el token de previous.connection_id (un sobre por conexión), 404 = ya no estaba; undone por id y por regla', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 200 }))
      .mockImplementationOnce(async () => new Response('{}', { status: 404 }));
    const { resultados, subpeticiones } = await deshacerBloqueos(envDoble().env, [accion('a1'), accion('a2', { provider_ref: 'b'.repeat(32) }),
      accion('a3', { provider_ref: null, previous: { connection_id: CONN, zone_id: ZONA, existed: true } })], { rid: 'r', ahora: AHORA });
    expect([...resultados]).toEqual([['a3', 'deshecho'], ['a1', 'deshecho'], ['a2', 'deshecho']]);
    expect(subpeticiones).toBe(2 + 2 + 2);                               // sobre · 2 DELETE · undone por id y por regla
    expect(cred.withSecret).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);                         // existed:true no toca Cloudflare
    expect(llamada().url).toBe(`${REGLAS}/f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6`);
    expect(llamada().init.method).toBe('DELETE');
    const [u, porRegla] = de('actions', 'update');
    expect(u!.payload).toEqual({ status: 'undone', undone_at: '2026-10-24T19:01:00.000Z' });
    // executed o failed: E22 reintenta las que la caducidad dejó failed con su regla.
    expect(u!.filters).toEqual([['id', 'in', ['a1', 'a2', 'a3']], ['org_id', 'in', [ORG]], ['status', 'in', ['executed', 'failed']]]);
    // Otra executed que apuntara a una regla ya borrada (carrera entre hermanas) tampoco bloquea nada: undone.
    expect(porRegla!.payload).toEqual({ status: 'undone', undone_at: '2026-10-24T19:01:00.000Z' });
    expect(porRegla!.filters).toEqual([['provider_ref', 'in', ['f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6', 'b'.repeat(32)]],
      ['org_id', 'in', [ORG]], ['status', 'eq', 'executed']]);
  });

  it('403 → sin_permiso, 401 → token_invalido, 400/409 → rechazado, 5xx/429/408/red → caido, previous ilegible → invalido; ninguna undone', async () => {
    for (const s of [403, 401, 400, 409, 502, 429, 408]) fetchMock.mockImplementationOnce(async () => new Response('{}', { status: s }));
    fetchMock.mockImplementationOnce(async () => { throw new TypeError('fetch failed'); });
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
    const { resultados } = await deshacerBloqueos(envDoble().env, [...ids.map((id) => accion(id)),
      accion('a9', { previous: { zone_id: ZONA } })], { rid: 'r' });
    expect(Object.fromEntries(resultados)).toEqual({ a1: 'sin_permiso', a2: 'token_invalido', a3: 'rechazado', a4: 'rechazado',
      a5: 'caido', a6: 'caido', a7: 'caido', a8: 'caido', a9: 'invalido' });
    expect(de('actions', 'update')).toHaveLength(0);
    expect(MENSAJE_DESHACER.rechazado).toContain('quítala a mano');
  });

  it('una fila de bajo ataque (previous.scope) → invalido sin tocar Cloudflare: un DELETE de access rule daría 404 y la «desharía»', async () => {
    const modo = accion('u1', { provider_ref: 'd'.repeat(32),
      previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ruleset_id: 'b'.repeat(32) } });
    const { resultados, subpeticiones } = await deshacerBloqueos(envDoble().env, [modo], { rid: 'r' });
    expect(resultados.get('u1')).toBe('invalido');
    expect(subpeticiones).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cred.withSecret).not.toHaveBeenCalled();
    expect(de('actions', 'update')).toHaveLength(0);
  });

  it('sin credencial o sobre ilegible → sin_credencial (permanente); material de claves sin leer → caido (se reintenta)', async () => {
    cred.withSecret.mockImplementation(async () => { throw new ApiError('not_found', 'x'); });
    expect((await deshacerBloqueos(envDoble().env, [accion('a1')], { rid: 'r' })).resultados.get('a1')).toBe('sin_credencial');
    cred.withSecret.mockImplementation(async () => { throw new DOMException('x', 'OperationError'); });
    expect((await deshacerBloqueos(envDoble().env, [accion('a1')], { rid: 'r' })).resultados.get('a1')).toBe('sin_credencial');
    cred.withSecret.mockImplementation(async () => { throw new Error('CRYPTO_MATERIAL_UNAVAILABLE'); });
    expect((await deshacerBloqueos(envDoble().env, [accion('a1')], { rid: 'r' })).resultados.get('a1')).toBe('caido');
  });
});
