import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError as ApiErrorBody, Incident, IncidentDetail, RespuestaEscritura } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
// El motor en vivo (ingesta) no entra en estas pruebas: sin su despachador.
vi.mock('../engine/evaluar.ts', () => ({ evaluarEnVivo: vi.fn() }));

const { app } = await import('../app.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';     // owner
const VERA = '7b1e0000-0000-4000-8000-000000000002';    // viewer
const ANON = '7b1e0000-0000-4000-8000-000000000003';    // «Ver demo»
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const OTRA_ORG = '0f6c0000-0000-4000-8000-000000000002';
const INC = '9e0b0000-0000-4000-8000-000000000001';
const INC_RESUELTO = '9e0b0000-0000-4000-8000-000000000002';
const INC_OTRA = '9e0b0000-0000-4000-8000-000000000003';
const T0 = Date.parse('2026-10-24T19:01:00.000Z');
const pg = (ms: number) => new Date(T0 + ms).toISOString().replace('Z', '+00:00');

type Fila = Record<string, unknown>;
const fila = (o: Fila): Fila => ({
  id: INC, org_id: ORG, code: 'A1F3C9', rule_ids: ['CF_UA_TOOL', 'CF_PATH_SCAN', 'CF_ADMIN_EXPOSED'], severity: 'critical',
  title: 'Escaneo con sqlmap y /admin abierto desde 186.92.x.x', resource: 'ip:186.92.14.7', status: 'open', event_count: 1342,
  details: { ip: '186.92.14.7', ua_top: 'sqlmap/1.8', n_60s: 1180, detected_at: pg(6_100), severity_up_at: pg(26_100) },
  started_at: pg(0), last_event_at: pg(60_000), notified_at: pg(8_400), acked_at: null, acked_via: null, muted_until: null,
  mitigated_at: null, resolved_at: null, suspected_injection: false, ...o,
});

let incidentes: Fila[];
let notificaciones: Fila[];
let doble: ReturnType<typeof dbDoble>;
const ROL: Record<string, string> = { [ANA]: 'owner', [VERA]: 'viewer', [ANON]: 'viewer' };
const CLAIMS: Record<string, Fila> = {
  ana: { sub: ANA, email: 'ana@acme.dev', is_anonymous: false },
  vera: { sub: VERA, email: 'vera@acme.dev', is_anonymous: false },
  anon: { sub: ANON, email: null, is_anonymous: true },
};

const inDe = (op: Op, col: string) => op.filters.find(([c, o]) => c === col && o === 'in')?.[2] as unknown[] | undefined;

function tabla(op: Op): Resp | undefined {
  if (op.table === 'org_members') {
    return { data: eqDe(op, 'org_id') === ORG ? { role: ROL[String(eqDe(op, 'user_id'))] } : null };
  }
  const org = eqDe(op, 'org_id');
  if (op.table === 'incidents') {
    const id = eqDe(op, 'id'), st = eqDe(op, 'status'), sts = inDe(op, 'status');
    const xs = incidentes.filter((f) => f.org_id === org && (id === undefined || f.id === id)
      && (st === undefined || f.status === st) && (!sts || sts.includes(f.status)));
    if (op.action === 'update') {
      if (!xs[0]) return { data: null };
      Object.assign(xs[0], op.payload);
      return { data: { ...xs[0] } };
    }
    return { data: op.single ? (xs[0] ? { ...xs[0] } : null) : xs.map((x) => ({ ...x })) };
  }
  const delIncidente = (xs: Fila[]) => xs.filter((x) => x.org_id === org && x.incident_id === eqDe(op, 'incident_id'));
  if (op.table === 'notifications') return { data: delIncidente(notificaciones) };
  if (op.table === 'actions') {
    return { data: delIncidente([{ id: '5a0c0000-0000-4000-8000-000000000001', org_id: ORG, incident_id: INC, kind: 'block_ip',
      target: '186.92.14.7', status: 'executed', created_at: pg(64_000), undone_at: null, expires_at: pg(64_000 + 3_600_000),
      approval_id: null }]) };
  }
  if (op.table === 'approvals') return { data: delIncidente([{ org_id: ORG, incident_id: INC, created_at: pg(50_000) }]) };
  return undefined;
}

beforeEach(() => {
  incidentes = [fila({}), fila({ id: INC_RESUELTO, code: 'B7E204', rule_ids: ['CF_UA_TOOL'], severity: 'high', status: 'resolved',
    resolved_at: pg(1_000_000) }), fila({ id: INC_OTRA, org_id: OTRA_ORG, code: 'C0FFEE' })];
  notificaciones = [
    { id: '4b0d0000-0000-4000-8000-000000000001', org_id: ORG, incident_id: INC, channel: 'whatsapp', recipient_masked: '+58•••0001',
      template: 'incident_v1', status: 'read', error: null, created_at: pg(7_900), sent_at: pg(8_400), delivered_at: pg(9_600),
      read_at: pg(14_000) },
    { id: '4b0d0000-0000-4000-8000-000000000002', org_id: OTRA_ORG, incident_id: INC, channel: 'whatsapp', recipient_masked: '+58•••9999',
      template: 'incident_v1', status: 'sent', error: null, created_at: pg(1), sent_at: pg(2), delivered_at: null, read_at: null },
  ];
  doble = dbDoble({ tabla, claims: (tok) => CLAIMS[tok] ?? null });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const pedir = (ruta: string, o: { tok?: string; method?: string; body?: string } = {}) =>
  app.request(`https://officialvanguard.com/api/orgs/${ruta}`, { method: o.method ?? 'GET',
    headers: { authorization: `Bearer ${o.tok ?? 'ana'}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: o.body }, envDoble().env);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;
const ops = (tablaNombre: string, action?: Op['action']) =>
  doble.ops.filter((o) => o.table === tablaNombre && (!action || o.action === action));

describe('E17 · GET /api/orgs/:org/incidents', () => {
  it('?status=open → open y ack de la org (el viewer puede leer), módulo derivado y fechas en …Z', async () => {
    incidentes.push(fila({ id: '9e0b0000-0000-4000-8000-000000000004', code: 'D00D11', status: 'ack', acked_at: pg(9_000),
      acked_via: 'whatsapp' }));
    const r = await pedir(`${ORG}/incidents?status=open`, { tok: 'vera' });
    expect(r.status).toBe(200);
    const xs = z.array(Incident).parse(await r.json());
    expect(xs.map((x) => x.code)).toEqual(['A1F3C9', 'D00D11']);
    expect(xs[0]).toMatchObject({ module: 'cloudflare', started_at: '2026-10-24T19:01:00.000Z', notified_at: '2026-10-24T19:01:08.400Z',
      details: { ip: '186.92.14.7', detected_at: '2026-10-24T19:01:06.100Z', severity_up_at: '2026-10-24T19:01:26.100Z' } });
    const op = ops('incidents')[0]!;
    expect(eqDe(op, 'org_id')).toBe(ORG);
    expect(inDe(op, 'status')).toEqual(['open', 'ack']);
  });

  it('sin status → últimas 24 h por last_event_at; status=resolved filtra exacto; status desconocido → 422', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0 + 3_600_000);
    const r = await pedir(`${ORG}/incidents`);
    expect(r.status).toBe(200);
    expect(z.array(Incident).parse(await r.json()).map((x) => x.code)).toEqual(['A1F3C9', 'B7E204']);
    expect(ops('incidents')[0]!.filters).toContainEqual(['last_event_at', 'gte', new Date(T0 + 3_600_000 - 24 * 3_600_000).toISOString()]);

    const res = await pedir(`${ORG}/incidents?status=resolved`);
    expect(z.array(Incident).parse(await res.json()).map((x) => x.code)).toEqual(['B7E204']);
    const mal = await pedir(`${ORG}/incidents?status=abierto`);
    expect(mal.status).toBe(422);
    expect((await error(mal)).details?.field_errors).toEqual({ status: ['Valor no válido'] });
  });

  it('org de la que no es miembro → 404 sin leer incidentes', async () => {
    const r = await pedir(`${OTRA_ORG}/incidents?status=open`);
    expect(r.status).toBe(404);
    expect(ops('incidents')).toEqual([]);
  });
});

describe('E17 · GET /api/orgs/:org/incidents/:id', () => {
  it('IncidentDetail con avisos, acciones y línea de tiempo; cada lectura lleva org_id e incident_id', async () => {
    const r = await pedir(`${ORG}/incidents/${INC}`, { tok: 'vera' });
    expect(r.status).toBe(200);
    const d = IncidentDetail.parse(await r.json());
    expect(d.code).toBe('A1F3C9');
    // La notificación de otra org con el mismo incident_id no aparece.
    expect(d.notifications.map((n) => n.recipient_masked)).toEqual(['+58•••0001']);
    expect(d.notifications[0]!.sent_at).toBe('2026-10-24T19:01:08.400Z');
    expect(d.actions).toHaveLength(1);
    expect(d.timeline.map((t) => [t.kind, t.ms])).toEqual([
      ['attack_start', 0], ['detected', 6_100], ['whatsapp_sent', 8_400], ['whatsapp_delivered', 9_600], ['whatsapp_read', 14_000],
      ['severity_up', 26_100], ['action_proposed', 50_000], ['action_executed', 64_000]]);
    for (const t of ['incidents', 'notifications', 'actions', 'approvals']) {
      expect(eqDe(ops(t)[0]!, 'org_id')).toBe(ORG);
    }
    for (const t of ['notifications', 'actions', 'approvals']) expect(eqDe(ops(t)[0]!, 'incident_id')).toBe(INC);
    expect(eqDe(ops('approvals')[0]!, 'channel')).toBe('in_app');
  });

  it('anti-IDOR: el id de un incidente de otra org → 404; un id que no es uuid → 404 sin consultar', async () => {
    const r = await pedir(`${ORG}/incidents/${INC_OTRA}`);
    expect(r.status).toBe(404);
    expect((await error(r)).code).toBe('not_found');
    const n = doble.ops.length;
    expect((await pedir(`${ORG}/incidents/1%20or%201=1`)).status).toBe(404);
    expect(doble.ops.slice(n).filter((o) => o.table !== 'org_members')).toEqual([]);
  });
});

describe('E19 · POST …/incidents/:id/ack', () => {
  it('admin: open → ack con acked_at y acked_via in_app; responde Incident + RespuestaEscritura', async () => {
    const r = await pedir(`${ORG}/incidents/${INC}/ack`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(Incident.parse(b)).toMatchObject({ status: 'ack', acked_via: 'in_app' });
    expect(RespuestaEscritura.parse(b)).toMatchObject({ ok: true, resultado: 'Lo estás viendo' });
    const [u, ...resto] = ops('incidents', 'update');
    expect(resto).toEqual([]);
    expect(u!.payload).toEqual({ status: 'ack', acked_at: expect.any(String), acked_via: 'in_app' });
    expect(eqDe(u!, 'id')).toBe(INC);
    expect(eqDe(u!, 'org_id')).toBe(ORG);
    expect(inDe(u!, 'status')).toEqual(['open']);
  });

  it('sin cuerpo también vale; ack ya en ack → 200 sin escribir (idempotente)', async () => {
    expect((await pedir(`${ORG}/incidents/${INC}/ack`, { method: 'POST' })).status).toBe(200);
    expect((await pedir(`${ORG}/incidents/${INC}/ack`, { method: 'POST' })).status).toBe(200);
    expect(ops('incidents', 'update')).toHaveLength(1);
  });

  it('mitigated sin ack previo: anota acked_at sin retroceder el estado', async () => {
    incidentes[0]!.status = 'mitigated';
    incidentes[0]!.mitigated_at = pg(64_100);
    const r = await pedir(`${ORG}/incidents/${INC}/ack`, { method: 'POST', body: '{}' });
    expect(Incident.parse(await r.json()).status).toBe('mitigated');
    expect(ops('incidents', 'update')[0]!.payload).toEqual({ acked_at: expect.any(String), acked_via: 'in_app' });
  });

  it('viewer y anónimo → 403 sin escribir; resuelto → 409 resolved; incidente de otra org → 404', async () => {
    for (const tok of ['vera', 'anon']) {
      const r = await pedir(`${ORG}/incidents/${INC}/ack`, { tok, method: 'POST', body: '{}' });
      expect(r.status).toBe(403);
      expect((await error(r)).code).toBe('forbidden');
    }
    const res = await pedir(`${ORG}/incidents/${INC_RESUELTO}/ack`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(409);
    expect((await error(res)).details?.reason).toBe('resolved');
    expect((await pedir(`${ORG}/incidents/${INC_OTRA}/ack`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect(ops('incidents', 'update')).toEqual([]);
    expect(incidentes.find((x) => x.id === INC_OTRA)!.status).toBe('open');
  });
});

describe('E19 · POST …/incidents/:id/mute', () => {
  it('{minutes: 30} → muted_until y details.muted_at (sin perder el resto de details); el estado no cambia', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0 + 100_000);
    const r = await pedir(`${ORG}/incidents/${INC}/mute`, { method: 'POST', body: JSON.stringify({ minutes: 30 }) });
    expect(r.status).toBe(200);
    const b = await r.json();
    const en = new Date(T0 + 100_000).toISOString();
    expect(Incident.parse(b)).toMatchObject({ status: 'open', muted_until: new Date(T0 + 100_000 + 30 * 60_000).toISOString(),
      details: { ip: '186.92.14.7', muted_at: en } });
    expect(RespuestaEscritura.parse(b)).toEqual({ ok: true, resultado: 'Silenciado 30 min', en });
    const u = ops('incidents', 'update')[0]!;
    expect(eqDe(u, 'org_id')).toBe(ORG);
    expect(inDe(u, 'status')).toEqual(['open', 'ack', 'mitigated']);
    expect((u.payload as Fila).details).toMatchObject({ ua_top: 'sqlmap/1.8', muted_at: en });
  });

  it('sin cuerpo → 60 min («Silenciado 1 h»); minutes fuera de 15–1440 → 422; JSON roto → 422', async () => {
    const r = await pedir(`${ORG}/incidents/${INC}/mute`, { method: 'POST' });
    expect(RespuestaEscritura.parse(await r.json()).resultado).toBe('Silenciado 1 h');
    for (const body of [JSON.stringify({ minutes: 10 }), JSON.stringify({ minutes: 1441 }), '{roto']) {
      const m = await pedir(`${ORG}/incidents/${INC}/mute`, { method: 'POST', body });
      expect(m.status).toBe(422);
      expect((await error(m)).code).toBe('invalid_body');
    }
    expect(ops('incidents', 'update')).toHaveLength(1);
  });

  it('resuelto → 409; viewer → 403; otra org → 404; ninguno escribe', async () => {
    const res = await pedir(`${ORG}/incidents/${INC_RESUELTO}/mute`, { method: 'POST', body: '{"minutes":60}' });
    expect(res.status).toBe(409);
    expect((await pedir(`${ORG}/incidents/${INC}/mute`, { tok: 'vera', method: 'POST', body: '{"minutes":60}' })).status).toBe(403);
    expect((await pedir(`${ORG}/incidents/${INC_OTRA}/mute`, { method: 'POST', body: '{"minutes":60}' })).status).toBe(404);
    expect(ops('incidents', 'update')).toEqual([]);
  });
});
