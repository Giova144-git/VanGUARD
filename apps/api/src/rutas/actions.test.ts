import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, ProposeResponse, RespuestaEscritura } from '@vanguard/contracts';
import { otpHashParam, refBajoAtaque } from '@vanguard/core';
import type { Keys } from '@vanguard/core/crypto';
import { sha256Hex } from '../lib/hmac.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const claves = vi.hoisted(() => ({ keys: null as unknown, kids: [] as string[] }));
vi.mock('../lib/keyring.ts', () => ({
  getKeys: async (_e: unknown, _a: unknown, kid: string) => { claves.kids.push(kid); return claves.keys; },
  activeKid: async () => 'v1',
}));
const cred = vi.hoisted(() => ({ withSecret: vi.fn() }));
vi.mock('../lib/credentials.ts', () => ({ withSecret: cred.withSecret, createConnectionWithSecret: vi.fn() }));

const { app } = await import('../app.ts');

// Valores falsos armados en tiempo de ejecución: ningún literal con forma de secreto, teléfono ni IP entera de un cliente.
const TOKEN = ['tok', 'acciones', 'x'.repeat(20)].join('-');
const CLAVE = ['clave', 'kapso', 'de', 'prueba'].join('-');
const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const INC = '9e0b0000-0000-4000-8000-000000000001';
const APR = 'a9900000-0000-4000-8000-000000000001';
const ACT = 'ac700000-0000-4000-8000-000000000001';
const CONN = 'c0aa0000-0000-4000-8000-000000000002';
const OTRO = 'ffff0000-0000-4000-8000-00000000ffff';
const ZONA = '023e105f4ecef8ad9ca31a8372d0c353';
const TEL = '+58' + '4141234567';
const IP = ['186', '92', '14', '7'].join('.');
const CODIGO = ['48', '39', '20'].join('');
const PROD = { VG_ENV: 'production' as const, APP_ORIGIN: 'https://officialvanguard.com', KAPSO_API_KEY: CLAVE,
  KAPSO_PHONE_NUMBER_ID: '1234567890' };
const REGLAS = `https://api.cloudflare.com/client/v4/zones/${ZONA}/firewall/access_rules/rules`;

type Fila = Record<string, unknown>;
let rol: string;
let incidente: Fila;
let conexiones: Fila[];
let vigentes: Fila[];
let previas: Fila[];
let contacto: Fila | null;
let org: Fila;
let aprob: Fila;
let accion: Fila | null;
let doble: ReturnType<typeof dbDoble>;
let fetchMock: ReturnType<typeof vi.fn>;
let logs: { mock: { calls: unknown[][] } };

beforeAll(async () => {
  const fpk = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  claves.keys = { kid: 'v1', kek: fpk, fpk } as unknown as Keys;
});

const paramsAprob = () => ({ target: IP, target_kind: 'ip', incident_id: INC, group: APR, connection_id: CONN, zone_id: ZONA,
  zone_name: 'officialvanguard.com', mode: 'block', ttl_s: 3600, incident_code: 'A1F3C9', regla: 'CF_UA_TOOL', requested_by: ANA, kid: 'v1' });

beforeEach(async () => {
  rol = 'owner';
  claves.kids = [];
  incidente = { id: INC, code: 'A1F3C9', rule_ids: ['CF_UA_TOOL', 'CF_PATH_SCAN'], severity: 'high', resource: `ip:${IP}`,
    status: 'open', details: { ip: IP, host: 'demo.officialvanguard.com' } };
  conexiones = [{ id: CONN, meta: { zone_id: ZONA, zone_name: 'officialvanguard.com' } }];
  vigentes = [];
  previas = [];
  contacto = { phone_e164: TEL, verified_at: '2026-10-24T14:00:00+00:00', wa_last_inbound_at: new Date(Date.now() - 3600_000).toISOString() };
  org = { is_demo: false };
  aprob = { id: APR, org_id: ORG, incident_id: INC, action_kind: 'block_ip', channel: 'in_app', recipient: ANA, params: paramsAprob(),
    attempts: 0, expires_at: new Date(Date.now() + 600_000).toISOString(), used_at: null,
    nonce_hash: await otpHashParam(claves.keys as Keys, APR, CODIGO) };
  accion = { id: ACT, org_id: ORG, kind: 'block_ip', status: 'executed', provider_ref: 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6',
    previous: { connection_id: CONN, zone_id: ZONA, existed: false } };
  doble = dbDoble({
    tabla: (op: Op): Resp | undefined => {
      const id = eqDe(op, 'id'), deOrg = eqDe(op, 'org_id') === ORG;
      if (op.table === 'org_members') return { data: { role: rol } };
      if (op.table === 'incidents' && op.action === 'select') return { data: id === INC && deOrg ? incidente : null };
      if (op.table === 'connections') return { data: conexiones };
      if (op.table === 'contacts') return { data: contacto };
      if (op.table === 'orgs') return { data: org };
      if (op.table === 'actions' && op.action === 'select' && op.single) {
        return { data: accion && id === accion.id && eqDe(op, 'org_id') === accion.org_id ? accion : null };
      }
      if (op.table === 'actions' && op.action === 'select') return { data: eqDe(op, 'status') === 'executed' ? vigentes : previas };
      if (op.table === 'actions' && op.action === 'insert') return { data: { id: ACT } };
      if (op.table === 'approvals' && op.action === 'select') {
        // Pre-lectura (id + org + in_app + recipient) y relectura (id + org): la semántica de las dos consultas de E21.
        const casa = id === aprob.id && eqDe(op, 'org_id') === aprob.org_id
          && (op.filters.every(([c, , v]) => c !== 'channel' || v === aprob.channel))
          && (op.filters.every(([c, , v]) => c !== 'recipient' || v === aprob.recipient));
        return { data: casa ? aprob : null };
      }
      return undefined;
    },
    // Doble de vg_redeem_approval (0005): un solo uso, no vencida, < 5 intentos, recipient y hash exactos; si no casa y
    // llega p_approval, attempts + 1.
    rpc: (name: string, a: Record<string, unknown>) => {
      if (name !== 'vg_redeem_approval') return undefined;
      const vivo = !aprob.used_at && Date.parse(String(aprob.expires_at)) > Date.now() && Number(aprob.attempts) < 5;
      if (vivo && a.p_approval === aprob.id && a.p_recipient === aprob.recipient && a.p_nonce_hash === aprob.nonce_hash) {
        aprob.used_at = new Date().toISOString();
        return { data: [aprob] };
      }
      if (a.p_approval === aprob.id && !aprob.used_at && Number(aprob.attempts) < 5) aprob.attempts = Number(aprob.attempts) + 1;
      return { data: [] };
    },
    claims: (tok: string) => (tok === 'ana' ? { sub: ANA, email: 'ana@acme.dev', is_anonymous: false } : null),
  });
  estado.client = doble.client;
  cred.withSecret.mockReset().mockImplementation(async (_e: unknown, _a: unknown, _c: unknown, fn: (t: string) => Promise<unknown>) => fn(TOKEN));
  fetchMock = vi.fn(async (url: string) => (String(url).startsWith('https://api.kapso.ai/')
    ? new Response(JSON.stringify({ messages: [{ id: 'wamid.HBgMprueba' }] }))
    : new Response(JSON.stringify({ success: true, result: { id: 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6' } }))));
  vi.stubGlobal('fetch', fetchMock);
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Opc = { host?: string; env?: Partial<CloudflareBindings>; ip?: string };
const post = (ruta: string, body: unknown, o: Opc = {}) => app.request(`https://${o.host ?? 'officialvanguard.com'}/api/orgs/${ORG}${ruta}`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { authorization: 'Bearer ana', 'content-type': 'application/json', ...(o.ip ? { 'cf-connecting-ip': o.ip } : {}) },
}, envDoble({ ...PROD, ...o.env }).env);
const proponer = (body: Fila = {}, o: Opc = {}) => post('/actions/propose', { incident_id: INC, kind: 'block_ip', target: IP, ...body }, o);
const confirmar = (code = CODIGO, id = APR, o: Opc = {}) => post(`/actions/${id}/confirm`, { code }, o);
const deshacer = (id = ACT, o: Opc = {}) => post(`/actions/${id}/undo`, {}, o);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;
const de = (tabla: string, action: Op['action']) => doble.ops.filter((o) => o.table === tabla && o.action === action);
const aCloudflare = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('https://api.cloudflare.com/'));
const aKapso = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('https://api.kapso.ai/'))
  .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Fila & { type: string; text?: { body: string };
    interactive?: { body: { text: string }; action: { buttons: { reply: { id: string; title: string } }[] } } });
const lineas = () => logs.mock.calls.map((c) => String(c[0])).join('\n');

describe('E20–E22 · guardas', () => {
  it('fuera del host de producción (VG_ENV=local, workers.dev o www) → 403 sin leer nada ni llamar a nadie', async () => {
    for (const o of [{ env: { VG_ENV: 'local' as const } }, { host: 'vanguard.giovannizm14.workers.dev' }, { host: 'www.officialvanguard.com' }]) {
      for (const r of [await proponer({}, o), await confirmar(CODIGO, APR, o), await deshacer(ACT, o)]) {
        expect(r.status).toBe(403);
        expect((await error(r)).code).toBe('forbidden');
      }
    }
    expect(doble.ops.some((x) => ['incidents', 'approvals', 'actions'].includes(x.table))).toBe(false);
    expect(doble.rpcs).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('viewer → 403 en las tres', async () => {
    rol = 'viewer';
    for (const r of [await proponer(), await confirmar(), await deshacer()]) expect(r.status).toBe(403);
  });
});

describe('E20 · propose (simulación, sin tocar Cloudflare)', () => {
  it('cada motivo de 422 con details.reason exacto; own_ip = cf-connecting-ip del operador', async () => {
    const casos: [string, string, Opc?][] = [
      ['hola', 'not_an_ip'], ['10.0.0.1', 'private_ip'], ['::1', 'private_ip'], ['203.0.113.7', 'documentation_range'],
      [`${IP}/24`, 'range_too_wide'], ['2800:3f0::/64', 'range_too_wide'], ['104.16.1.1', 'cloudflare_ip'],
      ['2606:4700::1111', 'cloudflare_ip'], [IP, 'own_ip', { ip: IP }],
    ];
    for (const [target, reason, o] of casos) {
      const r = await proponer({ target }, o);
      expect(r.status, target).toBe(422);
      const e = await error(r);
      expect([e.code, e.details?.reason]).toEqual(['invalid_body', reason]);
    }
    expect(de('approvals', 'insert')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con contacto verificado: 1 fila in_app (HMAC del código con la FPK) + 2 whatsapp ok/no del mismo group e interactivo', async () => {
    const r = await proponer();
    expect(r.status).toBe(200);
    const p = ProposeResponse.parse(await r.json());
    expect(p).toMatchObject({ efecto: `Bloquear ${IP} (/32) en la zona officialvanguard.com durante 1 h`, delivery: 'whatsapp', code: null });
    expect(p.avisos).toContain('Solo afecta a esta IP');
    expect(p.avisos).toContain('Bloquea la IP en toda la zona officialvanguard.com, también en tu web principal');

    const filas = de('approvals', 'insert').flatMap((o) => o.payload as Fila[]);
    expect(filas.map((f) => f.channel)).toEqual(['in_app', 'whatsapp', 'whatsapp']);
    const [app_, ok, no] = filas as [Fila, Fila, Fila];
    expect(app_).toMatchObject({ id: p.approval_id, org_id: ORG, incident_id: INC, action_kind: 'block_ip', recipient: ANA,
      expires_at: p.expires_at, params: { target: IP, target_kind: 'ip', incident_id: INC, group: p.approval_id, connection_id: CONN,
        zone_id: ZONA, zone_name: 'officialvanguard.com', mode: 'block', ttl_s: 3600, incident_code: 'A1F3C9', regla: 'CF_UA_TOOL',
        requested_by: ANA, kid: 'v1' } });
    expect(Date.parse(p.expires_at) - Date.now()).toBeGreaterThan(9 * 60_000);
    for (const [f, etapa] of [[ok, 'confirmar'], [no, 'cancelar']] as const) {
      expect(f).toMatchObject({ recipient: TEL.slice(1), params: { group: p.approval_id, etapa } });
    }

    const [m] = aKapso();
    expect(m!.type).toBe('interactive');
    const texto = m!.interactive!.body.text;
    expect(texto).toContain('186.92.x.x');
    expect(texto).not.toContain(IP);
    const code = /Código para la app: (\d{6})/.exec(texto)![1]!;
    expect(app_.nonce_hash).toBe(await otpHashParam(claves.keys as Keys, p.approval_id, code));   // nunca el código en claro
    expect(JSON.stringify(filas)).not.toContain(code);
    const botones = m!.interactive!.action.buttons.map((b) => b.reply);
    expect(botones.map((b) => b.title)).toEqual(['Sí, bloquear', 'Cancelar']);
    for (const [i, b] of botones.entries()) {
      const [accion, codigo, nonce] = b.id.split(':');
      expect([accion, codigo]).toEqual([i === 0 ? 'ok' : 'no', 'A1F3C9']);
      expect(filas[i + 1]!.nonce_hash).toBe(`\\x${await sha256Hex(nonce!)}`);
    }
    expect(aCloudflare()).toHaveLength(0);
    expect(lineas()).not.toContain(code);
    expect(lineas()).not.toContain(IP);
    expect(lineas()).not.toContain(TEL);
  });

  it('el interactivo falla → el código sale en un texto; sin WhatsApp en una org normal → 502 y no queda aprobación', async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => (++n === 1 ? new Response('{"error":{"code":131009}}', { status: 400 })
      : new Response(JSON.stringify({ messages: [{ id: 'wamid.HBgMtexto' }] }))));
    expect(ProposeResponse.parse(await (await proponer()).json()).delivery).toBe('whatsapp');
    expect(aKapso()[1]!.text!.body).toMatch(/^Código \d{6} para bloquear la IP 186\.92\.x\.x durante 1 h en officialvanguard\.com/);

    fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }));
    const r = await proponer();
    expect(r.status).toBe(502);
    expect((await error(r)).details?.reason).toBe('kapso');
    const borrado = de('approvals', 'delete').at(-1)!;
    expect(eqDe(borrado, 'org_id')).toBe(ORG);
    expect((borrado.filters.find(([c]) => c === 'id')![2] as string[])).toHaveLength(3);

    contacto = { ...contacto, verified_at: null };
    const sinVerificar = await proponer();
    expect([sinVerificar.status, (await error(sinVerificar)).details?.reason]).toEqual([502, 'sin_verificar']);
    contacto = null;
    expect((await proponer()).status).toBe(502);
  });

  it('org de demo sin WhatsApp utilizable → delivery in_app con el código en la respuesta (y casa con el hash guardado)', async () => {
    org = { is_demo: true };
    contacto = null;
    const p = ProposeResponse.parse(await (await proponer()).json());
    expect(p.delivery).toBe('in_app');
    expect(p.code).toMatch(/^\d{6}$/);
    const filas = de('approvals', 'insert').flatMap((o) => o.payload as Fila[]);
    expect(filas).toHaveLength(1);
    expect(filas[0]!.nonce_hash).toBe(await otpHashParam(claves.keys as Keys, p.approval_id, p.code!));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409 sin conexión action activa, 409 con bloqueo vigente (details.action_id); 404 incidente de otra org; kind/mode → 422', async () => {
    conexiones = [];
    let r = await proponer();
    expect([r.status, (await error(r)).message]).toEqual([409, 'Activa el Modo blindaje con un token de acciones']);
    conexiones = [{ id: CONN, meta: { zone_id: ZONA, zone_name: 'officialvanguard.com' } }];
    vigentes = [{ id: ACT }];
    r = await proponer();
    expect(r.status).toBe(409);
    expect((await error(r)).details).toMatchObject({ action_id: ACT });
    const vig = de('actions', 'select').find((o) => eqDe(o, 'status') === 'executed')!;
    expect([eqDe(vig, 'org_id'), eqDe(vig, 'target')]).toEqual([ORG, IP]);
    expect(vig.filters.some(([c, op]) => c === 'expires_at' && op === 'gt')).toBe(true);
    vigentes = [];
    expect((await proponer({ incident_id: OTRO })).status).toBe(404);
    expect((await proponer({ kind: 'under_attack_on' })).status).toBe(422);
    expect((await proponer({ mode: 'managed_challenge' })).status).toBe(422);
    expect(de('approvals', 'insert')).toHaveLength(0);
  });
});

describe('E21 · confirm', () => {
  it('código correcto → canje con el HMAC y executeBlock: 200 «IP bloqueada 1 h», regla creada e incidente mitigated', async () => {
    const r = await confirmar();
    expect(r.status).toBe(200);
    const b = RespuestaEscritura.parse(await r.json());
    expect(b).toMatchObject({ ok: true, resultado: 'IP bloqueada 1 h', action_id: ACT });
    expect(doble.rpcs[0]).toEqual({ name: 'vg_redeem_approval', args: { p_approval: APR, p_nonce_hash: aprob.nonce_hash, p_recipient: ANA } });
    expect(claves.kids).toEqual(['v1']);                                   // el kid de params, sin leer el activo
    expect(aCloudflare().map((c) => String(c[0]))).toEqual([REGLAS]);
    expect(de('incidents', 'update')[0]!.payload).toMatchObject({ status: 'mitigated' });
    expect(de('actions', 'update')[0]!.payload).toMatchObject({ status: 'executed', previous: { connection_id: CONN, zone_id: ZONA, existed: false } });
    expect(lineas()).not.toContain(CODIGO);
  });

  it('código erróneo → 422 wrong_code con attempts_left; al 5.º → 409 locked y ya no canjea ni el bueno', async () => {
    for (let i = 1; i <= 4; i++) {
      const r = await confirmar('000000');
      expect(r.status).toBe(422);
      expect((await error(r)).details).toEqual({ reason: 'wrong_code', attempts_left: 5 - i });
    }
    const quinto = await confirmar('000000');
    expect(quinto.status).toBe(409);
    expect((await error(quinto)).details).toEqual({ reason: 'locked' });
    const bueno = await confirmar();
    expect([bueno.status, (await error(bueno)).details?.reason]).toEqual([409, 'locked']);
    expect(aCloudflare()).toHaveLength(0);
  });

  it('dos confirmaciones: la segunda → 409 used sin otro executeBlock; vencida → 409 expired; formato malo → 422', async () => {
    expect((await confirmar()).status).toBe(200);
    const otra = await confirmar();
    expect([otra.status, (await error(otra)).details?.reason]).toEqual([409, 'used']);
    expect(aCloudflare()).toHaveLength(1);
    expect(de('actions', 'insert')).toHaveLength(1);

    aprob = { ...aprob, used_at: null, attempts: 0, expires_at: new Date(Date.now() - 1000).toISOString() };
    const vencida = await confirmar();
    expect([vencida.status, (await error(vencida)).details?.reason]).toEqual([409, 'expired']);
    expect((await confirmar('48392')).status).toBe(422);
  });

  it('anti-IDOR: aprobación de otra org, de otro usuario o que no es in_app → 404 sin canjear ni gastar intentos', async () => {
    aprob = { ...aprob, org_id: OTRO };
    expect((await confirmar()).status).toBe(404);
    aprob = { ...aprob, org_id: ORG, recipient: OTRO };
    expect((await confirmar()).status).toBe(404);
    aprob = { ...aprob, recipient: ANA, channel: 'whatsapp' };
    expect((await confirmar()).status).toBe(404);
    expect((await confirmar(CODIGO, 'no-es-uuid')).status).toBe(404);
    expect(doble.rpcs).toHaveLength(0);
    const pre = de('approvals', 'select')[0]!;
    expect([eqDe(pre, 'org_id'), eqDe(pre, 'channel'), eqDe(pre, 'recipient')]).toEqual([ORG, 'in_app', ANA]);
  });

  it('Cloudflare 403 → 200 ok:false con el permiso que falta y actions failed; 5xx → 502', async () => {
    fetchMock.mockImplementation(async () => new Response('{"success":false}', { status: 403 }));
    let r = await confirmar();
    expect(r.status).toBe(200);
    expect(RespuestaEscritura.parse(await r.json())).toMatchObject({ ok: false,
      error: 'Te falta el permiso Firewall Services · Edit en el token de acciones' });
    expect(de('actions', 'update')[0]!.payload).toEqual({ status: 'failed' });

    aprob = { ...aprob, used_at: null };
    fetchMock.mockImplementation(async () => new Response('{}', { status: 502 }));
    r = await confirmar();
    expect([r.status, (await error(r)).code]).toEqual([502, 'provider_unavailable']);
  });
});

describe('E22 · undo', () => {
  it('DELETE de la regla con el token de previous.connection_id → 200 «Bloqueo retirado» y undone', async () => {
    const r = await deshacer();
    expect(r.status).toBe(200);
    expect(RespuestaEscritura.parse(await r.json())).toMatchObject({ ok: true, resultado: 'Bloqueo retirado' });
    const [url, init] = aCloudflare()[0] as [string, RequestInit];
    expect([url, init.method]).toEqual([`${REGLAS}/f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6`, 'DELETE']);
    expect(cred.withSecret.mock.calls[0]![2]).toEqual({ orgId: ORG, connectionId: CONN, provider: 'cloudflare', kind: 'action' });
    const [u] = de('actions', 'update');
    expect(u!.payload).toMatchObject({ status: 'undone' });
    expect(u!.filters).toContainEqual(['org_id', 'in', [ORG]]);
  });

  it('404 de Cloudflare cuenta como deshecho; previous.existed no toca Cloudflare', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));
    expect((await deshacer()).status).toBe(200);
    accion = { ...accion, previous: { connection_id: CONN, zone_id: ZONA, existed: true }, provider_ref: null };
    fetchMock.mockClear();
    expect(RespuestaEscritura.parse(await (await deshacer()).json()).ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ya deshecha → 409; acción de otra org → 404; Cloudflare 403 → ok:false y sigue executed; 5xx → 502', async () => {
    accion = { ...accion, status: 'undone' };
    const r = await deshacer();
    expect([r.status, (await error(r)).details?.reason]).toEqual([409, 'undone']);
    accion = { ...accion, status: 'executed', org_id: OTRO };
    expect((await deshacer()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    accion = { ...accion, org_id: ORG };
    fetchMock.mockImplementation(async () => new Response('{}', { status: 403 }));
    expect(RespuestaEscritura.parse(await (await deshacer()).json())).toMatchObject({ ok: false });
    expect(de('actions', 'update')).toHaveLength(0);
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }));
    expect((await deshacer()).status).toBe(502);
  });

  it('Cloudflare 400 (zona borrada) → 200 ok:false, nunca 502 «no respondió»', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 400 }));
    const r = await deshacer();
    expect(r.status).toBe(200);
    expect(RespuestaEscritura.parse(await r.json())).toEqual({ ok: false, error: 'Cloudflare no dejó retirar la regla: quítala a mano en Cloudflare' });
  });

  it('failed que la caducidad no pudo retirar (con provider_ref y previous) → se reintenta y queda undone; failed sin regla → 409', async () => {
    accion = { ...accion, status: 'failed', previous: { connection_id: CONN, zone_id: ZONA, existed: false, intentos: 6, deshacer_error: 'caido' } };
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    expect(RespuestaEscritura.parse(await (await deshacer()).json())).toMatchObject({ ok: true, resultado: 'Bloqueo retirado' });
    expect(de('actions', 'update')[0]!.filters).toContainEqual(['status', 'in', ['executed', 'failed']]);
    // Un failed de executeBlock (el POST falló: sin provider_ref ni previous) no tiene nada que retirar.
    accion = { ...accion, provider_ref: null, previous: null };
    fetchMock.mockClear();
    const r = await deshacer();
    expect([r.status, (await error(r)).details?.reason]).toEqual([409, 'not_executed']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Modo bajo ataque (modo-bajo-ataque.md §5): E21 y E22 despachan por tipo en la primera línea; la rama block_ip de
// arriba sigue igual (sus casos no cambian).
describe('E21 y E22 · under_attack_on (despacho por tipo)', () => {
  const HOST = 'demo.officialvanguard.com';
  const RS = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
  const REGLA = 'd'.repeat(32);
  const EP = `https://api.cloudflare.com/client/v4/zones/${ZONA}/rulesets/phases/http_config_settings/entrypoint`;
  const POST_REGLA = `https://api.cloudflare.com/client/v4/zones/${ZONA}/rulesets/${RS}/rules`;
  let cf: Record<string, () => Response>;
  beforeEach(() => {
    aprob = { ...aprob, action_kind: 'under_attack_on', params: { scope: 'host', target: HOST, zone_id: ZONA, zone_name: 'officialvanguard.com',
      connection_id: CONN, incident_id: INC, incident_code: 'A1F3C9', ttl_s: 1800, group: APR, kid: 'v1', requested_by: ANA,
      ref: refBajoAtaque(APR), ruleset_id: RS, plan: 'free' } };
    accion = { id: ACT, org_id: ORG, kind: 'under_attack_on', status: 'executed', provider_ref: REGLA,
      previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ref: refBajoAtaque(APR), ruleset_id: RS } };
    cf = {
      [`GET ${EP}`]: () => new Response(JSON.stringify({ success: true, result: { id: RS, rules: [] } })),
      [`POST ${POST_REGLA}`]: () => new Response(JSON.stringify({ success: true, result: { id: RS, rules: [{ id: REGLA, ref: refBajoAtaque(APR) }] } })),
      [`DELETE ${POST_REGLA}/${REGLA}`]: () => new Response(null, { status: 200 }),
    };
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => (cf[`${init.method ?? 'GET'} ${url}`]
      ?? (() => new Response('{}', { status: 500 })))());
  });

  it('E21 con una aprobación under_attack_on → el mismo canje y executeUnderAttack: la regla de configuración, nunca access_rules', async () => {
    const r = await confirmar();
    expect(r.status).toBe(200);
    expect(RespuestaEscritura.parse(await r.json())).toMatchObject({ ok: true, action_id: ACT,
      resultado: 'Modo bajo ataque activo 30 min en demo.officialvanguard.com' });
    expect(doble.rpcs[0]).toEqual({ name: 'vg_redeem_approval', args: { p_approval: APR, p_nonce_hash: aprob.nonce_hash, p_recipient: ANA } });
    expect(claves.kids).toEqual(['v1']);
    expect(aCloudflare().map((c) => `${(c[1] as RequestInit).method} ${String(c[0])}`)).toEqual([`GET ${EP}`, `POST ${POST_REGLA}`]);
    expect(de('actions', 'insert')[0]!.payload).toMatchObject({ kind: 'under_attack_on', target: HOST, status: 'proposed' });
    expect(de('actions', 'update').at(-1)!.payload).toMatchObject({ status: 'executed', provider_ref: REGLA });
    expect(lineas()).not.toContain(CODIGO);
  });

  it('E21 under_attack_on: código erróneo → 422 wrong_code (mismo canje); Cloudflare 403 → ok:false con Config Rules; 5xx → 502', async () => {
    const malo = await confirmar('000000');
    expect([malo.status, (await error(malo)).details]).toEqual([422, { reason: 'wrong_code', attempts_left: 4 }]);
    expect(aCloudflare()).toHaveLength(0);
    aprob = { ...aprob, attempts: 0 };
    cf[`POST ${POST_REGLA}`] = () => new Response('{"success":false}', { status: 403 });
    expect(RespuestaEscritura.parse(await (await confirmar()).json())).toMatchObject({ ok: false,
      error: 'Te falta el permiso Zone · Config Rules · Edit en el token de Modo blindaje' });
    aprob = { ...aprob, used_at: null };
    cf[`POST ${POST_REGLA}`] = () => new Response('{}', { status: 503 });
    const caido = await confirmar();
    expect([caido.status, (await error(caido)).message]).toEqual([502, 'Cloudflare no respondió. Vuelve a proponerlo.']);
  });

  it('E21: ya usado → 409 «Vuelve a proponerlo» (sirve a los dos tipos)', async () => {
    expect((await confirmar()).status).toBe(200);
    const otra = await confirmar();
    expect([otra.status, (await error(otra)).message]).toEqual([409, 'Ese código ya se usó. Vuelve a proponerlo.']);
  });

  it('E22 con una acción under_attack_on → deshacerBajoAtaque: DELETE de la regla de configuración y «Modo bajo ataque desactivado»', async () => {
    const r = await deshacer();
    expect(RespuestaEscritura.parse(await r.json())).toMatchObject({ ok: true, resultado: 'Modo bajo ataque desactivado' });
    expect(aCloudflare().map((c) => `${(c[1] as RequestInit).method} ${String(c[0])}`)).toEqual([`DELETE ${POST_REGLA}/${REGLA}`]);
    expect(aCloudflare().some((c) => String(c[0]).includes('access_rules'))).toBe(false);
    expect(de('actions', 'update')[0]!.filters).toContainEqual(['kind', 'eq', 'under_attack_on']);
  });

  it('E22 under_attack_on: 403 → ok:false con Config Rules y sigue executed; ya desactivado → 409 undone; 5xx → 502', async () => {
    cf[`DELETE ${POST_REGLA}/${REGLA}`] = () => new Response(null, { status: 403 });
    expect(RespuestaEscritura.parse(await (await deshacer()).json())).toEqual({ ok: false,
      error: 'Te falta el permiso Zone · Config Rules · Edit en el token de Modo blindaje' });
    expect(de('actions', 'update')).toHaveLength(0);
    cf[`DELETE ${POST_REGLA}/${REGLA}`] = () => new Response(null, { status: 503 });
    expect((await deshacer()).status).toBe(502);
    accion = { ...accion, status: 'undone' };
    const r = await deshacer();
    expect([r.status, (await error(r)).details?.reason]).toEqual([409, 'undone']);
  });
});
