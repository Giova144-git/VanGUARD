import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../lib/hmac.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const bloqueo = vi.hoisted(() => ({ executeBlock: vi.fn() }));
vi.mock('./block-ip.ts', async (original) => ({ ...await original<typeof import('./block-ip.ts')>(), executeBlock: bloqueo.executeBlock }));

const {
  aBytea, canjearBotonAlerta, canjearBotonBloqueo, elegirConexion, filasBotones, hashNonce, nuevoNonce, parsearBoton, textoPropuesta,
  VIDA_BOTON_MS,
} = await import('./approvals.ts');

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

  it('filasBotones con blk (solo si llegan su nonce y la IP): fila block_ip con etapa proponer, la IP y el incidente', async () => {
    const ip = ['186', '92', '14', '7'].join('.');
    const nonces = { ack: nuevoNonce(), snz: nuevoNonce(), blk: nuevoNonce() };
    const filas = await filasBotones({ org_id: 'o1', incident_id: 'i1', recipient: '584141234567', nonces, target: ip });
    expect(filas).toHaveLength(3);
    expect(filas[2]).toMatchObject({ action_kind: 'block_ip', channel: 'whatsapp', recipient: '584141234567',
      nonce_hash: await hashNonce(nonces.blk), params: { etapa: 'proponer', target: ip, incident_id: 'i1' } });
    expect(await filasBotones({ org_id: 'o1', incident_id: 'i1', recipient: '584141234567', nonces, target: null })).toHaveLength(2);
  });
});

describe('propuesta de bloqueo · piezas puras', () => {
  const Z1 = '023e105f4ecef8ad9ca31a8372d0c353';
  const Z2 = 'b'.repeat(32);
  const filas = [{ id: 'c1', meta: { zone_id: Z1, zone_name: 'officialvanguard.com' } }, { id: 'c2', meta: { zone_id: Z2, zone_name: 'acme.dev' } }];

  it('elegirConexion (§08.8): la pedida, la única, o la cuya zona es sufijo del host; ninguna → null', () => {
    expect(elegirConexion(filas, 'c2', null)?.id).toBe('c2');
    expect(elegirConexion(filas, 'otra', null)).toBeNull();
    expect(elegirConexion([filas[0]], undefined, null)?.zone_name).toBe('officialvanguard.com');
    expect(elegirConexion(filas, undefined, 'demo.officialvanguard.com')?.id).toBe('c1');
    expect(elegirConexion(filas, undefined, 'acme.dev')?.id).toBe('c2');
    expect(elegirConexion(filas, undefined, 'evilacme.dev')).toBeNull();
    expect(elegirConexion(filas, undefined, null)).toBeNull();
    expect(elegirConexion([{ id: 'c3', meta: { zone_id: 'no-hex' } }], undefined, null)).toBeNull();
  });

  it('textoPropuesta: IP recortada; el código solo en la propuesta de la app', () => {
    const ip = ['186', '92', '14', '7'].join('.');
    const t = textoPropuesta(ip, 'officialvanguard.com', '483920');
    expect(t).toContain('¿Bloquear 186.92.x.x durante 1 h en officialvanguard.com?');
    expect(t).toContain('Código para la app: 483920. Vence en 10 min.');
    expect(t).not.toContain(ip);
    expect(textoPropuesta(ip, 'officialvanguard.com', null)).not.toMatch(/\d{6}/);
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

describe('canjearBotonBloqueo (E31 ok/no/blk)', () => {
  const ORG = '0f6c0000-0000-4000-8000-000000000001';
  const INC = '9e0b0000-0000-4000-8000-000000000001';
  const APR = 'a9900000-0000-4000-8000-000000000001';
  const CONN = 'c0aa0000-0000-4000-8000-000000000002';
  const ZONA = '023e105f4ecef8ad9ca31a8372d0c353';
  const TEL = '58' + '4141234567';
  const IP = ['186', '92', '14', '7'].join('.');
  const NONCE = 'Zx9kQm2Lp0Ab7Yt4' + 'cD3eFg';
  const PROD = { VG_ENV: 'production' as const, KAPSO_API_KEY: ['clave', 'kapso'].join('-'), KAPSO_PHONE_NUMBER_ID: '1234567890' };
  type Fila = Record<string, unknown>;
  let canje: Resp;
  let contacto: Fila | null;
  let conexiones: Fila[];
  let acciones: Fila[];
  let doble: ReturnType<typeof dbDoble>;
  let fetchMock: ReturnType<typeof vi.fn>;

  const filaCanjeada = (etapa: string, o: Fila = {}) => ({ id: 'w1', org_id: ORG, incident_id: INC, action_kind: 'block_ip',
    channel: 'whatsapp', recipient: TEL, params: { etapa, target: IP, incident_id: INC, group: APR, connection_id: CONN,
      zone_id: ZONA, target_kind: 'ip' }, ...o });

  beforeEach(() => {
    canje = { data: [filaCanjeada('confirmar')] };
    contacto = { id: 'c1', verified_at: '2026-10-24T14:00:00+00:00' };
    conexiones = [{ id: CONN, meta: { zone_id: ZONA, zone_name: 'officialvanguard.com' } }];
    acciones = [];
    doble = dbDoble({
      rpc: () => canje,
      tabla: (op: Op) => {
        if (op.table === 'incidents') return { data: { id: INC, code: 'A1F3C9', rule_ids: ['CF_UA_TOOL'], severity: 'high',
          resource: `ip:${IP}`, status: 'open', details: { host: 'demo.officialvanguard.com' } } };
        if (op.table === 'contacts') return { data: contacto };
        if (op.table === 'connections') return { data: conexiones };
        if (op.table === 'actions') return { data: acciones };
        return undefined;
      },
    });
    // El doble común no implementa .is(): aquí queda como filtro ['is.<col>', 'eq', valor] (como en webhooks-kapso.test).
    const from = doble.client.from;
    doble.client.from = (t: string) => { const b = from(t); return Object.assign(b, { is: (col: string, v: unknown) => b.eq(`is.${col}`, v) }); };
    estado.client = doble.client;
    bloqueo.executeBlock.mockReset().mockResolvedValue({ tipo: 'ejecutado', action_id: 'act-1', en: '2026-10-24T19:02:06.000Z',
      resultado: 'IP bloqueada 1 h', existia: false, repetido: false });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.HBgMprueba' }] })));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const pulsar = (accion: 'ok' | 'no' | 'blk' | 'ack', env: Partial<CloudflareBindings> = PROD, remitente = TEL) =>
    canjearBotonBloqueo(envDoble(env).env, { accion, codigo: 'A1F3C9', nonce: NONCE }, remitente, 'rid-1',
      Date.parse('2026-10-24T19:02:00.000Z'));

  it('ok → canje del sha256 del nonce con el remitente y executeBlock con la fila canjeada; responde «Bloqueada …»', async () => {
    const r = await pulsar('ok');
    expect(doble.rpcs).toEqual([{ name: 'vg_redeem_approval', args: { p_approval: null, p_nonce_hash: await hashNonce(NONCE), p_recipient: TEL } }]);
    expect(bloqueo.executeBlock).toHaveBeenCalledTimes(1);
    expect(bloqueo.executeBlock.mock.calls[0]![1]).toMatchObject({ id: 'w1', org_id: ORG, channel: 'whatsapp' });
    expect(r).toEqual({ resultado: 'ejecutado', texto: 'Bloqueada 186.92.x.x por 1 h. Puedes deshacerlo en la app.', action_id: 'act-1' });
    expect(fetchMock).not.toHaveBeenCalled();                           // la respuesta la manda E31 con su presupuesto
  });

  it('ok con Cloudflare 403 o caído → texto que lo dice; ok repetido (0 filas) → «Código vencido o ya usado»', async () => {
    bloqueo.executeBlock.mockResolvedValueOnce({ tipo: 'rechazado', action_id: 'act-1', status: 403,
      error: 'Te falta el permiso Firewall Services · Edit en el token de acciones' });
    expect((await pulsar('ok')).texto).toContain('Firewall Services · Edit');
    bloqueo.executeBlock.mockResolvedValueOnce({ tipo: 'caido', action_id: 'act-1', status: 503 });
    expect((await pulsar('ok')).resultado).toBe('caido');
    canje = { data: [] };
    expect(await pulsar('ok')).toEqual({ resultado: 'sin_canje', texto: 'Código vencido o ya usado. Abre officialvanguard.com' });
    expect(bloqueo.executeBlock).toHaveBeenCalledTimes(2);
  });

  it('no → las aprobaciones vivas y SIN USAR del group quedan usadas con canceled:true (la in_app incluida); nada en Cloudflare', async () => {
    canje = { data: [filaCanjeada('cancelar')] };
    const r = await pulsar('no');
    expect(r).toEqual({ resultado: 'cancelado', texto: 'Cancelado: no bloqueé 186.92.x.x.' });
    const ups = doble.ops.filter((o) => o.table === 'approvals' && o.action === 'update');
    const grupo = ups.find((o) => eqDe(o, 'params->>group') === APR)!;
    expect(grupo.payload).toEqual({ used_at: '2026-10-24T19:02:00.000Z', result: { canceled: true } });
    expect(eqDe(grupo, 'org_id')).toBe(ORG);
    expect(eqDe(grupo, 'is.used_at')).toBeNull();                        // una ya canjeada no se pisa
    expect(ups.find((o) => eqDe(o, 'id') === 'w1')!.payload).toEqual({ result: { canceled: true } });
    // Busca si la confirmación ganó antes: action de esa IP y org de los últimos 10 min.
    const sel = doble.ops.find((o) => o.table === 'actions')!;
    expect([eqDe(sel, 'org_id'), eqDe(sel, 'target')]).toEqual([ORG, IP]);
    expect(sel.filters).toContainEqual(['created_at', 'gte', '2026-10-24T18:52:00.000Z']);
    expect(bloqueo.executeBlock).not.toHaveBeenCalled();
  });

  it('no cuando el código de la app u ok ya ganó → contesta el estado real (bloqueada o aplicándose), nunca «Cancelado»', async () => {
    canje = { data: [filaCanjeada('cancelar')] };
    acciones = [{ id: 'act-1', status: 'executed' }];
    expect(await pulsar('no')).toEqual({ resultado: 'ya_bloqueada', action_id: 'act-1',
      texto: 'No cancelé: 186.92.x.x ya quedó bloqueada. Puedes deshacerlo en la app.' });
    acciones = [{ id: 'act-1', status: 'proposed' }];
    expect(await pulsar('no')).toMatchObject({ resultado: 'en_curso', action_id: 'act-1' });
    acciones = [{ id: 'act-1', status: 'failed' }];
    expect((await pulsar('no')).resultado).toBe('cancelado');
  });

  it('blk → propuesta por WhatsApp al remitente: 2 filas ok/no del mismo group y el interactivo, sin tocar Cloudflare', async () => {
    canje = { data: [filaCanjeada('proponer', { params: { etapa: 'proponer', target: IP, incident_id: INC } })] };
    const r = await pulsar('blk');
    expect(r).toEqual({ resultado: 'propuesto', texto: null });
    const filas = doble.ops.filter((o) => o.table === 'approvals' && o.action === 'insert').flatMap((o) => o.payload as Fila[]);
    expect(filas).toHaveLength(2);
    expect(filas.map((f) => (f.params as Fila).etapa)).toEqual(['confirmar', 'cancelar']);
    expect(new Set(filas.map((f) => (f.params as Fila).group)).size).toBe(1);
    expect(filas[0]).toMatchObject({ org_id: ORG, incident_id: INC, action_kind: 'block_ip', channel: 'whatsapp', recipient: TEL,
      params: { target: IP, connection_id: CONN, zone_id: ZONA, zone_name: 'officialvanguard.com', target_kind: 'ip', mode: 'block',
        ttl_s: 3600, incident_code: 'A1F3C9', regla: 'CF_UA_TOOL', requested_by: null } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.kapso.ai');
    const m = JSON.parse(String(init.body)) as { to: string;
      interactive: { body: { text: string }; action: { buttons: { reply: { id: string; title: string } }[] } } };
    expect(m.to).toBe(TEL);
    expect(m.interactive.body.text).not.toContain(IP);
    const botones = m.interactive.action.buttons.map((b) => b.reply);
    expect(botones.map((b) => b.title)).toEqual(['Sí, bloquear', 'Cancelar']);
    for (const [i, b] of botones.entries()) {
      const p = parsearBoton(b.id)!;
      expect([p.accion, p.codigo]).toEqual([i === 0 ? 'ok' : 'no', 'A1F3C9']);
      expect(filas[i]!.nonce_hash).toBe(await hashNonce(p.nonce));
    }
    expect(bloqueo.executeBlock).not.toHaveBeenCalled();
  });

  it('blk sin conexión de acciones → texto para activar el Modo blindaje y nada creado', async () => {
    canje = { data: [filaCanjeada('proponer')] };
    conexiones = [];
    expect(await pulsar('blk')).toEqual({ resultado: 'sin_conexion', texto: 'Activa el Modo blindaje con un token de acciones en la app.' });
    expect(doble.ops.some((o) => o.table === 'approvals' && o.action === 'insert')).toBe(false);
  });

  it('el prefijo del botón debe casar con la etapa de la fila (un nonce de blk no sirve como ok) y con el código del incidente', async () => {
    canje = { data: [filaCanjeada('proponer')] };
    expect((await pulsar('ok')).resultado).toBe('tipo_distinto');
    canje = { data: [filaCanjeada('confirmar')] };
    const otro = await canjearBotonBloqueo(envDoble(PROD).env, { accion: 'ok', codigo: 'FFFFFF', nonce: NONCE }, TEL, 'rid-1');
    expect(otro.resultado).toBe('otro_incidente');
    contacto = { id: 'c1', verified_at: null };
    expect((await pulsar('ok')).resultado).toBe('no_contacto');
    expect(bloqueo.executeBlock).not.toHaveBeenCalled();
  });

  it('fuera de producción, ack/snz o remitente ilegible → sin canje (no quema el nonce)', async () => {
    expect((await pulsar('ok', { VG_ENV: 'local' })).resultado).toBe('dry_run');
    expect((await pulsar('ack')).resultado).toBe('tipo_distinto');
    expect((await pulsar('ok', PROD, '123')).resultado).toBe('remitente_invalido');
    expect(doble.rpcs).toHaveLength(0);
  });
});
