import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refBajoAtaque } from '@vanguard/core';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const cred = vi.hoisted(() => ({ withSecret: vi.fn(), ctxs: [] as unknown[] }));
vi.mock('../lib/credentials.ts', () => ({ withSecret: cred.withSecret }));

const { deshacerBajoAtaque, ERROR_SIN_PERMISO_CONFIG, executeUnderAttack, hostsProtegidos, leerParamsBajoAtaque,
  MENSAJE_DESHACER_BAJO_ATAQUE, retirarHuerfanaBajoAtaque } = await import('./under-attack.ts');

// executeUnderAttack, deshacerBajoAtaque y la huérfana (modo-bajo-ataque.md §8 y §10) con fetch simulado por método y
// ruta: nunca un PUT, la expresión lleva la caducidad de expires_at y una carrera (23505) no toca Cloudflare.
const TOKEN = ['tok', 'acciones', 'x'.repeat(20)].join('-');
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const INC = '9e0b0000-0000-4000-8000-000000000001';
const APR = 'ab000000-0000-4000-8000-000000000002';
const ACT = 'ac000000-0000-4000-8000-000000000001';
const CONN = 'c0aa0000-0000-4000-8000-000000000002';
const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ZONA = '023e105f4ecef8ad9ca31a8372d0c353';
const RS = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
const REGLA_ID = 'd'.repeat(32);
const HOST = 'demo.officialvanguard.com';
const REF = refBajoAtaque(APR);
const AHORA = Date.parse('2026-10-24T23:12:00.000Z');
const EPOCH = Math.floor((AHORA + 1800_000) / 1000);
const CF = `https://api.cloudflare.com/client/v4/zones/${ZONA}`;
const EP = `${CF}/rulesets/phases/http_config_settings/entrypoint`;

type Fila = Record<string, unknown>;
const params = (o: Fila = {}) => ({ scope: 'host', target: HOST, zone_id: ZONA, zone_name: 'officialvanguard.com', connection_id: CONN,
  incident_id: INC, incident_code: 'A1F3C9', ttl_s: 1800, group: APR, kid: 'v1', requested_by: ANA, ref: REF, ruleset_id: RS,
  plan: 'free', ...o });
const aprobacion = (o: Fila = {}) => ({ id: APR, org_id: ORG, incident_id: INC, action_kind: 'under_attack_on', channel: 'in_app',
  recipient: ANA, params: params(), ...o });

let previa: Fila | null;
let viva: Fila[];
let errorInsert: { code: string } | null;
let doble: ReturnType<typeof dbDoble>;
let fetchMock: ReturnType<typeof vi.fn>;
let logs: { mock: { calls: unknown[][] } };
// Respuestas de Cloudflare por «MÉTODO url»; lo que no esté → 500.
let cf: Record<string, () => Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ruleset = (reglas: Fila[], id = RS) => json({ success: true, result: { id, rules: reglas } });

beforeEach(() => {
  previa = null;
  viva = [];
  errorInsert = null;
  doble = dbDoble({
    tabla: (op: Op): Resp | undefined => {
      if (op.table === 'actions' && op.action === 'select' && op.single) return { data: eqDe(op, 'approval_id') === APR ? previa : null };
      if (op.table === 'actions' && op.action === 'select') return { data: viva };
      if (op.table === 'actions' && op.action === 'insert') return errorInsert ? { error: errorInsert } : { data: { id: ACT } };
      return undefined;
    },
  });
  estado.client = doble.client;
  cred.ctxs = [];
  cred.withSecret.mockReset().mockImplementation(async (_e: unknown, _a: unknown, ctx: unknown, fn: (t: string) => Promise<unknown>) => {
    cred.ctxs.push(ctx);
    return fn(TOKEN);
  });
  cf = {
    [`GET ${EP}`]: () => ruleset([{ id: 'c'.repeat(32), ref: 'del_cliente' }]),
    [`POST ${CF}/rulesets/${RS}/rules`]: () => ruleset([{ id: 'c'.repeat(32), ref: 'del_cliente' }, { id: REGLA_ID, ref: REF }]),
  };
  fetchMock = vi.fn(async (url: string, init: RequestInit) => (cf[`${init.method} ${url}`] ?? (() => json({}, 500)))());
  vi.stubGlobal('fetch', fetchMock);
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ejecutar = (a: Fila = aprobacion()) =>
  executeUnderAttack(envDoble().env, a as Parameters<typeof executeUnderAttack>[1], { rid: 'rid-1', ahora: AHORA });
const de = (tabla: string, action: Op['action']) => doble.ops.filter((o) => o.table === tabla && o.action === action);
const metodos = () => fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit).method} ${String(c[0])}`);
const cuerpoDe = (i: number) => JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body)) as Fila;
const lineas = () => logs.mock.calls.map((c) => String(c[0])).join('\n');
const sinPut = () => expect(fetchMock.mock.calls.every((c) => ['GET', 'POST', 'DELETE'].includes(String((c[1] as RequestInit).method)))).toBe(true);

describe('params y protegidos', () => {
  it('leerParamsBajoAtaque exige scope host, host canónico, conexión uuid, zona de 32 hex y el ref vg_ua_', () => {
    expect(leerParamsBajoAtaque(params())).toMatchObject({ target: HOST, ttl_s: 1800, ref: REF, ruleset_id: RS, plan: 'free' });
    for (const malo of [{ scope: 'zone' }, { target: 'Tienda Demo' }, { connection_id: 'x' }, { zone_id: 'zona' }, { ref: 'vg_ua_x' }]) {
      expect(leerParamsBajoAtaque(params(malo)), JSON.stringify(malo)).toBeNull();
    }
    expect(leerParamsBajoAtaque(params({ ttl_s: 99_999 }))?.ttl_s).toBe(3600);
  });
  it('protegidos: el host de APP_ORIGIN y su www., y officialvanguard.com aunque APP_ORIGIN falte o sea local', () => {
    expect(hostsProtegidos({ APP_ORIGIN: 'https://officialvanguard.com' })).toEqual({
      protegidos: ['officialvanguard.com', 'www.officialvanguard.com'], zonaProducto: 'officialvanguard.com' });
    expect(hostsProtegidos({ APP_ORIGIN: 'http://localhost:5173' }).protegidos).toContain('officialvanguard.com');
    expect(hostsProtegidos({}).zonaProducto).toBe('officialvanguard.com');
  });
});

describe('executeUnderAttack (E21)', () => {
  it('entrypoint 200 → POST de la regla al final y executed con el id de la regla de nuestro ref; caducidad en la expresión', async () => {
    const x = await ejecutar();
    expect(x).toEqual({ tipo: 'ejecutado', action_id: ACT, en: new Date(AHORA).toISOString(), repetido: false,
      resultado: `Modo bajo ataque activo 30 min en ${HOST}`, expires_at: new Date(AHORA + 1800_000).toISOString() });
    expect(metodos()).toEqual([`GET ${EP}`, `POST ${CF}/rulesets/${RS}/rules`]);
    expect(cuerpoDe(1)).toEqual({ ref: REF, description: 'VanGUARD #A1F3C9 · bajo ataque · ab000000 · hasta 2026-10-24T23:42:00Z',
      expression: `(http.host eq "${HOST}" and http.request.timestamp.sec lt ${EPOCH})`, action: 'set_config',
      action_parameters: { security_level: 'under_attack' }, enabled: true });
    sinPut();
    const [ins] = de('actions', 'insert');
    expect(ins!.payload).toMatchObject({ org_id: ORG, incident_id: INC, approval_id: APR, kind: 'under_attack_on', target: HOST,
      status: 'proposed', requested_by: ANA, expires_at: new Date(AHORA + 1800_000).toISOString(),
      previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ref: REF, caduca_en_regla: true } });
    const up = de('actions', 'update').find((o) => (o.payload as Fila).status === 'executed')!;
    expect(up.payload).toMatchObject({ provider_ref: REGLA_ID, previous: { ruleset_id: RS, creo_ruleset: false, ref: REF } });
    expect([eqDe(up, 'id'), eqDe(up, 'org_id')]).toEqual([ACT, ORG]);
    const inc = de('incidents', 'update')[0]!;
    expect([eqDe(inc, 'id'), eqDe(inc, 'org_id'), (inc.payload as Fila).status]).toEqual([INC, ORG, 'mitigated']);
    expect(cred.ctxs[0]).toEqual({ orgId: ORG, connectionId: CONN, provider: 'cloudflare', kind: 'action' });
    expect(lineas()).not.toContain(TOKEN);
  });

  it('sin ruleset en la fase (404) → POST /rulesets con la regla y creo_ruleset:true', async () => {
    cf[`GET ${EP}`] = () => json({ success: false }, 404);
    cf[`POST ${CF}/rulesets`] = () => ruleset([{ id: REGLA_ID, ref: REF }], 'e'.repeat(32));
    expect(await ejecutar()).toMatchObject({ tipo: 'ejecutado', repetido: false });
    expect(metodos()).toEqual([`GET ${EP}`, `POST ${CF}/rulesets`]);
    expect(cuerpoDe(1)).toMatchObject({ name: 'default', kind: 'zone', phase: 'http_config_settings', rules: [{ ref: REF }] });
    const up = de('actions', 'update').find((o) => (o.payload as Fila).status === 'executed')!;
    expect(up.payload).toMatchObject({ provider_ref: REGLA_ID, previous: { ruleset_id: 'e'.repeat(32), creo_ruleset: true } });
  });

  it('Cloudflare 403 → failed y ok:false con el permiso de Config Rules; approvals.result cf_403', async () => {
    cf[`POST ${CF}/rulesets/${RS}/rules`] = () => json({ success: false }, 403);
    expect(await ejecutar()).toEqual({ tipo: 'rechazado', action_id: ACT, status: 403, error: ERROR_SIN_PERMISO_CONFIG });
    expect(de('actions', 'update').map((o) => (o.payload as Fila).status)).toEqual(['failed']);
    expect(de('approvals', 'update').map((o) => o.payload)).toContainEqual({ result: { error: 'cf_403' } });
    cf[`GET ${EP}`] = () => json({ success: false }, 403);
    expect(await ejecutar()).toMatchObject({ tipo: 'rechazado', error: ERROR_SIN_PERMISO_CONFIG });
  });

  it('5xx en el POST pero la regla aparece en el GET de reconciliación → executed (no queda una regla sin fila)', async () => {
    let gets = 0;
    cf[`GET ${EP}`] = () => (++gets === 1 ? ruleset([]) : ruleset([{ id: REGLA_ID, ref: REF }]));
    cf[`POST ${CF}/rulesets/${RS}/rules`] = () => json({}, 502);
    expect(await ejecutar()).toMatchObject({ tipo: 'ejecutado', action_id: ACT });
    expect(metodos()).toEqual([`GET ${EP}`, `POST ${CF}/rulesets/${RS}/rules`, `GET ${EP}`]);
    sinPut();
  });

  it('5xx y la regla no aparece → failed y caido (502); otro 4xx → rechazado con el código de Cloudflare', async () => {
    cf[`POST ${CF}/rulesets/${RS}/rules`] = () => json({}, 503);
    expect(await ejecutar()).toEqual({ tipo: 'caido', action_id: ACT, status: 503 });
    cf[`POST ${CF}/rulesets/${RS}/rules`] = () => json({ success: false, errors: [{ code: 20021 }] }, 400);
    expect(await ejecutar()).toMatchObject({ tipo: 'rechazado', error: 'Cloudflare no aceptó la regla (código 20021)' });
  });

  it('el plan ya usa sus 10 reglas → rechazado sin POST', async () => {
    cf[`GET ${EP}`] = () => ruleset(Array.from({ length: 10 }, (_, i) => ({ id: String(i).padStart(32, 'c'), ref: `r${i}` })));
    expect(await ejecutar()).toMatchObject({ tipo: 'rechazado', error: 'Tu plan ya usa sus 10 reglas de configuración' });
    expect(metodos()).toEqual([`GET ${EP}`]);
  });

  it('23505 (otro modo vivo de ese host, D7) → devuelve la fila viva sin llamar a Cloudflare', async () => {
    errorInsert = { code: '23505' };
    viva = [{ id: 'ac000000-0000-4000-8000-0000000000aa', status: 'executed', created_at: '2026-10-24T23:00:00+00:00',
      expires_at: '2026-10-24T23:30:00+00:00' }];
    expect(await ejecutar()).toMatchObject({ tipo: 'ejecutado', repetido: true, action_id: viva[0]!.id,
      resultado: `El modo bajo ataque ya estaba activo en ${HOST}` });
    viva = [{ id: 'ac000000-0000-4000-8000-0000000000bb', status: 'proposed' }];
    expect(await ejecutar()).toEqual({ tipo: 'en_curso', action_id: viva[0]!.id });
    expect(fetchMock).not.toHaveBeenCalled();
    const sel = de('actions', 'select').find((o) => !o.single)!;
    expect([eqDe(sel, 'org_id'), eqDe(sel, 'kind'), eqDe(sel, 'target')]).toEqual([ORG, 'under_attack_on', HOST]);
  });

  it('la misma aprobación ya ejecutada (idempotencia por approval_id) → sin insert ni Cloudflare', async () => {
    previa = { id: ACT, approval_id: APR, status: 'executed', created_at: '2026-10-24T23:00:00+00:00', expires_at: null };
    expect(await ejecutar()).toMatchObject({ tipo: 'ejecutado', repetido: true });
    expect(de('actions', 'insert')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('params ilegibles o un ref que no es el de esa aprobación → invalido sin tocar nada', async () => {
    expect(await ejecutar(aprobacion({ params: params({ ref: refBajoAtaque(INC) }) }))).toEqual({ tipo: 'invalido' });
    expect(await ejecutar(aprobacion({ action_kind: 'block_ip' }))).toEqual({ tipo: 'invalido' });
    // Una fila de otro id: sin group, su ref solo puede ser el suyo; con group, ni el suyo ni el del group → invalido.
    const OK = 'ab000000-0000-4000-8000-0000000000aa';
    expect(await ejecutar(aprobacion({ id: OK, channel: 'whatsapp', params: params({ group: null }) })))
      .toEqual({ tipo: 'invalido' });
    expect(await ejecutar(aprobacion({ id: OK, channel: 'whatsapp', params: params({ ref: refBajoAtaque(INC) }) })))
      .toEqual({ tipo: 'invalido' });
    expect(doble.ops).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fila ok de WhatsApp del mismo group (id propio) con los params de §4.2 y el ref del group → ejecutado', async () => {
    // El patrón de E20 (filasWa): las filas ok/no copian params y group, cada una con su id. El «Sí, activar» la reutiliza.
    const OK = 'ab000000-0000-4000-8000-0000000000aa';
    const x = await ejecutar(aprobacion({ id: OK, channel: 'whatsapp', recipient: '58' + '4141234567',
      params: params({ etapa: 'ok' }) }));
    expect(x).toMatchObject({ tipo: 'ejecutado', action_id: ACT, repetido: false });
    expect(de('actions', 'insert')[0]!.payload).toMatchObject({ approval_id: OK, requested_by: ANA, previous: { ref: REF } });
    expect(cuerpoDe(1)).toMatchObject({ ref: REF });
    const hermanas = de('approvals', 'update')[0]!;
    expect([eqDe(hermanas, 'org_id'), eqDe(hermanas, 'params->>group')]).toEqual([ORG, APR]);
    // El ref propio de la fila (sin el del group) también vale: cada fila ok puede llevar el suyo.
    cf[`POST ${CF}/rulesets/${RS}/rules`] = () => ruleset([{ id: REGLA_ID, ref: refBajoAtaque(OK) }]);
    expect(await ejecutar(aprobacion({ id: OK, channel: 'whatsapp', params: params({ ref: refBajoAtaque(OK) }) })))
      .toMatchObject({ tipo: 'ejecutado', repetido: false });
  });

  it('el UPDATE a executed falla → borra la regla recién creada antes del 500', async () => {
    doble = dbDoble({ tabla: (op) => {
      if (op.table === 'actions' && op.action === 'insert') return { data: { id: ACT } };
      if (op.table === 'actions' && op.action === 'update' && (op.payload as Fila).status === 'executed') return { error: { code: '57014' } };
      return undefined;
    } });
    estado.client = doble.client;
    cf[`DELETE ${CF}/rulesets/${RS}/rules/${REGLA_ID}`] = () => new Response(null, { status: 200 });
    await expect(ejecutar()).rejects.toMatchObject({ code: 'internal' });
    expect(metodos().at(-1)).toBe(`DELETE ${CF}/rulesets/${RS}/rules/${REGLA_ID}`);
  });
});

describe('deshacerBajoAtaque (E22, E10 y caducidad)', () => {
  const accion = (o: Fila = {}) => ({ id: ACT, org_id: ORG, provider_ref: REGLA_ID,
    previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ref: REF, ruleset_id: RS }, ...o });

  it('200 y 404 → undone en UNA escritura (solo under_attack_on, executed o failed); DELETE por id, nunca el ruleset', async () => {
    const OTRA = 'ac000000-0000-4000-8000-000000000002';
    cf[`DELETE ${CF}/rulesets/${RS}/rules/${REGLA_ID}`] = () => new Response(null, { status: 200 });
    cf[`DELETE ${CF}/rulesets/${RS}/rules/${'f'.repeat(32)}`] = () => new Response(null, { status: 404 });
    const { resultados, subpeticiones } = await deshacerBajoAtaque(envDoble().env,
      [accion(), accion({ id: OTRA, provider_ref: 'f'.repeat(32) })], { rid: 'r', ahora: AHORA });
    expect([...resultados.values()]).toEqual(['deshecho', 'deshecho']);
    expect(subpeticiones).toBe(2 + 2 + 1);
    expect(cred.withSecret).toHaveBeenCalledTimes(1);
    const [up] = de('actions', 'update');
    expect(up!.payload).toEqual({ status: 'undone', undone_at: new Date(AHORA).toISOString() });
    expect(up!.filters).toEqual([['id', 'in', [ACT, OTRA]], ['org_id', 'in', [ORG]], ['kind', 'eq', 'under_attack_on'],
      ['status', 'in', ['executed', 'failed']]]);
    sinPut();
  });

  it('403 → sin_permiso con el texto de Config Rules y la fila no cambia; 5xx → caido', async () => {
    cf[`DELETE ${CF}/rulesets/${RS}/rules/${REGLA_ID}`] = () => new Response(null, { status: 403 });
    let r = await deshacerBajoAtaque(envDoble().env, [accion()], { rid: 'r' });
    expect(r.resultados.get(ACT)).toBe('sin_permiso');
    expect(MENSAJE_DESHACER_BAJO_ATAQUE.sin_permiso).toBe(ERROR_SIN_PERMISO_CONFIG);
    expect(de('actions', 'update')).toHaveLength(0);
    cf[`DELETE ${CF}/rulesets/${RS}/rules/${REGLA_ID}`] = () => new Response(null, { status: 503 });
    r = await deshacerBajoAtaque(envDoble().env, [accion()], { rid: 'r' });
    expect(r.resultados.get(ACT)).toBe('caido');
  });

  it('sin ruleset_id, alcance zone (P1) o fila de bloqueo → invalido sin tocar Cloudflare; sin credencial → sin_credencial', async () => {
    for (const prev of [{ connection_id: CONN, zone_id: ZONA, scope: 'host' }, { connection_id: CONN, zone_id: ZONA, scope: 'zone' },
      { connection_id: CONN, zone_id: ZONA, existed: false }]) {
      const r = await deshacerBajoAtaque(envDoble().env, [accion({ previous: prev })], { rid: 'r' });
      expect(r.resultados.get(ACT)).toBe('invalido');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    cred.withSecret.mockImplementation(async () => { throw new Error('sin credencial'); });
    expect((await deshacerBajoAtaque(envDoble().env, [accion()], { rid: 'r' })).resultados.get(ACT)).toBe('sin_credencial');
  });

  it('retirada fallida de una huérfana (sin provider_ref, con previous.ref) → GET del entrypoint y DELETE por su ref', async () => {
    const huerfana = accion({ provider_ref: null, previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ref: REF,
      huerfana: 'sin_comprobar', deshacer_error: 'sin_permiso' } });
    cf[`GET ${EP}`] = () => ruleset([{ id: 'c'.repeat(32), ref: 'del_cliente' }, { id: REGLA_ID, ref: REF }]);
    cf[`DELETE ${CF}/rulesets/${RS}/rules/${REGLA_ID}`] = () => new Response(null, { status: 200 });
    let r = await deshacerBajoAtaque(envDoble().env, [huerfana], { rid: 'r', ahora: AHORA });
    expect(r.resultados.get(ACT)).toBe('deshecho');
    expect(r.subpeticiones).toBe(2 + 2 + 1);                   // sobre · GET · DELETE · undone
    expect(metodos()).toEqual([`GET ${EP}`, `DELETE ${CF}/rulesets/${RS}/rules/${REGLA_ID}`]);
    expect(de('actions', 'update')[0]!.payload).toEqual({ status: 'undone', undone_at: new Date(AHORA).toISOString() });
    sinPut();

    // Sin la regla de ese ref (o sin ruleset en la fase) ya no está: deshecho sin DELETE.
    fetchMock.mockClear();
    cf[`GET ${EP}`] = () => ruleset([{ id: 'c'.repeat(32), ref: 'del_cliente' }]);
    r = await deshacerBajoAtaque(envDoble().env, [huerfana], { rid: 'r', ahora: AHORA });
    expect([r.resultados.get(ACT), r.subpeticiones, metodos()]).toEqual(['deshecho', 2 + 1 + 1, [`GET ${EP}`]]);
    // 403 en el GET → sin_permiso y la fila no cambia.
    cf[`GET ${EP}`] = () => json({ success: false }, 403);
    const antes = de('actions', 'update').length;
    expect((await deshacerBajoAtaque(envDoble().env, [huerfana], { rid: 'r' })).resultados.get(ACT)).toBe('sin_permiso');
    expect(de('actions', 'update')).toHaveLength(antes);
    // Sin provider_ref ni un ref vg_ua_ → invalido sin tocar Cloudflare.
    fetchMock.mockClear();
    const sinRef = accion({ provider_ref: null, previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ref: 'x' } });
    expect((await deshacerBajoAtaque(envDoble().env, [sinRef], { rid: 'r' })).resultados.get(ACT)).toBe('invalido');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('retirarHuerfanaBajoAtaque (D8)', () => {
  let huerfana: Fila[];
  const fila = (o: Fila = {}) => ({ id: ACT, org_id: ORG, expires_at: new Date(AHORA + 25 * 60_000).toISOString(),
    previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ref: REF, descripcion: 'x' }, ...o });
  beforeEach(() => {
    huerfana = [fila()];
    doble = dbDoble({ tabla: (op) => (op.table === 'actions' && op.action === 'select' ? { data: huerfana } : undefined) });
    estado.client = doble.client;
  });
  const retirar = () => retirarHuerfanaBajoAtaque(envDoble().env, { rid: 'cron', ahora: AHORA });

  it('una proposed de > 2 min con la regla presente → DELETE por su ref y failed con huerfana retirada (6 subpeticiones)', async () => {
    cf[`GET ${EP}`] = () => ruleset([{ id: REGLA_ID, ref: REF }]);
    cf[`DELETE ${CF}/rulesets/${RS}/rules/${REGLA_ID}`] = () => new Response(null, { status: 200 });
    expect(await retirar()).toEqual({ resultado: 'retirada', subpeticiones: 6 });
    const sel = de('actions', 'select')[0]!;
    expect(sel.filters).toEqual([['kind', 'eq', 'under_attack_on'], ['status', 'eq', 'proposed'],
      ['created_at', 'lt', new Date(AHORA - 120_000).toISOString()]]);
    const up = de('actions', 'update')[0]!;
    expect(up.payload).toEqual({ status: 'failed', previous: { ...fila().previous, huerfana: 'retirada' } });
    expect([eqDe(up, 'id'), eqDe(up, 'org_id'), eqDe(up, 'status')]).toEqual([ACT, ORG, 'proposed']);
  });

  it('la regla no está (o la fase no tiene ruleset) → failed con huerfana no_estaba, sin DELETE', async () => {
    expect((await retirar()).resultado).toBe('no_estaba');
    cf[`GET ${EP}`] = () => json({}, 404);
    expect((await retirar()).resultado).toBe('no_estaba');
    expect(metodos().some((m) => m.startsWith('DELETE'))).toBe(false);
  });

  it('403 → sin_comprobar con deshacer_error (E55 la enseña); 5xx antes de expires_at → pendiente sin escribir; vencida → sin_comprobar', async () => {
    cf[`GET ${EP}`] = () => json({}, 403);
    expect((await retirar()).resultado).toBe('sin_comprobar');
    expect((de('actions', 'update')[0]!.payload as { previous: Fila }).previous).toMatchObject({ huerfana: 'sin_comprobar',
      deshacer_error: 'sin_permiso' });
    cf[`GET ${EP}`] = () => json({}, 503);
    const antes = de('actions', 'update').length;
    expect(await retirar()).toEqual({ resultado: 'pendiente', subpeticiones: 4 });
    expect(de('actions', 'update')).toHaveLength(antes);
    huerfana = [fila({ expires_at: new Date(AHORA - 1000).toISOString() })];
    expect((await retirar()).resultado).toBe('sin_comprobar');
  });

  it('sin huérfanas → null con 1 subpetición', async () => {
    huerfana = [];
    expect(await retirar()).toEqual({ resultado: null, subpeticiones: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
