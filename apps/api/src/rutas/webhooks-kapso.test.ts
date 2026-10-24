import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody } from '@vanguard/contracts';
import { sha256Hex } from '../lib/hmac.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown, bloqueo: null as null | ((...a: unknown[]) => unknown) }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
// canjearBotonBloqueo real salvo que una prueba ponga estado.bloqueo (sus internos se prueban en actions/approvals.test.ts).
vi.mock('../actions/approvals.ts', async (orig) => {
  const real = await orig<typeof import('../actions/approvals.ts')>();
  return { ...real, canjearBotonBloqueo: (...a: Parameters<typeof real.canjearBotonBloqueo>) =>
    (estado.bloqueo ? estado.bloqueo(...a) : real.canjearBotonBloqueo(...a)) };
});
// getKeys de mentira: FPK de bytes conocidos (0x11…) para recalcular los códigos con node:crypto; cuenta las llamadas.
const llaves = vi.hoisted(() => ({ llamadas: 0 }));
vi.mock('../lib/keyring.ts', () => ({
  getKeys: async (_env: unknown, _admin: unknown, kid: string) => {
    llaves.llamadas++;
    const fpk = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0x11), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return { kid, kek: fpk, fpk };
  },
  activeKid: async () => 'v1',
}));

const { app } = await import('../app.ts');
const { codigoError, nombreParaMensaje, resumenKapso, TEXTO_BAJA, TEXTO_CODIGO_NO_VALIDO, textoListo } =
  await import('./webhooks-kapso.ts');
const { textoEnlace } = await import('../lib/verificacion.ts');

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
    // Además del dedupe, solo la última entrada del teléfono (B3): nada de incidentes.
    expect(doble.ops.map((o) => o.table)).toEqual(['webhook_events', 'contacts']);
    expect(Object.keys(doble.ops[1]!.payload as object)).toEqual(['wa_last_inbound_at']);
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

  it('ok, no y blk van a canjearBotonBloqueo con el botón y el remitente; fuera de producción, dry_run sin efecto', async () => {
    for (const [i, a] of ['ok', 'no', 'blk'].entries()) {
      await enviar(boton(`${a}:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received', clave: `x${i}` });
    }
    // envDoble no es production: el canje real contesta dry_run sin tocar la base ni Cloudflare.
    expect(doble.rpcs).toHaveLength(0);
    expect(doble.ops.every((o) => o.table === 'webhook_events'
      || (o.table === 'contacts' && Object.keys(o.payload as object).join() === 'wa_last_inbound_at'))).toBe(true);
    expect(lineas().filter((l) => l.includes('"kapso.bloqueo_canje"') && l.includes('"dry_run"'))).toHaveLength(3);
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

describe('E31 · VERIFICAR, BAJA y última entrada (B3)', () => {
  const ORG_A = 'aaaa0000-0000-4000-8000-00000000000a';
  const ORG_B = 'bbbb0000-0000-4000-8000-00000000000b';
  const C_A = 'c0c00000-0000-4000-8000-00000000000a';
  const C_B = 'c0c00000-0000-4000-8000-00000000000b';
  const C_OTRO = 'c0c00000-0000-4000-8000-0000000000c1';
  const OTRO = '58' + '4249998877';
  const SIN_CONTACTO = '58' + '4161112233';
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  type Contacto = { id: string; org_id: string; phone_e164: string; whatsapp: boolean; verified_at: string | null;
    optin_at: string | null; wa_last_inbound_at: string | null };
  let contactos: Contacto[];
  let orgs: Record<string, string>;
  let rlWa: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let envWa: Partial<CloudflareBindings>;
  let n = 0;

  // Referencia independiente (node:crypto) del código de E26: HMAC-SHA256(fpk, contact|org|id), 6 hex en mayúsculas.
  const codigoDe = (org: string, id: string) =>
    createHmac('sha256', Buffer.alloc(32, 0x11)).update(`contact|${org}|${id}`).digest('hex').slice(0, 6).toUpperCase();
  const contacto = (id: string, org_id: string, tel: string): Contacto =>
    ({ id, org_id, phone_e164: `+${tel}`, whatsapp: true, verified_at: null, optin_at: null, wa_last_inbound_at: null });
  const fila = (id: string) => contactos.find((c) => c.id === id)!;
  // ¿La fila pasa los .eq de la consulta? 'is.<col>' es el .is(col, null) que añade conIs.
  const pasa = (f: Record<string, unknown>, op: Op) =>
    op.filters.every(([c, o, v]) => o !== 'eq' || (c.startsWith('is.') ? f[c.slice(3)] === v : f[c] === v));
  // El doble común no implementa .is(): aquí se añade y queda como filtro ['is.<col>', 'eq', valor].
  const conIs = (c: ReturnType<typeof dbDoble>['client']) => ({ ...c, from: (t: string) => {
    const b = c.from(t);
    return Object.assign(b, { is: (col: string, v: unknown) => b.eq(`is.${col}`, v) });
  } });

  beforeEach(() => {
    n = 0;
    llaves.llamadas = 0;
    contactos = [contacto(C_A, ORG_A, TEL), contacto(C_B, ORG_B, TEL), contacto(C_OTRO, ORG_A, OTRO)];
    orgs = { [ORG_A]: 'Acme Seguridad', [ORG_B]: 'Banco Ejemplo' };
    estado.client = conIs(doble.client);
    tabla = (op) => {
      if (op.table === 'orgs' && op.action === 'select') {
        const id = String(eqDe(op, 'id'));
        return { data: orgs[id] ? { name: orgs[id] } : null };
      }
      if (op.table !== 'contacts') return undefined;
      const filas = contactos.filter((f) => pasa(f, op));
      if (op.action === 'select') return { data: filas.map((f) => ({ id: f.id, org_id: f.org_id, verified_at: f.verified_at })) };
      if (op.action === 'update') {
        for (const f of filas) Object.assign(f, op.payload);
        return { data: filas.map((f) => ({ id: f.id })) };
      }
      return undefined;
    };
    // Doble de RL_WA: 3 por clave (la ventana de 60 s no corre dentro de una prueba).
    const usos = new Map<string, number>();
    rlWa = vi.fn(async ({ key }: { key: string }) => {
      const k = (usos.get(key) ?? 0) + 1;
      usos.set(key, k);
      return { success: k <= 3 };
    });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.RESP1' }] })));
    vi.stubGlobal('fetch', fetchMock);
    envWa = { KAPSO_API_KEY: ['kapso', 'prueba'].join('-'), KAPSO_PHONE_NUMBER_ID: '1234567890',
      RL_WA: { limit: rlWa } as unknown as RateLimit };
  });

  const texto = (body: string, from: string | null = TEL) => ({
    message: { id: `wamid.T${++n}`, ...(from ? { from } : {}), type: 'text', text: { body }, kapso: { direction: 'inbound' } },
    ...(from ? { conversation: { phone_number: `+${from}` } } : {}),
  });
  const entra = (p: unknown, clave = `k${++n}`) => enviar(p, { evento: 'whatsapp.message.received', clave, env: envWa });
  type Enviado = { messaging_product: string; to: string; type: string; text: { body: string } };
  const enviados = (): Enviado[] => fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Enviado);
  const cambios = (col: string) => doble.ops.filter((o) => o.table === 'contacts' && o.action === 'update'
    && col in (o.payload as object));
  const sinRastro = (cod: string) => {
    const todo = lineas().join('\n');
    expect(todo).not.toContain('4141234567');
    expect(todo).not.toMatch(new RegExp(`\\b${cod}\\b`, 'i'));
    expect(todo).not.toMatch(/VERIFICAR\s|Acme|Banco/);   // ni el texto ni el nombre de la org
  };

  it('VERIFICAR con código y from correctos → verified_at y optin_at, y una confirmación con el nombre de la org', async () => {
    const cod = codigoDe(ORG_A, C_A);
    const r = await entra(texto(`VERIFICAR ${cod}`));
    expect(r.status).toBe(200);
    expect(fila(C_A).verified_at).toMatch(ISO);
    expect(fila(C_A).optin_at).toBe(fila(C_A).verified_at);
    expect(fila(C_B).verified_at).toBeNull();
    // Candidatos: ese teléfono con whatsapp, en todas las orgs (sin org_id); UNA getKeys para los dos candidatos.
    const sel = doble.ops.find((o) => o.table === 'contacts' && o.action === 'select')!;
    expect(eqDe(sel, 'phone_e164')).toBe(`+${TEL}`);
    expect(eqDe(sel, 'whatsapp')).toBe(true);
    expect(eqDe(sel, 'org_id')).toBeUndefined();
    expect(llaves.llamadas).toBe(1);
    const [u] = cambios('verified_at');
    expect(u!.payload).toEqual({ verified_at: fila(C_A).verified_at, optin_at: fila(C_A).verified_at });
    expect([eqDe(u!, 'id'), eqDe(u!, 'org_id'), eqDe(u!, 'phone_e164'), eqDe(u!, 'is.verified_at')])
      .toEqual([C_A, ORG_A, `+${TEL}`, null]);
    expect(enviados()).toEqual([{ messaging_product: 'whatsapp', to: TEL, type: 'text',
      text: { body: 'Listo: este WhatsApp recibirá alertas de seguridad de VanGUARD para "Acme Seguridad". Para dejar de recibirlas escribe BAJA.' } }]);
    expect(rlWa).not.toHaveBeenCalled();   // la primera confirmación no se puede repetir: no gasta RL_WA
    expect(JSON.parse(lineas().find((l) => l.includes('"kapso.verificar"'))!))
      .toMatchObject({ resultado: 'verificado', org_id: ORG_A, remitente: '+58•••4567' });
    sinRastro(cod);
    expect(JSON.stringify(doble.ops.find((o) => o.table === 'webhook_events')!.payload)).not.toContain(cod);
  });

  it('el código correcto desde otro teléfono → no verifica nada; responde lo mismo que a un código malo', async () => {
    await entra(texto(`VERIFICAR ${codigoDe(ORG_A, C_A)}`, OTRO));
    expect(contactos.every((c) => c.verified_at === null)).toBe(true);
    expect(cambios('verified_at')).toHaveLength(0);
    expect(enviados()).toEqual([expect.objectContaining({ to: OTRO, text: { body: TEXTO_CODIGO_NO_VALIDO } })]);
  });

  it('un contacto con whatsapp apagado no es candidato aunque el código sea el suyo', async () => {
    fila(C_A).whatsapp = false;
    await entra(texto(`VERIFICAR ${codigoDe(ORG_A, C_A)}`));
    expect(fila(C_A).verified_at).toBeNull();
    expect(enviados().map((e) => e.text.body)).toEqual([TEXTO_CODIGO_NO_VALIDO]);
  });

  it('código malo → respuesta genérica (igual exista o no el teléfono); la 4.ª en el mismo minuto no responde', async () => {
    expect([codigoDe(ORG_A, C_A), codigoDe(ORG_B, C_B)]).not.toContain('000000');
    for (let i = 0; i < 4; i++) await entra(texto('VERIFICAR 000000'));
    expect(enviados().map((e) => e.text.body)).toEqual([TEXTO_CODIGO_NO_VALIDO, TEXTO_CODIGO_NO_VALIDO, TEXTO_CODIGO_NO_VALIDO]);
    expect(rlWa).toHaveBeenCalledTimes(4);
    expect(rlWa).toHaveBeenCalledWith({ key: `wa:${TEL}` });
    expect(lineas().filter((l) => l.includes('"kapso.respuesta_limitada"'))).toHaveLength(1);
    expect(contactos.every((c) => c.verified_at === null)).toBe(true);
    // Un teléfono que no está en ninguna org recibe exactamente el mismo texto y no se consultan claves.
    llaves.llamadas = 0;
    await entra(texto('VERIFICAR 000000', SIN_CONTACTO));
    expect(enviados().at(-1)).toEqual({ messaging_product: 'whatsapp', to: SIN_CONTACTO, type: 'text',
      text: { body: TEXTO_CODIGO_NO_VALIDO } });
    expect(llaves.llamadas).toBe(0);
    sinRastro('000000');
  });

  it("'verificar <código>' en minúsculas también verifica", async () => {
    const cod = codigoDe(ORG_A, C_A);
    await entra(texto(`verificar ${cod.toLowerCase()}`));
    expect(fila(C_A).verified_at).toMatch(ISO);
    expect(enviados().map((e) => e.text.body)).toEqual([textoListo('Acme Seguridad')]);
  });

  it('el texto completo del enlace wa.me de E26 (textoEnlace) también casa', async () => {
    await entra(texto(textoEnlace(codigoDe(ORG_B, C_B))));
    expect(fila(C_B).verified_at).toMatch(ISO);
    expect(fila(C_A).verified_at).toBeNull();
    expect(enviados().map((e) => e.text.body)).toEqual([textoListo('Banco Ejemplo')]);
  });

  it('dos orgs con el mismo teléfono: cada código verifica solo su contacto', async () => {
    await entra(texto(`VERIFICAR ${codigoDe(ORG_B, C_B)}`));
    expect([fila(C_A).verified_at, typeof fila(C_B).verified_at]).toEqual([null, 'string']);
    await entra(texto(`VERIFICAR ${codigoDe(ORG_A, C_A)}`));
    expect(fila(C_A).verified_at).toMatch(ISO);
    const us = cambios('verified_at');
    expect(us.map((u) => [eqDe(u, 'id'), eqDe(u, 'org_id')])).toEqual([[C_B, ORG_B], [C_A, ORG_A]]);
    expect(enviados().map((e) => e.text.body)).toEqual([textoListo('Banco Ejemplo'), textoListo('Acme Seguridad')]);
    expect(fila(C_OTRO).verified_at).toBeNull();
  });

  it('repetir el VERIFICAR es idempotente: no cambia fechas y vuelve a confirmar (con RL_WA); el mismo evento, nada', async () => {
    const cod = codigoDe(ORG_A, C_A);
    await entra(texto(`VERIFICAR ${cod}`), 'r1');
    const { verified_at, optin_at } = fila(C_A);
    await new Promise((ok) => setTimeout(ok, 5));
    await entra(texto(`VERIFICAR ${cod}`), 'r2');
    await entra(texto(`VERIFICAR ${cod}`), 'r2');   // misma X-Idempotency-Key: deduplicado
    expect(fila(C_A)).toMatchObject({ verified_at, optin_at });
    expect(cambios('verified_at')).toHaveLength(1);
    expect(enviados().map((e) => e.text.body)).toEqual([textoListo('Acme Seguridad'), textoListo('Acme Seguridad')]);
    expect(rlWa).toHaveBeenCalledOnce();
    expect(lineas().some((l) => l.includes('"ya_verificado"'))).toBe(true);
  });

  it('BAJA, STOP y SALIR: verified_at = null en todas las filas del teléfono, optin_at se conserva, y se confirma', async () => {
    const antes = '2026-10-24T14:00:00.000Z';
    for (const [i, palabra] of ['BAJA', 'stop', 'Salir por favor'].entries()) {
      for (const c of contactos) Object.assign(c, { verified_at: antes, optin_at: antes });
      await entra(texto(palabra), `baja${i}`);
      expect([fila(C_A).verified_at, fila(C_B).verified_at]).toEqual([null, null]);
      expect([fila(C_A).optin_at, fila(C_B).optin_at]).toEqual([antes, antes]);
      expect(fila(C_OTRO).verified_at).toBe(antes);
    }
    const us = cambios('verified_at');
    expect(us).toHaveLength(3);
    for (const u of us) {
      expect(u.payload).toEqual({ verified_at: null });
      expect(u.filters).toEqual([['phone_e164', 'eq', `+${TEL}`]]);
    }
    expect(enviados().map((e) => e.text.body)).toEqual([TEXTO_BAJA, TEXTO_BAJA, TEXTO_BAJA]);
    // Sin contactos con ese teléfono: la misma confirmación (no revela nada).
    await entra(texto('BAJA', SIN_CONTACTO));
    expect(enviados().at(-1)).toMatchObject({ to: SIN_CONTACTO, text: { body: TEXTO_BAJA } });
    expect(lineas().join('\n')).not.toContain('4141234567');
  });

  it('cualquier entrante (texto, botón, imagen, solo conversation.phone_number) actualiza wa_last_inbound_at', async () => {
    await entra(texto('hola'));
    await entra(boton(`ack:A1F3C9:${NONCE}`));
    await entra({ message: { id: 'wamid.IMG', from: TEL, type: 'image', image: { id: 'm1' } } });
    await entra({ message: { id: 'wamid.SIN_FROM', type: 'reaction' }, conversation: { phone_number: `+${TEL}` } });
    const us = cambios('wa_last_inbound_at');
    expect(us).toHaveLength(4);
    for (const u of us) {
      expect(Object.keys(u.payload as object)).toEqual(['wa_last_inbound_at']);
      expect(String((u.payload as Record<string, unknown>).wa_last_inbound_at)).toMatch(ISO);
      expect(u.filters).toEqual([['phone_e164', 'eq', `+${TEL}`]]);   // una sentencia, todas las orgs
    }
    expect([fila(C_A).wa_last_inbound_at, fila(C_B).wa_last_inbound_at].every((t) => ISO.test(String(t)))).toBe(true);
    expect(fila(C_OTRO).wa_last_inbound_at).toBeNull();
    // «hola» no se contesta: ni RL_WA ni envío.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rlWa).not.toHaveBeenCalled();
    expect(lineas().some((l) => l.includes('"kapso.texto_ignorado"'))).toBe(true);
  });

  it('sin from ni conversation.phone_number → solo el log kapso.sin_telefono', async () => {
    const r = await entra(texto(`VERIFICAR ${codigoDe(ORG_A, C_A)}`, null));
    expect(r.status).toBe(200);
    expect(doble.ops.map((o) => o.table)).toEqual(['webhook_events']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rlWa).not.toHaveBeenCalled();
    expect(llaves.llamadas).toBe(0);
    expect(lineas().some((l) => l.includes('"kapso.sin_telefono"'))).toBe(true);
  });

  it('un fallo al responder (Kapso caído o sin configurar) no tumba nada: 200, contacto verificado y log', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }));
    const r = await entra(texto(`VERIFICAR ${codigoDe(ORG_A, C_A)}`));
    expect(r.status).toBe(200);
    expect(fila(C_A).verified_at).toMatch(ISO);
    expect(JSON.parse(lineas().find((l) => l.includes('"kapso.respuesta_error"'))!)).toMatchObject({ tipo: 'listo', code: 'unavailable' });
    envWa = { ...envWa, KAPSO_API_KEY: undefined };
    fetchMock.mockClear();
    await entra(texto('BAJA'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lineas().some((l) => l.includes('"kapso.respuesta_error"') && l.includes('"sin_config"'))).toBe(true);
  });

  it('sin binding RL_WA no se responde lo que pasa por el tope (falla cerrada)', async () => {
    envWa = { ...envWa, RL_WA: undefined as unknown as RateLimit };
    await entra(texto('VERIFICAR 000000'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lineas().some((l) => l.includes('"kapso.respuesta_limitada"'))).toBe(true);
  });

  it('presupuesto: un lote de 10 VERIFICAR en el peor caso no pasa de 40 subpeticiones', async () => {
    // Diez contactos con su propio teléfono y su código bueno; Kapso sin red → cada envío reintenta una vez (2 fetch).
    const items = Array.from({ length: 10 }, (_, i) => {
      const tel = '58414' + String(1000000 + i);
      const id = `d0d00000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      contactos.push(contacto(id, ORG_A, tel));
      return { message: { id: `wamid.L${i}`, from: tel, type: 'text', text: { body: `VERIFICAR ${codigoDe(ORG_A, id)}` } } };
    });
    fetchMock.mockImplementation(async () => { throw new TypeError('sin red'); });
    await entra({ data: items });
    const subpeticiones = doble.ops.length + doble.rpcs.length + llaves.llamadas + fetchMock.mock.calls.length
      + rlWa.mock.calls.length;
    expect(subpeticiones).toBeLessThanOrEqual(40);
    expect(contactos.filter((c) => c.verified_at).length).toBe(5);
    expect(JSON.parse(lineas().find((l) => l.includes('"kapso.presupuesto_agotado"'))!)).toMatchObject({ omitidos: 6 });
  });

  it('nombreParaMensaje: sin URL, sin comillas dobles, sin caracteres de formato, una línea de ≤ 40', () => {
    expect(nombreParaMensaje('Acme Seguridad')).toBe('Acme Seguridad');
    const hostil = nombreParaMensaje('Acme https://evil.example/x?t=1 "VIP" visita www.malo.test o acme.com\nya');
    expect(hostil).not.toMatch(/https?:|evil|www\.|malo\.test|acme\.com|"|\n/i);
    expect(hostil).toContain('Acme');
    expect(nombreParaMensaje('‮abc​ def')).toBe('abc def');
    expect(nombreParaMensaje('x'.repeat(80)).length).toBeLessThanOrEqual(40);
    for (const vacio of ['', '   ', 'https://solo.url', 'dominio.com']) expect(nombreParaMensaje(vacio)).toBe('tu organización');
  });

  it('el nombre de la org llega saneado a la confirmación', async () => {
    orgs[ORG_A] = 'Mi "Org" en https://phish.example';
    await entra(texto(`VERIFICAR ${codigoDe(ORG_A, C_A)}`));
    expect(enviados().map((e) => e.text.body)).toEqual([textoListo("Mi 'Org' en")]);
  });
});

describe('E31 · botones ok/no/blk: respuesta del canje (§12.9)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let rlWa: ReturnType<typeof vi.fn>;
  let canje: ReturnType<typeof vi.fn>;
  const envBoton = () => ({ KAPSO_API_KEY: ['kapso', 'prueba'].join('-'), KAPSO_PHONE_NUMBER_ID: '1234567890',
    RL_WA: { limit: rlWa } as unknown as RateLimit });
  beforeEach(() => {
    let usos = 0;
    rlWa = vi.fn(async () => ({ success: ++usos <= 3 }));
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.R1' }] })));
    vi.stubGlobal('fetch', fetchMock);
    canje = vi.fn(async () => ({ resultado: 'ejecutado', texto: 'Bloqueada 186.92.x.x por 1 h. Puedes deshacerlo en la app.', action_id: 'a1' }));
    estado.bloqueo = canje as unknown as (...a: unknown[]) => unknown;
  });
  afterEach(() => { estado.bloqueo = null; vi.unstubAllGlobals(); });
  const pulsar = (a: string, clave: string) =>
    enviar(boton(`${a}:A1F3C9:${NONCE}`), { evento: 'whatsapp.message.received', clave, env: envBoton() });
  const enviados = () => fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { to: string; text: { body: string } });

  it('ok ejecutado → un texto de servicio al remitente con la respuesta del canje (con RL_WA)', async () => {
    await pulsar('ok', 'o1');
    expect(canje).toHaveBeenCalledOnce();
    expect(canje.mock.calls[0]!.slice(1, 3)).toEqual([{ accion: 'ok', codigo: 'A1F3C9', nonce: NONCE }, TEL]);
    expect(rlWa).toHaveBeenCalledWith({ key: `wa:${TEL}` });
    expect(enviados()).toEqual([expect.objectContaining({ to: TEL, text: { body: 'Bloqueada 186.92.x.x por 1 h. Puedes deshacerlo en la app.' } })]);
    expect(lineas().some((l) => l.includes('"kapso.bloqueo_canje"') && l.includes('"ejecutado"') && !l.includes(TEL))).toBe(true);
  });

  it('sin texto no se responde; un botón viejo repetido no pasa de 3 respuestas por minuto', async () => {
    canje.mockResolvedValueOnce({ resultado: 'sin_canje', texto: null });
    await pulsar('no', 'n0');
    expect(fetchMock).not.toHaveBeenCalled();
    canje.mockResolvedValue({ resultado: 'sin_canje', texto: 'Código vencido o ya usado. Abre officialvanguard.com' });
    for (let i = 1; i <= 4; i++) await pulsar('ok', `v${i}`);
    expect(enviados()).toHaveLength(3);
  });

  it('sin presupuesto para el peor caso del canje, ni canje ni respuesta (queda omitido en el log)', async () => {
    const { procesarKapso } = await import('./webhooks-kapso.ts');
    await procesarKapso(envDoble(envBoton()).env, 'whatsapp.message.received', boton(`blk:A1F3C9:${NONCE}`), 'rid-x', { quedan: 5, omitidos: 0 });
    expect(canje).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
