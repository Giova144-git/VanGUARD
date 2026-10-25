import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, MAX_REPOS_GITHUB, ScanAccepted, ScanRun, type ZipResult } from '@vanguard/contracts';
import type { JobMsg } from '../jobs.ts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// E11 con kind 'zip' y E23 · POST …/scans/:id/zip-result (F-18, §09.3) sin red: scan_runs en memoria con los .eq(),
// .in() y .gt() de cada consulta aplicados como Postgres (el update condicionado es el que hace E23 de un solo uso).
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const { app } = await import('../app.ts');
const { inicioDiaCaracas } = await import('./scans.ts');

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
let esDemo: boolean;                         // orgs.is_demo de ORG
let topes: Record<string, unknown> | null;   // app_config 'topes'
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
  esDemo = false;
  topes = null;
  doble = dbDoble({
    claims: (tok) => (USUARIO[tok] ? { sub: USUARIO[tok], email: `${tok}@acme.dev`, is_anonymous: false } : null),
    tabla: (op: Op): Resp | undefined => {
      if (op.table === 'org_members') return { data: eqDe(op, 'org_id') === ORG ? { role: ROL[String(eqDe(op, 'user_id'))] } : null };
      if (op.table === 'orgs') return { data: eqDe(op, 'id') === ORG ? { is_demo: esDemo } : null };
      if (op.table === 'app_config') return { data: topes ? { value: topes } : null };
      if (op.table !== 'scan_runs') return undefined;
      const casan = filas.filter((x) => cumple(x, op));
      if (op.action === 'select') return { data: op.single ? (casan[0] ?? null) : casan, count: casan.length };
      if (op.action === 'insert') {
        // scan_runs_lighthouse_en_curso (supabase/migrations/0019_medir_ahora.sql): una sola medición en curso por org.
        const p = op.payload as Fila;
        if (p.kind === 'lighthouse' && filas.some((x) => x.org_id === p.org_id && x.kind === 'lighthouse'
          && (x.status === 'queued' || x.status === 'running'))) return { error: { code: '23505' } };
        const nueva = { id: crypto.randomUUID(), created_at: new Date().toISOString(), step: null, started_at: null, ...p };
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

  it('sin JOBS_Q (vista previa) → 503 «no corren en la vista previa» ANTES de insertar nada, para cualquier kind', async () => {
    for (const body of [{ kind: 'full_audit' }, { kind: 'repo' }, { kind: 'zip', filename: 'a.zip', size_bytes: 10 }]) {
      const r = await post(`/${ORG}/scans`, body, 'ana', envDoble({ ...PROD, JOBS_Q: undefined }));
      expect(r.status).toBe(503);
      const e = await error(r);
      expect(e.message).toBe('Las auditorías no corren en la vista previa');
      expect(e.code).toBe('preview_unsupported');
    }
    expect(filas).toEqual([]);
    expect(doble.ops.some((o) => o.table === 'scan_runs' && o.action !== 'select')).toBe(false);
  });

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

describe('E11 · POST /api/orgs/:org/scans con kind lighthouse («Medir ahora», §10.4)', () => {
  beforeEach(() => { filas = []; });
  const medir = (body: Record<string, unknown>, quien = 'ana', d = envDoble(PROD)) =>
    post(`/${ORG}/scans`, { kind: 'lighthouse', ...body }, quien, d);
  // Mediciones ya hechas hoy (justo después de la medianoche de Caracas, así nunca caen en ayer) y terminadas.
  const hechasHoy = (n: number, extra: Fila = {}) => Array.from({ length: n }, (_, i) => esperando({ kind: 'lighthouse',
    id: `5a1c0000-0000-4000-8000-${String(i).padStart(12, '0')}`, status: 'succeeded', step: null,
    created_at: new Date(Date.parse(inicioDiaCaracas()) + 1000 + i).toISOString(), ...extra }));

  it('crea el scan con un solo paso psi y params.perf (URL normalizada), y encola UN mensaje psi; móvil por defecto', async () => {
    const d = envDoble(PROD);
    const r = await medir({ url: 'https://Tienda.Example.com/ofertas?utm=x#arriba', version_label: 'v2-regresion' }, 'ana', d);
    expect(r.status).toBe(202);
    const { scan_run_id } = ScanAccepted.parse(await r.json());
    expect(fila(scan_run_id)).toMatchObject({ org_id: ORG, kind: 'lighthouse', status: 'queued', requested_by: ANA, step: null,
      steps: [{ name: 'psi', status: 'pending' }],
      params: { perf: { url: 'https://tienda.example.com/ofertas', strategy: 'mobile', version_label: 'v2-regresion', trigger: 'manual' } } });
    expect(d.enviados).toEqual<JobMsg[]>([{ v: 1, kind: 'scan', scan_run_id, org_id: ORG, paso: 'psi' }]);
    expect(doble.ops.some((o) => o.table === 'connections')).toBe(false);   // no hace falta ninguna conexión
  });

  it('escritorio y sin etiqueta: params.perf.strategy desktop sin version_label, y un único mensaje', async () => {
    const d = envDoble(PROD);
    const r = await medir({ url: 'https://tienda.example.com/', strategy: 'desktop' }, 'ana', d);
    expect(r.status).toBe(202);
    const { scan_run_id } = ScanAccepted.parse(await r.json());
    expect(fila(scan_run_id).params).toEqual({ perf: { url: 'https://tienda.example.com/', strategy: 'desktop', trigger: 'manual' } });
    expect(d.enviados).toHaveLength(1);
  });

  it('URL http, con IP, localhost, de VanGUARD, con credenciales o puerto raro → 422 sin crear ni encolar', async () => {
    const d = envDoble(PROD);
    const casos: [string, string | null][] = [['http://tienda.example.com/', null], ['https://127.0.0.1/', 'ip'],
      ['https://8.8.8.8/', 'ip'], ['https://[::1]/', 'ip'], ['https://localhost/', 'interno'], ['https://db.internal/', 'interno'],
      ['https://officialvanguard.com/', 'propio'], ['https://demo.officialvanguard.com/', 'propio'],
      ['https://vanguard.giovannizm14.workers.dev/', 'propio'], ['https://ana:clave@tienda.example.com/', 'credenciales'],
      ['https://tienda.example.com:8443/', 'puerto']];
    for (const [url, reason] of casos) {
      const r = await medir({ url }, 'ana', d);
      expect(r.status, url).toBe(422);
      const e = await error(r);
      expect(e.details?.field_errors, url).toHaveProperty('url');
      if (reason) expect(e.details?.reason, url).toBe(reason);   // http:// lo para antes el contrato (solo https)
    }
    expect(filas).toEqual([]);
    expect(d.enviados).toEqual([]);
  });

  it('la víctima de la demo (demo.officialvanguard.com) solo se mide desde la org de demo; el resto de VanGUARD nunca', async () => {
    const d = envDoble(PROD);
    esDemo = true;
    const r = await medir({ url: 'https://Demo.OfficialVanguard.com./?x=1', version_label: 'v2-regresion' }, 'ana', d);
    expect(r.status).toBe(202);
    const { scan_run_id } = ScanAccepted.parse(await r.json());
    expect(fila(scan_run_id).params).toMatchObject({ perf: { url: 'https://demo.officialvanguard.com/' } });
    // Ni siquiera desde la demo: el apex, otros subdominios, el Worker de respaldo y Supabase.
    for (const url of ['https://officialvanguard.com/', 'https://www.officialvanguard.com/', 'https://x.demo.officialvanguard.com/',
      'https://vanguard.giovannizm14.workers.dev/', 'https://accshmgmfrqrxubpuxcl.supabase.co/']) {
      const e = await medir({ url }, 'ana', d);
      expect(e.status, url).toBe(422);
      expect((await error(e)).details?.reason, url).toBe('propio');
    }
    // Una org normal: 422 propio, como cualquier host de VanGUARD.
    esDemo = false;
    const n = await medir({ url: 'https://demo.officialvanguard.com/' }, 'ana', d);
    expect(n.status).toBe(422);
    expect((await error(n)).details?.reason).toBe('propio');
    expect(d.enviados).toHaveLength(1);
  });

  it('cupo diario: 10 mediciones hoy → 429 budget_exceeded con texto claro; las de ayer no cuentan; demo 20; app_config manda', async () => {
    filas = hechasHoy(10);
    const r = await medir({ url: 'https://tienda.example.com/' });
    expect(r.status).toBe(429);
    const e = await error(r);
    expect(e.code).toBe('budget_exceeded');
    expect(e.message).toBe('Ya hiciste 10 mediciones de rendimiento hoy, el máximo diario. Vuelve mañana.');
    expect(filas).toHaveLength(10);
    filas = hechasHoy(9);
    filas.push(esperando({ id: AJENO, kind: 'lighthouse', status: 'succeeded', created_at: hace(60 * 30) }));   // de ayer
    expect((await medir({ url: 'https://tienda.example.com/' })).status).toBe(202);
    esDemo = true;
    filas = hechasHoy(19);
    expect((await medir({ url: 'https://tienda.example.com/' })).status).toBe(202);
    for (const x of filas) x.status = 'succeeded';   // la 20.ª terminó: sin esto la siguiente daría 409 (en curso)
    expect((await error(await medir({ url: 'https://tienda.example.com/' }))).message).toMatch(/^Ya hiciste 20 mediciones/);
    esDemo = false;
    topes = { org_perf_day: 2, org_audits_day: 3 };
    filas = hechasHoy(2);
    expect((await error(await medir({ url: 'https://tienda.example.com/' }))).message).toMatch(/^Ya hiciste 2 mediciones/);
    // Las mediciones no gastan el cupo de auditorías completas.
    filas = hechasHoy(5, { kind: 'full_audit' });
    topes = null;
    expect((await medir({ url: 'https://tienda.example.com/' })).status).toBe(202);
  });

  it('RL_COSTLY agotado → 429 rate_limited con Retry-After; viewer → 403; una medición en curso → 409', async () => {
    const lleno = envDoble({ ...PROD, RL_COSTLY: { limit: async () => ({ success: false }) } } as Partial<CloudflareBindings>);
    const r = await medir({ url: 'https://tienda.example.com/' }, 'ana', lleno);
    expect(r.status).toBe(429);
    expect((await error(r)).code).toBe('rate_limited');
    expect(r.headers.get('retry-after')).toBe('60');
    expect((await medir({ url: 'https://tienda.example.com/' }, 'vera')).status).toBe(403);
    expect(filas).toEqual([]);
    filas = [esperando({ kind: 'lighthouse', status: 'running', step: 'psi', created_at: hace(1) })];
    const enCurso = await medir({ url: 'https://tienda.example.com/' });
    expect(enCurso.status).toBe(409);
    const e = await error(enCurso);
    expect(e.details).toEqual({ scan_run_id: SCAN });
    expect(e.message).toMatch(/medición de rendimiento en curso/);
  });

  it('ráfaga de 5 a la vez con 9 hechas hoy: gana una (índice de 0019: 23505 → 409) y el cupo no se rebasa', async () => {
    filas = hechasHoy(9);
    const d = envDoble(PROD);
    const rs = await Promise.all(Array.from({ length: 5 }, () => medir({ url: 'https://tienda.example.com/' }, 'ana', d)));
    expect(rs.map((r) => r.status).sort()).toEqual([202, 409, 409, 409, 409]);
    for (const r of rs.filter((x) => x.status === 409)) {
      expect((await error(r)).message).toMatch(/medición de rendimiento en curso/);
    }
    expect(filas.filter((f) => f.kind === 'lighthouse')).toHaveLength(10);
    expect(d.enviados).toHaveLength(1);
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

// E12 con varios repos (asignaciones/varias-codebases.md §2.3, B4): repos sale de coverage.detail.codebase.repos.
describe('E12 · GET /api/orgs/:org/scans/:id · repos (varias-codebases B4)', () => {
  const AUDITORIA = '5a1c0000-0000-4000-8000-0000000000c3';
  const CONN_1 = 'c0000000-0000-4000-8000-000000000001';
  const CONN_2 = 'c0000000-0000-4000-8000-000000000007';
  const auditoria = (codebase?: Fila): Fila => ({ id: AUDITORIA, org_id: ORG, kind: 'full_audit', status: 'succeeded', progress: 100,
    step: null, steps: [{ name: 'repo', status: 'done', findings: 7, error_code: 'parcial' }], score: 64, summary: null, error: null,
    coverage: { seen: 1, total: 4, missing: [], ...(codebase ? { detail: { codebase } } : {}) },
    created_at: hace(30), started_at: hace(29), finished_at: hace(28) });
  const leer = async () => {
    const r = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/scans/${AUDITORIA}`,
      { headers: { authorization: 'Bearer vera' } }, envDoble(PROD).env);
    expect(r.status).toBe(200);
    const crudo = await r.json() as ScanRun;   // tal cual sale (sin que zod quite nada en la prueba), y cumple ScanRun
    ScanRun.parse(crudo);
    return crudo;
  };

  it('presente: cada entrada con ScanRepo (sin miradas, sha ni nada interno); sin repos o sin detalle, sin campo', async () => {
    filas.push(auditoria({ modo: 'riesgo', connection_id: CONN_1, miradas: { secretos: true }, repos: [
      { connection_id: CONN_1, repo_full_name: 'acme/tienda', status: 'done', findings: 7, sha: 'a'.repeat(40),
        miradas: { env: true } },
      { connection_id: CONN_2, repo_full_name: 'acme/landing', status: 'failed', error_code: 'unauthorized' },
    ] }));
    const run = await leer();
    expect(run.repos).toEqual([
      { connection_id: CONN_1, repo_full_name: 'acme/tienda', status: 'done', findings: 7 },
      { connection_id: CONN_2, repo_full_name: 'acme/landing', status: 'failed', error_code: 'unauthorized' },
    ]);
    expect(run.coverage).toEqual({ seen: 1, total: 4, missing: [] });   // el detalle interno no sale

    filas.splice(filas.length - 1, 1, auditoria({ modo: 'riesgo', connection_id: CONN_1 }));
    expect('repos' in (await leer())).toBe(false);
    filas.splice(filas.length - 1, 1, auditoria());
    expect('repos' in (await leer())).toBe(false);
  });

  it('descarta la entrada inválida (id malformado, estado raro, error_code > 40); si no queda ninguna, sin campo', async () => {
    const buena = { connection_id: CONN_1, repo_full_name: 'acme/tienda', status: 'done', findings: 0 };
    filas.push(auditoria({ repos: [{ ...buena, connection_id: 'no-es-un-id' }, buena, { ...buena, status: 'rara' },
      { ...buena, connection_id: CONN_2, status: 'failed', error_code: 'x'.repeat(41) }, 'texto', null] }));
    expect((await leer()).repos).toEqual([buena]);
    filas.splice(filas.length - 1, 1, auditoria({ repos: [{ ...buena, status: 'rara' }] }));
    expect('repos' in (await leer())).toBe(false);
    filas.splice(filas.length - 1, 1, auditoria({ repos: 'no es una lista' }));
    expect('repos' in (await leer())).toBe(false);
  });

  it(`como mucho ${MAX_REPOS_GITHUB} entradas (el contrato no admite más)`, async () => {
    const entrada = (i: number) => ({ connection_id: `c0000000-0000-4000-8000-00000000001${i}`, repo_full_name: `acme/r${i}`,
      status: 'done', findings: i });
    filas.push(auditoria({ repos: Array.from({ length: MAX_REPOS_GITHUB + 2 }, (_, i) => entrada(i)) }));
    const run = await leer();
    expect(run.repos).toHaveLength(MAX_REPOS_GITHUB);
    expect(run.repos?.[0]).toEqual(entrada(0));
  });
});
