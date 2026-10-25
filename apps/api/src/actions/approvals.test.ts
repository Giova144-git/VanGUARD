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
  VIDA_BOTON_MS, canjearBotonRevision, COSTE_BOTON_REVISION, filasBotonesRevision, peorHallazgo, SILENCIO_REPO_MS,
} = await import('./approvals.ts');
const { ACCIONES_BOTON, TEXTO_BOTON_VENCIDO } = await import('@vanguard/core');

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

  it('anexo de botones: fix, iss, rvs, rpr y uat con código y nonce válidos; inválidos → null', () => {
    for (const accion of ['fix', 'iss', 'rvs', 'rpr', 'uat'] as const) {
      expect(parsearBoton(`${accion}:C4A1E9:${nonce}`)).toEqual({ accion, codigo: 'C4A1E9', nonce });
      for (const malo of [`${accion}:c4a1e9:${nonce}`, `${accion}:C4A1E:${nonce}`, `${accion}:C4A1E9:corto`,
        `${accion}x:C4A1E9:${nonce}`, `${accion.toUpperCase()}:C4A1E9:${nonce}`, ` ${accion}:C4A1E9:${nonce}`,
        `${accion}:C4A1E9:${'x'.repeat(44)}`]) {
        expect(parsearBoton(malo)).toBeNull();
      }
    }
    // La regex del webhook acepta exactamente las acciones de core (TITULOS_BOTON): no se pueden desalinear.
    for (const accion of ACCIONES_BOTON) expect(parsearBoton(`${accion}:A1F3C9:${nonce}`)?.accion).toBe(accion);
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

describe('botones del aviso de revisión: filas y canje (E31 fix/rvs)', () => {
  const ORG = '0f6c0000-0000-4000-8000-000000000001';
  const ORG_B = '0f6c0000-0000-4000-8000-00000000000b';
  const REV = 'c4a1e9f0-0000-4000-8000-000000000011';
  const CFG = 'cf000000-0000-4000-8000-000000000021';
  const TEL = '58' + '4141234567';
  const NONCE = 'Zx9kQm2Lp0Ab7Yt4' + 'cD3eFg';
  const AHORA = Date.parse('2026-10-24T23:40:00.000Z');
  type Fila = Record<string, unknown>;
  let canje: Resp;
  let revision: Fila | null;
  let contacto: Fila | null;
  let silencio: Resp;
  let doble: ReturnType<typeof dbDoble>;

  const filaCanjeada = (action_kind: string, o: Fila = {}) => ({ id: 'w1', org_id: ORG, incident_id: null, code_review_id: REV,
    action_kind, channel: 'whatsapp', recipient: TEL, params: {}, ...o });

  beforeEach(() => {
    canje = { data: [filaCanjeada('send_fix')] };
    revision = { id: REV, config_id: CFG, new_findings: [
      { finding_id: 'f1', rule_id: 'CB_GITIGNORE_NO_ENV', severity: 'medium', title: 'El .gitignore no excluye .env',
        resource: '.gitignore' },
      { finding_id: 'f2', rule_id: 'CB_SECRET_GITHUB_PAT', severity: 'critical', title: 'Token de GitHub en el código',
        resource: 'scripts/deploy.sh:12' }] };
    contacto = { id: 'c1', verified_at: '2026-10-24T14:00:00+00:00' };
    silencio = { data: [{ id: CFG }] };
    doble = dbDoble({
      rpc: () => canje,
      tabla: (op: Op) => {
        if (op.table === 'code_reviews' && op.action === 'select') return { data: revision };
        if (op.table === 'contacts') return { data: contacto };
        if (op.table === 'code_review_configs') return silencio;
        return undefined;
      },
    });
    estado.client = doble.client;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const pulsar = (accion: 'fix' | 'rvs' | 'ack' | 'iss', o: { remitente?: string; codigo?: string } = {}) =>
    canjearBotonRevision(envDoble({ APP_ORIGIN: 'https://officialvanguard.com/' }).env,
      { accion, codigo: o.codigo ?? 'C4A1E9', nonce: NONCE }, o.remitente ?? TEL, 'rid-1', AHORA);
  const escrituras = () => doble.ops.filter((o) => o.action === 'update');

  it('filasBotonesRevision: send_fix y mute_repo colgadas de la revisión, whatsapp, sin +, solo el hash y 10 min', async () => {
    const nonces = { fix: nuevoNonce(), rvs: nuevoNonce() };
    const filas = await filasBotonesRevision({ org_id: ORG, code_review_id: REV, recipient: TEL, nonces, ahora: AHORA });
    expect(filas).toEqual([
      { org_id: ORG, code_review_id: REV, action_kind: 'send_fix', channel: 'whatsapp', recipient: TEL,
        nonce_hash: await hashNonce(nonces.fix), expires_at: '2026-10-24T23:50:00.000Z', params: {} },
      { org_id: ORG, code_review_id: REV, action_kind: 'mute_repo', channel: 'whatsapp', recipient: TEL,
        nonce_hash: await hashNonce(nonces.rvs), expires_at: '2026-10-24T23:50:00.000Z', params: {} },
    ]);
    expect(JSON.stringify(filas)).not.toContain(nonces.fix);
    const solo = await filasBotonesRevision({ org_id: ORG, code_review_id: REV, recipient: TEL, nonces: { rvs: nonces.rvs } });
    expect(solo.map((f) => f.action_kind)).toEqual(['mute_repo']);
  });

  it('peorHallazgo: la severidad más alta (a igualdad, la primera); filas ilegibles se saltan', () => {
    expect(peorHallazgo(revision!.new_findings)).toEqual({ rule_id: 'CB_SECRET_GITHUB_PAT', severity: 'critical' });
    expect(peorHallazgo([{ rule_id: 'CB_A', severity: 'high' }, { rule_id: 'CB_B', severity: 'high' }])?.rule_id).toBe('CB_A');
    expect(peorHallazgo([{ rule_id: 'CB_A', severity: 'grave' }, { severity: 'high' }, 'x'])).toBeNull();
    expect(peorHallazgo(null)).toBeNull();
  });

  it('fix válido → canje del sha256 con el remitente, pasos de la regla más grave + url, y whatsapp_action fix_sent', async () => {
    const r = await pulsar('fix');
    expect(doble.rpcs).toEqual([{ name: 'vg_redeem_approval',
      args: { p_approval: null, p_nonce_hash: await hashNonce(NONCE), p_recipient: TEL } }]);
    expect(r.resultado).toBe('arreglo_enviado');
    expect(r.texto!.split('\n')[0])
      .toBe('Hecho: así se corrige `CB_SECRET_GITHUB_PAT` (severidad crítica), lo más grave de esta revisión.');
    expect(r.texto).toContain('en GitHub: revoca el token en Settings → Developer settings');
    expect(r.texto!.endsWith(`está en el panel: https://officialvanguard.com/o/${ORG}/codebase?revision=${REV}`)).toBe(true);
    for (const prohibido of ['deploy.sh', 'scripts/', 'Token de GitHub en el código', '.gitignore no excluye']) {
      expect(r.texto).not.toContain(prohibido);
    }
    const lectura = doble.ops.find((o) => o.table === 'code_reviews' && o.action === 'select')!;
    expect([eqDe(lectura, 'id'), eqDe(lectura, 'org_id')]).toEqual([REV, ORG]);
    const [marca] = escrituras();
    expect(marca!.table).toBe('code_reviews');
    expect(marca!.payload).toEqual({ whatsapp_action: 'fix_sent', whatsapp_action_at: '2026-10-24T23:40:00.000Z' });
    expect([eqDe(marca!, 'id'), eqDe(marca!, 'org_id')]).toEqual([REV, ORG]);
    expect(doble.ops.length + doble.rpcs.length).toBeLessThanOrEqual(COSTE_BOTON_REVISION);
  });

  it('rvs válido → muted_until = ahora + 1 h en la config (id y org), whatsapp_action muted y la hora de fin', async () => {
    canje = { data: [filaCanjeada('mute_repo')] };
    const r = await pulsar('rvs');
    expect(r).toEqual({ resultado: 'silenciado', texto: 'Hecho: no te mandaré avisos de revisión de este repo hasta las 20:40 '
      + '(hora de Caracas). Las revisiones siguen y las ves en la app.' });
    const [cfg, marca] = escrituras();
    expect(cfg!.table).toBe('code_review_configs');
    expect(cfg!.payload).toEqual({ muted_until: new Date(AHORA + SILENCIO_REPO_MS).toISOString() });
    expect([eqDe(cfg!, 'id'), eqDe(cfg!, 'org_id')]).toEqual([CFG, ORG]);
    expect(marca!.payload).toMatchObject({ whatsapp_action: 'muted' });
    expect(doble.ops.length + doble.rpcs.length).toBeLessThanOrEqual(COSTE_BOTON_REVISION);
  });

  it('nonce reusado, vencido o de otro teléfono (0 filas) → «No se pudo: el botón venció…» sin leer ni escribir nada', async () => {
    canje = { data: [] };
    expect(await pulsar('fix')).toEqual({ resultado: 'sin_canje', texto: TEXTO_BOTON_VENCIDO });
    expect(doble.ops).toHaveLength(0);
  });

  it('remitente que ya no es contacto verificado (o de otra org) → sin efecto y SIN respuesta', async () => {
    contacto = { id: 'c1', verified_at: null };
    expect(await pulsar('fix')).toEqual({ resultado: 'no_contacto', texto: null });
    // Aprobación de otra org: el contacto y la revisión se buscan con la org de la fila canjeada.
    contacto = null;
    canje = { data: [filaCanjeada('mute_repo', { org_id: ORG_B })] };
    expect(await pulsar('rvs')).toEqual({ resultado: 'no_contacto', texto: null });
    const lecturas = doble.ops.filter((o) => o.action === 'select');
    expect(lecturas.slice(-2).map((o) => eqDe(o, 'org_id'))).toEqual([ORG_B, ORG_B]);
    expect(escrituras()).toHaveLength(0);
  });

  it('nonce de otra acción, de un incidente o código de otra revisión → «No se pudo: …» y nada escrito', async () => {
    canje = { data: [filaCanjeada('mute_repo')] };
    expect(await pulsar('fix')).toEqual({ resultado: 'tipo_distinto', texto: 'No se pudo: ese botón no corresponde a esta acción.' });
    canje = { data: [filaCanjeada('ack', { code_review_id: null, incident_id: 'i1' })] };
    expect((await pulsar('fix')).resultado).toBe('tipo_distinto');
    canje = { data: [filaCanjeada('send_fix')] };
    expect(await pulsar('fix', { codigo: 'FFFFFF' }))
      .toEqual({ resultado: 'otra_revision', texto: 'No se pudo: no encontré esa revisión.' });
    revision = null;
    expect((await pulsar('fix')).resultado).toBe('otra_revision');
    expect(escrituras()).toHaveLength(0);
  });

  it('fix de una revisión sin hallazgos nuevos y rvs sin config → «No se pudo: …»; error al silenciar → lo dice', async () => {
    revision!.new_findings = [];
    expect(await pulsar('fix')).toEqual({ resultado: 'sin_hallazgos',
      texto: 'No se pudo: esta revisión no trae hallazgos nuevos que arreglar.' });
    canje = { data: [filaCanjeada('mute_repo')] };
    silencio = { data: [] };
    expect((await pulsar('rvs')).resultado).toBe('sin_config');
    silencio = { error: { code: '42703' } };
    expect(await pulsar('rvs')).toEqual({ resultado: 'error', texto: 'No se pudo: no pude guardarlo, inténtalo desde la app.' });
    expect(escrituras().filter((o) => o.table === 'code_reviews')).toHaveLength(0);
  });

  it('remitente ilegible o acción que no es fix/rvs → sin canje (no quema el nonce); error del canje → sin respuesta', async () => {
    expect((await pulsar('fix', { remitente: '123' })).resultado).toBe('remitente_invalido');
    expect((await pulsar('ack')).resultado).toBe('tipo_distinto');
    expect((await pulsar('iss')).resultado).toBe('tipo_distinto');
    expect(doble.rpcs).toHaveLength(0);
    canje = { error: { code: '57014' } };
    expect(await pulsar('fix')).toEqual({ resultado: 'error', texto: null });
    estado.client = { rpc: () => { throw new Error('boom'); } };
    expect(await pulsar('fix')).toEqual({ resultado: 'error', texto: null });
  });
});
