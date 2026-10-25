import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError as ApiErrorBody, NotificationTestResult, ProposeResponse, RespuestaEscritura, ScanAccepted, UnderAttackOffer,
  UnderAttackProposal,
} from '@vanguard/contracts';
import { otpHashParam } from '@vanguard/core';
import type { Keys } from '@vanguard/core/crypto';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// Sandbox de «Ver demo» (0026): el servidor decide por orgs.sandbox_of (lo lee orgMember) que nada toca lo real. fetch
// está prohibido en todo el archivo: cualquier llamada a Cloudflare o a Kapso hace fallar la prueba.
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const claves = vi.hoisted(() => ({ keys: null as unknown }));
vi.mock('../lib/keyring.ts', () => ({ getKeys: async () => claves.keys, activeKid: async () => 'v1' }));
const cred = vi.hoisted(() => ({ withSecret: vi.fn(async () => { throw new Error('ningún secreto en la sandbox'); }) }));
vi.mock('../lib/credentials.ts', () => ({ withSecret: cred.withSecret, createConnectionWithSecret: vi.fn() }));

const { app } = await import('../app.ts');
const { housekeeping } = await import('../engine/housekeeping.ts');

const ANON = '7b1e0000-0000-4000-8000-0000000000aa';
const SBX = '0f6c0000-0000-4000-8000-0000000005b1';
const DEMO = '00000000-0000-4000-a000-00000000de00';
const INC = '9e0b0000-0000-4000-8000-000000000001';
const APR = 'a9900000-0000-4000-8000-000000000001';
const ACT = 'ac700000-0000-4000-8000-000000000001';
const IP = ['203', '0', '113', '77'].join('.');          // TEST-NET-3: la del simulador de ataques
const TEL = '+58' + '4141234567';
const CODIGO = ['48', '39', '20'].join('');
const HOST = 'tienda.demo.test';
// Producción con Kapso configurado: aun así, nada sale de la sandbox.
const PROD = { VG_ENV: 'production' as const, APP_ORIGIN: 'https://officialvanguard.com', KAPSO_API_KEY: ['k', 'x'.repeat(12)].join('-'),
  KAPSO_PHONE_NUMBER_ID: '1234567890' };

type Fila = Record<string, unknown>;
let sandboxOf: string | null;
let incidente: Fila;
let aprob: Fila | null;
let accion: Fila | null;
let contacto: Fila | null;
let conexionesLectura: number;
let inundaciones: number;
let doble: ReturnType<typeof dbDoble>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const fpk = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  claves.keys = { kid: 'v1', kek: fpk, fpk } as unknown as Keys;
});

beforeEach(() => {
  sandboxOf = DEMO;
  incidente = { id: INC, code: 'A1F3C9', rule_ids: ['CF_UA_TOOL'], severity: 'high', resource: `ip:${IP}`, status: 'open',
    details: { ip: IP, host: HOST } };
  aprob = null;
  accion = null;
  contacto = { id: 'c1', phone_e164: TEL, verified_at: null, wa_last_inbound_at: null };
  conexionesLectura = 0;
  inundaciones = 0;
  doble = dbDoble({
    tabla: (op: Op): Resp | undefined => {
      const id = eqDe(op, 'id');
      if (op.table === 'org_members') return { data: { role: 'owner', orgs: { sandbox_of: sandboxOf } } };
      if (op.table === 'incidents' && op.action === 'select' && op.head) return { count: inundaciones };
      if (op.table === 'incidents' && op.action === 'select') return { data: id === INC && eqDe(op, 'org_id') === SBX ? incidente : null };
      if (op.table === 'approvals' && op.action === 'select') return { data: aprob && id === aprob.id ? aprob : null };
      if (op.table === 'actions' && op.action === 'select' && op.single) return { data: accion && id === accion.id ? accion : null };
      if (op.table === 'actions' && op.action === 'select') return { data: [] };
      if (op.table === 'actions' && op.action === 'insert') return { data: { id: ACT } };
      if (op.table === 'contacts') return { data: contacto };
      if (op.table === 'orgs') return { data: { name: 'Tienda Demo', is_demo: false, sandbox_of: sandboxOf } };
      if (op.table === 'connections' && op.head) return { count: conexionesLectura };
      if (op.table === 'connections') return { data: null };
      if (op.table === 'notifications' && op.action === 'insert') return { data: { id: 'n1' } };
      if (op.table === 'scan_runs' && op.action === 'select') return { data: null, count: 0 };
      if (op.table === 'scan_runs' && op.action === 'insert') return { data: { id: 'e5c40000-0000-4000-8000-000000000002' } };
      if (op.table === 'app_config') return { data: { value: { org_audits_day: 3 } } };
      return undefined;
    },
    rpc: (name: string, a: Record<string, unknown>) => {
      if (name === 'vg_redeem_approval') return { data: aprob && a.p_approval === aprob.id ? [aprob] : [] };
      if (name === 'vg_sandbox_replay') return { data: 'e5c40000-0000-4000-8000-000000000001' };
      return undefined;
    },
    claims: (tok: string) => (tok === 'anon' ? { sub: ANON, is_anonymous: true, role: 'authenticated' } : null),
  });
  estado.client = doble.client;
  fetchMock = vi.fn(async (url: unknown) => { throw new Error(`fetch prohibido en la sandbox: ${String(url)}`); });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Opc = { host?: string; env?: Partial<CloudflareBindings> };
const post = (ruta: string, body: unknown, o: Opc = {}) => app.request(`https://${o.host ?? 'officialvanguard.com'}/api/orgs/${SBX}${ruta}`, {
  method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer anon', 'content-type': 'application/json' },
}, envDoble({ ...PROD, ...o.env }).env);
const de = (tabla: string, action: Op['action']) => doble.ops.filter((o) => o.table === tabla && o.action === action);

describe('Cloudflare en seco (E20, E21, E22, E55, E56)', () => {
  it('E20: el anónimo propone en su sandbox, también en local y con una IP de TEST-NET; el código vuelve en la respuesta', async () => {
    const r = await post('/actions/propose', { incident_id: INC, kind: 'block_ip', target: IP }, { env: { VG_ENV: 'local' } });
    expect(r.status).toBe(200);
    const b = ProposeResponse.parse(await r.json());
    expect(b.delivery).toBe('in_app');
    expect(b.code).toMatch(/^\d{6}$/);
    const fila = de('approvals', 'insert')[0]!.payload as Fila;
    expect(fila).toMatchObject({ org_id: SBX, action_kind: 'block_ip', channel: 'in_app', recipient: ANON });
    expect((fila.params as Fila).simulado).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cred.withSecret).not.toHaveBeenCalled();
  });

  it('E21: el canje ejecuta en seco: actions executed con provider_ref simulado e incidente mitigated, sin Cloudflare', async () => {
    aprob = { id: APR, org_id: SBX, incident_id: INC, action_kind: 'block_ip', channel: 'in_app', recipient: ANON,
      params: { target: IP, incident_id: INC, zone_name: HOST, simulado: true, requested_by: ANON, kid: 'v1' },
      nonce_hash: await otpHashParam(claves.keys as Keys, APR, CODIGO) };
    const r = await post(`/actions/${APR}/confirm`, { code: CODIGO });
    expect(r.status).toBe(200);
    expect(RespuestaEscritura.parse(await r.json())).toMatchObject({ ok: true, action_id: ACT });
    const ins = de('actions', 'insert')[0]!.payload as Fila;
    expect(ins).toMatchObject({ org_id: SBX, approval_id: APR, kind: 'block_ip', target: IP, status: 'executed' });
    expect(String(ins.provider_ref)).toMatch(/^simulado:/);
    expect((ins.previous as Fila).simulado).toBe(true);
    expect(de('incidents', 'update')[0]?.payload).toMatchObject({ status: 'mitigated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('E21: una aprobación sin params.simulado no se ejecuta en una sandbox (nunca cae al camino real)', async () => {
    aprob = { id: APR, org_id: SBX, incident_id: INC, action_kind: 'block_ip', channel: 'in_app', recipient: ANON,
      params: { target: IP, incident_id: INC, connection_id: ACT, zone_id: '0'.repeat(32), kid: 'v1' } };
    const r = await post(`/actions/${APR}/confirm`, { code: CODIGO });
    expect(r.status).toBe(500);
    expect(de('actions', 'insert')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('E22: deshacer en seco pasa la acción a undone sin Cloudflare', async () => {
    accion = { id: ACT, org_id: SBX, kind: 'block_ip', target: IP, status: 'executed', provider_ref: 'simulado:x',
      previous: { simulado: true } };
    const r = await post(`/actions/${ACT}/undo`, {});
    expect(r.status).toBe(200);
    expect(RespuestaEscritura.parse(await r.json()).ok).toBe(true);
    expect(de('actions', 'update')[0]?.payload).toMatchObject({ status: 'undone' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('E55 y E56: oferta sin conexión de acciones (permiso ok) y propuesta con código, sin dry_run en Cloudflare', async () => {
    incidente = { ...incidente, rule_ids: ['CF_IP_FLOOD'], severity: 'critical' };
    inundaciones = 3;
    const o = await app.request(`https://officialvanguard.com/api/orgs/${SBX}/incidents/${INC}/under-attack`,
      { headers: { authorization: 'Bearer anon' } }, envDoble(PROD).env);
    expect(UnderAttackOffer.parse(await o.json())).toMatchObject({ ofrece: true, motivo: null, hostname: HOST, connection_id: null,
      permiso: 'ok', scopes: ['host'] });
    const r = await post(`/incidents/${INC}/under-attack/propose`, { scope: 'host' }, { host: 'vanguard-preview.workers.dev' });
    expect(r.status).toBe(200);
    const b = UnderAttackProposal.parse(await r.json());
    expect(b).toMatchObject({ delivery: 'in_app', target: HOST, validado: true });
    expect(b.code).toMatch(/^\d{6}$/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cred.withSecret).not.toHaveBeenCalled();
  });

  it('caducidad (housekeeping): una acción en seco vencida pasa a undone sin llamar a Cloudflare', async () => {
    const vencida = { id: ACT, org_id: SBX, kind: 'block_ip', target: IP, provider_ref: 'simulado:x', previous: { simulado: true } };
    doble = dbDoble({
      tabla: (op) => (op.table === 'actions' && op.action === 'select' && eqDe(op, 'status') === 'executed' ? { data: [vencida] }
        : op.action === 'select' ? { data: [] } : {}),
      rpc: () => ({ data: [] }),
    });
    estado.client = doble.client;
    const r = await housekeeping(envDoble({ VG_ENV: 'production' }).env, new Date());
    expect(r.deshechos).toBe(1);
    expect(de('actions', 'update').find((o) => eqDe(o, 'id') === ACT)?.payload).toMatchObject({ status: 'undone' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WhatsApp y contactos (E26, E27)', () => {
  it('E27 en una sandbox: fila skipped con el texto que habría llegado y ok sin provider_id; nada por Kapso', async () => {
    const r = await post('/notifications/test', { channel: 'whatsapp' });
    expect(r.status).toBe(200);
    expect(NotificationTestResult.parse(await r.json())).toEqual({ ok: true, provider_id: null });
    const fila = de('notifications', 'insert')[0]!.payload as Fila;
    expect(fila).toMatchObject({ org_id: SBX, status: 'skipped', error: 'sandbox', template: 'test_v1' });
    expect(String(fila.preview)).toContain('Tienda Demo');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('E26 en una sandbox: los contactos salen sin código ni enlace de verificación', async () => {
    contacto = null;
    doble = dbDoble({
      tabla: (op) => (op.table === 'org_members' ? { data: { role: 'owner', orgs: { sandbox_of: DEMO } } }
        : op.table === 'contacts' ? { data: [{ id: 'c3d40000-0000-4000-8000-000000000001', name: 'Yo', phone_e164: TEL,
          whatsapp: true, voice: false, priority: 1, verified_at: null }] } : undefined),
      claims: (tok) => (tok === 'anon' ? { sub: ANON, is_anonymous: true } : null),
    });
    estado.client = doble.client;
    const r = await app.request(`https://officialvanguard.com/api/orgs/${SBX}/contacts`, { headers: { authorization: 'Bearer anon' } },
      envDoble({ ...PROD, KAPSO_DISPLAY_NUMBER: '+584140000000' }).env);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Fila[])[0]?.verificacion ?? null).toBeNull();
  });
});

describe('Simulador (E57) y auditorías (E11)', () => {
  it('«Simular ataque» pasa la guarda en una sandbox (y sigue prohibido en una org normal)', async () => {
    const r = await post('/incidents/simulate', {});
    // Pasó la guarda: el doble no trae la conexión del simulador → 409 (no 403).
    expect(r.status).toBe(409);
    expect(ApiErrorBody.parse(await r.json()).error.message).toMatch(/simulador/);
    sandboxOf = null;
    const n = await post('/incidents/simulate', {});
    expect(n.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('full_audit sin conexiones reales → replay (vg_sandbox_replay), sin encolar; fuera de una sandbox → 409', async () => {
    const env = envDoble({ ...PROD });
    const r = await app.request(`https://officialvanguard.com/api/orgs/${SBX}/scans`, { method: 'POST',
      body: JSON.stringify({ kind: 'full_audit' }), headers: { authorization: 'Bearer anon', 'content-type': 'application/json' } }, env.env);
    expect(r.status).toBe(202);
    expect(ScanAccepted.parse(await r.json()).scan_run_id).toBe('e5c40000-0000-4000-8000-000000000001');
    expect(doble.rpcs.map((x) => x.name)).toContain('vg_sandbox_replay');
    expect(env.enviados).toHaveLength(0);
    // Las conexiones copiadas de la demo no cuentan como auditables.
    const conteo = doble.ops.find((o) => o.table === 'connections' && o.head)!;
    expect(conteo.filters).toContainEqual(['meta->>demostracion', 'is', null]);
    sandboxOf = null;
    const n = await app.request(`https://officialvanguard.com/api/orgs/${SBX}/scans`, { method: 'POST',
      body: JSON.stringify({ kind: 'full_audit' }), headers: { authorization: 'Bearer anon', 'content-type': 'application/json' } },
      envDoble({ ...PROD }).env);
    expect(n.status).toBe(403);    // un anónimo fuera de su sandbox no escribe
  });

  it('con una conexión real conectada en la sandbox, audita de verdad (encola en vg-jobs)', async () => {
    conexionesLectura = 1;
    doble.rpcs.length = 0;
    const env = envDoble({ ...PROD });
    const r = await app.request(`https://officialvanguard.com/api/orgs/${SBX}/scans`, { method: 'POST',
      body: JSON.stringify({ kind: 'full_audit' }), headers: { authorization: 'Bearer anon', 'content-type': 'application/json' } }, env.env);
    expect(r.status).toBe(202);
    expect(doble.rpcs.map((x) => x.name)).not.toContain('vg_sandbox_replay');
    expect(env.enviados).toHaveLength(1);
  });

  it('el token de acciones de Cloudflare no se acepta en una sandbox', async () => {
    const r = await post('/connections', { provider: 'cloudflare', zone_id: '0'.repeat(32), read_token: 'r'.repeat(30),
      action_token: 'a'.repeat(30) });
    expect(r.status).toBe(403);
    expect(ApiErrorBody.parse(await r.json()).error.details?.reason).toBe('sandbox_sin_acciones');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
