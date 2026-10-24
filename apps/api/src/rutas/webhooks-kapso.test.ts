import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody } from '@vanguard/contracts';
import { sha256Hex } from '../lib/hmac.ts';
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
let rpc: (name: string, args: Record<string, unknown>) => Resp | undefined;
let pendientes: Promise<unknown>[];
let logs: { mock: { calls: unknown[][] } };

beforeEach(() => {
  vistas = new Set();
  pendientes = [];
  tabla = () => undefined;
  rpc = () => undefined;
  doble = dbDoble({
    rpc: (name, args) => rpc(name, args),
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

describe('E31 · botones: registro', () => {
  it('ack sin aprobación que canjear → log sin teléfono completo ni nonce, canje con sha256 y sin tocar incidentes', async () => {
    const r = await enviar(boton(`ack:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received' });
    expect(r.status).toBe(200);
    expect(doble.rpcs).toEqual([{ name: 'vg_redeem_approval',
      args: { p_approval: null, p_nonce_hash: `\\x${await sha256Hex(NONCE)}`, p_recipient: TEL } }]);
    expect(doble.ops.map((o) => o.table)).toEqual(['webhook_events']);
    const linea = lineas().find((l) => l.includes('"kapso.boton"'))!;
    expect(JSON.parse(linea)).toMatchObject({ accion: 'ack', codigo: 'A1F3C9', remitente: '+58•••4567' });
    expect(JSON.parse(lineas().find((l) => l.includes('"kapso.boton_canje"'))!)).toMatchObject({ resultado: 'sin_canje' });
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

  it('ok, no y blk solo se registran (hito siguiente): ni canje ni efecto', async () => {
    for (const [i, a] of ['ok', 'no', 'blk'].entries()) {
      await enviar(boton(`${a}:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received', clave: `x${i}` });
    }
    expect(doble.rpcs).toHaveLength(0);
    expect(doble.ops.every((o) => o.table === 'webhook_events')).toBe(true);
  });

  it('resumenKapso marca los botones que no casan como desconocido', () => {
    expect(resumenKapso('whatsapp.message.received', boton('noop')).items[0]!.button).toBe('desconocido');
  });
});

describe('E31 · botones ack/snz: canje del nonce', () => {
  const ORG_A = '0f6c0000-0000-4000-8000-00000000000a';
  const ORG_B = '0f6c0000-0000-4000-8000-00000000000b';
  const INC = '9e0b0000-0000-4000-8000-000000000001';
  const NONCE_SNZ = 'Qw8rTy6Ui4Op2As0' + 'Df1gHj';
  type Fila = Record<string, unknown>;
  let aprobaciones: Map<string, Fila>;
  let incidente: Fila;
  let contacto: Fila | null;

  // Doble de approvals con la semántica de vg_redeem_approval: un solo uso, no vencida y recipient = remitente.
  async function sembrar(nonce: string, extra: Fila = {}) {
    aprobaciones.set(`\\x${await sha256Hex(nonce)}`, { id: crypto.randomUUID(), org_id: ORG_A, incident_id: INC,
      action_kind: 'ack', channel: 'whatsapp', recipient: TEL, used_at: null, expires_at: new Date(Date.now() + 600_000).toISOString(), ...extra });
  }
  beforeEach(() => {
    aprobaciones = new Map();
    incidente = { id: INC, code: 'A1F3C9', status: 'open', acked_at: null, muted_until: null,
      details: { ip: 'x', n_60s: 180, detected_at: '2026-10-24T19:01:06.000Z' } };
    contacto = { id: 'c1', verified_at: '2026-10-24T14:00:00+00:00' };
    rpc = (name, args) => {
      if (name !== 'vg_redeem_approval') return undefined;
      const f = aprobaciones.get(String(args.p_nonce_hash));
      if (!f || f.used_at || Date.parse(String(f.expires_at)) <= Date.now() || f.recipient !== args.p_recipient) return { data: [] };
      f.used_at = new Date().toISOString();
      return { data: [{ ...f }] };
    };
    tabla = (op) => {
      if (op.table === 'incidents' && op.action === 'select') {
        return { data: eqDe(op, 'id') === INC && eqDe(op, 'org_id') === ORG_A ? incidente : null };
      }
      if (op.table === 'contacts') {
        return { data: eqDe(op, 'org_id') === ORG_A && eqDe(op, 'phone_e164') === `+${TEL}` ? contacto : null };
      }
      return undefined;
    };
  });
  const incUpdates = () => doble.ops.filter((o) => o.table === 'incidents' && o.action === 'update');
  const resultado = () => lineas().filter((l) => l.includes('"kapso.boton_canje"')).map((l) => JSON.parse(l).resultado as string);

  it('ack válido → incidente ack con acked_at y acked_via whatsapp, filtrando por id, org y status', async () => {
    await sembrar(NONCE);
    await enviar(boton(`ack:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received' });
    const [u] = incUpdates();
    expect(u!.payload).toEqual({ status: 'ack', acked_at: expect.stringMatching(/Z$/), acked_via: 'whatsapp' });
    expect(eqDe(u!, 'id')).toBe(INC);
    expect(eqDe(u!, 'org_id')).toBe(ORG_A);
    expect(eqDe(u!, 'status')).toBe('open');
    expect(resultado()).toEqual(['aplicado']);
  });

  it('el mismo nonce otra vez (otro evento de Kapso) → sin efecto: ya está usado', async () => {
    await sembrar(NONCE);
    await enviar(boton(`ack:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received', clave: 'e1' });
    await enviar(boton(`ack:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received', clave: 'e2' });
    expect(incUpdates()).toHaveLength(1);
    expect(resultado()).toEqual(['aplicado', 'sin_canje']);
  });

  it('nonce vencido o de otro remitente → sin efecto', async () => {
    await sembrar(NONCE, { expires_at: new Date(Date.now() - 1000).toISOString() });
    await sembrar(NONCE_SNZ, { recipient: '584249998877', action_kind: 'mute' });
    await enviar(boton(`ack:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received', clave: 'v1' });
    await enviar(boton(`snz:A1F3C9:${NONCE_SNZ}`), { evento: 'whatsapp.message.received', clave: 'v2' });
    expect(incUpdates()).toHaveLength(0);
    expect(resultado()).toEqual(['sin_canje', 'sin_canje']);
  });

  it('nonce de un incidente de otra org → sin efecto (el incidente se busca por id y org de la aprobación)', async () => {
    await sembrar(NONCE, { org_id: ORG_B });
    await enviar(boton(`ack:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received' });
    expect(incUpdates()).toHaveLength(0);
    expect(resultado()).toEqual(['otro_incidente']);
    const lectura = doble.ops.find((o) => o.table === 'incidents')!;
    expect(eqDe(lectura, 'org_id')).toBe(ORG_B);
  });

  it('código del botón distinto del incidente de la aprobación → sin efecto', async () => {
    await sembrar(NONCE);
    await enviar(boton(`ack:B2C3D4:${NONCE}`), { evento: 'whatsapp.message.received' });
    expect(incUpdates()).toHaveLength(0);
    expect(resultado()).toEqual(['otro_incidente']);
  });

  it('remitente que ya no es contacto verificado de la org → sin efecto', async () => {
    await sembrar(NONCE);
    contacto = { id: 'c1', verified_at: null };
    await enviar(boton(`ack:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received' });
    expect(incUpdates()).toHaveLength(0);
    expect(resultado()).toEqual(['no_contacto']);
  });

  it('nonce de snz usado en un botón ack → sin efecto (cada nonce vale para su acción)', async () => {
    await sembrar(NONCE, { action_kind: 'mute' });
    await enviar(boton(`ack:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received' });
    expect(incUpdates()).toHaveLength(0);
    expect(resultado()).toEqual(['tipo_distinto']);
  });

  it('snz válido → muted_until = ahora + 1 h y details.muted_at, conservando el resto de details', async () => {
    await sembrar(NONCE_SNZ, { action_kind: 'mute' });
    const antes = Date.now();
    await enviar(boton(`snz:A1F3C9:${NONCE_SNZ}`), { evento: 'whatsapp.message.received' });
    const [u] = incUpdates();
    const p = u!.payload as { muted_until: string; details: Record<string, unknown> };
    const hasta = Date.parse(p.muted_until) - antes;
    expect(hasta).toBeGreaterThanOrEqual(3_600_000 - 50);
    expect(hasta).toBeLessThan(3_600_000 + 5_000);
    expect(p.details).toEqual({ ip: 'x', n_60s: 180, detected_at: '2026-10-24T19:01:06.000Z', muted_at: expect.stringMatching(/Z$/) });
    expect(eqDe(u!, 'org_id')).toBe(ORG_A);
  });

  it('incidente resuelto o ya con ack → sin efecto', async () => {
    await sembrar(NONCE);
    incidente.status = 'resolved';
    await enviar(boton(`ack:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received', clave: 'r1' });
    await sembrar(NONCE_SNZ);
    incidente.status = 'ack';
    incidente.acked_at = '2026-10-24T19:02:00+00:00';
    await enviar(boton(`ack:A1F3C9:${NONCE_SNZ}`), { evento: 'whatsapp.message.received', clave: 'r2' });
    expect(incUpdates()).toHaveLength(0);
    expect(resultado()).toEqual(['resuelto', 'ya_ack']);
  });
});
