import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ZipFinding, ZipResult } from '@vanguard/contracts';
import type { JobMsg, MsgScan, ResultadoPaso } from '../jobs.ts';
import { dbDoble, type Op } from '../test/db-doble.ts';

// Paso zip (F-18, §09.3 paso 6) sin red: el resultado que E23 dejó en params.zip, supabase-js con el doble y OSV con
// fetch simulado. Por la cola de verdad (guarded) se mira la cadena zip → zip:osv → puntaje y el tope de subpeticiones.
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const { borradorZip, pasoZip, recursoZip, sanearNombreZip, severidadZip } = await import('./zip-paso.ts');
const { TOPE_SUBPETICIONES } = await import('./comun.ts');
const { guarded, registrarPaso } = await import('../jobs.ts');
registrarPaso('zip', pasoZip);

const SCAN = '5a1c0000-0000-4000-8000-000000000002';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const env = {} as CloudflareBindings;
const msg = (extra: Partial<MsgScan> = {}) => ({ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: 'zip', ...extra }) as MsgScan;
const ARCHIVO = 'proyecto.zip';

const hallazgo = (over: Partial<ZipFinding> = {}): ZipFinding => ({ rule_id: 'CB_SECRET_AWS', severity: 'critical',
  title: 'Clave de acceso de AWS en el código', resource: 'src/aws.ts:3', evidence: { path: 'src/aws.ts', line: 3, preview: 'AKIA…WXYZ' },
  ...over });
const ENV: ZipFinding = { rule_id: 'CB_ENV_COMMITTED', severity: 'critical', title: 'Archivo .env subido al repositorio',
  resource: '.env', evidence: { path: '.env' } };

type Fila = { rule_id: string; severity: string; title: string; resource: string; evidence: Record<string, unknown> };
type Rpc = { rows: Fila[]; conn: unknown; complete: boolean };
type Detalle = Record<string, unknown> & { miradas?: Record<string, boolean> };
let zip: ZipResult | null;
let filename: string;
let coverage: Record<string, unknown> | null;
let rpcs: Rpc[];
let marcas: Record<string, unknown>[];
let rechazo: (rows: Fila[]) => boolean;
let doble: ReturnType<typeof dbDoble>;
let osv: { batch: number | null };
let f: Mock<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
const detalle = () => ((coverage?.detail as Record<string, unknown> | undefined)?.codebase ?? {}) as Detalle;
const filas = () => rpcs.flatMap((r) => r.rows);
const continuacion = (r: ResultadoPaso) => {
  if (!('continuar' in r)) throw new Error('esperaba continuar');
  return r.continuar;
};

// OSV: todo paquete tiene un aviso; /query da el de lodash (npm) o el de laravel (Packagist) según el ecosistema.
async function responder(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const u = new URL(String(url));
  if (u.host !== 'api.osv.dev') return new Response('fuera de la lista', { status: 599 });
  const cuerpo = JSON.parse(String(init?.body)) as { queries?: unknown[]; package?: { ecosystem: string; name: string } };
  if (u.pathname === '/v1/querybatch') {
    if (osv.batch) return new Response('x', { status: osv.batch });
    return Response.json({ results: (cuerpo.queries ?? []).map(() => ({ vulns: [{ id: 'GHSA-1' }] })) });
  }
  return Response.json({ vulns: [cuerpo.package?.ecosystem === 'Packagist'
    ? { id: 'GHSA-3p32-j457-pg5x', aliases: ['CVE-2021-3129'], database_specific: { severity: 'CRITICAL' },
      affected: [{ package: { name: 'laravel/framework', ecosystem: 'Packagist' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '8.4.2' }] }] }] }
    : { id: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-23337'], database_specific: { severity: 'HIGH' } }] });
}

beforeEach(() => {
  zip = { files_seen: 40, deps: [], findings: [hallazgo(), ENV], analyzer: 'core@0.1.0' };
  filename = ARCHIVO;
  coverage = { seen: 1, detail: { supabase: { miradas: { advisors: true } } } };
  rpcs = [];
  marcas = [];
  rechazo = () => false;
  osv = { batch: null };
  doble = dbDoble({
    tabla: (op: Op) => {
      if (op.table === 'scan_runs' && op.action === 'select') {
        const c = op.columns ?? '';
        if (c.includes('steps')) {
          return { data: { id: SCAN, org_id: ORG, kind: 'zip', status: 'running',
            steps: [{ name: 'zip', status: 'running' }, { name: 'resumen_ia', status: 'pending' }] } };
        }
        if (c === 'coverage') return { data: { coverage } };
        if (c.includes('zip:params->zip')) return { data: { filename, zip } };
        if (c.includes('deps:params->zip->deps')) return { data: { filename, deps: zip?.deps ?? null } };
        if (c === 'filename:params->>filename') return { data: { filename } };
      }
      if (op.table === 'scan_runs' && op.action === 'update') { coverage = (op.payload as { coverage: Record<string, unknown> }).coverage; return {}; }
      if (op.table === 'findings') return { count: 7 };
      return undefined;
    },
    rpc: (name, a) => {
      if (name === 'vg_claim_step') return { data: true };
      if (name === 'vg_mark_step') { marcas.push(a.p_patch as Record<string, unknown>); return {}; }
      if (name !== 'vg_upsert_findings') return undefined;
      const rows = a.p_rows as Fila[];
      rpcs.push({ rows, conn: a.p_conn, complete: a.p_complete as boolean });
      return rechazo(rows) ? { error: { code: '23514' } } : { data: rows.length };
    },
  });
  estado.client = doble.client;
  f = vi.fn(responder);
  vi.stubGlobal('fetch', f);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('nombre, resource y severidad del ZIP', () => {
  it('sanearNombreZip quita barras, «..», control y bidi, y deja ≤ 100 con su .zip', () => {
    const bidi = String.fromCharCode(0x202e);
    const nul = String.fromCharCode(0);
    for (const n of ['../../etc/passwd.zip', 'a\\..\\b.zip', `mal${nul}vado${bidi}piz.zip`, '/abs/x.zip', 'x.. .zip', `sin\nsalto.zip`]) {
      const s = sanearNombreZip(n);
      expect(s, n).not.toMatch(/[\\/]|\.\.|[\p{Cc}\p{Cf}]/u);
      expect(s, n).toMatch(/\.zip$/i);
    }
    expect(sanearNombreZip('../../etc/passwd.zip')).toBe('_._etc_passwd.zip');
    expect(sanearNombreZip(`mal${nul}vado${bidi}piz.zip`)).toBe('malvadopiz.zip');
    expect(sanearNombreZip('proyecto (1).ZIP')).toBe('proyecto (1).ZIP');
    expect(sanearNombreZip('....zip')).toBe('archivo.zip');
    const largo = sanearNombreZip(`${'a'.repeat(95)}..${'b'.repeat(40)}.zip`);   // el corte cae justo tras el punto
    expect(largo).toBe(`${'a'.repeat(95)}.zip`);   // sin el punto suelto del corte: nunca «..zip»
  });

  it('el prefijo zip:<archivo>/ va una sola vez y nunca se recorta: si no cabe, se recorta la ruta por la izquierda', () => {
    expect(recursoZip(ARCHIVO, 'src/a.ts:4')).toBe('zip:proyecto.zip/src/a.ts:4');
    expect(recursoZip(ARCHIVO, 'zip:proyecto.zip/src/a.ts:4')).toBe('zip:proyecto.zip/src/a.ts:4');
    const r = recursoZip(ARCHIVO, `${'d/'.repeat(200)}fin.ts:9`);
    expect(r.length).toBe(300);
    expect(r.startsWith('zip:proyecto.zip/…')).toBe(true);
    expect(r.endsWith('fin.ts:9')).toBe(true);
  });

  it('borradorZip: resource con ruta y línea, evidencia enmascarada tal cual con fuente zip, sin duplicar el prefijo', () => {
    expect(borradorZip(ARCHIVO, hallazgo())).toEqual({ rule_id: 'CB_SECRET_AWS', severity: 'critical', confirmed: true, origin: 'rule',
      title: 'Clave de acceso de AWS en el código', resource: 'zip:proyecto.zip/src/aws.ts:3',
      evidence: { fuente: 'zip', path: 'src/aws.ts', line: 3, preview: 'AKIA…WXYZ' } });
    const yaPrefijado = borradorZip(ARCHIVO, hallazgo({ evidence: { path: 'zip:proyecto.zip/src/aws.ts', line: 3 } }));
    expect(yaPrefijado.resource).toBe('zip:proyecto.zip/src/aws.ts:3');
    expect(yaPrefijado.evidence).toEqual({ fuente: 'zip', path: 'src/aws.ts', line: 3 });
    expect(borradorZip(ARCHIVO, ENV).resource).toBe('zip:proyecto.zip/.env');
  });

  it('la severidad la decide el servidor por rule_id (con las excepciones de core: pruebas y Postgres de Supabase)', () => {
    expect(severidadZip({ rule_id: 'CB_ENV_COMMITTED', severity: 'low' }, '.env')).toBe('critical');
    expect(severidadZip({ rule_id: 'CB_GITIGNORE_NO_ENV', severity: 'critical' }, '.gitignore')).toBe('medium');
    expect(severidadZip({ rule_id: 'CB_SECRET_AWS', severity: 'info' }, 'src/a.ts')).toBe('critical');
    expect(severidadZip({ rule_id: 'CB_SECRET_AWS', severity: 'low' }, 'src/__tests__/a.ts')).toBe('low');
    expect(severidadZip({ rule_id: 'CB_SECRET_AWS', severity: 'low' }, 'src/a.ts')).toBe('critical');
    expect(severidadZip({ rule_id: 'CB_SECRET_POSTGRES_URL', severity: 'critical' }, 'src/db.ts')).toBe('critical');
    expect(severidadZip({ rule_id: 'CB_SECRET_POSTGRES_URL', severity: 'medium' }, 'src/db.ts')).toBe('high');
    expect(severidadZip({ rule_id: 'CB_SECRET_INVENTADA', severity: 'critical' }, 'src/a.ts')).toBe('medium');
  });
});

describe('zip (sin cursor): hallazgos del navegador', () => {
  it('sin deps: un RPC con p_conn null y p_complete false, prefijo zip:<archivo>/, miradas y coverage fusionado', async () => {
    zip!.findings = [hallazgo({ severity: 'info' }), { ...ENV, severity: 'low' }];   // un cliente que rebaja la severidad
    const r = await pasoZip(env, msg());
    expect(r).toEqual({ status: 'done', findings: 7 });
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]).toMatchObject({ conn: null, complete: false });
    expect(filas().map((x) => [x.rule_id, x.severity, x.resource])).toEqual([
      ['CB_SECRET_AWS', 'critical', 'zip:proyecto.zip/src/aws.ts:3'], ['CB_ENV_COMMITTED', 'critical', 'zip:proyecto.zip/.env']]);
    expect(filas()[0]?.evidence).toEqual({ fuente: 'zip', path: 'src/aws.ts', line: 3, preview: 'AKIA…WXYZ' });
    expect(detalle()).toMatchObject({ fuente: 'zip', modo: 'zip', archivo: ARCHIVO, archivos_vistos: 40, deps: 0,
      hallazgos_recibidos: 2, hallazgos_descartados: 0, miradas: { secretos: true, env: true, lockfiles: false, osv: false } });
    expect((coverage?.detail as Record<string, unknown>).supabase).toEqual({ miradas: { advisors: true } });
    expect(coverage?.seen).toBe(1);
    expect(f).not.toHaveBeenCalled();
  });

  it('con deps: guarda los hallazgos y sigue en zip:osv con el cursor de repo, sin las deps en el mensaje', async () => {
    zip!.deps = [{ ecosystem: 'npm', name: 'lodash', version: '4.17.15' }];
    const c = continuacion(await pasoZip(env, msg()));
    expect(c).toEqual({ cursor: 'osv:1::2:0' });
    expect(detalle().miradas).toEqual({ secretos: true, env: true, lockfiles: true, osv: false });
    expect(f).not.toHaveBeenCalled();
  });

  // «x_ghp_…» pasa redact() (que exige \b) y lo para el cable trampa de comun.ts, como en repo.
  it('cable trampa: la fila con un secreto en el resource se descarta, error_code tripwire y secretos sin mirar', async () => {
    const pat = ['ghp', 'x'.repeat(36)].join('_');
    zip!.findings = [hallazgo({ evidence: { path: `src/x_${pat}.ts`, line: 1 } }), ENV];
    const r = await pasoZip(env, msg());
    expect(r).toMatchObject({ status: 'done', error_code: 'tripwire' });
    expect(filas().map((x) => x.rule_id)).toEqual(['CB_ENV_COMMITTED']);
    expect(JSON.stringify(rpcs)).not.toContain(pat);
    expect(detalle()).toMatchObject({ hallazgos_descartados: 1, miradas: { secretos: false, env: false } });
  });

  it('sin resultado válido en params (o sin nombre): failed ZIP_RESULT_MISSING y nada escrito', async () => {
    zip = { files_seen: 1, deps: [], findings: [{ ...hallazgo(), evidence: { path: 'a', snippet: 'x' } as never }] };
    expect(await pasoZip(env, msg())).toEqual({ status: 'failed', error_code: 'ZIP_RESULT_MISSING' });
    zip = null;
    expect(await pasoZip(env, msg())).toEqual({ status: 'failed', error_code: 'ZIP_RESULT_MISSING' });
    expect(rpcs).toHaveLength(0);
  });

  it('ZIP vacío o con 200 hallazgos (el navegador pudo recortar): secretos y .env sin mirar y error_code parcial', async () => {
    zip = { files_seen: 0, deps: [], findings: [] };
    expect(await pasoZip(env, msg())).toMatchObject({ status: 'done', error_code: 'parcial' });
    expect(detalle().miradas).toMatchObject({ secretos: false, env: false });
    zip = { files_seen: 9, deps: [], findings: Array.from({ length: 200 }, (_, i) => hallazgo({ evidence: { path: `d${i}/a.ts`, line: 1 } })) };
    await pasoZip(env, msg());
    expect(detalle().miradas).toMatchObject({ secretos: false, env: false });
  });
});

describe('zip:osv', () => {
  const DEPS = [{ ecosystem: 'npm' as const, name: 'lodash', version: '4.17.15' },
    { ecosystem: 'Packagist' as const, name: 'laravel/framework', version: '8.0.0', dev: false }];
  const conDeps = async () => {
    zip!.deps = DEPS;
    await pasoZip(env, msg());   // escribe el detalle con lockfiles true
    rpcs = [];
  };

  it('OSV de deps npm y Packagist: querybatch con los dos ecosistemas, CB_DEP_VULN con prefijo y miradas.osv true', async () => {
    await conDeps();
    const r = await pasoZip(env, msg({ cursor: 'osv:1::2:0' }));
    expect(r).toEqual({ status: 'done', findings: 7 });
    const batch = JSON.parse(String(f.mock.calls.find(([u]) => String(u).endsWith('/querybatch'))?.[1]?.body)) as { queries: unknown[] };
    expect(batch.queries).toEqual([{ package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.15' },
      { package: { ecosystem: 'Packagist', name: 'laravel/framework' }, version: '8.0.0' }]);
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]).toMatchObject({ conn: null, complete: false });
    const porRecurso = Object.fromEntries(filas().map((x) => [x.resource, x]));
    expect(Object.keys(porRecurso).sort()).toEqual(['zip:proyecto.zip/Packagist:laravel/framework@8.0.0', 'zip:proyecto.zip/npm:lodash@4.17.15']);
    expect(porRecurso['zip:proyecto.zip/Packagist:laravel/framework@8.0.0']).toMatchObject({ rule_id: 'CB_DEP_VULN', severity: 'critical',
      evidence: { fuente: 'zip', version_arreglo: '8.4.2' } });
    expect(porRecurso['zip:proyecto.zip/npm:lodash@4.17.15']).toMatchObject({ severity: 'high', evidence: { fuente: 'zip' } });
    expect(detalle().miradas).toEqual({ secretos: true, env: true, lockfiles: true, osv: true });
  });

  it('más de 12 vulnerables: la ronda 1 detalla 12 y la siguiente lleva el resto en el mensaje; la última cierra', async () => {
    zip!.deps = Array.from({ length: 20 }, (_, i) => ({ ecosystem: 'npm' as const, name: `p${i}`, version: '1.0.0' }));
    await pasoZip(env, msg());
    const c = continuacion(await pasoZip(env, msg({ cursor: 'osv:1::2:0' })));
    expect(c.cursor).toBe('osv:2::14:0');
    expect(c.deps).toHaveLength(8);
    expect(c.deps?.[0]).toEqual(['npm', 'p12', '1.0.0', 0]);
    const r = await pasoZip(env, msg({ cursor: c.cursor, deps: c.deps }));
    expect(r).toEqual({ status: 'done', findings: 7 });
    expect(filas().filter((x) => x.rule_id === 'CB_DEP_VULN')).toHaveLength(20);
    expect(filas().every((x) => x.resource.startsWith('zip:proyecto.zip/'))).toBe(true);
  });

  it('OSV caído: la primera entrega lanza para que la cola reintente; con el reintento gastado, done osv_unavailable', async () => {
    await conDeps();
    osv.batch = 503;
    await expect(pasoZip(env, msg({ cursor: 'osv:1::2:0' }), 1)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await pasoZip(env, msg({ cursor: 'osv:1::2:0' }), 2)).toEqual({ status: 'done', findings: 7, error_code: 'osv_unavailable' });
    expect(detalle().miradas?.osv).toBe(false);
    expect(rpcs).toHaveLength(0);
  });
});

describe('por la cola (guarded)', () => {
  const entrega = (cuerpo: MsgScan) => ({ id: 'm1', timestamp: new Date(), body: cuerpo as JobMsg, attempts: 1, ack: vi.fn(), retry: vi.fn() });

  it('zip → zip:osv → puntaje: steps[zip] se marca al cerrar OSV y cada entrega gasta ≤ 40 subpeticiones con 2000 deps', async () => {
    zip!.deps = Array.from({ length: 2000 }, (_, i) => ({ ecosystem: 'npm' as const, name: `p${i}`, version: '1.0.0' }));
    const enviados: JobMsg[] = [];
    const cola = { JOBS_Q: { send: vi.fn(async (b: JobMsg) => { enviados.push(b); }) } } as unknown as CloudflareBindings;
    let cuerpo = msg();
    for (let vuelta = 0; vuelta < 12; vuelta++) {
      const antes = doble.ops.length + doble.rpcs.length + f.mock.calls.length + enviados.length;
      const m = entrega(cuerpo);
      await guarded(cola, m as unknown as Message<JobMsg>, cuerpo);
      expect(m.ack).toHaveBeenCalled();
      expect(doble.ops.length + doble.rpcs.length + f.mock.calls.length + enviados.length - antes).toBeLessThanOrEqual(TOPE_SUBPETICIONES);
      const sig = enviados.at(-1) as MsgScan;
      if (sig.paso !== 'zip') break;
      cuerpo = sig;
    }
    expect(enviados.map((e) => (e as MsgScan).paso)).toEqual([...Array(8).fill('zip'), 'puntaje']);   // osv:1 … osv:8
    expect((enviados[0] as MsgScan).cursor).toBe('osv:1:p:2:0');   // p: 2000 deps = el tope, pudo haber más
    expect(marcas).toEqual([{ status: 'done', findings: 7, error_code: 'hallazgos_truncados' }]);   // 2000 vulnerables > 200 filas
    expect(detalle()).toMatchObject({ deps_truncadas: true, miradas: { lockfiles: false, osv: false } });
  });
});
