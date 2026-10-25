// E51 y E52 (evolución entre revisiones, asignaciones/evolucion-entre-revisiones.md §4.1 y las pruebas de B6 en §9.2):
// la RPC con el doble de supabase-js; lo que devuelve la base lo prueban supabase/tests/evolucion.sql y los fixtures.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditDelta, Evolution, fixtures } from '@vanguard/contracts';
import { dbDoble, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { app } = await import('../app.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const AJENA = '0f6c0000-0000-4000-8000-000000000002';
const SCAN = fixtures.scanDone.id;
let rol: string;
let anon: boolean;
let rpc: (name: string, args: Record<string, unknown>) => Resp | undefined;
let doble: ReturnType<typeof dbDoble>;

beforeEach(() => {
  rol = 'owner'; anon = false;
  rpc = (name) => {
    if (name === 'vg_audit_delta') return { data: { found: true, ...fixtures.auditDelta } };
    if (name === 'vg_evolution') return { data: fixtures.evolution };
    return undefined;
  };
  doble = dbDoble({
    // Solo ORG tiene a Ana como miembro: cualquier otra org da 404 en orgMember, antes de la RPC.
    tabla: (op) => (op.table === 'org_members' ? { data: op.filters.some(([c, , v]) => c === 'org_id' && v === ORG)
      ? { role: rol } : null } : undefined),
    rpc: (name, a) => rpc(name, a),
    claims: (t) => (t === 'ok' ? { sub: ANA, email: anon ? '' : 'ana@acme.dev', is_anonymous: anon } : null),
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const pedir = (ruta: string, org = ORG) => app.request(`https://officialvanguard.com/api/orgs/${org}/${ruta}`,
  { headers: { authorization: 'Bearer ok', origin: 'https://officialvanguard.com' } }, envDoble().env);
const llamadas = (name: string) => doble.rpcs.filter((r) => r.name === name);
const lineas = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
  .join('\n');
type Cuerpo = { error?: { code: string; message: string; details?: { field_errors?: Record<string, string[]> } } };

describe('E51 · GET scans/:id/delta', () => {
  it('available:true → el cuerpo de la RPC sin found, que cumple AuditDelta; p_org de orgMember y p_limit 50', async () => {
    const r = await pedir(`scans/${SCAN}/delta`);
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b).not.toHaveProperty('found');
    expect(AuditDelta.safeParse(b).success).toBe(true);
    expect(b).toEqual(JSON.parse(JSON.stringify(fixtures.auditDelta)));
    expect(llamadas('vg_audit_delta')).toEqual([{ name: 'vg_audit_delta', args: { p_org: ORG, p_scan: SCAN, p_limit: 50 } }]);
  });

  it('available:false (en_curso o sin_foto) pasa tal cual', async () => {
    for (const reason of ['en_curso', 'sin_foto'] as const) {
      rpc = () => ({ data: { found: true, available: false, scan_run_id: SCAN, reason } });
      const b = await (await pedir(`scans/${SCAN}/delta`)).json();
      expect(b).toEqual({ available: false, scan_run_id: SCAN, reason });
      expect(AuditDelta.safeParse(b).success).toBe(true);
    }
  });

  it('id que no es uuid → 404 sin RPC; found:false (de otra org o inexistente) → el mismo 404', async () => {
    const malo = await pedir('scans/no-es-uuid/delta');
    expect(malo.status).toBe(404);
    expect(llamadas('vg_audit_delta')).toEqual([]);
    rpc = () => ({ data: { found: false } });
    const ajena = await pedir(`scans/${SCAN}/delta`);
    expect(ajena.status).toBe(404);
    const [a, b] = [(await malo.json()) as Cuerpo, (await ajena.json()) as Cuerpo];
    expect([a.error?.code, a.error?.message]).toEqual(['not_found', 'Auditoría no encontrada']);
    expect(b.error?.message).toBe(a.error?.message);
    rpc = () => ({ data: null });   // una respuesta sin found tampoco se toma por buena
    expect((await pedir(`scans/${SCAN}/delta`)).status).toBe(404);
  });

  it('error de la base → 500 internal con log evolucion.delta_error (rid y code, sin cuerpos)', async () => {
    rpc = () => ({ error: { code: '08006', message: 'conexión perdida con datos internos' } });
    const r = await pedir(`scans/${SCAN}/delta`);
    expect(r.status).toBe(500);
    expect(((await r.json()) as Cuerpo).error?.message).toBe('No pudimos leer los cambios de esta auditoría');
    expect(lineas()).toContain('"event":"evolucion.delta_error"');
    expect(lineas()).toContain('"code":"08006"');
    expect(lineas()).not.toContain('datos internos');
  });
});

describe('E52 · GET evolution', () => {
  it('sin parámetros → 30/30; la salida del doble (los fixtures) cumple Evolution y sale tal cual', async () => {
    const r = await pedir('evolution');
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(Evolution.safeParse(b).success).toBe(true);
    expect(b).toEqual(JSON.parse(JSON.stringify(fixtures.evolution)));
    expect(llamadas('vg_evolution')).toEqual([{ name: 'vg_evolution', args: { p_org: ORG, p_days: 30, p_limit: 30 } }]);
    // Subpeticiones a la base: la de orgMember y la RPC (ninguna lectura más).
    expect([doble.ops.map((o) => o.table), doble.rpcs.length]).toEqual([['org_members'], 1]);
  });

  it('days y limit dentro de rango pasan a la RPC (bordes 1/90 y 1/60)', async () => {
    await pedir('evolution?days=7&limit=60');
    await pedir('evolution?days=90&limit=1');
    await pedir('evolution?days=1');
    expect(llamadas('vg_evolution').map((x) => [x.args.p_days, x.args.p_limit])).toEqual([[7, 60], [90, 1], [1, 30]]);
  });

  it('days=0, days=91, limit=61, days=abc, days=1e1 o limit=7.5 → 422 invalid_body con field_errors, sin RPC', async () => {
    const casos: [string, string][] = [['days=0', 'days'], ['days=91', 'days'], ['limit=61', 'limit'], ['days=abc', 'days'],
      ['days=1e1', 'days'], ['limit=7.5', 'limit'], ['limit=-1', 'limit']];
    for (const [q, campo] of casos) {
      const r = await pedir(`evolution?${q}`);
      expect(r.status, q).toBe(422);
      const b = (await r.json()) as Cuerpo;
      expect(b.error?.code, q).toBe('invalid_body');
      expect(Object.keys(b.error?.details?.field_errors ?? {}), q).toEqual([campo]);
    }
    expect(llamadas('vg_evolution')).toEqual([]);
  });

  it('RPC sin points (o que no son una lista) → 500; error de la base → 500 con log evolucion.lectura_error', async () => {
    for (const data of [{ days: 30 }, { ...fixtures.evolution, points: {} }, null, [fixtures.evolution]]) {
      rpc = () => ({ data });
      const r = await pedir('evolution');
      expect(r.status).toBe(500);
      expect(((await r.json()) as Cuerpo).error?.message).toBe('No pudimos leer la evolución');
    }
    expect(lineas()).toContain('"code":"forma"');
    rpc = () => ({ error: { code: '57014' } });
    expect((await pedir('evolution')).status).toBe(500);
    expect(lineas()).toContain('"event":"evolucion.lectura_error"');
    expect(lineas()).toContain('"code":"57014"');
  });
});

describe('E51 y E52 · acceso', () => {
  it('p_org sale de orgMember: la org de la URL en mayúsculas llega en minúsculas; sin ser miembro → 404 sin RPC',
    async () => {
      expect((await pedir('evolution', ORG.toUpperCase())).status).toBe(200);
      expect((await pedir(`scans/${SCAN}/delta`, ORG.toUpperCase())).status).toBe(200);
      expect([...llamadas('vg_evolution'), ...llamadas('vg_audit_delta')].map((x) => x.args.p_org)).toEqual([ORG, ORG]);
      doble.rpcs.length = 0;
      expect((await pedir('evolution', AJENA)).status).toBe(404);
      expect((await pedir(`scans/${SCAN}/delta`, AJENA)).status).toBe(404);
      expect((await pedir('evolution?p_org=' + AJENA)).status).toBe(200);   // un p_org en la URL no cuenta
      expect(doble.rpcs.map((x) => x.args.p_org)).toEqual([ORG]);
    });

  it('viewer y anónimo de la demo → 200 en las dos', async () => {
    for (const [r, a] of [['viewer', false], ['viewer', true]] as const) {
      rol = r; anon = a;
      expect((await pedir('evolution')).status).toBe(200);
      expect((await pedir(`scans/${SCAN}/delta`)).status).toBe(200);
    }
  });
});
