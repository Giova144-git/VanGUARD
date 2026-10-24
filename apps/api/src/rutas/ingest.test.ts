import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, IngestAccepted } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const cred = vi.hoisted(() => ({ ingestKey: vi.fn() }));
vi.mock('../lib/credentials.ts', () => cred);
const motor = vi.hoisted(() => ({ evaluarEnVivo: vi.fn() }));
vi.mock('../engine/evaluar.ts', () => motor);

const { app } = await import('../app.ts');

// Secreto armado en tiempo de ejecución: ningún literal con forma de secreto queda en el repo.
const SECRETO = ['vgi', 'prueba', 'ingesta', 'k'.repeat(24)].join('_');
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const OTRA_ORG = '0f6c0000-0000-4000-8000-000000000002';
const CONN = '1c0e0000-0000-4000-8000-000000000001';
const REVOCADA = '1c0e0000-0000-4000-8000-000000000002';
const DE_CF = '1c0e0000-0000-4000-8000-000000000003';
const AJENA = '1c0e0000-0000-4000-8000-000000000009';
const URL_IN = 'https://officialvanguard.com/ingest/v1/events';
const COLUMNAS = ['auth', 'connection_id', 'ip', 'latency_ms', 'method', 'org_id', 'path', 'status', 'ts', 'ua'];

const CONEXIONES: Record<string, { id: string; org_id: string; provider: string; status: string }> = {
  [CONN]: { id: CONN, org_id: ORG, provider: 'ingest', status: 'active' },
  [REVOCADA]: { id: REVOCADA, org_id: ORG, provider: 'ingest', status: 'revoked' },
  [DE_CF]: { id: DE_CF, org_id: ORG, provider: 'cloudflare', status: 'active' },
};

const te = new TextEncoder();
// Copia literal de firmar() del fragmento de PLAN_MAESTRO 02.5.2 (el BACK no importa apps/web).
async function firmar(secreto: string, ts: string, cuerpo: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', te.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(`${ts}.${cuerpo}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

let doble: ReturnType<typeof dbDoble>;
let errorInsert: { code: string } | null;
let pendientes: Promise<unknown>[];
let logs: { mock: { calls: unknown[][] } };

beforeEach(() => {
  errorInsert = null;
  pendientes = [];
  doble = dbDoble({
    tabla: (op: Op): Resp | undefined => {
      if (op.table === 'connections' && op.action === 'select') {
        const f = CONEXIONES[String(eqDe(op, 'id'))];
        const casa = f && eqDe(op, 'provider') === f.provider && eqDe(op, 'status') === f.status;
        return { data: casa ? { id: f.id, org_id: f.org_id } : null };
      }
      if (op.table === 'edge_hits' && op.action === 'insert') return { error: errorInsert };
      return undefined;
    },
  });
  estado.client = doble.client;
  cred.ingestKey.mockReset();
  cred.ingestKey.mockImplementation(async () =>
    crypto.subtle.importKey('raw', te.encode(SECRETO), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']));
  motor.evaluarEnVivo.mockReset();
  motor.evaluarEnVivo.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sin red en las pruebas'); }));
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ctx = () => ({ waitUntil: (p: Promise<unknown>) => { pendientes.push(p); }, passThroughOnException() {}, props: {} }) as
  unknown as ExecutionContext;
const ahoraS = () => Math.floor(Date.now() / 1000);
const evento = (extra: Record<string, unknown> = {}) => ({ ts: new Date().toISOString(), ip: '198.51.100.23', method: 'GET',
  path: '/admin', status: 404, ua: 'sqlmap/1.8', latency_ms: 12, auth: false, ...extra });
const lote = (n = 3) => ({ events: Array.from({ length: n }, (_, i) => evento({ path: `/p${i}` })) });

type Opciones = { ts?: string; conn?: string; firma?: string | null; secreto?: string; headers?: Record<string, string>;
  env?: Partial<CloudflareBindings>; sinCtx?: boolean };
async function enviar(payload: unknown, o: Opciones = {}) {
  const cuerpo = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ts = o.ts ?? String(ahoraS());
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-vg-conn': o.conn ?? CONN, 'x-vg-ts': ts,
    'cf-ray': 'ray-1', ...o.headers };
  const firma = o.firma === undefined ? await firmar(o.secreto ?? SECRETO, ts, cuerpo) : o.firma;
  if (firma !== null) headers['x-vg-sig'] = firma;
  const { env } = envDoble(o.env);
  const r = await app.request(URL_IN, { method: 'POST', headers, body: cuerpo }, env, o.sinCtx ? undefined : ctx());
  await Promise.all(pendientes);
  return { r, env };
}

const inserts = () => doble.ops.filter((op) => op.table === 'edge_hits' && op.action === 'insert');
const filas = () => (inserts()[0]?.payload ?? []) as Record<string, unknown>[];
const lineas = (): string[] => logs.mock.calls.map((c) => String(c[0]));

describe('E30 · firma del fragmento de 02.5.2', () => {
  it('firmar() da el mismo hex que createHmac de node:crypto', async () => {
    const ts = '1761332460';
    const cuerpo = JSON.stringify(lote(2));
    const hex = await firmar(SECRETO, ts, cuerpo);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe(createHmac('sha256', SECRETO).update(`${ts}.${cuerpo}`).digest('hex'));
  });

  it('firma buena → 202 {accepted:n}, una sola inserción y la clave pedida con org/conn de la fila', async () => {
    const { r } = await enviar(lote(3));
    expect(r.status).toBe(202);
    expect(IngestAccepted.parse(await r.json())).toEqual({ accepted: 3 });
    expect(inserts()).toHaveLength(1);
    expect(filas()).toHaveLength(3);
    expect(cred.ingestKey).toHaveBeenCalledTimes(1);
    expect(cred.ingestKey.mock.calls[0]?.[2]).toEqual({ orgId: ORG, connectionId: CONN, provider: 'ingest', kind: 'read' });
  });

  it('la ruta acepta una firma hecha con createHmac (otro firmante, mismo formato)', async () => {
    const ts = String(ahoraS());
    const cuerpo = JSON.stringify(lote(1));
    const { r } = await enviar(cuerpo, { ts, firma: createHmac('sha256', SECRETO).update(`${ts}.${cuerpo}`).digest('hex') });
    expect(r.status).toBe(202);
  });

  it('x-vg-conn en mayúsculas se normaliza', async () => {
    const { r } = await enviar(lote(1), { conn: CONN.toUpperCase() });
    expect(r.status).toBe(202);
    expect(eqDe(doble.ops[0]!, 'id')).toBe(CONN);
  });
});

describe('E30 · todo fallo de autenticación → 401 sin detalle', () => {
  const rechazo = async (o: Opciones, payload: unknown = lote(2)) => {
    const { r } = await enviar(payload, o);
    expect(r.status).toBe(401);
    const b = ApiErrorBody.parse(await r.json());
    expect(b.error.code).toBe('unauthorized');
    expect(b.error.details).toBeUndefined();
    return b.error.message;
  };
  const sinEfecto = () => {
    expect(inserts()).toHaveLength(0);
    expect(motor.evaluarEnVivo).not.toHaveBeenCalled();
  };

  it('firma alterada en un carácter → 401', async () => {
    const ts = String(ahoraS());
    const cuerpo = JSON.stringify(lote(2));
    const buena = await firmar(SECRETO, ts, cuerpo);
    const alterada = buena.slice(0, -1) + (buena.endsWith('0') ? '1' : '0');
    await rechazo({ ts, firma: alterada }, cuerpo);
    sinEfecto();
  });

  it('firma de otro secreto, de otro cuerpo, de otro ts, sin firma o ilegible → 401', async () => {
    await rechazo({ secreto: 'otro-secreto' });
    const ts = String(ahoraS());
    await rechazo({ ts, firma: await firmar(SECRETO, ts, '{"events":[]}') });
    await rechazo({ ts, firma: await firmar(SECRETO, String(Number(ts) - 1), JSON.stringify(lote(2))) });
    await rechazo({ firma: null });
    await rechazo({ firma: 'zz'.repeat(32) });
    await rechazo({ firma: 'ab'.repeat(31) });
    sinEfecto();
  });

  it('ts fuera de la ventana de 300 s (pasado o futuro) o ilegible → 401 sin tocar la base', async () => {
    await rechazo({ ts: String(ahoraS() - 301) });
    await rechazo({ ts: String(ahoraS() + 301) });
    await rechazo({ ts: 'ayer' });
    await rechazo({ ts: '' });
    expect(doble.ops).toHaveLength(0);
    expect((await enviar(lote(1), { ts: String(ahoraS() - 290) })).r.status).toBe(202);
  });

  it('conexión revocada, de otro provider o inexistente → 401 y nunca se pide la clave', async () => {
    await rechazo({ conn: REVOCADA });
    await rechazo({ conn: DE_CF });
    await rechazo({ conn: AJENA });
    expect(cred.ingestKey).not.toHaveBeenCalled();
    sinEfecto();
  });

  it('x-vg-conn que no es UUID → 401 sin consultar la base', async () => {
    await rechazo({ conn: "1' or '1'='1" });
    await rechazo({ headers: { 'x-vg-conn': '' } });
    expect(doble.ops).toHaveLength(0);
  });

  it('sin secreto guardado (ingestKey lanza) → 401', async () => {
    cred.ingestKey.mockRejectedValue(new Error('CRYPTO_MATERIAL_UNAVAILABLE'));
    await rechazo({});
    sinEfecto();
  });

  it('el mensaje es el mismo para cada causa: no distingue', async () => {
    const ts = String(ahoraS());
    const mensajes = new Set([
      await rechazo({ ts, firma: 'ab'.repeat(32) }),
      await rechazo({ ts: String(ahoraS() - 400) }),
      await rechazo({ conn: REVOCADA }),
      await rechazo({ conn: DE_CF }),
      await rechazo({ conn: 'no-uuid' }),
    ]);
    expect(mensajes.size).toBe(1);
  });

  it('se autentica antes de validar: 101 eventos con firma mala → 401, no 422', async () => {
    await rechazo({ firma: 'ab'.repeat(32) }, lote(101));
  });
});

describe('E30 · límites y validación', () => {
  const grande = () => `{"events":[],"relleno":"${'a'.repeat(65 * 1024)}"}`;

  it('65 KB → 413 invalid_body sin tocar la base (sin Content-Length: se cuenta al leer)', async () => {
    const { r } = await enviar(grande());
    expect(r.status).toBe(413);
    expect(ApiErrorBody.parse(await r.json()).error.code).toBe('invalid_body');
    expect(doble.ops).toHaveLength(0);
  });

  it('65 KB con Content-Length → 413 antes de leer el cuerpo', async () => {
    const cuerpo = grande();
    const { r } = await enviar(cuerpo, { headers: { 'content-length': String(te.encode(cuerpo).length) } });
    expect(r.status).toBe(413);
    expect(doble.ops).toHaveLength(0);
  });

  it('justo 64 KB pasa el límite (luego lo decide la firma y el esquema)', async () => {
    const base = `{"events":[${JSON.stringify(evento())}],"relleno":""}`;
    const cuerpo = base.replace('"relleno":""', `"relleno":"${'a'.repeat(64 * 1024 - te.encode(base).length)}"`);
    expect(te.encode(cuerpo).length).toBe(64 * 1024);
    const { r } = await enviar(cuerpo);
    expect(r.status).toBe(202);
  });

  it('101 eventos con firma buena → 422 con field_errors.events, sin inserción', async () => {
    const { r } = await enviar(lote(101));
    expect(r.status).toBe(422);
    const b = ApiErrorBody.parse(await r.json());
    expect(b.error.code).toBe('invalid_body');
    expect((b.error.details?.field_errors as Record<string, unknown>).events).toBeDefined();
    expect(inserts()).toHaveLength(0);
    expect(motor.evaluarEnVivo).not.toHaveBeenCalled();
  });

  it('0 eventos, evento sin campos o JSON roto (firmados) → 422', async () => {
    expect((await enviar({ events: [] })).r.status).toBe(422);
    expect((await enviar({ events: [{ ip: '198.51.100.23' }] })).r.status).toBe(422);
    expect((await enviar('{"events": [')).r.status).toBe(422);
    expect(inserts()).toHaveLength(0);
  });

  it('RL_INGEST con clave c:<connection_id> tras autenticar → 429; sin firma ni se consulta', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const { r } = await enviar(lote(1), { env: { RL_INGEST: { limit } as RateLimit } });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('10');
    expect(limit).toHaveBeenCalledWith({ key: `c:${CONN}` });
    expect(inserts()).toHaveLength(0);
    limit.mockClear();
    expect((await enviar(lote(1), { firma: 'ab'.repeat(32), env: { RL_INGEST: { limit } as RateLimit } })).r.status).toBe(401);
    expect(limit).not.toHaveBeenCalled();
  });

  it('no pasa por auth, originGuard ni RL_API: Origin ajeno, sin Bearer y RL_API agotado → 202', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const { r } = await enviar(lote(1), { headers: { origin: 'https://evil.example' }, env: { RL_API: { limit } as RateLimit } });
    expect(r.status).toBe(202);
    expect(limit).not.toHaveBeenCalled();
  });
});

describe('E30 · inserción en edge_hits', () => {
  it('org_id y connection_id salen de la fila de connections aunque el cuerpo traiga otros', async () => {
    const { r } = await enviar({ org_id: OTRA_ORG, connection_id: AJENA,
      events: [evento({ org_id: OTRA_ORG, connection_id: AJENA }), evento()] });
    expect(r.status).toBe(202);
    expect(filas()).toHaveLength(2);
    for (const f of filas()) {
      expect(f.org_id).toBe(ORG);
      expect(f.connection_id).toBe(CONN);
      expect(Object.keys(f).sort()).toEqual(COLUMNAS);
    }
  });

  it('mapea EdgeEvent a las columnas y normaliza lo que Postgres rechazaría', async () => {
    const ts = new Date(Date.now() - 5000).toISOString();
    const { r } = await enviar({ events: [
      evento({ ts, ip: ' 2800:03F0:0:0:0:0:0:1 ', path: '/buscar?q=1', ua: 'x\u0000y', latency_ms: 1e12, auth: true, status: 500 }),
      evento({ ip: 'no-es-ip' }),
      evento({ ts: new Date(Date.now() - 25 * 3600_000).toISOString() }),   // fuera de la retención
      evento({ ts: new Date(Date.now() + 3600_000).toISOString() }),        // futuro: contaría siempre en la ventana
      evento({ method: 'POST', path: '/login' }),
    ] });
    expect(r.status).toBe(202);
    expect(IngestAccepted.parse(await r.json())).toEqual({ accepted: 2 });
    expect(filas()).toHaveLength(2);
    expect(filas()[0]).toEqual({ org_id: ORG, connection_id: CONN, ts, ip: '2800:3f0::1', method: 'GET', path: '/buscar',
      status: 500, ua: 'xy', latency_ms: 2_147_483_647, auth: true });
    expect(filas()[1]).toMatchObject({ ip: '198.51.100.23', method: 'POST', path: '/login', ua: 'sqlmap/1.8' });
  });

  it('un surrogate suelto (UA recortado a mitad de un emoji) se sustituye y no tumba el lote', async () => {
    const emoji = '😀';
    await enviar({ events: [evento({ ua: `bot ${emoji}`.slice(0, 5), path: `/x\uDC00y` }), evento({ ua: `ok ${emoji}` })] });
    expect(filas()).toHaveLength(2);
    expect(filas()[0]).toMatchObject({ ua: 'bot �', path: '/x�y' });
    expect(filas()[1]).toMatchObject({ ua: `ok ${emoji}` });   // los pares válidos no se tocan
    const suelto = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(filas().some((f) => Object.values(f as object).some((v) => typeof v === 'string' && suelto.test(v)))).toBe(false);
  });

  it('si ningún evento sirve → 202 {accepted:0} sin inserción ni evaluación', async () => {
    const { r } = await enviar({ events: [evento({ ip: 'x' })] });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: 0 });
    expect(inserts()).toHaveLength(0);
    expect(motor.evaluarEnVivo).not.toHaveBeenCalled();
  });

  it('error de la base al insertar → 500 internal y sin evaluación', async () => {
    errorInsert = { code: '22P02' };
    const { r } = await enviar(lote(2));
    expect(r.status).toBe(500);
    expect(ApiErrorBody.parse(await r.json()).error.code).toBe('internal');
    expect(motor.evaluarEnVivo).not.toHaveBeenCalled();
  });

  it('los logs no llevan IPs, secretos ni firmas', async () => {
    await enviar(lote(2));
    await enviar(lote(2), { firma: 'ab'.repeat(32) });
    const todo = lineas().join('\n');
    expect(todo).not.toContain('198.51.100');
    expect(todo).not.toContain(SECRETO);
    expect(todo).not.toContain('abababab');
  });
});

describe('E30 · evaluación en vivo en waitUntil', () => {
  it('evaluarEnVivo se llama una vez, en waitUntil, con org/conn de la base y el rid', async () => {
    const { r, env } = await enviar(lote(3));
    expect(r.status).toBe(202);
    expect(pendientes).toHaveLength(1);
    expect(motor.evaluarEnVivo).toHaveBeenCalledTimes(1);
    expect(motor.evaluarEnVivo).toHaveBeenCalledWith(env, { orgId: ORG, connectionId: CONN, rid: 'ray-1' });
  });

  it('si la evaluación falla, la respuesta sigue siendo 202 y queda el log', async () => {
    motor.evaluarEnVivo.mockRejectedValue(new TypeError('x'));
    const { r } = await enviar(lote(1));
    expect(r.status).toBe(202);
    expect(lineas().some((l) => l.includes('ingest.evaluacion_error'))).toBe(true);
  });

  it('sin ExecutionContext (dev-node sin doble) se espera en la propia petición', async () => {
    const { r } = await enviar(lote(1), { sinCtx: true });
    expect(r.status).toBe(202);
    expect(motor.evaluarEnVivo).toHaveBeenCalledTimes(1);
  });
});
