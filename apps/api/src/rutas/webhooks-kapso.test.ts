import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { app } = await import('../app.ts');
const { codigoError, resumenKapso } = await import('./webhooks-kapso.ts');

const enc = new TextEncoder();
// Secreto y nonce armados en tiempo de ejecución: ningún literal con forma de secreto real.
const SECRETO = ['secreto', 'webhook', 'prueba'].join('-');
const NONCE = 'Zx9kQm2Lp0Ab7Yt4' + 'cD3eFg';
const TEL = '58' + '4141234567';
const URL_WH = 'https://officialvanguard.com/webhooks/kapso';

async function firmar(cuerpo: string, secreto = SECRETO): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(cuerpo))),
    (b) => b.toString(16).padStart(2, '0')).join('');
}

let doble: ReturnType<typeof dbDoble>;
let vistas: Set<string>;
let tabla: (op: Op) => Resp | undefined;
let pendientes: Promise<unknown>[];
let logs: { mock: { calls: unknown[][] } };

beforeEach(() => {
  vistas = new Set();
  pendientes = [];
  tabla = () => undefined;
  doble = dbDoble({
    tabla: (op) => {
      if (op.table === 'webhook_events' && op.action === 'insert') {
        const k = String((op.payload as Record<string, unknown>).external_id);
        if (vistas.has(k)) return { error: { code: '23505' } };
        vistas.add(k);
        return {};
      }
      if (op.table === 'notifications' && op.action === 'update') return { data: [{ id: 'n1' }] };
      return tabla(op);
    },
  });
  estado.client = doble.client;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sin red en las pruebas'); }));
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ctx = () => ({ waitUntil: (p: Promise<unknown>) => { pendientes.push(p); }, passThroughOnException() {}, props: {} }) as
  unknown as ExecutionContext;

type Opciones = { evento?: string; clave?: string | null; firma?: string | null; env?: Partial<CloudflareBindings> };
async function enviar(payload: unknown, o: Opciones = {}) {
  const cuerpo = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' };
  if (o.evento) headers['x-webhook-event'] = o.evento;
  if (o.clave !== null) headers['x-idempotency-key'] = o.clave ?? 'idem-1';
  const firma = o.firma === undefined ? await firmar(cuerpo) : o.firma;
  if (firma !== null) headers['x-webhook-signature'] = firma;
  const r = await app.request(URL_WH, { method: 'POST', headers, body: cuerpo },
    envDoble({ KAPSO_WEBHOOK_SECRET: SECRETO, ...o.env }).env, ctx());
  await Promise.all(pendientes);
  return r;
}

const estadoMsg = (status: string, extra: Record<string, unknown> = {}) => ({
  message: { id: 'wamid.HBgM1', type: 'text', kapso: { direction: 'outbound', status,
    statuses: [{ id: 'wamid.HBgM1', status, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }] } },
  conversation: { phone_number: `+${TEL}` }, phone_number_id: '1234567890',
});
const boton = (id: string) => ({
  message: { id: 'wamid.ENTRA', from: TEL, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'Lo estoy viendo' } },
    kapso: { direction: 'inbound' } },
  conversation: { phone_number: `+${TEL}` }, is_new_conversation: false,
});
const updates = () => doble.ops.filter((o) => o.table === 'notifications' && o.action === 'update');
const lineas = (): string[] => logs.mock.calls.map((c) => String(c[0]));

describe('E31 · firma antes de todo', () => {
  it('firma mala → 401 sin tocar la base', async () => {
    const r = await enviar(estadoMsg('delivered'), { evento: 'whatsapp.message.delivered', firma: 'ab'.repeat(32) });
    expect(r.status).toBe(401);
    expect(ApiErrorBody.parse(await r.json()).error.code).toBe('unauthorized');
    expect(doble.ops).toHaveLength(0);
  });

  it('firma de otro cuerpo, sin cabecera o con otro secreto → 401', async () => {
    const otra = await firmar('{"otro":1}');
    expect((await enviar(estadoMsg('read'), { firma: otra })).status).toBe(401);
    expect((await enviar(estadoMsg('read'), { firma: null })).status).toBe(401);
    expect((await enviar(estadoMsg('read'), { firma: await firmar(JSON.stringify(estadoMsg('read')), 'otro-secreto') })).status).toBe(401);
    expect(doble.ops).toHaveLength(0);
  });

  it('sin KAPSO_WEBHOOK_SECRET en el Worker → 401 siempre (falla cerrada)', async () => {
    const r = await enviar('{}', { env: { KAPSO_WEBHOOK_SECRET: undefined } });
    expect(r.status).toBe(401);
    expect(doble.ops).toHaveLength(0);
  });

  it('no pasa por auth ni por originGuard: un Origin ajeno con firma buena → 200', async () => {
    const cuerpo = JSON.stringify(estadoMsg('read'));
    const r = await app.request(URL_WH, { method: 'POST', body: cuerpo, headers: { origin: 'https://evil.example',
      'x-webhook-signature': await firmar(cuerpo), 'x-webhook-event': 'whatsapp.message.read', 'x-idempotency-key': 'o-1' } },
    envDoble({ KAPSO_WEBHOOK_SECRET: SECRETO }).env, ctx());
    await Promise.all(pendientes);
    expect(r.status).toBe(200);
  });

  it('RL_API por IP: superado → 429 antes de leer la firma', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const r = await enviar('{}', { env: { RL_API: { limit } as RateLimit } });
    expect(r.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: 'ip:203.0.113.9' });
    expect(doble.ops).toHaveLength(0);
  });
});

describe('E31 · dedupe y proceso en waitUntil', () => {
  it('la misma X-Idempotency-Key dos veces → 200 las dos, se procesa una', async () => {
    const p = estadoMsg('delivered');
    const a = await enviar(p, { evento: 'whatsapp.message.delivered', clave: 'evt-7' });
    const b = await enviar(p, { evento: 'whatsapp.message.delivered', clave: 'evt-7' });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(updates()).toHaveLength(1);
    expect(doble.ops.filter((o) => o.table === 'webhook_events')).toHaveLength(2);
  });

  it('webhook_events lleva provider kapso, la clave y un payload_redacted sin teléfono ni nonce', async () => {
    await enviar(boton(`ack:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received', clave: 'evt-8' });
    const ins = doble.ops.find((o) => o.table === 'webhook_events')!;
    const fila = ins.payload as Record<string, unknown>;
    expect(fila.provider).toBe('kapso');
    expect(fila.external_id).toBe('evt-8');
    const txt = JSON.stringify(fila.payload_redacted);
    expect(txt).not.toContain('4141234567');
    expect(txt).not.toContain(NONCE);
    expect(fila.payload_redacted).toEqual({ event: 'whatsapp.message.received',
      items: [{ message_id: 'wamid.ENTRA', type: 'interactive', status: null, error_code: null, button: 'ack' }] });
  });

  it('sin X-Idempotency-Key la clave es el sha256 del cuerpo crudo', async () => {
    await enviar(estadoMsg('read'), { evento: 'whatsapp.message.read', clave: null });
    const fila = doble.ops.find((o) => o.table === 'webhook_events')!.payload as Record<string, unknown>;
    expect(fila.external_id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('error de la base al deduplicar (no 23505) → 500 y no se procesa (Kapso reintenta)', async () => {
    doble = dbDoble({ tabla: (op) => (op.table === 'webhook_events' ? { error: { code: '57014' } } : undefined) });
    estado.client = doble.client;
    const r = await enviar(estadoMsg('delivered'), { evento: 'whatsapp.message.delivered' });
    expect(r.status).toBe(500);
    expect(updates()).toHaveLength(0);
  });

  it('el proceso corre en waitUntil (la respuesta no lo espera)', async () => {
    const cuerpo = JSON.stringify(estadoMsg('delivered'));
    const propios: Promise<unknown>[] = [];
    const c = { waitUntil: (p: Promise<unknown>) => { propios.push(p); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const r = await app.request(URL_WH, { method: 'POST', body: cuerpo, headers: { 'x-webhook-signature': await firmar(cuerpo),
      'x-webhook-event': 'whatsapp.message.delivered', 'x-idempotency-key': 'w-1' } }, envDoble({ KAPSO_WEBHOOK_SECRET: SECRETO }).env, c);
    expect(r.status).toBe(200);
    expect(propios).toHaveLength(1);
    await Promise.all(propios);
    expect(updates()).toHaveLength(1);
  });
});

describe('E31 · estados de entrega', () => {
  it('delivered actualiza notifications filtrando por provider_id, sin deshacer un read', async () => {
    await enviar(estadoMsg('delivered'), { evento: 'whatsapp.message.delivered' });
    const [u] = updates();
    expect(eqDe(u!, 'provider_id')).toBe('wamid.HBgM1');
    expect(eqDe(u!, 'channel')).toBe('whatsapp');
    expect(u!.filters).toContainEqual(['status', 'in', ['queued', 'sent']]);
    const cambio = u!.payload as Record<string, unknown>;
    expect(cambio.status).toBe('delivered');
    expect(String(cambio.delivered_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('read pone read_at; sent pone sent_at', async () => {
    await enviar(estadoMsg('read'), { evento: 'whatsapp.message.read', clave: 'r' });
    await enviar(estadoMsg('sent'), { evento: 'whatsapp.message.sent', clave: 's' });
    const [r, s] = updates();
    expect(r!.payload).toMatchObject({ status: 'read' });
    expect(r!.payload).toHaveProperty('read_at');
    expect(r!.filters).toContainEqual(['status', 'in', ['queued', 'sent', 'delivered']]);
    expect(s!.payload).toMatchObject({ status: 'sent' });
    expect(s!.payload).toHaveProperty('sent_at');
  });

  it('failed guarda el código corto (131047 = ventana de 24 h cerrada), nunca el título del error', async () => {
    await enviar(estadoMsg('failed', { errors: [{ code: 131047, title: 'Re-engagement message' }] }), { evento: 'whatsapp.message.failed' });
    const [u] = updates();
    expect(u!.payload).toEqual({ status: 'failed', error: '131047' });
  });

  it('sin cabecera de evento usa message.kapso.status', async () => {
    await enviar(estadoMsg('delivered'));
    expect(updates()[0]!.payload).toMatchObject({ status: 'delivered' });
  });

  it('codigoError lee statuses[].errors[].code y de respaldo message.errors[].code', () => {
    expect(codigoError({ kapso: { statuses: [{ errors: [{ code: 131026 }] }] } })).toBe('131026');
    expect(codigoError({ errors: [{ code: '131047' }] })).toBe('131047');
    expect(codigoError({ errors: [{ code: 'mal formado; con espacios' }] })).toBeNull();
    expect(codigoError({})).toBeNull();
  });
});

describe('E31 · botones (hito 5: solo se registran)', () => {
  it('ack:<código>:<nonce> se registra con log sin teléfono completo y sin canje ni acciones', async () => {
    const r = await enviar(boton(`ack:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received' });
    expect(r.status).toBe(200);
    expect(doble.rpcs).toHaveLength(0);
    expect(doble.ops.map((o) => o.table)).toEqual(['webhook_events']);
    const linea = lineas().find((l) => l.includes('"kapso.boton"'))!;
    expect(JSON.parse(linea)).toMatchObject({ accion: 'ack', codigo: 'A1F3C9', remitente: '+58•••4567' });
    expect(lineas().join('\n')).not.toContain('4141234567');
    expect(lineas().join('\n')).not.toContain(NONCE);
  });

  it('el botón de plantilla (message.button.payload) también se lee; los textos libres se ignoran', async () => {
    await enviar({ message: { id: 'w2', from: TEL, type: 'button', button: { payload: `snz:A1F3C9:${NONCE}`, text: 'Silenciar 1 h' } } },
      { evento: 'whatsapp.message.received', clave: 'b2' });
    await enviar({ message: { id: 'w3', from: TEL, type: 'text', text: { body: 'hola' } } }, { evento: 'whatsapp.message.received', clave: 'b3' });
    expect(lineas().some((l) => l.includes('"kapso.boton"') && l.includes('"snz"'))).toBe(true);
    expect(lineas().some((l) => l.includes('"kapso.texto_ignorado"'))).toBe(true);
    expect(updates()).toHaveLength(0);
  });

  it('resumenKapso marca los botones que no casan como desconocido', () => {
    expect(resumenKapso('whatsapp.message.received', boton('noop')).items[0]!.button).toBe('desconocido');
  });
});
