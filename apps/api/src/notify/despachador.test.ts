import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsearBoton } from '../actions/approvals.ts';
import { sha256Hex } from '../lib/hmac.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { avisarIncidente } = await import('./despachador.ts');

// Valores falsos armados en tiempo de ejecución: ningún literal con forma de secreto ni teléfono entero en el repo.
const CLAVE = ['clave', 'kapso', 'de', 'prueba'].join('-');
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const INC = '9e0b0000-0000-4000-8000-000000000001';
const TEL_A = '+58' + '4141234567';
const TEL_B = '+58' + '4241112233';
const IP = ['186', '92', '14', '7'].join('.');
const PROD = { VG_ENV: 'production' as const, KAPSO_API_KEY: CLAVE, KAPSO_PHONE_NUMBER_ID: '1234567890' };
const NUEVO = { is_new: true, prev_severity: null, reopened: false };
const VERIFICADO = '2026-10-24T14:00:00+00:00';

type Fila = Record<string, unknown>;
let incidente: Fila;
let contactos: Fila[];
let org: Fila;
let cfg: Fila | null;
let usadas: number;
let recientes: Fila[];
let storms: number;
let errorQueued: { code: string } | null;
let errorApprovals: { code: string } | null;
let doble: ReturnType<typeof dbDoble>;
let fetchMock: ReturnType<typeof vi.fn>;
let logs: { mock: { calls: unknown[][] } };

beforeEach(() => {
  incidente = { id: INC, code: 'A1F3C9', severity: 'high', rule_ids: ['CF_UA_TOOL', 'CF_PATH_SCAN'], resource: `ip:${IP}`,
    status: 'open', last_event_at: '2026-10-24T19:01:00+00:00', muted_until: null, notified_at: null,
    details: { ip: IP, host: 'demo.officialvanguard.com', source: 'ingest', ua_top: 'sqlmap/1.8', n_60s: 180, total_60s: 200,
      share_pct: 90, paths_4xx: 37, probe_hits: 2, admin_ok: 0, n5xx: 0, p95_ms: 120 } };
  contactos = [
    { id: 'c2', phone_e164: TEL_B, whatsapp: true, voice: false, priority: 2, verified_at: VERIFICADO },
    { id: 'c1', phone_e164: TEL_A, whatsapp: true, voice: true, priority: 1, verified_at: VERIFICADO },
  ];
  org = { is_demo: false };
  cfg = null;
  usadas = 0;
  recientes = [{ rule_ids: ['CF_UA_TOOL'] }];
  storms = 0;
  errorQueued = null;
  errorApprovals = null;
  doble = dbDoble({
    tabla: (op: Op): Resp | undefined => {
      if (op.table === 'incidents' && op.action === 'select' && op.single) {
        return { data: eqDe(op, 'id') === INC && eqDe(op, 'org_id') === ORG ? incidente : null };
      }
      if (op.table === 'incidents' && op.action === 'select') return { data: recientes, count: recientes.length };
      if (op.table === 'contacts') return { data: contactos };
      if (op.table === 'orgs') return { data: org };
      if (op.table === 'app_config') return { data: cfg };
      if (op.table === 'notifications' && op.action === 'select') return { count: eqDe(op, 'template') === 'storm_v1' ? storms : usadas };
      if (op.table === 'notifications' && op.action === 'insert') {
        const f = op.payload as Fila;
        if (f.status !== 'queued') return {};
        return errorQueued ? { error: errorQueued } : { data: { id: `n-${String(f.recipient_masked).slice(-4)}` } };
      }
      if (op.table === 'approvals' && op.action === 'insert') return errorApprovals ? { error: errorApprovals } : {};
      return undefined;
    },
  });
  estado.client = doble.client;
  let n = 0;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.HBgM${++n}` }] })));
  vi.stubGlobal('fetch', fetchMock);
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const avisar = (r: { is_new: boolean; prev_severity: string | null; reopened: boolean } = NUEVO, env: Partial<CloudflareBindings> = {}) =>
  avisarIncidente(envDoble({ ...PROD, ...env }).env, ORG, INC, r, 'rid-1');
const de = (tabla: string, action: Op['action']) => doble.ops.filter((o) => o.table === tabla && o.action === action);
const filasNotif = () => de('notifications', 'insert').map((o) => o.payload as Fila);
const enviados = () => fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Fila & {
  to: string; type: string; text?: { body: string };
  interactive: { header: { text: string }; body: { text: string }; footer: { text: string };
    action: { buttons: { reply: { id: string; title: string } }[] } };
});
const lineas = () => logs.mock.calls.map((c) => String(c[0])).join('\n');

describe('despachador · envío de WhatsApp', () => {
  it('2 contactos verificados → 2 filas queued, 2 × 2 approvals con sha256(nonce) y 2 interactivos con ack/snz canjeables', async () => {
    await avisar();
    // En orden de prioridad (c1 = TEL_A primero), aunque la base los devuelva desordenados.
    expect(filasNotif()).toEqual([TEL_A, TEL_B].map((t) => ({ org_id: ORG, incident_id: INC, channel: 'whatsapp',
      template: 'incident_v1', recipient_masked: `+58•••${t.slice(-4)}`, status: 'queued' })));

    const msgs = enviados();
    expect(msgs.map((m) => m.to).sort()).toEqual([TEL_A.slice(1), TEL_B.slice(1)].sort());
    const aprob = de('approvals', 'insert').flatMap((o) => o.payload as Fila[]);
    expect(aprob).toHaveLength(4);
    for (const m of msgs) {
      expect(m.type).toBe('interactive');
      expect(m.interactive.header.text).toBe('ALERTA ALTA · Cloudflare');
      expect(m.interactive.footer.text).toBe('Incidente #A1F3C9 · VanGUARD');
      expect(m.interactive.body.text).toContain('Trafico con herramienta de ataque (sqlmap/1.8) contra demo.officialvanguard.com');
      expect(m.interactive.body.text).toContain('Recurso: ip:186.92.x.x');
      expect(m.interactive.body.text).not.toContain(IP);
      const botones = m.interactive.action.buttons.map((b) => b.reply);
      expect(botones.map((b) => b.title)).toEqual(['Lo estoy viendo', 'Silenciar 1 h']);
      const parsed = botones.map((b) => parsearBoton(b.id));
      expect(parsed.map((p) => [p?.accion, p?.codigo])).toEqual([['ack', 'A1F3C9'], ['snz', 'A1F3C9']]);
      // En approvals solo vive el sha256 del nonce de cada botón, con su recipient (E.164 sin '+') y su tipo.
      for (const p of parsed) {
        expect(p!.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
        const hash = `\\x${await sha256Hex(p!.nonce)}`;
        expect(hash).toMatch(/^\\x[0-9a-f]{64}$/);
        const fila = aprob.find((a) => a.nonce_hash === hash)!;
        expect(fila).toMatchObject({ org_id: ORG, incident_id: INC, channel: 'whatsapp', recipient: m.to,
          action_kind: p!.accion === 'ack' ? 'ack' : 'mute' });
        expect(JSON.stringify(aprob)).not.toContain(p!.nonce);
        const vida = Date.parse(String(fila.expires_at)) - Date.now();
        expect(vida).toBeGreaterThan(9 * 60_000);
        expect(vida).toBeLessThanOrEqual(10 * 60_000);
      }
    }

    const cierres = de('notifications', 'update');
    expect(cierres).toHaveLength(2);
    for (const u of cierres) {
      expect(u.payload).toMatchObject({ status: 'sent', provider_id: expect.stringMatching(/^wamid\.HBgM\d$/) });
      expect(eqDe(u, 'org_id')).toBe(ORG);
      expect(eqDe(u, 'status')).toBe('queued');
    }
    const notified = de('incidents', 'update');
    expect(notified).toHaveLength(1);
    expect(notified[0]!.payload).toHaveProperty('notified_at');
    expect(eqDe(notified[0]!, 'org_id')).toBe(ORG);
    // Logs sin teléfonos completos, sin la IP entera y sin nonces.
    const txt = lineas();
    expect(txt).not.toContain('4141234567');
    expect(txt).not.toContain(IP);
    for (const m of msgs) for (const b of m.interactive.action.buttons) expect(txt).not.toContain(parsearBoton(b.reply.id)!.nonce);
  });

  it('23505 al insertar la fila queued (ya avisado) → ni approvals ni envío', async () => {
    errorQueued = { code: '23505' };
    await avisar();
    expect(filasNotif()).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(de('approvals', 'insert')).toHaveLength(0);
    expect(de('notifications', 'update')).toHaveLength(0);
    expect(lineas()).toContain('"despacho.ya_avisado"');
  });

  it('otro error al insertar la fila queued → no se envía (sin fila escaparía al tope)', async () => {
    errorQueued = { code: '57014' };
    await avisar();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tope de 10 WhatsApp/h alcanzado → filas skipped_cap con error cap y ni un fetch', async () => {
    usadas = 10;
    await avisar();
    expect(filasNotif().map((f) => [f.status, f.error])).toEqual([['skipped_cap', 'cap'], ['skipped_cap', 'cap']]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(de('approvals', 'insert')).toHaveLength(0);
    const uso = de('notifications', 'select').find((o) => eqDe(o, 'channel') === 'whatsapp')!;
    expect(uso.filters).toContainEqual(['status', 'in', ['queued', 'sent', 'delivered', 'read']]);
    expect(eqDe(uso, 'org_id')).toBe(ORG);
  });

  it('org de demo con la ventana cerrada → skipped_cap fuera_de_ventana_demo; abierta → envía (tope 30)', async () => {
    org = { is_demo: true };
    usadas = 12;
    await avisar();
    expect(filasNotif().map((f) => f.error)).toEqual(['fuera_de_ventana_demo', 'fuera_de_ventana_demo']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(eqDe(de('app_config', 'select')[0]!, 'key')).toBe('demo_alertas_hasta');

    cfg = { value: new Date(Date.now() + 45 * 60_000).toISOString() };
    doble.ops.length = 0;
    await avisar();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('contacto sin verificar → fila failed unverified y sin envío; el verificado sí recibe', async () => {
    contactos[0]!.verified_at = null;
    await avisar();
    expect(filasNotif().find((f) => f.recipient_masked === '+58•••2233')).toMatchObject({ status: 'failed', error: 'unverified' });
    expect(enviados().map((m) => m.to)).toEqual([TEL_A.slice(1)]);
  });

  it('fuera de producción (VG_ENV local) → filas failed dry_run, sin approvals ni Kapso', async () => {
    await avisar(NUEVO, { VG_ENV: 'local' });
    expect(filasNotif().map((f) => [f.status, f.error])).toEqual([['failed', 'dry_run'], ['failed', 'dry_run']]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(de('approvals', 'insert')).toHaveLength(0);
  });

  it('Kapso rechaza (131047) → la fila se cierra failed con el código corto y no se marca notified_at', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement' } }), { status: 400 }));
    contactos = [contactos[1]!];
    await avisar();
    expect(de('notifications', 'update').map((u) => u.payload)).toEqual([{ status: 'failed', error: '131047' }]);
    expect(de('incidents', 'update')).toHaveLength(0);
    expect(lineas()).not.toContain('Re-engagement');
  });

  it('si approvals falla, la alerta sale igual como texto sin botones', async () => {
    errorApprovals = { code: '23505' };
    contactos = [contactos[1]!];
    await avisar();
    const [m] = enviados();
    expect(m!.type).toBe('text');
    expect(m!.text!.body).toContain('ALERTA ALTA · Cloudflare');
    expect(m!.text!.body).toContain('Incidente #A1F3C9');
    expect(de('notifications', 'update')[0]!.payload).toMatchObject({ status: 'sent' });
  });
});

describe('despachador · cuándo no avisa', () => {
  it('sin cambio (ni nuevo, ni subida, ni reapertura) → no lee contactos ni envía', async () => {
    await avisar({ is_new: false, prev_severity: 'high', reopened: false });
    expect(doble.ops.map((o) => o.table)).toEqual(['incidents']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('muted_until futuro → nada', async () => {
    incidente.muted_until = new Date(Date.now() + 30 * 60_000).toISOString();
    await avisar();
    expect(doble.ops.map((o) => o.table)).toEqual(['incidents']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('severidad medium → solo in-app', async () => {
    incidente.severity = 'medium';
    await avisar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(filasNotif()).toHaveLength(0);
  });

  it('incidente de otra org (no casa id + org) → solo la lectura, nada más', async () => {
    await avisarIncidente(envDoble(PROD).env, '0f6c0000-0000-4000-8000-0000000000bb', INC, NUEVO, 'rid-1');
    expect(doble.ops.map((o) => o.table)).toEqual(['incidents']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('high → critical: incident_up_v1 con «SUBIÓ A CRÍTICA»; la llamada (P1) no deja fila', async () => {
    incidente.severity = 'critical';
    incidente.rule_ids = ['CF_UA_TOOL', 'CF_PATH_SCAN', 'CF_ADMIN_EXPOSED'];
    await avisar({ is_new: false, prev_severity: 'high', reopened: false });
    expect(filasNotif().map((f) => [f.channel, f.template])).toEqual([['whatsapp', 'incident_up_v1'], ['whatsapp', 'incident_up_v1']]);
    expect(enviados()[0]!.interactive.header.text).toBe('SUBIÓ A CRÍTICA · Cloudflare');
  });

  it('tormenta first → un solo storm_v1 de texto al contacto de prioridad 1; suppressed → nada', async () => {
    recientes = Array.from({ length: 6 }, (_, i) => ({ rule_ids: [i < 4 ? 'CF_UA_TOOL' : 'SB_DB_DOWN'] }));
    await avisar();
    const msgs = enviados();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ to: TEL_A.slice(1), type: 'text' });
    expect(msgs[0]!.text!.body).toBe('6 alertas nuevas en 2 min: 4 de Cloudflare y 2 de Supabase. Abre el panel para verlas.');
    expect(filasNotif()).toEqual([expect.objectContaining({ template: 'storm_v1', status: 'queued' })]);
    expect(de('approvals', 'insert')).toHaveLength(0);

    storms = 1;
    fetchMock.mockClear();
    doble.ops.length = 0;
    await avisar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(filasNotif()).toHaveLength(0);
  });

  it('nunca lanza: una excepción de la base solo deja un log', async () => {
    estado.client = { from: () => { throw new Error('boom'); } };
    await expect(avisar()).resolves.toBeUndefined();
    expect(lineas()).toContain('"despacho.error"');
  });
});
