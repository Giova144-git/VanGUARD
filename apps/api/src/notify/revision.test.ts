import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MsgRevision } from '../jobs.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// Paso 'aviso' de la revisión de código sin red (asignaciones/revision-codigo.md §5 y pruebas B4+B5 de §8.2): Kapso con
// fetch simulado y supabase-js con el doble (notifications en memoria con su unique por revisión, canal y destinatario).
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { avisarRevision } = await import('./revision.ts');

// Valores falsos armados en tiempo de ejecución: ningún literal con forma de secreto ni teléfono entero en el repo.
const CLAVE = ['clave', 'kapso', 'de', 'prueba'].join('-');
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const REV = 'c4000000-0000-4000-8000-000000000011';
const HEAD = '9f1c2e7a4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a';
const TEL_A = '+58' + '4141234567';
const TEL_B = '+58' + '4241112233';
const PROD = { VG_ENV: 'production' as const, KAPSO_API_KEY: CLAVE, KAPSO_PHONE_NUMBER_ID: '1234567890',
  APP_ORIGIN: 'https://officialvanguard.com' };
const hace = (ms: number) => new Date(Date.now() - ms).toISOString();

type Fila = Record<string, unknown>;
let rev: Fila;
let prefs: Fila | null;
let contactos: Fila[];
let org: Fila;
let cfg: Fila | null;
let avisadas: number;
let notifs: Fila[];
let errores: { lectura?: boolean; cierre?: boolean };
let linea: string[];   // orden de escrituras y envíos
let doble: ReturnType<typeof dbDoble>;
let fetchMock: ReturnType<typeof vi.fn>;

const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) =>
  o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : true);

beforeEach(() => {
  rev = { id: REV, org_id: ORG, event: 'push', branch: 'main', head_sha: HEAD, pr_number: null, partial: false,
    counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, max_severity: 'critical', alert_state: 'pending',
    new_findings: [{ finding_id: 'f1', rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical',
      title: 'Clave live de Stripe en el código', resource: 'src/lib/pagos.ts:3' }] };
  prefs = null;
  contactos = [
    { id: 'c2', phone_e164: TEL_B, whatsapp: true, voice: false, priority: 2, verified_at: null, wa_last_inbound_at: null },
    { id: 'c1', phone_e164: TEL_A, whatsapp: true, voice: true, priority: 1, verified_at: hace(86_400_000),
      wa_last_inbound_at: hace(3600_000) },
  ];
  org = { is_demo: false };
  cfg = null;
  avisadas = 0;
  notifs = [];
  errores = {};
  linea = [];
  doble = dbDoble({
    tabla: (op): Resp | undefined => {
      if (op.table === 'code_reviews' && op.action === 'select') {
        if (errores.lectura) return { error: { code: '08006' } };
        if (op.head) return { count: avisadas };
        return { data: eqDe(op, 'id') === REV && eqDe(op, 'org_id') === ORG ? rev : null };
      }
      if (op.table === 'code_reviews' && op.action === 'update') {
        if (errores.cierre) return { error: { code: '08006' } };
        if (cumple(rev, op)) Object.assign(rev, op.payload);
        linea.push(`cierre:${String((op.payload as Fila).alert_state)}`);
        return {};
      }
      if (op.table === 'alert_prefs') return { data: prefs };
      if (op.table === 'contacts') return { data: contactos };
      if (op.table === 'orgs') return { data: org };
      if (op.table === 'app_config') return { data: cfg };
      if (op.table !== 'notifications') return undefined;
      if (op.action === 'insert') {
        const f = op.payload as Fila;
        if (notifs.some((n) => n.code_review_id === f.code_review_id && n.channel === f.channel
          && n.recipient_masked === f.recipient_masked)) return { error: { code: '23505' } };
        const n = { id: `n${notifs.length + 1}`, ...f };
        notifs.push(n);
        linea.push(`fila:${String(f.status)}`);
        return { data: { id: n.id } };
      }
      const hit = notifs.find((n) => cumple(n, op));
      if (op.action === 'update') { if (hit) Object.assign(hit, op.payload); return {}; }
      if (op.action === 'select') return { data: hit ?? null };
      return undefined;
    },
  });
  estado.client = doble.client;
  let k = 0;
  fetchMock = vi.fn(async () => {
    linea.push('kapso');
    return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.HBgM${++k}` }] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const msg: MsgRevision = { v: 1, kind: 'review', org_id: ORG, review_id: REV, paso: 'aviso' };
const avisar = (env: Partial<CloudflareBindings> = {}, intento = 1) => avisarRevision(envDoble({ ...PROD, ...env }).env, msg, intento);
const enviados = () => fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as
  { to: string; type: string; text: { body: string } });
const mascara = (t: string) => `+58•••${t.slice(-4)}`;

describe('aviso · envío', () => {
  it('fila queued con code_review_id y code_review_v1 ANTES del envío, texto fijo con la url y cierre sent', async () => {
    expect(await avisar()).toBe('ack');
    expect(notifs.map((n) => [n.recipient_masked, n.status, n.error ?? null])).toEqual([
      [mascara(TEL_A), 'sent', null], [mascara(TEL_B), 'failed', 'unverified']]);
    expect(notifs[0]).toMatchObject({ org_id: ORG, code_review_id: REV, channel: 'whatsapp', template: 'code_review_v1',
      provider_id: 'wamid.HBgM1' });
    expect(notifs.every((n) => !('incident_id' in n))).toBe(true);
    expect(linea.indexOf('fila:queued')).toBeLessThan(linea.indexOf('kapso'));
    const [m] = enviados();
    expect(m!.to).toBe(TEL_A.slice(1));
    expect(m!.type).toBe('text');
    expect(m!.text.body).toBe(['VanGUARD · Revisión de código', 'Push a main (9f1c2e7).', 'Nuevo: 1 crítico.',
      '- 1 clave o token en el código',
      `Rota las claves expuestas y revisa el detalle: https://officialvanguard.com/o/${ORG}/codebase?revision=${REV}`].join('\n'));
    expect(m!.text.body).not.toContain('pagos.ts');
    // Pasó también el umbral de llamada (critical) y c1 tiene voz verificada: voice_pending, el aviso salió por WhatsApp.
    expect(rev).toMatchObject({ alert_state: 'sent', alert_reason: null, voice_pending: true });
    expect(typeof rev.notified_at).toBe('string');
    const cierre = doble.ops.find((o) => o.table === 'code_reviews' && o.action === 'update')!;
    expect(cierre.filters).toContainEqual(['alert_state', 'eq', 'pending']);
    expect(eqDe(cierre, 'org_id')).toBe(ORG);
  });

  it('revisión parcial sin nuevos → avisa como incompleta', async () => {
    Object.assign(rev, { partial: true, max_severity: null, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      new_findings: [] });
    await avisar();
    expect(enviados()[0]!.text.body).toContain('No pudimos revisar entero este push.');
    expect(rev).toMatchObject({ alert_state: 'sent', voice_pending: false });
  });

  it('Kapso falla → fila failed con el código corto y la revisión not_sent/envio', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":{"code":131030,"message":"x"}}', { status: 400 }));
    await avisar();
    expect(notifs[0]).toMatchObject({ status: 'failed', error: '131030' });
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'envio' });
  });
});

describe('aviso · lo que no sale', () => {
  it('ventana de 24 h cerrada → fila failed/window_closed sin llamar a Kapso y not_sent/window_closed', async () => {
    contactos[1]!.wa_last_inbound_at = hace(2 * 86_400_000);
    await avisar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifs.map((n) => [n.status, n.error])).toEqual([['failed', 'window_closed'], ['failed', 'unverified']]);
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'window_closed' });
    // En el sandbox (KAPSO_SANDBOX='1') nuestra comprobación da la ventana por abierta.
    Object.assign(rev, { alert_state: 'pending' });
    notifs = [];
    await avisar({ KAPSO_SANDBOX: '1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('el segundo aviso no repite: con la revisión ya cerrada, ack sin leer contactos ni enviar', async () => {
    await avisar();
    doble.ops.length = 0;
    expect(await avisar()).toBe('ack');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(doble.ops.map((o) => o.table)).toEqual(['code_reviews']);
  });

  it('un reintento con las filas ya escritas (23505) no llama a Kapso y cierra con lo que dicen esas filas', async () => {
    errores.cierre = true;
    expect(await avisar()).toEqual({ retry: 10 });   // envió, pero no pudo cerrar
    expect(fetchMock).toHaveBeenCalledTimes(1);
    errores.cierre = false;
    expect(await avisar({}, 2)).toBe('ack');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notifs).toHaveLength(2);
    expect(rev).toMatchObject({ alert_state: 'sent', voice_pending: true });
  });

  it('fuera de producción → failed/dry_run y not_sent/dry_run; sin Kapso configurado → failed/sin_config', async () => {
    await avisar({ VG_ENV: 'local' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifs[0]).toMatchObject({ status: 'failed', error: 'dry_run' });
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'dry_run' });

    Object.assign(rev, { alert_state: 'pending' });
    notifs = [];
    await avisar({ KAPSO_API_KEY: undefined });
    expect(notifs[0]).toMatchObject({ status: 'failed', error: 'sin_config' });
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'sin_config' });
  });

  it('el cupo de revisión corta la 4.ª: 3 avisadas en la hora → skipped_cap/cap; la org de demo admite 10', async () => {
    avisadas = 3;
    await avisar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifs[0]).toMatchObject({ status: 'skipped_cap', error: 'cap' });
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'cap' });
    const cupo = doble.ops.find((o) => o.table === 'code_reviews' && o.head)!;
    expect(cupo.filters).toContainEqual(['alert_state', 'eq', 'sent']);
    expect(cupo.filters.some(([c, o]) => c === 'notified_at' && o === 'gte')).toBe(true);
    expect(eqDe(cupo, 'org_id')).toBe(ORG);

    Object.assign(rev, { alert_state: 'pending' });
    notifs = [];
    org = { is_demo: true };
    cfg = { value: new Date(Date.now() + 45 * 60_000).toISOString() };
    await avisar();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('org de demo con la ventana de alertas cerrada → skipped_cap/fuera_de_ventana_demo', async () => {
    org = { is_demo: true };
    await avisar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifs.map((n) => n.error)).toEqual(['fuera_de_ventana_demo', 'fuera_de_ventana_demo']);
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'fuera_de_ventana_demo' });
  });

  it('voice_pending también cuando no sale nada (cupo, ventana de 24 h, sin WhatsApp); sin voz verificada, false', async () => {
    const otraVez = () => {
      Object.assign(rev, { alert_state: 'pending', alert_reason: null });
      delete rev.voice_pending;
      notifs = [];
    };
    avisadas = 3;
    await avisar();
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'cap', voice_pending: true });
    otraVez();
    avisadas = 0;
    contactos[1]!.wa_last_inbound_at = hace(2 * 86_400_000);
    await avisar();
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'window_closed', voice_pending: true });
    otraVez();
    contactos = [{ id: 'c9', phone_e164: TEL_A, whatsapp: false, voice: true, priority: 1, verified_at: hace(1000) }];
    await avisar();
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'sin_contactos', voice_pending: true });
    otraVez();
    contactos = [{ id: 'c9', phone_e164: TEL_A, whatsapp: false, voice: true, priority: 1, verified_at: null }];
    await avisar();
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'sin_contactos', voice_pending: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin contactos con WhatsApp → not_sent/sin_contactos sin filas', async () => {
    contactos = [{ id: 'c9', phone_e164: TEL_A, whatsapp: false, voice: true, priority: 1, verified_at: hace(1000) }];
    await avisar();
    expect(notifs).toEqual([]);
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'sin_contactos' });
  });

  it('las preferencias pasaron a off tras el diff → none/bajo_umbral sin filas', async () => {
    prefs = { review_whatsapp_min: 'off', review_voice_min: 'off' };
    await avisar();
    expect(notifs).toEqual([]);
    expect(rev).toMatchObject({ alert_state: 'none', alert_reason: 'bajo_umbral' });
  });

  it('solo el umbral de voz pasa (WhatsApp en off) → sale por WhatsApp mientras no haya llamadas', async () => {
    prefs = { review_whatsapp_min: 'off', review_voice_min: 'critical' };
    await avisar();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rev).toMatchObject({ alert_state: 'sent', voice_pending: true });
  });

  it('alert_state no pendiente → ack sin nada; si no puede leer, retry sin escribir', async () => {
    rev.alert_state = 'none';
    expect(await avisar()).toBe('ack');
    expect(notifs).toEqual([]);
    rev.alert_state = 'pending';
    errores.lectura = true;
    expect(await avisar({}, 2)).toEqual({ retry: 20 });
    expect(notifs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
