import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// El contrato de E30 se lee del paquete por ruta relativa: la víctima no declara dependencias (solo lo usa la prueba).
import { IngestBatch } from '../../../packages/contracts/src/ingest.ts';

// Secreto falso armado por concatenación (sin literales con forma de secreto en el repo).
const SECRETO = 'vg' + 'i_' + 'x'.repeat(43);
const CONN = '00000000-0000-4000-a000-0000000000c1';
const URL_INGEST = 'http://ingest.prueba/ingest/v1/events';
const ENV = { VG_INGEST_SECRET: SECRETO, VG_INGEST_CONN_ID: CONN, VG_INGEST_URL: URL_INGEST };

type Envio = { url: string; body: string; headers: Record<string, string> };
let envios: Envio[];
let pendientes: Promise<unknown>[];
const ctx = { waitUntil: (p: Promise<unknown>) => { pendientes.push(p); } };

// Estado del búfer por isolate: módulo nuevo en cada prueba.
async function cargar() {
  vi.resetModules();
  return import('./ingesta.ts');
}

function peticion(i: number, extra: { path?: string; ua?: string; ip?: string | null } = {}) {
  const h: Record<string, string> = { 'user-agent': extra.ua ?? 'Mozilla/5.0' };
  if (extra.ip !== null) h['cf-connecting-ip'] = extra.ip ?? '203.0.113.7';
  return new Request(`https://demo.prueba${extra.path ?? `/p/${i}`}?q=no-viaja`, { headers: h });
}

const app = { fetch: () => new Response('ok') };

async function drenar() {
  await vi.advanceTimersByTimeAsync(2_000);
  await Promise.all(pendientes);
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-24T19:00:00Z') });
  envios = []; pendientes = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    envios.push({ url, body: init.body as string, headers: init.headers as Record<string, string> });
    return new Response('{"accepted":1}', { status: 202 });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('firmar', () => {
  it('da el mismo hex que createHmac sobre `${ts}.${cuerpo}`', async () => {
    const { firmar } = await cargar();
    const cuerpo = '{"events":[]}', ts = '1792868400';
    const esperado = createHmac('sha256', SECRETO).update(`${ts}.${cuerpo}`).digest('hex');
    expect(await firmar(SECRETO, ts, cuerpo)).toBe(esperado);
    expect(esperado).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('lotes', () => {
  it('250 peticiones → 3 POST (100, 100, 50), firmados, válidos para IngestBatch y ninguno > 64 KB', async () => {
    const { conVanguard } = await cargar();
    const w = conVanguard(app);
    for (let i = 0; i < 250; i++) await w.fetch(peticion(i), ENV, ctx);
    await drenar();

    expect(envios.map((e) => IngestBatch.parse(JSON.parse(e.body)).events.length)).toEqual([100, 100, 50]);
    for (const e of envios) {
      expect(e.url).toBe(URL_INGEST);
      expect(new TextEncoder().encode(e.body).length).toBeLessThanOrEqual(64 * 1024);
      expect(e.headers['content-type']).toBe('application/json');
      expect(e.headers['x-vg-conn']).toBe(CONN);
      const ts = e.headers['x-vg-ts']!;
      expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThanOrEqual(300);   // ventana de E30
      expect(e.headers['x-vg-sig']).toBe(createHmac('sha256', SECRETO).update(`${ts}.${e.body}`).digest('hex'));
    }
  });

  it('eventos al máximo (ruta 300, UA 200 de 2 bytes) se parten en lotes de ≤ 56 KB', async () => {
    const { conVanguard, MAX_BYTES } = await cargar();
    const w = conVanguard(app);
    for (let i = 0; i < 250; i++) await w.fetch(peticion(i, { path: '/' + 'r'.repeat(400), ua: 'ñ'.repeat(300) }), ENV, ctx);
    await drenar();

    expect(envios.length).toBeGreaterThan(3);
    let total = 0;
    for (const e of envios) {
      expect(new TextEncoder().encode(e.body).length).toBeLessThanOrEqual(MAX_BYTES);
      const lote = IngestBatch.parse(JSON.parse(e.body));
      expect(lote.events[0]!.path).toHaveLength(300);
      expect(lote.events[0]!.ua).toHaveLength(200);
      total += lote.events.length;
    }
    expect(total).toBe(250);
  });

  it('pocos eventos salen juntos a los 2 s, no uno por petición', async () => {
    const { conVanguard } = await cargar();
    const w = conVanguard(app);
    for (let i = 0; i < 5; i++) await w.fetch(peticion(i), ENV, ctx);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(envios).toHaveLength(0);
    await drenar();
    expect(envios).toHaveLength(1);
    expect(JSON.parse(envios[0]!.body).events).toHaveLength(5);
  });

  it('el evento casa con EdgeEvent: sin query, IP de cf-connecting-ip, estado de la respuesta', async () => {
    const { conVanguard } = await cargar();
    await conVanguard({ fetch: () => new Response('x', { status: 404 }) }).fetch(peticion(0, { path: '/.env' }), ENV, ctx);
    await drenar();
    const [ev] = IngestBatch.parse(JSON.parse(envios[0]!.body)).events;
    expect(ev).toMatchObject({ ip: '203.0.113.7', method: 'GET', path: '/.env', status: 404, ua: 'Mozilla/5.0', auth: false });
    expect(ev!.ts).toBe('2026-10-24T19:00:00.000Z');
  });
});

describe('nunca frena ni rompe la app', () => {
  it('la respuesta sale aunque el ingest no conteste nunca', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { conVanguard } = await cargar();
    const w = conVanguard(app);
    for (let i = 0; i < 100; i++) {
      const r = await w.fetch(peticion(i), ENV, ctx);          // incluida la 100.ª, que dispara el envío
      expect(await r.text()).toBe('ok');
    }
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));   // la firma es asíncrona de verdad
    const estado = await Promise.race([Promise.all(pendientes).then(() => 'resuelto'), Promise.resolve('pendiente')]);
    expect(estado).toBe('pendiente');                           // el envío sigue en waitUntil, no en la respuesta
  });

  it('un ingest caído o que responde 401 no lanza', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('red caída'); }));
    const { conVanguard } = await cargar();
    await conVanguard(app).fetch(peticion(0), ENV, ctx);
    await expect(drenar()).resolves.toBeUndefined();

    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await conVanguard(app).fetch(peticion(1), ENV, ctx);
    await drenar();
    expect(aviso).toHaveBeenCalledWith('ingesta.rechazada', 401);
  });

  it('sin cf-connecting-ip o sin secreto no envía nada', async () => {
    const { conVanguard } = await cargar();
    const w = conVanguard(app);
    await w.fetch(peticion(0, { ip: null }), ENV, ctx);
    await w.fetch(peticion(1), { ...ENV, VG_INGEST_SECRET: '' }, ctx);
    await w.fetch(peticion(2), { ...ENV, VG_INGEST_CONN_ID: undefined }, ctx);
    await drenar();
    expect(fetch).not.toHaveBeenCalled();
  });
});
