import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, NotificationTestResult } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { app } = await import('../app.ts');

// Valores falsos armados en tiempo de ejecución: ningún literal con forma de secreto queda en el repo.
const CLAVE = ['clave', 'kapso', 'de', 'prueba'].join('-');
const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const PROD = { VG_ENV: 'production' as const, APP_ORIGIN: 'https://officialvanguard.com', KAPSO_API_KEY: CLAVE,
  KAPSO_PHONE_NUMBER_ID: '1234567890' };

let rol: string;
let contacto: Record<string, unknown> | null;
let org: Record<string, unknown>;
let usadas: number;
let errorInsert: { code: string } | null;
let errorUpdate: { code: string } | null;
let doble: ReturnType<typeof dbDoble>;
let fetchMock: ReturnType<typeof vi.fn>;

const claims = (tok: string) => (tok === 'ana' ? { sub: ANA, email: 'ana@acme.dev', is_anonymous: false } : null);

beforeEach(() => {
  rol = 'owner';
  contacto = { id: 'c1', phone_e164: '+584141234567', verified_at: '2026-10-24T14:00:00+00:00' };
  org = { name: 'Tienda Demo', is_demo: false };
  usadas = 0;
  errorInsert = null;
  errorUpdate = null;
  doble = dbDoble({
    tabla: (op: Op): Resp | undefined => {
      if (op.table === 'org_members') return { data: { role: rol } };
      if (op.table === 'contacts') return { data: contacto };
      if (op.table === 'orgs') return { data: org };
      if (op.table === 'notifications' && op.action === 'select') return { count: usadas };
      if (op.table === 'notifications' && op.action === 'insert') return errorInsert ? { error: errorInsert } : { data: { id: 'n1' } };
      if (op.table === 'notifications' && op.action === 'update') return { error: errorUpdate };
      return undefined;
    },
    claims,
  });
  estado.client = doble.client;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.HBgMprueba' }] })));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const probar = (body: unknown = { channel: 'whatsapp' }, o: { host?: string; env?: Partial<CloudflareBindings> } = {}) =>
  app.request(`https://${o.host ?? 'officialvanguard.com'}/api/orgs/${ORG}/notifications/test`, {
    method: 'POST', headers: { authorization: 'Bearer ana', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, envDoble({ ...PROD, ...o.env }).env);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;
const inserts = () => doble.ops.filter((x) => x.table === 'notifications' && x.action === 'insert')
  .map((x) => x.payload as Record<string, unknown>);
const updates = () => doble.ops.filter((x) => x.table === 'notifications' && x.action === 'update');

describe('E27 · guardas', () => {
  it('fuera del host de producción → 403 (workers.dev, www o VG_ENV=local) sin leer contactos ni llamar a Kapso', async () => {
    for (const [host, env] of [['vanguard.giovannizm14.workers.dev', {}], ['www.officialvanguard.com', {}],
      ['officialvanguard.com', { VG_ENV: 'local' as const }]] as const) {
      const r = await probar(undefined, { host, env });
      expect(r.status).toBe(403);
      expect((await error(r)).code).toBe('forbidden');
    }
    expect(doble.ops.some((o) => o.table === 'contacts')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('viewer → 403', async () => {
    rol = 'viewer';
    expect((await probar()).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('canal desconocido → 422; voice → 409 voice_disabled sin llamar a nadie', async () => {
    expect((await probar({ channel: 'sms' })).status).toBe(422);
    const r = await probar({ channel: 'voice' });
    expect(r.status).toBe(409);
    expect((await error(r)).details?.reason).toBe('voice_disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RL_COSTLY superado → 429 rate_limited', async () => {
    const r = await probar(undefined, { env: { RL_COSTLY: { limit: async () => ({ success: false }) } as RateLimit } });
    expect(r.status).toBe(429);
    expect((await error(r)).code).toBe('rate_limited');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('E27 · contacto', () => {
  it('sin contacto con WhatsApp → 409 no_contact', async () => {
    contacto = null;
    const r = await probar();
    expect(r.status).toBe(409);
    expect((await error(r)).details?.reason).toBe('no_contact');
    const op = doble.ops.find((o) => o.table === 'contacts')!;
    expect(eqDe(op, 'org_id')).toBe(ORG);
    expect(eqDe(op, 'whatsapp')).toBe(true);
  });

  it('contacto sin verificar → 409 unverified, fila failed/unverified y ni un fetch', async () => {
    contacto = { id: 'c1', phone_e164: '+584141234567', verified_at: null };
    const r = await probar();
    expect(r.status).toBe(409);
    const e = await error(r);
    expect(e.code).toBe('conflict');
    expect(e.details?.reason).toBe('unverified');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts()).toEqual([{ org_id: ORG, channel: 'whatsapp', template: 'test_v1', recipient_masked: '+58•••4567',
      status: 'failed', error: 'unverified' }]);
    expect(updates()).toEqual([]);
  });
});

describe('E27 · envío', () => {
  it('verificado → 200 {ok, provider_id}, texto al número sin "+", fila queued ANTES del envío y update a sent', async () => {
    let filasAlEnviar: unknown[] = [];
    fetchMock.mockImplementation(async () => {
      filasAlEnviar = inserts().map((f) => f.status);
      return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.HBgMprueba' }] }));
    });
    const r = await probar();
    expect(r.status).toBe(200);
    expect(NotificationTestResult.parse(await r.json())).toEqual({ ok: true, provider_id: 'wamid.HBgMprueba' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/1234567890/messages');
    const enviado = JSON.parse(String(init.body)) as { to: string; type: string; text: { body: string } };
    expect(enviado.to).toBe('584141234567');
    expect(enviado.type).toBe('text');
    expect(enviado.text.body).toContain('Prueba de VanGUARD');
    expect(enviado.text.body).toContain('Tienda Demo');
    // §12.6: la fila existe (queued) cuando sale la petición a Kapso, sin incident_id (0008g).
    expect(filasAlEnviar).toEqual(['queued']);
    expect(inserts()).toEqual([{ org_id: ORG, channel: 'whatsapp', template: 'test_v1', recipient_masked: '+58•••4567',
      status: 'queued' }]);
    const [cierre, ...resto] = updates();
    expect(resto).toEqual([]);
    expect(cierre!.payload).toMatchObject({ status: 'sent', provider_id: 'wamid.HBgMprueba' });
    expect(String((cierre!.payload as Record<string, unknown>).sent_at)).toMatch(/Z$/);
    expect(eqDe(cierre!, 'id')).toBe('n1');
    expect(eqDe(cierre!, 'org_id')).toBe(ORG);
    expect(eqDe(cierre!, 'status')).toBe('queued');
  });

  it('si la fila queued no se puede escribir (p. ej. 23502) → 500 y ni un fetch: sin registro no sale nada real', async () => {
    errorInsert = { code: '23502' };
    const r = await probar();
    expect(r.status).toBe(500);
    expect((await error(r)).code).toBe('internal');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });

  it('si el update a sent falla, el mensaje ya salió: 200 con provider_id (la fila queda queued y sigue contando)', async () => {
    errorUpdate = { code: '57014' };
    const r = await probar();
    expect(r.status).toBe(200);
    expect(NotificationTestResult.parse(await r.json()).provider_id).toBe('wamid.HBgMprueba');
    expect(inserts()).toEqual([expect.objectContaining({ status: 'queued' })]);
  });

  it('error de Kapso → 502 provider_unavailable con details.provider_code corto y la fila queued pasa a failed', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }), { status: 400 }));
    const r = await probar();
    expect(r.status).toBe(502);
    const e = await error(r);
    expect(e.code).toBe('provider_unavailable');
    expect(e.details).toEqual({ provider_code: '131047' });
    expect(JSON.stringify(e)).not.toContain('Re-engagement');
    expect(inserts()).toEqual([expect.objectContaining({ status: 'queued' })]);
    expect(updates().map((u) => u.payload)).toEqual([{ status: 'failed', error: '131047' }]);
    expect(eqDe(updates()[0]!, 'id')).toBe('n1');
  });

  it('Kapso caído por plazo → 502 con provider_code timeout', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('plazo'), { name: 'TimeoutError' }));
    const r = await probar();
    expect(r.status).toBe(502);
    expect((await error(r)).details?.provider_code).toBe('timeout');
  });

  it('sin KAPSO_API_KEY en el Worker → 502 sin_config, ni un fetch ni fila queued huérfana', async () => {
    const r = await probar(undefined, { env: { KAPSO_API_KEY: undefined } });
    expect(r.status).toBe(502);
    expect((await error(r)).details?.provider_code).toBe('sin_config');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts()).toEqual([]);
  });
});

describe('E27 · topes de §06.9', () => {
  it('10 WhatsApp en la última hora → 429 budget_exceeded y fila skipped_cap, sin llamar a Kapso', async () => {
    usadas = 10;
    const r = await probar();
    expect(r.status).toBe(429);
    const e = await error(r);
    expect(e.code).toBe('budget_exceeded');
    expect(e.details?.reason).toBe('cap');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inserts()).toEqual([expect.objectContaining({ status: 'skipped_cap' })]);
    const conteo = doble.ops.find((o) => o.table === 'notifications' && o.action === 'select')!;
    expect(eqDe(conteo, 'org_id')).toBe(ORG);
    expect(conteo.filters).toContainEqual(['status', 'in', ['queued', 'sent', 'delivered', 'read']]);
  });

  it('la org de demo tiene tope 30', async () => {
    org = { name: 'Demo', is_demo: true };
    usadas = 10;
    expect((await probar()).status).toBe(200);
    usadas = 30;
    expect((await probar()).status).toBe(429);
  });
});

// Base viva en memoria con el esquema tras 0008g: incident_id nulo solo con la plantilla de prueba (23514 si no). Así se
// prueba el recorrido entero del criterio de §16: E27 deja la fila, Kapso responde y E31 la marca delivered.
describe('E27 → E31 · la fila de la prueba se puede casar y cuenta para el tope', () => {
  type FilaN = Record<string, unknown>;
  const SECRETO = ['secreto', 'webhook', 'prueba'].join('-');
  const enc = new TextEncoder();
  let filas: FilaN[];
  let pendientes: Promise<unknown>[];

  const cumple = (f: FilaN, op: Op) =>
    op.filters.every(([col, o, v]) => (o === 'eq' ? f[col] === v : o === 'in' ? (v as unknown[]).includes(f[col]) : true));

  beforeEach(() => {
    filas = [];
    pendientes = [];
    let n = 0;
    doble = dbDoble({
      tabla: (op: Op): Resp | undefined => {
        if (op.table === 'org_members') return { data: { role: rol } };
        if (op.table === 'contacts') return { data: contacto };
        if (op.table === 'orgs') return { data: org };
        if (op.table === 'webhook_events') return {};
        if (op.table !== 'notifications') return undefined;
        if (op.action === 'insert') {
          const f: FilaN = { id: `n${++n}`, incident_id: null, provider_id: null, ...(op.payload as FilaN) };
          if (f.incident_id === null && f.template !== 'test_v1') return { error: { code: '23514' } };
          filas.push(f);
          return { data: { id: f.id } };
        }
        const elegidas = filas.filter((f) => cumple(f, op));
        if (op.action === 'update') {
          for (const f of elegidas) Object.assign(f, op.payload);
          return { data: elegidas.map((f) => ({ id: f.id })) };
        }
        if (op.action === 'select') return { count: elegidas.length };
        return undefined;
      },
      claims,
    });
    estado.client = doble.client;
  });

  async function webhook(evento: string, payload: unknown) {
    const cuerpo = JSON.stringify(payload);
    const k = await crypto.subtle.importKey('raw', enc.encode(SECRETO), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const firma = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(cuerpo))),
      (b) => b.toString(16).padStart(2, '0')).join('');
    const ctx = { waitUntil: (p: Promise<unknown>) => { pendientes.push(p); }, passThroughOnException() {}, props: {} } as
      unknown as ExecutionContext;
    const r = await app.request('https://officialvanguard.com/webhooks/kapso', {
      method: 'POST', body: cuerpo,
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', 'x-webhook-event': evento,
        'x-idempotency-key': `evt-${evento}`, 'x-webhook-signature': firma },
    }, envDoble({ KAPSO_WEBHOOK_SECRET: SECRETO }).env, ctx);
    await Promise.all(pendientes);
    return r;
  }

  it('E27 deja la fila queued antes del envío, la cierra en sent con el wamid y E31 delivered la marca', async () => {
    let alEnviar: unknown[] = [];
    fetchMock.mockImplementation(async () => {
      alEnviar = filas.map((f) => f.status);
      return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.HBgMprueba' }] }));
    });
    expect((await probar()).status).toBe(200);
    expect(alEnviar).toEqual(['queued']);
    expect(filas).toEqual([expect.objectContaining({ org_id: ORG, incident_id: null, template: 'test_v1', status: 'sent',
      provider_id: 'wamid.HBgMprueba' })]);

    const ahora = String(Math.floor(Date.now() / 1000));
    const r = await webhook('whatsapp.message.delivered', {
      message: { id: 'wamid.HBgMprueba', type: 'text', kapso: { direction: 'outbound', status: 'delivered',
        statuses: [{ id: 'wamid.HBgMprueba', status: 'delivered', timestamp: ahora }] } },
      phone_number_id: '1234567890',
    });
    expect(r.status).toBe(200);
    expect(filas).toEqual([expect.objectContaining({ status: 'delivered', delivered_at: expect.stringMatching(/Z$/) })]);
  });

  it('error de Kapso: una sola fila, queued → failed con el código corto', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'x', code: 131047 } }), { status: 400 }));
    expect((await probar()).status).toBe(502);
    expect(filas).toEqual([expect.objectContaining({ status: 'failed', error: '131047', provider_id: null })]);
  });

  it('cada prueba enviada cuenta para el tope de 10 por hora; las failed/unverified no', async () => {
    for (let i = 0; i < 9; i++) filas.push({ id: `v${i}`, org_id: ORG, channel: 'whatsapp', status: 'sent', template: 'test_v1' });
    filas.push({ id: 'f1', org_id: ORG, channel: 'whatsapp', status: 'failed', error: 'unverified', template: 'test_v1' });
    expect((await probar()).status).toBe(200);
    const r = await probar();
    expect(r.status).toBe(429);
    expect((await error(r)).details?.reason).toBe('cap');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// 0008g: la columna incident_id de notifications acaba admitiendo null tras aplicar las migraciones en orden.
describe('migraciones · notifications.incident_id', () => {
  it('0005 la crea NOT NULL y una migración posterior la deja nullable (y ninguna la vuelve a cerrar)', () => {
    const dir = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url).href);
    const archivos = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const sql = archivos.map((f) => readFileSync(join(dir, f), 'utf8').toLowerCase());
    const crea = sql.findIndex((s) => /incident_id uuid not null references public\.incidents/.test(s)
      && s.includes('create table if not exists public.notifications'));
    const abre = sql.findIndex((s) => /alter table public\.notifications alter column incident_id drop not null/.test(s));
    expect(crea).toBeGreaterThanOrEqual(0);
    expect(abre).toBeGreaterThan(crea);
    expect(sql.slice(abre).some((s) => /alter table public\.notifications alter column incident_id set not null/.test(s)))
      .toBe(false);
    expect(sql[abre]).toMatch(/check \(incident_id is not null or template = 'test_v1'\)/);
  });
});
