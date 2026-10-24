import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../lib/hmac.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { aBytea, canjearBotonAlerta, filasBotones, hashNonce, nuevoNonce, parsearBoton, VIDA_BOTON_MS } = await import('./approvals.ts');

describe('parsearBoton (regex de S15 15.10)', () => {
  const nonce = 'Zx9kQm2Lp0Ab7Yt4cD3eFg';

  it('lee las cinco acciones con su código de incidente y nonce', () => {
    for (const accion of ['ack', 'snz', 'ok', 'no', 'blk'] as const) {
      expect(parsearBoton(`${accion}:A1F3C9:${nonce}`)).toEqual({ accion, codigo: 'A1F3C9', nonce });
    }
  });

  it('rechaza acciones desconocidas, códigos en minúsculas, nonces cortos o con otros caracteres y textos libres', () => {
    for (const p of [`del:A1F3C9:${nonce}`, `ack:a1f3c9:${nonce}`, 'ack:A1F3C9:corto', `ack:A1F3C9:${nonce}!`, 'noop',
      'VERIFICAR 1A2B3C', `ack:A1F3C9:${nonce}:extra`]) {
      expect(parsearBoton(p)).toBeNull();
    }
  });
});

describe('nonces y filas de approvals (§12.6, §15.10)', () => {
  it('nuevoNonce: 16 bytes en base64url sin relleno (22 car.), distintos y aceptados por parsearBoton', () => {
    const xs = Array.from({ length: 50 }, () => nuevoNonce());
    for (const n of xs) {
      expect(n).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(parsearBoton(`ack:A1F3C9:${n}`)?.nonce).toBe(n);
    }
    expect(new Set(xs).size).toBe(xs.length);
  });

  it('hashNonce = \\x + sha256 hex (bytea de 32 bytes por PostgREST)', async () => {
    expect(aBytea('ab')).toBe('\\xab');
    expect(await hashNonce('hola')).toBe(`\\x${await sha256Hex('hola')}`);
    expect(await hashNonce('hola')).toMatch(/^\\x[0-9a-f]{64}$/);
  });

  it('filasBotones: una fila ack y otra mute, whatsapp, recipient sin +, solo el hash y 10 min de vida', async () => {
    const ahora = Date.parse('2026-10-24T19:01:10.000Z');
    const nonces = { ack: nuevoNonce(), snz: nuevoNonce() };
    const filas = await filasBotones({ org_id: 'o1', incident_id: 'i1', recipient: '584141234567', nonces, ahora });
    expect(filas).toEqual([
      { org_id: 'o1', incident_id: 'i1', action_kind: 'ack', channel: 'whatsapp', recipient: '584141234567',
        nonce_hash: await hashNonce(nonces.ack), expires_at: new Date(ahora + VIDA_BOTON_MS).toISOString(), params: {} },
      { org_id: 'o1', incident_id: 'i1', action_kind: 'mute', channel: 'whatsapp', recipient: '584141234567',
        nonce_hash: await hashNonce(nonces.snz), expires_at: '2026-10-24T19:11:10.000Z', params: {} },
    ]);
    expect(JSON.stringify(filas)).not.toContain(nonces.ack);
  });
});

describe('canjearBotonAlerta (E31 ack/snz)', () => {
  const ORG = '0f6c0000-0000-4000-8000-000000000001';
  const INC = '9e0b0000-0000-4000-8000-000000000001';
  const TEL = '58' + '4141234567';
  const NONCE = 'Zx9kQm2Lp0Ab7Yt4' + 'cD3eFg';
  let incidente: Record<string, unknown>;
  let canje: Resp;
  let doble: ReturnType<typeof dbDoble>;

  beforeEach(() => {
    incidente = { id: INC, code: 'A1F3C9', status: 'open', acked_at: null, muted_until: null, details: {} };
    canje = { data: [{ id: 'a1', org_id: ORG, incident_id: INC, action_kind: 'ack', channel: 'whatsapp', recipient: TEL }] };
    doble = dbDoble({
      rpc: () => canje,
      tabla: (op: Op) => {
        if (op.table === 'incidents' && op.action === 'select') return { data: incidente };
        if (op.table === 'contacts') return { data: { id: 'c1', verified_at: '2026-10-24T14:00:00+00:00' } };
        return undefined;
      },
    });
    estado.client = doble.client;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const canjear = (accion: 'ack' | 'snz' | 'ok', remitente = TEL, ahora?: number) =>
    canjearBotonAlerta(envDoble().env, { accion, codigo: 'A1F3C9', nonce: NONCE }, remitente, 'rid-1', ahora);
  const updates = () => doble.ops.filter((o) => o.table === 'incidents' && o.action === 'update');

  it('ack sobre un incidente mitigated: no retrocede el estado, solo pone acked_at y acked_via', async () => {
    incidente.status = 'mitigated';
    expect(await canjear('ack')).toBe('aplicado');
    expect(updates()[0]!.payload).toMatchObject({ status: 'mitigated', acked_via: 'whatsapp' });
    expect(eqDe(updates()[0]!, 'status')).toBe('mitigated');
  });

  it('snz no acorta un silencio más largo ya puesto (E19 admite hasta 24 h)', async () => {
    const ahora = Date.parse('2026-10-24T19:00:00.000Z');
    incidente.muted_until = '2026-10-25T10:00:00.000Z';
    canje = { data: [{ id: 'a1', org_id: ORG, incident_id: INC, action_kind: 'mute', channel: 'whatsapp', recipient: TEL }] };
    expect(await canjear('snz', TEL, ahora)).toBe('aplicado');
    expect(updates()[0]!.payload).toMatchObject({ muted_until: '2026-10-25T10:00:00.000Z',
      details: { muted_at: '2026-10-24T19:00:00.000Z' } });
  });

  it('remitente ilegible, acción que no es ack/snz o error del canje → sin efecto y sin lanzar', async () => {
    expect(await canjear('ack', '123')).toBe('remitente_invalido');
    expect(await canjear('ok')).toBe('tipo_distinto');
    expect(doble.rpcs).toHaveLength(0);
    canje = { error: { code: '57014' } };
    expect(await canjear('ack')).toBe('error');
    estado.client = { rpc: () => { throw new Error('boom'); } };
    expect(await canjear('ack')).toBe('error');
    expect(updates()).toHaveLength(0);
  });
});
