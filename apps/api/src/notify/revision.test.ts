import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MsgRevision } from '../jobs.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// Paso 'aviso' de la revisión de código sin red (asignaciones/revision-codigo.md §5 y pruebas B4+B5 de §8.2): Kapso con
// fetch simulado y supabase-js con el doble (notifications en memoria con su unique por revisión, canal y destinatario).
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { avisarRevision } = await import('./revision.ts');
const { canjearBotonRevision, hashNonce, parsearBoton, VIDA_BOTON_MS } = await import('../actions/approvals.ts');

// Valores falsos armados en tiempo de ejecución: ningún literal con forma de secreto ni teléfono entero en el repo.
const CLAVE = ['clave', 'kapso', 'de', 'prueba'].join('-');
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const REV = 'c4000000-0000-4000-8000-000000000011';
const CFG = 'cf000000-0000-4000-8000-000000000021';
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
let config: Fila | null;          // code_review_configs de la revisión (muted_until del botón rvs)
let aprobaciones: Fila[];         // approvals escritas (una por botón)
let errores: { lectura?: boolean; cierre?: boolean; approvals?: boolean; silencio?: boolean };
let linea: string[];   // orden de escrituras y envíos
let doble: ReturnType<typeof dbDoble>;
let fetchMock: ReturnType<typeof vi.fn>;

const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) =>
  o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : true);

beforeEach(() => {
  rev = { id: REV, org_id: ORG, config_id: CFG, event: 'push', branch: 'main', head_sha: HEAD, pr_number: null, partial: false,
    counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, max_severity: 'critical', alert_state: 'pending',
    new_findings: [{ finding_id: 'f1', rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical',
      title: 'Clave live de Stripe en el código', resource: 'src/lib/pagos.ts:3' }] };
  prefs = null;
  contactos = [
    { id: 'c2', org_id: ORG, phone_e164: TEL_B, whatsapp: true, voice: false, priority: 2, verified_at: null,
      wa_last_inbound_at: null },
    { id: 'c1', org_id: ORG, phone_e164: TEL_A, whatsapp: true, voice: true, priority: 1, verified_at: hace(86_400_000),
      wa_last_inbound_at: hace(3600_000) },
  ];
  org = { is_demo: false };
  cfg = null;
  avisadas = 0;
  notifs = [];
  config = { id: CFG, org_id: ORG, muted_until: null };
  aprobaciones = [];
  errores = {};
  linea = [];
  doble = dbDoble({
    // vg_redeem_approval con su semántica: un solo uso, no vencida y recipient = remitente (para los botones de abajo).
    rpc: (name, args) => {
      if (name !== 'vg_redeem_approval') return undefined;
      const f = aprobaciones.find((a) => a.nonce_hash === args.p_nonce_hash);
      if (!f || f.used_at || Date.parse(String(f.expires_at)) <= Date.now() || f.recipient !== args.p_recipient) return { data: [] };
      f.used_at = new Date().toISOString();
      return { data: [{ ...f }] };
    },
    tabla: (op): Resp | undefined => {
      if (op.table === 'code_reviews' && op.action === 'select') {
        if (errores.lectura) return { error: { code: '08006' } };
        if (op.head) return { count: avisadas };
        return { data: eqDe(op, 'id') === REV && eqDe(op, 'org_id') === ORG ? rev : null };
      }
      if (op.table === 'code_reviews' && op.action === 'update') {
        if (errores.cierre) return { error: { code: '08006' } };
        if (cumple(rev, op)) Object.assign(rev, op.payload);
        linea.push(`cierre:${String((op.payload as Fila).alert_state ?? (op.payload as Fila).whatsapp_action)}`);
        return {};
      }
      if (op.table === 'code_review_configs') {
        if (op.action === 'select' && errores.silencio) return { error: { code: '42703' } };
        const hit = config && cumple(config, op) ? config : null;
        if (op.action === 'update') { if (hit) Object.assign(hit, op.payload); return { data: hit ? [{ id: hit.id }] : [] }; }
        return { data: hit };
      }
      if (op.table === 'approvals' && op.action === 'insert') {
        if (errores.approvals) return { error: { code: '42703' } };
        aprobaciones.push(...(op.payload as Fila[]).map((f) => ({ ...f, used_at: null })));
        linea.push('approvals');
        return {};
      }
      if (op.table === 'alert_prefs') return { data: prefs };
      // El canje de un botón busca UN contacto por teléfono y org; el aviso lee la lista.
      if (op.table === 'contacts' && op.single) return { data: contactos.find((c) => cumple(c, op)) ?? null };
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
type Enviado = { to: string; type: string; text?: { body: string }; interactive?: { header?: unknown; footer?: unknown;
  body: { text: string }; action: { buttons: { reply: { id: string; title: string } }[] } } };
const enviados = () => fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Enviado);
/** El texto del aviso, venga como interactivo (con botones) o como texto (sin ellos). */
const cuerpo = (m: Enviado | undefined) => (m?.type === 'interactive' ? m.interactive!.body.text : m?.text?.body);
const botonesDe = (m: Enviado | undefined) => m?.interactive?.action.buttons.map((b) => b.reply) ?? [];
const mascara = (t: string) => `+58•••${t.slice(-4)}`;
const TEXTO_PUSH = ['VanGUARD · Revisión de código', 'Push a main (9f1c2e7).', 'Nuevo: 1 crítico.', '- 1 clave o token en el código',
  `Rota las claves expuestas y revisa el detalle: https://officialvanguard.com/o/${ORG}/codebase?revision=${REV}`].join('\n');

describe('aviso · envío', () => {
  it('fila queued con code_review_id y code_review_v1 ANTES del envío, interactivo con el texto fijo y cierre sent', async () => {
    expect(await avisar()).toBe('ack');
    expect(notifs.map((n) => [n.recipient_masked, n.status, n.error ?? null])).toEqual([
      [mascara(TEL_A), 'sent', null], [mascara(TEL_B), 'failed', 'unverified']]);
    expect(notifs[0]).toMatchObject({ org_id: ORG, code_review_id: REV, channel: 'whatsapp', template: 'code_review_v1',
      provider_id: 'wamid.HBgM1' });
    expect(notifs.every((n) => !('incident_id' in n))).toBe(true);
    expect(linea.indexOf('fila:queued')).toBeLessThan(linea.indexOf('approvals'));
    expect(linea.indexOf('approvals')).toBeLessThan(linea.indexOf('kapso'));
    const [m] = enviados();
    expect(m!.to).toBe(TEL_A.slice(1));
    expect(m!.type).toBe('interactive');
    expect(cuerpo(m)).toBe(TEXTO_PUSH);                   // el mismo texto fijo de mensajeRevision, sin cabecera ni pie
    expect(m!.interactive!.header).toBeUndefined();
    expect(m!.interactive!.footer).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain('pagos.ts');
    // Pasó también el umbral de llamada (critical) y c1 tiene voz verificada: voice_pending, el aviso salió por WhatsApp.
    expect(rev).toMatchObject({ alert_state: 'sent', alert_reason: null, voice_pending: true });
    expect(typeof rev.notified_at).toBe('string');
    const cierre = doble.ops.find((o) => o.table === 'code_reviews' && o.action === 'update')!;
    expect(cierre.filters).toContainEqual(['alert_state', 'eq', 'pending']);
    expect(eqDe(cierre, 'org_id')).toBe(ORG);
  });

  it('botones «Enviarme el arreglo» y «Silenciar repo 1 h» con el código de la revisión; una fila de approvals por botón', async () => {
    const antes = Date.now();
    await avisar();
    const botones = botonesDe(enviados()[0]);
    expect(botones.map((b) => b.title)).toEqual(['Enviarme el arreglo', 'Silenciar repo 1 h']);
    const ids = botones.map((b) => parsearBoton(b.id)!);
    expect(ids.map((b) => [b.accion, b.codigo])).toEqual([['fix', 'C40000'], ['rvs', 'C40000']]);
    expect(ids[0]!.nonce).not.toBe(ids[1]!.nonce);
    // Solo el contacto al que se le envió (el sin verificar no tiene botones): una fila por botón, solo con el sha256.
    expect(aprobaciones).toHaveLength(2);
    for (const [i, f] of aprobaciones.entries()) {
      expect(f).toMatchObject({ org_id: ORG, code_review_id: REV, channel: 'whatsapp', recipient: TEL_A.slice(1),
        action_kind: i === 0 ? 'send_fix' : 'mute_repo', nonce_hash: await hashNonce(ids[i]!.nonce), params: {} });
      expect('incident_id' in f).toBe(false);
      const vida = Date.parse(String(f.expires_at)) - antes;
      expect(vida).toBeGreaterThanOrEqual(VIDA_BOTON_MS - 50);
      expect(vida).toBeLessThan(VIDA_BOTON_MS + 5_000);
    }
    expect(JSON.stringify(aprobaciones)).not.toContain(ids[0]!.nonce);
  });

  it('revisión parcial sin nuevos → avisa como incompleta, solo con «Silenciar repo 1 h» (no hay arreglo que enviar)', async () => {
    Object.assign(rev, { partial: true, max_severity: null, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      new_findings: [] });
    await avisar();
    expect(cuerpo(enviados()[0])).toContain('No pudimos revisar entero este push.');
    expect(botonesDe(enviados()[0]).map((b) => b.title)).toEqual(['Silenciar repo 1 h']);
    expect(aprobaciones.map((a) => a.action_kind)).toEqual(['mute_repo']);
    expect(rev).toMatchObject({ alert_state: 'sent', voice_pending: false });
  });

  it('approvals falla → el aviso sale igual, como el texto de siempre y sin botones', async () => {
    errores.approvals = true;
    await avisar();
    const [m] = enviados();
    expect(m!.type).toBe('text');
    expect(m!.text!.body).toBe(TEXTO_PUSH);
    expect(notifs[0]).toMatchObject({ status: 'sent' });
    expect(rev).toMatchObject({ alert_state: 'sent' });
  });

  it('Kapso falla → fila failed con el código corto y la revisión not_sent/envio', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":{"code":131030,"message":"x"}}', { status: 400 }));
    await avisar();
    expect(notifs[0]).toMatchObject({ status: 'failed', error: '131030' });
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'envio' });
  });
});

describe('aviso · pull_request (B7)', () => {
  it('el aviso de un PR dice «Pull request #N hacia main (sha7).» con la misma url y las mismas lecturas que un push', async () => {
    await avisar();   // push de referencia
    const lecturas = doble.ops.length;
    Object.assign(rev, { event: 'pull_request', pr_number: 12, alert_state: 'pending' });
    notifs = [];
    doble.ops.length = 0;
    expect(await avisar()).toBe('ack');
    expect(doble.ops.length).toBe(lecturas);
    const lectura = doble.ops.find((o) => o.table === 'code_reviews' && o.action === 'select' && !o.head)!;
    expect(lectura.columns).toContain('event');
    expect(lectura.columns).toContain('pr_number');
    expect(cuerpo(enviados()[1])).toBe(['VanGUARD · Revisión de código', 'Pull request #12 hacia main (9f1c2e7).',
      'Nuevo: 1 crítico.', '- 1 clave o token en el código',
      `Rota las claves expuestas y revisa el detalle: https://officialvanguard.com/o/${ORG}/codebase?revision=${REV}`].join('\n'));
    expect(notifs[0]).toMatchObject({ code_review_id: REV, template: 'code_review_v1', status: 'sent' });
    expect(rev).toMatchObject({ alert_state: 'sent' });
  });

  it('PR parcial sin nuevos → «No pudimos revisar entero este pull request.»; nada del PR más allá del número', async () => {
    Object.assign(rev, { event: 'pull_request', pr_number: 7, partial: true, max_severity: null, new_findings: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } });
    await avisar();
    expect(cuerpo(enviados()[0])).toBe(['VanGUARD · Revisión de código', 'Pull request #7 hacia main (9f1c2e7).',
      'No pudimos revisar entero este pull request.',
      `Revísalo en VanGUARD: https://officialvanguard.com/o/${ORG}/codebase?revision=${REV}`].join('\n'));
  });
});

describe('aviso · lo que no sale', () => {
  it('ventana de 24 h cerrada → fila failed/window_closed sin llamar a Kapso y not_sent/window_closed', async () => {
    contactos[1]!.wa_last_inbound_at = hace(2 * 86_400_000);
    await avisar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifs.map((n) => [n.status, n.error])).toEqual([['failed', 'window_closed'], ['failed', 'unverified']]);
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'window_closed' });
    expect(aprobaciones).toEqual([]);                     // sin envío no hay botones que canjear
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
    expect(aprobaciones).toHaveLength(2);                 // el reintento no escribe botones nuevos
    expect(rev).toMatchObject({ alert_state: 'sent', voice_pending: true });
  });

  it('fuera de producción → failed/dry_run y not_sent/dry_run; sin Kapso configurado → failed/sin_config', async () => {
    await avisar({ VG_ENV: 'local' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifs[0]).toMatchObject({ status: 'failed', error: 'dry_run' });
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'dry_run' });
    expect(aprobaciones).toEqual([]);

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
    expect(aprobaciones).toHaveLength(2);                 // solo las del envío que salió
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

describe('aviso · repo silenciado (botón rvs) y botones de punta a punta', () => {
  it('muted_until en el futuro → not_sent/silenciado sin filas ni Kapso; la config se lee por id y org; vencido → avisa', async () => {
    config!.muted_until = new Date(Date.now() + 30 * 60_000).toISOString();
    expect(await avisar()).toBe('ack');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifs).toEqual([]);
    expect(aprobaciones).toEqual([]);
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'silenciado', voice_pending: false });
    const lectura = doble.ops.find((o) => o.table === 'code_review_configs')!;
    expect([eqDe(lectura, 'id'), eqDe(lectura, 'org_id')]).toEqual([CFG, ORG]);
    expect(lectura.columns).toBe('muted_until');

    Object.assign(rev, { alert_state: 'pending', alert_reason: null });
    config!.muted_until = new Date(Date.now() - 1000).toISOString();
    await avisar();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rev).toMatchObject({ alert_state: 'sent' });
  });

  it('sin leer el silencio (p. ej. 0018 sin aplicar) avisa igual: falla hacia avisar', async () => {
    errores.silencio = true;
    await avisar();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rev).toMatchObject({ alert_state: 'sent' });
  });

  it('rvs del aviso pone muted_until = ahora + 1 h y el aviso de la siguiente revisión sale silenciado', async () => {
    await avisar();
    const rvs = parsearBoton(botonesDe(enviados()[0]).find((b) => b.title === 'Silenciar repo 1 h')!.id)!;
    const ahora = Date.now();
    const c = await canjearBotonRevision(envDoble(PROD).env, rvs, TEL_A.slice(1), 'rid-1', ahora);
    expect(c.resultado).toBe('silenciado');
    expect(c.texto).toMatch(/^Hecho: no te mandaré avisos de revisión de este repo hasta las \d{2}:\d{2} \(hora de Caracas\)\./);
    expect(config!.muted_until).toBe(new Date(ahora + 3_600_000).toISOString());
    expect(rev).toMatchObject({ whatsapp_action: 'muted', whatsapp_action_at: new Date(ahora).toISOString() });
    // El mismo botón otra vez: ya está usado.
    expect((await canjearBotonRevision(envDoble(PROD).env, rvs, TEL_A.slice(1), 'rid-2')).resultado).toBe('sin_canje');

    // Siguiente push del mismo repo: la revisión sigue, el WhatsApp no sale.
    Object.assign(rev, { alert_state: 'pending', alert_reason: null });
    notifs = [];
    fetchMock.mockClear();
    await avisar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rev).toMatchObject({ alert_state: 'not_sent', alert_reason: 'silenciado' });
  });

  it('fix del aviso → los pasos fijos de la regla más grave y el enlace al panel, sin ruta, valor ni título del hallazgo', async () => {
    rev.new_findings = [
      { finding_id: 'f2', rule_id: 'CB_ENV_COMMITTED', severity: 'high', title: 'Archivo config/.env.prod subido',
        resource: 'config/.env.prod' },
      { finding_id: 'f1', rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical', title: 'Clave live de Stripe en el código',
        resource: 'src/lib/pagos.ts:3' },
    ];
    await avisar();
    const fix = parsearBoton(botonesDe(enviados()[0]).find((b) => b.title === 'Enviarme el arreglo')!.id)!;
    const c = await canjearBotonRevision(envDoble(PROD).env, fix, TEL_A.slice(1), 'rid-1');
    expect(c.resultado).toBe('arreglo_enviado');
    expect(c.texto!.split('\n')[0])
      .toBe('Hecho: así se corrige `CB_SECRET_STRIPE_LIVE` (severidad crítica), lo más grave de esta revisión.');
    expect(c.texto).toContain('1. Rota la credencial antes que nada (en Stripe');
    expect(c.texto!.endsWith(`https://officialvanguard.com/o/${ORG}/codebase?revision=${REV}`)).toBe(true);
    for (const prohibido of ['pagos.ts', 'src/lib', '.env.prod', 'config/', 'Clave live de Stripe']) {
      expect(c.texto).not.toContain(prohibido);
    }
    expect(rev).toMatchObject({ whatsapp_action: 'fix_sent' });
    expect(config!.muted_until).toBeNull();               // fix no silencia nada
  });
});
