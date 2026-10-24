import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, ScanAccepted, type ZipResult } from '@vanguard/contracts';
import type { JobMsg } from '../jobs.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// E11 con kind 'zip' y E23 · POST …/scans/:id/zip-result (F-18, §09.3) sin red: scan_runs en memoria con los .eq(),
// .in() y .gt() de cada consulta aplicados como Postgres (el update condicionado es el que hace E23 de un solo uso).
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const { app } = await import('../app.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';    // admin
const BETO = '7b1e0000-0000-4000-8000-000000000002';   // otro admin de la misma org
const VERA = '7b1e0000-0000-4000-8000-000000000003';   // viewer
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const OTRA_ORG = '0f6c0000-0000-4000-8000-000000000002';
const SCAN = '5a1c0000-0000-4000-8000-0000000000a1';
const AJENO = '5a1c0000-0000-4000-8000-0000000000b2';  // un zip esperando, pero de OTRA_ORG
const MB = 1024 * 1024;
const USUARIO: Record<string, string> = { ana: ANA, beto: BETO, vera: VERA };
const ROL: Record<string, string> = { [ANA]: 'admin', [BETO]: 'admin', [VERA]: 'viewer' };

type Fila = Record<string, unknown>;
let filas: Fila[];
let rechazoUpdate: Resp['error'];
let doble: ReturnType<typeof dbDoble>;
const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) =>
  (o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : o === 'gt' ? String(f[c]) > String(v) : String(f[c]) >= String(v)));
const esperando = (extra: Fila = {}): Fila => ({ id: SCAN, org_id: ORG, kind: 'zip', status: 'queued', step: 'waiting_result',
  steps: [{ name: 'zip', status: 'pending' }, { name: 'resumen_ia', status: 'pending' }], params: { filename: 'proyecto.zip', size_bytes: 4096 },
  requested_by: ANA, created_at: hace(2), started_at: null, finished_at: null, error: null, ...extra });
const fila = (id = SCAN) => filas.find((x) => x.id === id)!;

beforeEach(() => {
  filas = [esperando(), esperando({ id: AJENO, org_id: OTRA_ORG })];
  rechazoUpdate = null;
  doble = dbDoble({
    claims: (tok) => (USUARIO[tok] ? { sub: USUARIO[tok], email: `${tok}@acme.dev`, is_anonymous: false } : null),
    tabla: (op: Op): Resp | undefined => {
      if (op.table === 'org_members') return { data: eqDe(op, 'org_id') === ORG ? { role: ROL[String(eqDe(op, 'user_id'))] } : null };
      if (op.table !== 'scan_runs') return undefined;
      const casan = filas.filter((x) => cumple(x, op));
      if (op.action === 'select') return { data: op.single ? (casan[0] ?? null) : casan, count: casan.length };
      if (op.action === 'insert') {
        const nueva = { id: crypto.randomUUID(), created_at: new Date().toISOString(), step: null, started_at: null, ...(op.payload as Fila) };
        filas.push(nueva);
        return { data: { id: nueva.id } };
      }
      if (op.action === 'update') {
        if (rechazoUpdate) return { error: rechazoUpdate };
        for (const x of casan) Object.assign(x, op.payload as Fila);
        return { data: casan.map((x) => ({ id: x.id })) };
      }
      return undefined;
    },
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const PROD = { VG_ENV: 'production' as const, APP_ORIGIN: 'https://officialvanguard.com' };
const post = (ruta: string, body: unknown, quien = 'ana', d = envDoble(PROD)) => app.request(`https://officialvanguard.com/api/orgs${ruta}`,
  { method: 'POST', headers: { authorization: `Bearer ${quien}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body) }, d.env);
const crearZip = (filename: string, size_bytes = 4096, quien = 'ana', d = envDoble(PROD)) =>
  post(`/${ORG}/scans`, { kind: 'zip', filename, size_bytes }, quien, d);
const RESULTADO: ZipResult = { files_seen: 12, analyzer: 'core@0.1.0',
  deps: [{ ecosystem: 'npm', name: 'lodash', version: '4.17.15' }, { ecosystem: 'Packagist', name: 'laravel/framework', version: '8.0.0', dev: false }],
  findings: [{ rule_id: 'CB_SECRET_AWS', severity: 'critical', title: 'Clave de acceso de AWS en el código', resource: 'src/aws.ts:3',
    evidence: { path: 'src/aws.ts', line: 3, preview: 'AKIA…WXYZ' } }] };
const enviarResultado = (body: unknown = RESULTADO, id = SCAN, quien = 'ana', d = envDoble(PROD), org = ORG) =>
  post(`/${org}/scans/${id}/zip-result`, body, quien, d);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;

describe('E11 · POST /api/orgs/:org/scans con kind zip', () => {
  beforeEach(() => { filas = []; });

  it('crea el scan en waiting_result sin encolar nada y con el nombre saneado ( «..», > 100 car.)', async () => {
    const d = envDoble(PROD);
    const r = await crearZip(`mi..proyecto ${'x'.repeat(100)}.zip`, 4096, 'ana', d);
    expect(r.status).toBe(202);
    const { scan_run_id } = ScanAccepted.parse(await r.json());
    expect(fila(scan_run_id)).toMatchObject({ org_id: ORG, kind: 'zip', status: 'queued', step: 'waiting_result', requested_by: ANA,
      steps: [{ name: 'zip', status: 'pending' }, { name: 'resumen_ia', status: 'pending' }] });
    const { filename, size_bytes } = fila(scan_run_id).params as { filename: string; size_bytes: number };
    expect(size_bytes).toBe(4096);
    expect(filename.length).toBeLessThanOrEqual(100);
    expect(filename).toMatch(/^mi\.proyecto x+\.zip$/);
    expect(d.enviados).toEqual([]);
    const solo = await crearZip('....zip');
    expect(solo.status).toBe(202);   // reemplaza al anterior (mismo usuario, esperando)
    expect((fila(ScanAccepted.parse(await solo.json()).scan_run_id).params as { filename: string }).filename).toBe('archivo.zip');
  });

  it('barras o caracteres de control en el nombre → 422 del contrato, sin crear nada', async () => {
    for (const n of ['../evil.zip', 'a/b.zip', 'a\\b.zip', `mal${String.fromCharCode(0)}.zip`, `x${String.fromCharCode(0x202e)}piz.zip`]) {
      const r = await crearZip(n);
      expect(r.status, n).toBe(422);
      expect((await error(r)).details?.field_errors, n).toHaveProperty('filename');
    }
    expect(filas).toEqual([]);
  });

  it('size_bytes > 25 MB → 422; justo 25 MB vale', async () => {
    const r = await crearZip('grande.zip', 25 * MB + 1);
    expect(r.status).toBe(422);
    expect((await error(r)).details?.field_errors).toHaveProperty('size_bytes');
    expect((await crearZip('justo.zip', 25 * MB)).status).toBe(202);
  });

  it('un zip esperando del mismo usuario se da por perdido (ZIP_RESULT_MISSING); el de otro usuario da 409', async () => {
    filas = [esperando()];
    expect((await crearZip('nuevo.zip')).status).toBe(202);
    expect(fila()).toMatchObject({ status: 'failed', error: 'ZIP_RESULT_MISSING' });
    filas = [esperando()];
    const r = await crearZip('nuevo.zip', 4096, 'beto');
    expect(r.status).toBe(409);
    expect((await error(r)).details).toEqual({ scan_run_id: SCAN });
  });

  it('viewer → 403 y RL_COSTLY agotado → 429 con Retry-After, sin crear nada', async () => {
    expect((await crearZip('a.zip', 4096, 'vera')).status).toBe(403);
    const lleno = envDoble({ ...PROD, RL_COSTLY: { limit: async () => ({ success: false }) } } as Partial<CloudflareBindings>);
    const r = await crearZip('a.zip', 4096, 'ana', lleno);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect(filas).toEqual([]);
  });
});

describe('E23 · POST /api/orgs/:org/scans/:id/zip-result', () => {
  it('feliz: guarda el resultado en params.zip, deja de esperar, fija started_at y encola el paso zip', async () => {
    const d = envDoble(PROD);
    const r = await enviarResultado(RESULTADO, SCAN, 'ana', d);
    expect(r.status).toBe(202);
    expect(ScanAccepted.parse(await r.json())).toEqual({ scan_run_id: SCAN });
    expect(fila()).toMatchObject({ status: 'queued', step: null, params: { filename: 'proyecto.zip', size_bytes: 4096, zip: RESULTADO } });
    expect(typeof fila().started_at).toBe('string');   // el vigilante (0011) cuenta desde aquí, no desde created_at
    expect(d.enviados).toEqual<JobMsg[]>([{ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: 'zip' }]);
    const upd = doble.ops.find((o) => o.table === 'scan_runs' && o.action === 'update')!;
    expect(upd.filters).toEqual(expect.arrayContaining([['org_id', 'eq', ORG], ['step', 'eq', 'waiting_result'], ['kind', 'eq', 'zip'],
      ['status', 'eq', 'queued'], ['requested_by', 'eq', ANA]]));
  });

  it('un scan de otra org, inexistente o con un id que no es uuid → 404 uniforme, sin tocar nada', async () => {
    const d = envDoble(PROD);
    for (const id of [AJENO, '5a1c0000-0000-4000-8000-0000000000ff', 'no-es-uuid']) {
      const r = await enviarResultado(RESULTADO, id, 'ana', d);
      expect(r.status, id).toBe(404);
      expect((await error(r)).message, id).toBe('Esa auditoría no existe');
    }
    expect((await enviarResultado(RESULTADO, AJENO, 'ana', d, OTRA_ORG)).status).toBe(404);   // ni siquiera es miembro
    expect(fila(AJENO)).toMatchObject({ step: 'waiting_result' });
    expect(d.enviados).toEqual([]);
  });

  it('segundo E23 → 409 not_waiting y no se encola dos veces', async () => {
    const d = envDoble(PROD);
    expect((await enviarResultado(RESULTADO, SCAN, 'ana', d)).status).toBe(202);
    const r = await enviarResultado(RESULTADO, SCAN, 'ana', d);
    expect(r.status).toBe(409);
    expect((await error(r)).details).toEqual({ reason: 'not_waiting' });
    expect(d.enviados).toHaveLength(1);
  });

  it('dos E23 a la vez: gana uno (el update condicionado a waiting_result) y el otro recibe 409', async () => {
    const d = envDoble(PROD);
    const rs = await Promise.all([enviarResultado(RESULTADO, SCAN, 'ana', d), enviarResultado(RESULTADO, SCAN, 'ana', d)]);
    expect(rs.map((r) => r.status).sort()).toEqual([202, 409]);
    // Los dos pasaron la lectura (ambos vieron waiting_result) y llegaron al update: lo decidió la condición del update.
    expect(doble.ops.filter((o) => o.table === 'scan_runs' && o.action === 'update')).toHaveLength(2);
    expect(d.enviados).toHaveLength(1);
  });

  it('a los 16 min → 409 expired y el scan queda failed (ZIP_RESULT_MISSING), sin encolar', async () => {
    filas = [esperando({ created_at: hace(16) })];
    const d = envDoble(PROD);
    const r = await enviarResultado(RESULTADO, SCAN, 'ana', d);
    expect(r.status).toBe(409);
    expect((await error(r)).details).toEqual({ reason: 'expired' });
    expect(fila()).toMatchObject({ status: 'failed', error: 'ZIP_RESULT_MISSING' });
    expect((fila().params as Fila).zip).toBeUndefined();
    expect(d.enviados).toEqual([]);
  });

  it('cuerpo > 1 MB → 413 antes de mirar la base', async () => {
    const r = await enviarResultado(JSON.stringify({ ...RESULTADO, analyzer: 'x'.repeat(MB) }));
    expect(r.status).toBe(413);
    expect((await error(r)).code).toBe('invalid_body');
    expect(doble.ops.some((o) => o.table === 'scan_runs')).toBe(false);
  });

  it('ZipFinding con un campo de más en evidence (strictObject) → 422 y nada guardado ni encolado', async () => {
    const d = envDoble(PROD);
    const conSecreto = { ...RESULTADO, findings: [{ ...RESULTADO.findings[0]!, evidence: { path: 'src/aws.ts', line: 3, valor: 'entero' } }] };
    const r = await enviarResultado(conSecreto, SCAN, 'ana', d);
    expect(r.status).toBe(422);
    expect((await error(r)).details?.field_errors).toHaveProperty('findings');
    expect(fila()).toMatchObject({ step: 'waiting_result' });
    expect(d.enviados).toEqual([]);
    for (const malo of [{ ...RESULTADO, deps: Array.from({ length: 2001 }, () => RESULTADO.deps[0]) },
      { ...RESULTADO, findings: [{ ...RESULTADO.findings[0]!, rule_id: 'CB_DEP_VULN' }] },
      { ...RESULTADO, findings: [{ ...RESULTADO.findings[0]!, evidence: { path: 'a', preview: 'x'.repeat(13) } }] }]) {
      expect((await enviarResultado(malo, SCAN, 'ana', d)).status).toBe(422);
    }
  });

  it('viewer → 403; otro admin, un scan que no es zip o que ya terminó → 409', async () => {
    const d = envDoble(PROD);
    expect((await enviarResultado(RESULTADO, SCAN, 'vera', d)).status).toBe(403);
    const r = await enviarResultado(RESULTADO, SCAN, 'beto', d);
    expect(r.status).toBe(409);
    expect((await error(r)).details).toEqual({ reason: 'not_waiting' });
    filas = [esperando({ kind: 'repo', step: null })];
    expect((await error(await enviarResultado(RESULTADO, SCAN, 'ana', d))).details).toEqual({ reason: 'not_zip' });
    filas = [esperando({ status: 'failed' })];
    expect((await enviarResultado(RESULTADO, SCAN, 'ana', d)).status).toBe(409);
    expect(d.enviados).toEqual([]);
  });

  it('la base rechaza params por parecer un secreto (23514) → 422 looks_like_secret; la cola caída → 502 y failed', async () => {
    rechazoUpdate = { code: '23514' };
    const r = await enviarResultado();
    expect(r.status).toBe(422);
    expect((await error(r)).details).toEqual({ reason: 'looks_like_secret' });
    rechazoUpdate = null;
    const caida = envDoble(PROD);
    caida.cola.send.mockRejectedValueOnce(new Error('queue down'));
    const r2 = await enviarResultado(RESULTADO, SCAN, 'ana', caida);
    expect(r2.status).toBe(502);
    expect(fila()).toMatchObject({ status: 'failed', error: 'No se pudo encolar' });
  });

  it('fuera de officialvanguard.com en producción → 403 (requireColaPropia)', async () => {
    const r = await app.request(`https://vanguard.workers.dev/api/orgs/${ORG}/scans/${SCAN}/zip-result`,
      { method: 'POST', headers: { authorization: 'Bearer ana', 'content-type': 'application/json' }, body: JSON.stringify(RESULTADO) },
      envDoble(PROD).env);
    expect(r.status).toBe(403);
    expect(fila()).toMatchObject({ step: 'waiting_result' });
  });
});
