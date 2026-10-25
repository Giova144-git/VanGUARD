import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, fixtures, UnderAttackOffer, UnderAttackProposal } from '@vanguard/contracts';
import { otpHashParam, pasosRetirarBajoAtaque, refBajoAtaque } from '@vanguard/core';
import type { Keys } from '@vanguard/core/crypto';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const claves = vi.hoisted(() => ({ keys: null as unknown }));
vi.mock('../lib/keyring.ts', () => ({ getKeys: async () => claves.keys, activeKid: async () => 'v1' }));
const cred = vi.hoisted(() => ({ withSecret: vi.fn() }));
vi.mock('../lib/credentials.ts', () => ({ withSecret: cred.withSecret, createConnectionWithSecret: vi.fn() }));

const { app } = await import('../app.ts');

// E55 (oferta) y E56 (propuesta con dry_run) de modo-bajo-ataque.md §5 y §10. Sin red: doble de la base y fetch simulado.
// Ningún literal con forma de secreto, teléfono ni IP entera de un cliente: se arman en tiempo de ejecución.
const TOKEN = ['tok', 'acciones', 'x'.repeat(20)].join('-');
const CLAVE = ['clave', 'kapso', 'de', 'prueba'].join('-');
const ANA = '7b1e0000-0000-4000-8000-000000000001';     // owner
const VERA = '7b1e0000-0000-4000-8000-000000000002';    // viewer
const ANON = '7b1e0000-0000-4000-8000-000000000003';    // «Ver demo»
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const INC = '9e0b0000-0000-4000-8000-000000000001';
const OTRO = '9e0b0000-0000-4000-8000-0000000000ff';
const CONN = 'c0aa0000-0000-4000-8000-000000000002';
const ACT = 'ac000000-0000-4000-8000-000000000001';
const ZONA = '023e105f4ecef8ad9ca31a8372d0c353';
const ZN = 'officialvanguard.com';
const HOST = 'demo.officialvanguard.com';
const RS = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
const TEL = '+58' + '4141234567';
const IP = ['186', '92', '14', '7'].join('.');
const PROD = { VG_ENV: 'production' as const, APP_ORIGIN: 'https://officialvanguard.com', KAPSO_API_KEY: CLAVE,
  KAPSO_PHONE_NUMBER_ID: '1234567890' };
const CF = `https://api.cloudflare.com/client/v4/zones/${ZONA}`;
const EP = `${CF}/rulesets/phases/http_config_settings/entrypoint`;
const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

type Fila = Record<string, unknown>;
let incidente: Fila;
let conexiones: Fila[];
let filas: Fila[];
let ips: number;
let contacto: Fila | null;
let org: Fila;
let doble: ReturnType<typeof dbDoble>;
let fetchMock: ReturnType<typeof vi.fn>;
let logs: { mock: { calls: unknown[][] } };
let cf: Record<string, () => Response>;
const ROL: Record<string, string> = { [ANA]: 'owner', [VERA]: 'viewer', [ANON]: 'viewer' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeAll(async () => {
  const fpk = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  claves.keys = { kid: 'v1', kek: fpk, fpk } as unknown as Keys;
});

// El doble común no trae .contains (el conteo de CF_IP_FLOOD): se registra como un filtro «in» sobre «rule_ids@>».
function conContains(d: ReturnType<typeof dbDoble>) {
  const from = d.client.from;
  d.client.from = ((t: string) => {
    const b = from(t) as ReturnType<typeof from> & { contains?: (c: string, v: unknown) => unknown };
    b.contains = (c: string, v: unknown) => b.in(`${c}@>`, v);
    return b;
  }) as typeof from;
  return d;
}

beforeEach(() => {
  incidente = { id: INC, code: 'A1F3C9', rule_ids: ['CF_IP_FLOOD'], severity: 'critical', resource: `ip:${IP}`, status: 'open',
    details: { ip: IP, host: HOST } };
  conexiones = [{ id: CONN, meta: { zone_id: ZONA, zone_name: ZN, plan: 'free' }, capabilities: { firewall_read: true, config_rules_edit: true } }];
  filas = [];
  ips = 2;
  contacto = null;
  org = { is_demo: true };
  doble = conContains(dbDoble({
    tabla: (op: Op): Resp | undefined => {
      const deOrg = eqDe(op, 'org_id') === ORG;
      if (op.table === 'org_members') return { data: eqDe(op, 'org_id') === ORG ? { role: ROL[String(eqDe(op, 'user_id'))] } : null };
      if (op.table === 'incidents' && op.head) return { count: deOrg ? ips : 0 };
      if (op.table === 'incidents' && op.action === 'select') return { data: eqDe(op, 'id') === INC && deOrg ? incidente : null };
      if (op.table === 'connections') return { data: deOrg ? conexiones : [] };
      if (op.table === 'actions' && op.action === 'select') return { data: deOrg ? filas : [] };
      if (op.table === 'contacts') return { data: contacto };
      if (op.table === 'orgs') return { data: org };
      return undefined;
    },
    claims: (tok: string) => ({ ana: { sub: ANA, email: 'ana@acme.dev', is_anonymous: false },
      vera: { sub: VERA, email: 'vera@acme.dev', is_anonymous: false }, anon: { sub: ANON, email: null, is_anonymous: true } } as
      Record<string, Fila>)[tok] ?? null,
  }));
  estado.client = doble.client;
  cred.withSecret.mockReset().mockImplementation(async (_e: unknown, _a: unknown, _c: unknown, fn: (t: string) => Promise<unknown>) => fn(TOKEN));
  cf = {
    [`GET ${EP}`]: () => json({ success: true, result: { id: RS, rules: [{ id: 'c'.repeat(32), ref: 'T02-04' }] } }),
    [`POST ${CF}/rulesets/${RS}/rules?dry_run=true`]: () => json({ success: true, result: null }),
    [`POST ${CF}/rulesets?dry_run=true`]: () => json({ success: true, result: null }),
  };
  fetchMock = vi.fn(async (url: string, init: RequestInit) => (String(url).startsWith('https://api.kapso.ai/')
    ? json({ messages: [{ id: 'wamid.HBgMprueba' }] })
    : (cf[`${init.method ?? 'GET'} ${url}`] ?? (() => json({}, 500)))()));
  vi.stubGlobal('fetch', fetchMock);
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const oferta = (o: { quien?: string; id?: string } = {}) => app.request(`https://officialvanguard.com/api/orgs/${ORG}/incidents/${o.id ?? INC}/under-attack`,
  { headers: { authorization: `Bearer ${o.quien ?? 'vera'}` } }, envDoble(PROD).env);
const proponer = (body: Fila = {}, o: { quien?: string; host?: string; id?: string } = {}) => app.request(
  `https://${o.host ?? 'officialvanguard.com'}/api/orgs/${ORG}/incidents/${o.id ?? INC}/under-attack/propose`,
  { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${o.quien ?? 'ana'}`, 'content-type': 'application/json' } },
  envDoble(PROD).env);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;
const leerOferta = async (r: Response) => { expect(r.status).toBe(200); return UnderAttackOffer.parse(await r.json()); };
const de = (tabla: string, action: Op['action']) => doble.ops.filter((x) => x.table === tabla && x.action === action);
const aCloudflare = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('https://api.cloudflare.com/'))
  .map((c) => ({ url: String(c[0]), method: (c[1] as RequestInit).method ?? 'GET', body: (c[1] as RequestInit).body }));
const aKapso = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('https://api.kapso.ai/'))
  .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { type: string; text?: { body: string } });
const lineas = () => logs.mock.calls.map((c) => String(c[0])).join('\n');
const motivoE56 = async (r: Response) => { const e = await error(r); return [r.status, e.details?.reason]; };

describe('E55 · GET incidents/:id/under-attack (oferta, solo base)', () => {
  it('viewer y anónimo de demo → 200: dos IPs inundan el host y el token tiene el permiso → ofrece; 0 llamadas a Cloudflare', async () => {
    for (const quien of ['vera', 'anon', 'ana']) {
      expect(await leerOferta(await oferta({ quien }))).toEqual({ ...fixtures.underAttackOffer, connection_id: CONN });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const cuenta = doble.ops.find((x) => x.table === 'incidents' && x.head)!;
    expect(cuenta.filters).toEqual([['org_id', 'eq', ORG], ['status', 'in', ['open', 'ack', 'mitigated']],
      ['rule_ids@>', 'in', ['CF_IP_FLOOD']], ['details->>host', 'eq', HOST]]);
    const acc = de('actions', 'select')[0]!;
    expect([eqDe(acc, 'org_id'), eqDe(acc, 'kind'), eqDe(acc, 'target')]).toEqual([ORG, 'under_attack_on', HOST]);
  });

  it('incidente de otra org o inexistente → 404 sin leer nada más', async () => {
    const r = await oferta({ id: OTRO });
    expect([r.status, (await error(r)).code]).toEqual([404, 'not_found']);
    expect(de('actions', 'select')).toHaveLength(0);
  });

  it('un solo CF_IP_FLOOD no resuelto para ese host → una_ip, sin botón (como el fixture)', async () => {
    ips = 1;
    expect(await leerOferta(await oferta())).toEqual({ ...fixtures.underAttackOfferUnaIp, connection_id: CONN });
  });

  it('una proposed de hace 3 min en ese host → en_curso', async () => {
    filas = [{ id: ACT, status: 'proposed', target: HOST, created_at: hace(3), previous: {} }];
    expect(await leerOferta(await oferta())).toMatchObject({ ofrece: true, motivo: 'en_curso', scopes: [], activo: null });
  });

  it('una failed con deshacer_error de hace 1 h → activo.retirada_fallida con los pasos para borrarla', async () => {
    const expira = hace(30);
    const descripcion = 'VanGUARD #A1F3C9 · bajo ataque · ab000000 · hasta 2026-10-24T23:42:00Z';
    filas = [{ id: ACT, status: 'failed', target: HOST, created_at: hace(60), expires_at: expira,
      previous: { scope: 'host', descripcion, zone_name: ZN, caduca_en_regla: true, deshacer_error: 'sin_permiso' } }];
    const o = await leerOferta(await oferta());
    expect(o.activo).toEqual({ action_id: ACT, scope: 'host', target: HOST, created_at: filas[0]!.created_at, expires_at: expira,
      retirada_fallida: true });
    expect(o.copiar).toBe(pasosRetirarBajoAtaque(descripcion, ZN, new Date(expira)));
    // De hace más de 24 h ya no se enseña.
    filas[0]!.created_at = hace(25 * 60);
    expect((await leerOferta(await oferta())).activo).toBeNull();
  });

  it('una executed (aunque ya haya vencido) → activo sin retirada_fallida, también con el incidente resuelto', async () => {
    incidente.status = 'resolved';
    ips = 1;
    filas = [{ id: ACT, status: 'executed', target: HOST, created_at: hace(40), expires_at: hace(10), previous: { scope: 'host' } }];
    const o = await leerOferta(await oferta());
    expect(o).toMatchObject({ ofrece: false, motivo: 'cerrado', activo: { action_id: ACT, retirada_fallida: false } });
  });

  it('permiso: 403 de la sonda → sin_permiso con los pasos manuales del fixture; sin sondear → sin_probar y se deja proponer', async () => {
    conexiones[0]!.capabilities = { firewall_read: true, config_rules_edit: false };
    expect(await leerOferta(await oferta())).toEqual({ ...fixtures.underAttackOfferSinPermiso, connection_id: CONN });
    conexiones[0]!.capabilities = { firewall_read: true };
    expect(await leerOferta(await oferta())).toMatchObject({ motivo: null, permiso: 'sin_probar', scopes: ['host'] });
  });

  it('sin Modo blindaje → sin_conexion; host de VanGUARD → host_protegido; nombre de ingesta que no es host → sin_host sin más lecturas', async () => {
    conexiones = [];
    expect(await leerOferta(await oferta())).toMatchObject({ motivo: 'sin_conexion', permiso: null, connection_id: null,
      copiar: expect.stringContaining('Hostname · equals · demo.officialvanguard.com') });
    conexiones = [{ id: CONN, meta: { zone_id: ZONA, zone_name: ZN }, capabilities: {} }];
    incidente.details = { ip: IP, host: 'www.officialvanguard.com' };
    expect(await leerOferta(await oferta())).toMatchObject({ motivo: 'host_protegido', ofrece: true });
    incidente.details = { ip: IP, host: 'Tienda Demo' };
    doble.ops.length = 0;
    expect(await leerOferta(await oferta())).toMatchObject({ motivo: 'sin_host', hostname: null, ips: 0 });
    expect(doble.ops.some((x) => x.table === 'actions' || x.head)).toBe(false);
  });

  it('un incidente que no es de inundación → no_aplica', async () => {
    incidente.rule_ids = ['CF_UA_TOOL', 'CF_PATH_SCAN', 'CF_ADMIN_EXPOSED'];
    expect(await leerOferta(await oferta())).toMatchObject({ ofrece: false, motivo: 'no_aplica', scopes: [] });
  });
});

describe('E56 · POST incidents/:id/under-attack/propose', () => {
  it('sin admin → 403; fuera de officialvanguard.com → 403; sin leer el incidente ni llamar a Cloudflare', async () => {
    for (const r of [await proponer({}, { quien: 'vera' }), await proponer({}, { quien: 'anon' }),
      await proponer({}, { host: 'vanguard.giovannizm14.workers.dev' }), await proponer({}, { host: 'www.officialvanguard.com' })]) {
      expect([r.status, (await error(r)).code]).toEqual([403, 'forbidden']);
    }
    expect(doble.ops.some((x) => x.table === 'incidents')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('org de demo sin WhatsApp → validado con dry_run, código en la respuesta y HMAC guardado; nunca publica', async () => {
    const r = await proponer();
    expect(r.status).toBe(200);
    const p = UnderAttackProposal.parse(await r.json());
    const fx = fixtures.underAttackProposal;
    expect(p).toMatchObject({ efecto: fx.efecto, avisos: fx.avisos, delivery: 'in_app', scope: 'host', target: HOST, zone_name: ZN,
      ttl_s: 1800, validado: true });
    expect(p.code).toMatch(/^\d{6}$/);
    expect(Date.parse(p.expires_at) - Date.now()).toBeGreaterThan(9 * 60_000);
    const [ins] = de('approvals', 'insert');
    const fila = ins!.payload as Fila;
    expect(fila).toMatchObject({ id: p.approval_id, org_id: ORG, incident_id: INC, action_kind: 'under_attack_on', channel: 'in_app',
      recipient: ANA, expires_at: p.expires_at, params: { scope: 'host', target: HOST, zone_id: ZONA, zone_name: ZN, connection_id: CONN,
        incident_id: INC, incident_code: 'A1F3C9', ttl_s: 1800, group: p.approval_id, kid: 'v1', requested_by: ANA,
        ref: refBajoAtaque(p.approval_id), ruleset_id: RS, plan: 'free' } });
    expect(fila.nonce_hash).toBe(await otpHashParam(claves.keys as Keys, p.approval_id, p.code!));
    // Cloudflare: GET del entrypoint y la MISMA regla de E21 con dry_run=true; ninguna otra mutación.
    const llamadas = aCloudflare();
    expect(llamadas.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${EP}`, `POST ${CF}/rulesets/${RS}/rules?dry_run=true`]);
    expect(llamadas.filter((c) => c.method !== 'GET').every((c) => new URL(c.url).searchParams.get('dry_run') === 'true')).toBe(true);
    const regla = JSON.parse(String(llamadas[1]!.body)) as Fila;
    expect(regla).toMatchObject({ ref: refBajoAtaque(p.approval_id), action: 'set_config', action_parameters: { security_level: 'under_attack' } });
    expect(String(regla.expression)).toMatch(/^\(http\.host eq "demo\.officialvanguard\.com" and http\.request\.timestamp\.sec lt \d{10}\)$/);
    expect(lineas()).not.toContain(p.code!);
    expect(lineas()).not.toContain(TOKEN);
  });

  it('sin ruleset en la fase (404) → dry_run de POST /rulesets; todo fetch no GET lleva dry_run=true', async () => {
    cf[`GET ${EP}`] = () => json({}, 404);
    const p = UnderAttackProposal.parse(await (await proponer()).json());
    expect(p.validado).toBe(true);
    expect(aCloudflare().map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${EP}`, `POST ${CF}/rulesets?dry_run=true`]);
    expect((de('approvals', 'insert')[0]!.payload as { params: Fila }).params.ruleset_id).toBeNull();
  });

  it('con contacto verificado y ventana abierta → código por WhatsApp de texto (delivery whatsapp, code null)', async () => {
    contacto = { phone_e164: TEL, verified_at: hace(600), wa_last_inbound_at: hace(60) };
    org = { is_demo: false };
    const p = UnderAttackProposal.parse(await (await proponer()).json());
    expect([p.delivery, p.code]).toEqual(['whatsapp', null]);
    const [m] = aKapso();
    expect(m!.type).toBe('text');
    expect(m!.text!.body).toMatch(/^Código \d{6} para activar el modo bajo ataque en demo\.officialvanguard\.com durante 30 min\. Vence en 10 min\.$/);
    const code = /Código (\d{6})/.exec(m!.text!.body)![1]!;
    expect((de('approvals', 'insert')[0]!.payload as Fila).nonce_hash).toBe(await otpHashParam(claves.keys as Keys, p.approval_id, code));
    expect(lineas()).not.toContain(code);
    expect(lineas()).not.toContain(TEL);
  });

  it('otra org sin WhatsApp utilizable → 502 sin crear filas ni llamar a Cloudflare; Kapso caído → 502 y se borra la aprobación', async () => {
    org = { is_demo: false };
    let r = await proponer();
    expect(await motivoE56(r)).toEqual([502, 'sin_contacto']);
    expect(de('approvals', 'insert')).toHaveLength(0);
    expect(aCloudflare()).toHaveLength(0);
    contacto = { phone_e164: TEL, verified_at: hace(600), wa_last_inbound_at: hace(60) };
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => (String(url).startsWith('https://api.kapso.ai/')
      ? json({}, 500) : (cf[`${init.method ?? 'GET'} ${url}`] ?? (() => json({}, 500)))()));
    r = await proponer();
    expect(await motivoE56(r)).toEqual([502, 'kapso']);
    const borrado = de('approvals', 'delete')[0]!;
    expect([eqDe(borrado, 'org_id'), eqDe(borrado, 'id')]).toEqual([ORG, (de('approvals', 'insert')[0]!.payload as Fila).id]);
  });

  it('rechazos sin tocar Cloudflare: sin conexión 409, host protegido 422, una_ip 422, no_aplica 422, resuelto 409, zone 422', async () => {
    conexiones = [];
    expect(await motivoE56(await proponer())).toEqual([409, 'no_action_connection']);
    conexiones = [{ id: CONN, meta: { zone_id: ZONA, zone_name: ZN, plan: 'free' }, capabilities: {} }];
    incidente.details = { ip: IP, host: 'officialvanguard.com' };
    const r = await proponer();
    expect(await motivoE56(r.clone())).toEqual([422, 'host_protegido']);
    expect((await error(r)).message).toBe('Ese host es VanGUARD: ponerlo bajo ataque cortaría tu panel y tus avisos');
    incidente.details = { ip: IP, host: HOST };
    ips = 1;
    expect(await motivoE56(await proponer())).toEqual([422, 'una_ip']);
    ips = 2;
    incidente.rule_ids = ['CF_PATH_SCAN'];
    expect(await motivoE56(await proponer())).toEqual([422, 'no_aplica']);
    incidente.rule_ids = ['CF_IP_FLOOD'];
    incidente.status = 'resolved';
    expect(await motivoE56(await proponer())).toEqual([409, 'resolved']);
    incidente.status = 'open';
    expect(await motivoE56(await proponer({ scope: 'zone' }))).toEqual([422, 'zona_del_producto']);
    expect(await motivoE56(await proponer({ scope: 'zona' }))).toEqual([422, undefined]);   // fuera del enum: invalid_body
    expect((await proponer({}, { id: OTRO })).status).toBe(404);
    expect(aCloudflare()).toHaveLength(0);
    expect(de('approvals', 'insert')).toHaveLength(0);
  });

  it('ya activo → 409 already_active con action_id; una proposed de 3 min → 409 in_progress', async () => {
    filas = [{ id: ACT, status: 'executed', target: HOST, created_at: hace(5), previous: { scope: 'host' } }];
    const r = await proponer();
    expect([r.status, (await error(r)).details]).toEqual([409, { reason: 'already_active', action_id: ACT }]);
    filas = [{ id: ACT, status: 'proposed', target: HOST, created_at: hace(3), previous: {} }];
    expect(await motivoE56(await proponer())).toEqual([409, 'in_progress']);
    expect(aCloudflare()).toHaveLength(0);
  });

  it('dry_run 403 → 409 sin_permiso con details.copiar; el GET con 403 también; sin aprobación', async () => {
    cf[`POST ${CF}/rulesets/${RS}/rules?dry_run=true`] = () => json({ success: false }, 403);
    let r = await proponer();
    const e = await error(r);
    expect([r.status, e.details?.reason, e.message]).toEqual([409, 'sin_permiso',
      'Te falta el permiso Zone · Config Rules · Edit en el token de Modo blindaje']);
    expect(e.details?.copiar).toBe(fixtures.underAttackOfferSinPermiso.copiar);
    cf[`GET ${EP}`] = () => json({}, 403);
    r = await proponer();
    expect(await motivoE56(r)).toEqual([409, 'sin_permiso']);
    expect(de('approvals', 'insert')).toHaveLength(0);
  });

  it('dry_run caído → validado:false con su aviso; otro 4xx → 422 rechazada_por_cloudflare; cupo lleno → 422 sin_cupo', async () => {
    cf[`POST ${CF}/rulesets/${RS}/rules?dry_run=true`] = () => json({}, 503);
    const p = UnderAttackProposal.parse(await (await proponer()).json());
    expect(p.validado).toBe(false);
    expect(p.avisos.at(-1)).toBe('No pudimos validarla con Cloudflare: se comprobará al confirmar');
    cf[`POST ${CF}/rulesets/${RS}/rules?dry_run=true`] = () => json({ success: false, errors: [{ code: 20021 }] }, 400);
    let r = await proponer();
    expect([r.status, (await error(r.clone())).details?.reason, (await error(r)).message])
      .toEqual([422, 'rechazada_por_cloudflare', 'Cloudflare no aceptó la regla (código 20021)']);
    cf[`GET ${EP}`] = () => json({ result: { id: RS, rules: Array.from({ length: 10 }, (_, i) => ({ id: String(i).padStart(32, 'c') })) } });
    r = await proponer();
    expect([r.status, (await error(r)).message]).toEqual([422, 'Tu plan admite 10 reglas de configuración y ya las usas']);
  });

  it('el dry_run devuelve un ruleset (Cloudflare escribió) → borra la regla al instante, 500 y sin aprobación', async () => {
    cf[`POST ${CF}/rulesets/${RS}/rules?dry_run=true`] = () => json({ success: true, result: { id: RS, rules: [] } });
    // La regla con nuestro ref la devolvemos en el cuerpo que arma la prueba, con el ref que mande el Worker.
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'POST' && String(url).includes('dry_run=true')) {
        const ref = (JSON.parse(String(init.body)) as Fila).ref;
        return json({ success: true, result: { id: RS, rules: [{ id: 'd'.repeat(32), ref }] } });
      }
      if (init.method === 'DELETE') return new Response(null, { status: 200 });
      return (cf[`${init.method ?? 'GET'} ${url}`] ?? (() => json({}, 500)))();
    });
    const r = await proponer();
    expect([r.status, (await error(r)).code]).toEqual([500, 'internal']);
    expect(aCloudflare().at(-1)).toMatchObject({ method: 'DELETE', url: `${CF}/rulesets/${RS}/rules/${'d'.repeat(32)}` });
    expect(de('approvals', 'insert')).toHaveLength(0);
    expect(lineas()).toContain('"bajo_ataque.dry_run_escribio"');
  });
});
