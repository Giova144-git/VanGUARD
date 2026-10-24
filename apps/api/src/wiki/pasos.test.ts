import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WikiDoc, WikiRunStep } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';
import type { MsgWiki } from '../jobs.ts';

// Pasos 'wiki' de vg-jobs (LEEME de deepwiki, puntos 4–7) con el motor real: GitHub es un fetch simulado, Claude un
// doble de llamarIATexto, la base un doble que imita wiki_runs y vg_wiki_avanzar (compare-and-set sobre state.n) y el
// PAT llega por un withSecret simulado. Cero red.
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
// PAT falso armado en tiempo de ejecución: ningún literal con forma de secreto queda en el repo.
const PAT = vi.hoisted(() => ['github', 'pat', 'Q'.repeat(40)].join('_'));
vi.mock('../lib/credentials.ts', () => ({
  withSecret: async (_e: unknown, _a: unknown, _c: unknown, fn: (t: string) => Promise<unknown>) => fn(PAT),
}));
const ia = vi.hoisted(() => ({ llamar: vi.fn() }));
vi.mock('../ia/claude.ts', () => ({ llamarIATexto: ia.llamar }));

const { cierreWikiDlq, pasoWiki, REINTENTOS_WIKI } = await import('./pasos.ts');
const { MAX_REINTENTOS_COLA } = await import('../jobs.ts');

const ORG = '0f6c0000-0000-4000-8000-000000000001';
const RUN = '3a110000-0000-4000-8000-000000000001';
const CONN = 'c0aa0000-0000-4000-8000-000000000001';
const OTRA_CONN = 'c0aa0000-0000-4000-8000-000000000002';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const MARCA = 'MARCA_CONTENIDO_DEL_REPO';

const ARCHIVOS: Record<string, string> = {
  'README.md': `# Tienda demo\nTienda en línea. ${MARCA}\n`,
  'package.json': '{"name":"tienda","dependencies":{"hono":"4.0.0"}}\n',
  'src/index.ts': `import { Hono } from "hono"; // ${MARCA}\nexport default new Hono();\n`,
  'src/rutas/pedidos.ts': 'export const pedidos = [];\n',
  'docs/arquitectura.md': '# Arquitectura\n',
};
const TRIAGE = JSON.stringify(Object.keys(ARCHIVOS));
const SINTESIS = `# tienda

## Qué es y para qué sirve
Una tienda en línea.

## Cómo funciona, en simple
Como una tienda de barrio.

## Las piezas principales
- **Tienda:** muestra productos.

## Mapa visual
\`\`\`mermaid
flowchart LR
  Cliente[Cliente] --> Tienda[Tienda web]
\`\`\`

## Riesgos y puntos de atención
La tabla de pedidos está expuesta [H1].`;
const USO = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

type Fila = Record<string, unknown> & { status: string; state: Record<string, unknown> | null; steps: unknown[];
  progress: number; cost_usd: number; max_usd: number; doc: unknown; error: string | null };
let fila: Fila;
let doble: ReturnType<typeof dbDoble>;
let lineas: string[];
let urls: { url: string; auth: string | null }[];
let github: (url: string) => Response | Promise<Response>;
let casPierde: boolean;
let fallaAvanzar: number;
let auditorias: Record<string, unknown>[];
let hallazgosDb: Record<string, unknown>[];

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
function githubOk(url: string): Response {
  if (url === `${API}/repos/acme/tienda`) {
    return json({ full_name: 'acme/tienda', description: 'Tienda de prueba', language: 'TypeScript', private: true, default_branch: 'main' });
  }
  if (url === `${API}/repos/acme/tienda/commits/main` || url === `${API}/repos/acme/tienda/commits/${SHA}`) return new Response(SHA);
  if (url === `${API}/repos/acme/tienda/git/trees/${SHA}?recursive=1`) {
    return json({ sha: SHA, truncated: false, tree: Object.entries(ARCHIVOS).map(([path, c]) => ({ path, type: 'blob', size: c.length })) });
  }
  const pref = `${RAW}/acme/tienda/${SHA}/`;
  if (url.startsWith(pref)) {
    const c = ARCHIVOS[decodeURIComponent(url.slice(pref.length))];
    return c === undefined ? new Response('404', { status: 404 }) : new Response(c);
  }
  return new Response('no', { status: 404 });
}

const nDe = (s: unknown) => ((s as { n?: number } | null)?.n ?? 0);
const clon = <T>(v: T): T => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

beforeEach(() => {
  fila = { id: RUN, org_id: ORG, connection_id: CONN, repo_full_name: 'acme/tienda', branch: 'main', status: 'queued',
    est_usd: null, max_usd: 1, models: { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' }, state: null,
    steps: [], progress: 0, cost_usd: 0, doc: null, error: null, commit_sha: SHA, started_at: null, finished_at: null };
  casPierde = false;
  fallaAvanzar = 0;
  // Una auditoría terminada en la que el paso repo leyó acme/tienda (hallazgosDelRepo de wiki/corridas.ts).
  auditorias = [{ steps: [{ name: 'repo', status: 'done' }], params: {}, finished_at: '2026-10-20T15:00:00+00:00' }];
  hallazgosDb = [
    { rule_id: 'SB_RLS_DISABLED', severity: 'critical', title: 'Tabla pedidos sin RLS', module: 'supabase', connection_id: null, path: null },
    { rule_id: 'CB_SECRET_GENERIC', severity: 'high', title: 'Clave en el código', module: 'codebase', connection_id: CONN, path: 'src/index.ts' },
    { rule_id: 'CB_ENV_COMMITTED', severity: 'high', title: 'De otro repo', module: 'codebase', connection_id: OTRA_CONN, path: '.env' },
    { rule_id: 'PF_REGRESSION', severity: 'medium', title: 'Más lenta', module: 'performance', connection_id: null, path: null },
  ];
  doble = dbDoble({
    tabla: (op: Op): Resp | undefined => {
      if (op.table === 'wiki_runs' && op.action === 'select') {
        return { data: eqDe(op, 'id') === fila.id && eqDe(op, 'org_id') === fila.org_id ? clon(fila) : null };
      }
      if (op.table === 'connections' && op.single === 'maybe') {
        return { data: eqDe(op, 'id') === CONN ? { id: CONN, provider: 'github', kind: 'read', status: 'active' } : null };
      }
      if (op.table === 'connections') {
        return { data: [{ id: CONN, meta: { repo_full_name: 'Acme/Tienda' } }, { id: OTRA_CONN, meta: { repo_full_name: 'acme/otro' } }] };
      }
      if (op.table === 'scan_runs') return { data: auditorias };
      if (op.table === 'findings') {
        const modulos = op.filters.find(([c, o]) => c === 'module' && o === 'in')?.[2] as string[] | undefined;
        return { data: hallazgosDb.filter((h) => !modulos || modulos.includes(String(h.module))) };
      }
      return undefined;
    },
    // vg_wiki_avanzar de 0010: id + org + n + corrida abierta; progress nunca baja; started_at/finished_at.
    rpc: (name, a): Resp | undefined => {
      if (name !== 'vg_wiki_avanzar') return undefined;
      if (fallaAvanzar > 0) { fallaAvanzar--; return { error: { code: '08006' } }; }
      const abierta = fila.status === 'queued' || fila.status === 'running';
      if (casPierde || a.p_run !== fila.id || a.p_org !== fila.org_id || a.p_n !== nDe(fila.state) || !abierta) return { data: false };
      if (a.p_state !== null) fila.state = clon(a.p_state) as Record<string, unknown>;
      const p = (a.p_patch ?? {}) as Record<string, unknown>;
      for (const k of ['status', 'steps', 'cost_usd', 'commit_sha', 'branch', 'error', 'doc', 'est_usd', 'models']) {
        if (k in p) (fila as Record<string, unknown>)[k] = clon(p[k]);
      }
      if (typeof p.progress === 'number') fila.progress = Math.max(fila.progress, p.progress);
      if (p.status === 'running') fila.started_at ??= 'ahora';
      if (p.status === 'succeeded' || p.status === 'failed') fila.finished_at ??= 'ahora';
      return { data: true };
    },
  });
  estado.client = doble.client;
  lineas = [];
  vi.spyOn(console, 'log').mockImplementation((l: unknown) => { lineas.push(String(l)); });
  urls = [];
  github = githubOk;
  vi.stubGlobal('fetch', async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u);
    urls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    return github(url);
  });
  ia.llamar.mockReset().mockImplementation(async (_e: unknown, p: { ruta: string; modelo: string; usuario: string }) => {
    if (p.ruta === 'wiki_triage') return { ok: true, texto: TRIAGE, model: p.modelo, uso: USO, stop_reason: 'end_turn', cost_usd: 0 };
    if (p.ruta === 'wiki_area') {
      const rutas = [...p.usuario.matchAll(/<repo_file path="([^"]*)">/g)].map((x) => x[1]);
      return { ok: true, texto: `Título: Parte de la tienda\nEsta parte atiende pedidos.\nArchivos clave: ${rutas[0] ?? ''}`,
        model: p.modelo, uso: USO, stop_reason: 'end_turn', cost_usd: 0 };
    }
    return { ok: true, texto: SINTESIS, model: p.modelo, uso: USO, stop_reason: 'end_turn', cost_usd: 0 };
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const msg = (paso: MsgWiki['paso'], area?: string): MsgWiki =>
  ({ v: 1, kind: 'wiki', org_id: ORG, wiki_run_id: RUN, paso, ...(area !== undefined ? { area } : {}) });
const llamadasIA = (ruta?: string) => ia.llamar.mock.calls.filter(([, p]) => !ruta || (p as { ruta: string }).ruta === ruta);
const avances = () => doble.rpcs.filter((r) => r.name === 'vg_wiki_avanzar');
const stepDe = (name: string) => (fila.steps as WikiRunStep[]).find((s) => s.name === name);

// Subpeticiones de una invocación: base (consultas y RPC), GitHub, 4 por llamada a la IA (status, reserve, Anthropic,
// settle), envíos a la cola y 2 más si usó el PAT (connection_secrets y vg_crypto_material que el doble se salta).
async function medido(d: ReturnType<typeof envDoble>, m: MsgWiki, intento = 1) {
  const o0 = doble.ops.length, r0 = doble.rpcs.length, u0 = urls.length, i0 = ia.llamar.mock.calls.length, s0 = d.enviados.length;
  const r = await pasoWiki(d.env, m, intento);
  const conPat = doble.ops.slice(o0).some((o) => o.table === 'connections' && o.single === 'maybe') ? 2 : 0;
  const sub = doble.ops.length - o0 + doble.rpcs.length - r0 + urls.length - u0 + 4 * (ia.llamar.mock.calls.length - i0)
    + d.enviados.length - s0 + conPat;
  return { r, sub, nuevos: d.enviados.slice(s0) as MsgWiki[] };
}

// Corre la cola en orden (como colaEnSerie) hasta vaciarla o hasta `parar`; devuelve lo que quedó sin correr.
async function correrCola(d: ReturnType<typeof envDoble>, desde: MsgWiki[], parar?: (m: MsgWiki) => boolean) {
  const cola = [...desde];
  const medidas: { paso: string; sub: number; r: unknown }[] = [];
  for (let vueltas = 0; cola.length > 0 && vueltas < 40; vueltas++) {
    if (parar?.(cola[0]!)) break;
    const m = cola.shift()!;
    const { r, sub, nuevos } = await medido(d, m);
    medidas.push({ paso: m.paso, sub, r });
    cola.push(...nuevos);
  }
  return { medidas, pendientes: cola };
}
const conIA = (extra: Partial<CloudflareBindings> = {}) => envDoble({ ANTHROPIC_API_KEY: 'clave-de-prueba', ...extra });

describe('recorrido completo', () => {
  it('arbol → triage → area × N → sintesis → succeeded con el documento; cada invocación ≤ 40 subpeticiones', async () => {
    const d = conIA();
    const { medidas, pendientes } = await correrCola(d, [msg('arbol')]);
    expect(pendientes).toEqual([]);
    const areas = (fila.state as { areas: unknown[] }).areas.length;
    expect(areas).toBeGreaterThan(1);
    expect(medidas.map((x) => x.paso)).toEqual(['arbol', 'triage', ...Array(areas).fill('area'), 'sintesis']);
    expect(medidas.every((x) => x.r === 'ack')).toBe(true);
    for (const x of medidas) expect(x.sub, x.paso).toBeLessThanOrEqual(40);

    expect(fila.status).toBe('succeeded');
    expect(fila.progress).toBe(100);
    expect([fila.started_at, fila.finished_at]).toEqual(['ahora', 'ahora']);
    expect(fila.commit_sha).toBe(SHA);
    expect(fila.branch).toBe('main');
    expect(typeof fila.est_usd).toBe('number');
    const doc = WikiDoc.omit({ run_id: true }).parse(fila.doc);
    expect(doc.mermaid).toContain('flowchart LR');
    expect(doc.paginas).toHaveLength(areas);
    expect(fila.cost_usd).toBe(doc.stats.cost_usd);
    expect(doc.stats.cost_usd).toBeGreaterThan(0);
    const steps = WikiRunStep.array().parse(fila.steps);
    expect(steps.map((s) => [s.name, s.status])).toEqual([['arbol', 'done'], ['triage', 'done'], ['area', 'done'],
      ['sintesis', 'done'], ['fin', 'done']]);
    expect(stepDe('fin')?.detalle).toBe('Documento y diagrama listos');

    // Modelos y rutas de ai_usage: Haiku para triage y áreas, Sonnet para la síntesis.
    expect(llamadasIA().map(([, p]) => [(p as { ruta: string }).ruta, (p as { modelo: string }).modelo])).toEqual([
      ['wiki_triage', 'claude-haiku-5-5'], ...Array(areas).fill(['wiki_area', 'claude-haiku-5-5']),
      ['wiki_sintesis', 'claude-sonnet-5-5']]);
    // El estado nunca guarda el código leído.
    expect(JSON.stringify(fila.state)).not.toContain(MARCA);
  });

  it('mientras avanza, steps marca el paso que sigue como running con su detalle y progress sube', async () => {
    const d = conIA();
    await pasoWiki(d.env, msg('arbol'));
    expect(fila.status).toBe('running');
    expect(fila.progress).toBe(10);
    expect(stepDe('arbol')?.status).toBe('done');
    expect(stepDe('triage')).toMatchObject({ status: 'running', detalle: expect.stringContaining('Eligiendo archivos') });
    expect(d.enviados).toEqual([msg('triage')]);
    await pasoWiki(d.env, msg('triage'));
    expect(stepDe('area')).toMatchObject({ status: 'running', detalle: expect.stringMatching(/^Área 1 de \d+/) });
    expect(fila.progress).toBeGreaterThan(30);
    expect(d.enviados[1]).toMatchObject({ kind: 'wiki', paso: 'area', area: expect.any(String) });
  });

  it('la síntesis recibe los hallazgos del repo (sin evidencia ni número de línea) y la fecha de la auditoría', async () => {
    const d = conIA();
    await correrCola(d, [msg('arbol')]);
    const usuario = (llamadasIA('wiki_sintesis')[0]?.[1] as { usuario: string }).usuario;
    expect(usuario).toContain('Tabla pedidos sin RLS');
    expect(usuario).toContain('Clave en el código');
    expect(usuario).not.toContain('De otro repo');
    expect(usuario).not.toContain('Más lenta');
    expect(WikiDoc.omit({ run_id: true }).parse(fila.doc).avisos.join(' ')).toContain('20/10/2026');
  });
});

describe('commit y hallazgos de la corrida', () => {
  it('el árbol se lee del commit que guardó E41 (llave de la caché) y la rama que se muestra es la de la fila', async () => {
    const d = conIA();
    await pasoWiki(d.env, msg('arbol'));
    expect(urls.map((u) => u.url)).toContain(`${API}/repos/acme/tienda/commits/${SHA}`);
    expect(urls.map((u) => u.url)).not.toContain(`${API}/repos/acme/tienda/commits/main`);
    expect((fila.state as { meta: { branch: string; commit_sha: string } }).meta).toMatchObject({ branch: 'main', commit_sha: SHA });
    expect([fila.branch, fila.commit_sha]).toEqual(['main', SHA]);
  });

  it('sin commit en la fila, resuelve la rama (o la principal)', async () => {
    const d = conIA();
    fila.commit_sha = null;
    fila.branch = null;
    await pasoWiki(d.env, msg('arbol'));
    expect(urls.map((u) => u.url)).toContain(`${API}/repos/acme/tienda/commits/main`);
    expect([fila.branch, fila.commit_sha]).toEqual(['main', SHA]);
  });

  it('repo nunca auditado: la síntesis corre sin hallazgos (el documento lo dice) y termina', async () => {
    const d = conIA();
    auditorias = [];
    await correrCola(d, [msg('arbol')]);
    expect(fila.status).toBe('succeeded');
    const usuario = (llamadasIA('wiki_sintesis')[0]?.[1] as { usuario: string }).usuario;
    expect(usuario).not.toContain('Tabla pedidos sin RLS');
  });

  it('la base falla al leer los hallazgos → retry sin marcar la síntesis', async () => {
    const d = conIA();
    await correrCola(d, [msg('arbol')], (m) => m.paso === 'sintesis');
    const n0 = nDe(fila.state);
    const real = doble.client;
    estado.client = { ...real, from: (t: string) => (t === 'findings'
      ? dbDoble({ tabla: () => ({ error: { code: '08006' } }) }).client.from(t) : real.from(t)) };
    expect(await pasoWiki(d.env, msg('sintesis'))).toEqual({ retry: 10 });
    expect(nDe(fila.state)).toBe(n0);
    expect(llamadasIA('wiki_sintesis')).toHaveLength(0);
  });
});

describe('entregas repetidas y compare-and-set', () => {
  it('el mismo paso entregado otra vez no guarda, no paga ni encola', async () => {
    const d = conIA();
    await pasoWiki(d.env, msg('arbol'));
    await pasoWiki(d.env, msg('triage'));
    const [a0, u0, i0, e0] = [avances().length, urls.length, llamadasIA().length, d.enviados.length];
    expect(await pasoWiki(d.env, msg('arbol'))).toBe('ack');
    expect(await pasoWiki(d.env, msg('triage'))).toBe('ack');
    const area = (d.enviados[1] as MsgWiki).area!;
    await pasoWiki(d.env, msg('area', area));
    const [a1, i1, e1] = [avances().length, llamadasIA().length, d.enviados.length];
    expect(await pasoWiki(d.env, msg('area', area))).toBe('ack');
    expect([avances().length, llamadasIA().length, d.enviados.length]).toEqual([a1, i1, e1]);
    expect(a1 - a0).toBe(1);
    expect(urls.length - u0).toBeGreaterThan(0);     // solo el área nueva leyó GitHub
    expect(i1 - i0).toBe(1);
    expect(e1 - e0).toBe(1);
  });

  it('CAS perdido (otra entrega ya avanzó): no encola nada', async () => {
    const d = conIA();
    await pasoWiki(d.env, msg('arbol'));
    casPierde = true;
    expect(await pasoWiki(d.env, msg('triage'))).toBe('ack');
    expect(d.enviados).toEqual([msg('triage')]);
    expect(lineas.join('\n')).toContain('wiki.cas_perdido');
  });

  it('se guardó pero el envío falló: la reentrega reencola el siguiente paso una vez', async () => {
    const d = conIA();
    d.cola.send.mockRejectedValueOnce(new Error('cola')).mockRejectedValueOnce(new Error('cola'));
    expect(await pasoWiki(d.env, msg('arbol'))).toEqual({ retry: 10 });
    expect(nDe(fila.state)).toBe(1);
    expect(d.enviados).toEqual([]);
    expect(await pasoWiki(d.env, msg('arbol'), 2)).toBe('ack');
    expect(d.enviados).toEqual([msg('triage')]);
    expect(urls.filter((u) => u.url.includes('/git/trees/'))).toHaveLength(1);   // el árbol no se volvió a leer
  });

  it('una escritura que falla dos veces seguidas → retry sin encolar; la reentrega rehace el paso', async () => {
    const d = conIA();
    fallaAvanzar = 2;
    expect(await pasoWiki(d.env, msg('arbol'))).toEqual({ retry: 10 });
    expect(d.enviados).toEqual([]);
    expect(await pasoWiki(d.env, msg('arbol'), 2)).toBe('ack');
    expect(d.enviados).toEqual([msg('triage')]);
  });
});

describe('tope de costo (max_usd) antes de pagar', () => {
  it('el triage pasaría el tope → failed con tope_usd sin llamar a la IA', async () => {
    const d = conIA();
    fila.max_usd = 0.001;
    await pasoWiki(d.env, msg('arbol'));
    expect(await pasoWiki(d.env, msg('triage'))).toBe('ack');
    expect(llamadasIA()).toHaveLength(0);
    expect(fila.status).toBe('failed');
    expect(fila.error).toMatch(/tope de US\$ 0\.0010.*antes de pagarlo/);
    expect(stepDe('triage')).toMatchObject({ status: 'failed', error_code: 'tope_usd' });
    expect(stepDe('fin')?.status).toBe('skipped');
    expect(d.enviados).toEqual([msg('triage')]);
  });

  it('la síntesis (Sonnet) pasaría el tope → se corta antes de marcarla o pagarla', async () => {
    const d = conIA();
    fila.max_usd = 0.03;
    await correrCola(d, [msg('arbol')]);
    expect(llamadasIA('wiki_sintesis')).toHaveLength(0);
    expect(llamadasIA('wiki_area').length).toBeGreaterThan(0);
    expect(fila.status).toBe('failed');
    expect(stepDe('sintesis')).toMatchObject({ status: 'failed', error_code: 'tope_usd' });
    expect((fila.state as { sintesis_iniciada?: string }).sintesis_iniciada).toBeUndefined();
    expect(fila.doc).toBeNull();
  });

  it('un documento ya pagado se guarda aunque el pensamiento haya pasado el tope, con aviso', async () => {
    const d = conIA();
    const { pendientes } = await correrCola(d, [msg('arbol')], (m) => m.paso === 'sintesis');
    const gastado = (fila.state as { consumo: { cost_usd: number } }).consumo.cost_usd;
    fila.max_usd = gastado + 0.07;   // el techo de la síntesis cabe
    ia.llamar.mockImplementationOnce(async (_e: unknown, p: { modelo: string }) => ({ ok: true, texto: SINTESIS, model: p.modelo,
      uso: { input_tokens: 5000, output_tokens: 9000 }, stop_reason: 'end_turn', cost_usd: 0 }));
    await correrCola(d, pendientes);
    expect(fila.status).toBe('succeeded');
    const doc = WikiDoc.omit({ run_id: true }).parse(fila.doc);
    expect(doc.stats.cost_usd).toBeGreaterThan(fila.max_usd);
    expect(doc.avisos[0]).toMatch(/^El costo final .* pasó el tope/);
  });
});

describe('síntesis sin pagar dos veces', () => {
  it('dos entregas de la síntesis: la segunda ve succeeded y no paga', async () => {
    const d = conIA();
    const { pendientes } = await correrCola(d, [msg('arbol')], (m) => m.paso === 'sintesis');
    await correrCola(d, pendientes);
    expect(fila.status).toBe('succeeded');
    expect(await pasoWiki(d.env, msg('sintesis'))).toBe('ack');
    expect(llamadasIA('wiki_sintesis')).toHaveLength(1);
  });

  it('marca de otra entrega de hace 1 minuto → reintenta cuando venza, sin pagar ni escribir', async () => {
    const d = conIA();
    await correrCola(d, [msg('arbol')], (m) => m.paso === 'sintesis');
    fila.state = { ...fila.state!, sintesis_iniciada: new Date(Date.now() - 60_000).toISOString() };
    const a0 = avances().length;
    const r = await pasoWiki(d.env, msg('sintesis'));
    expect(r).toEqual({ retry: expect.any(Number) });
    expect((r as { retry: number }).retry).toBeGreaterThan(230);
    expect((r as { retry: number }).retry).toBeLessThanOrEqual(246);
    expect(llamadasIA('wiki_sintesis')).toHaveLength(0);
    expect(avances().length).toBe(a0);
  });

  it('una marca de hace más de 5 minutos es de un Worker caído: se repite', async () => {
    const d = conIA();
    await correrCola(d, [msg('arbol')], (m) => m.paso === 'sintesis');
    fila.state = { ...fila.state!, sintesis_iniciada: new Date(Date.now() - 6 * 60_000).toISOString() };
    expect(await pasoWiki(d.env, msg('sintesis'))).toBe('ack');
    expect(fila.status).toBe('succeeded');
  });

  it('antes de pagar guarda la marca; si la IA cae (transitorio) desmarca y reintenta', async () => {
    const d = conIA();
    await correrCola(d, [msg('arbol')], (m) => m.paso === 'sintesis');
    const n0 = nDe(fila.state);
    ia.llamar.mockResolvedValueOnce({ ok: false, code: 'timeout' });
    expect(await pasoWiki(d.env, msg('sintesis'))).toEqual({ retry: 10 });
    expect(nDe(fila.state)).toBe(n0 + 2);                        // marca + desmarca
    expect((fila.state as { sintesis_iniciada?: string }).sintesis_iniciada).toBeUndefined();
    expect(fila.status).toBe('running');
    expect(await pasoWiki(d.env, msg('sintesis'), 2)).toBe('ack');
    expect(fila.status).toBe('succeeded');
  });
});

describe('errores de GitHub y de la IA', () => {
  it('limite_github → retry con la espera que pide GitHub; en la última entrega, failed con limite_github', async () => {
    const d = conIA();
    await pasoWiki(d.env, msg('arbol'));
    await pasoWiki(d.env, msg('triage'));
    const area = (d.enviados[1] as MsgWiki).area!;
    github = (url) => (url.startsWith(RAW) ? new Response('', { status: 403, headers: { 'retry-after': '120' } }) : githubOk(url));
    expect(await pasoWiki(d.env, msg('area', area))).toEqual({ retry: 120 });
    expect(fila.status).toBe('running');
    expect(llamadasIA('wiki_area')).toHaveLength(0);
    expect(await pasoWiki(d.env, msg('area', area), REINTENTOS_WIKI + 1)).toBe('ack');
    expect(fila.status).toBe('failed');
    expect(stepDe('area')).toMatchObject({ status: 'failed', error_code: 'limite_github' });
    expect(fila.error).not.toMatch(/Límite de GitHub o permiso/);   // texto propio, no el del motor
  });

  it('github_red (la mayoría de los archivos no llegan) → reintento escalonado', async () => {
    const d = conIA();
    await pasoWiki(d.env, msg('arbol'));
    await pasoWiki(d.env, msg('triage'));
    const area = (d.enviados[1] as MsgWiki).area!;
    github = (url) => { if (url.startsWith(RAW)) throw new TypeError('red'); return githubOk(url); };
    expect(await pasoWiki(d.env, msg('area', area))).toEqual({ retry: 10 });
    expect(await pasoWiki(d.env, msg('area', area), 2)).toEqual({ retry: 20 });
    expect(await pasoWiki(d.env, msg('area', area), 4)).toBe('ack');
    expect(stepDe('area')).toMatchObject({ status: 'failed', error_code: 'github_red' });
  });

  it('repo inexistente → failed con su código, sin reintentar', async () => {
    const d = conIA();
    github = () => new Response('', { status: 404 });
    expect(await pasoWiki(d.env, msg('arbol'))).toBe('ack');
    expect(fila.status).toBe('failed');
    expect(stepDe('arbol')).toMatchObject({ status: 'failed', error_code: 'repo_no_encontrado' });
    expect(stepDe('triage')?.status).toBe('skipped');
  });

  it('conexión de GitHub revocada o de otra org → failed con conexion_no_encontrada', async () => {
    const d = conIA();
    fila.connection_id = OTRA_CONN;
    expect(await pasoWiki(d.env, msg('arbol'))).toBe('ack');
    expect(stepDe('arbol')).toMatchObject({ status: 'failed', error_code: 'conexion_no_encontrada' });
    expect(urls).toEqual([]);
  });

  it('IA_CORTE=1 → failed con sin_llm antes de leer GitHub, sin coste', async () => {
    const d = conIA({ IA_CORTE: '1' });
    expect(await pasoWiki(d.env, msg('arbol'))).toBe('ack');
    expect(fila.status).toBe('failed');
    expect(stepDe('arbol')).toMatchObject({ status: 'failed', error_code: 'sin_llm' });
    expect(fila.error).toContain('IA está apagada');
    expect([urls.length, llamadasIA().length, fila.cost_usd]).toEqual([0, 0, 0]);
  });

  it('la IA apagada en el triage (disabled) → failed con sin_llm, sin coste ni encolar', async () => {
    const d = conIA();
    await pasoWiki(d.env, msg('arbol'));
    ia.llamar.mockResolvedValueOnce({ ok: false, code: 'disabled' });
    expect(await pasoWiki(d.env, msg('triage'))).toBe('ack');
    expect(fila.status).toBe('failed');
    expect(stepDe('triage')).toMatchObject({ status: 'failed', error_code: 'sin_llm' });
    expect(fila.cost_usd).toBe(0);
    expect(d.enviados).toEqual([msg('triage')]);
  });

  it('sin presupuesto → failed; con el ritmo por minuto lleno → retry a 60 s', async () => {
    const d = conIA();
    await pasoWiki(d.env, msg('arbol'));
    ia.llamar.mockResolvedValueOnce({ ok: false, code: 'budget', reintentar: true });
    expect(await pasoWiki(d.env, msg('triage'))).toEqual({ retry: 60 });
    ia.llamar.mockResolvedValueOnce({ ok: false, code: 'budget' });
    expect(await pasoWiki(d.env, msg('triage'), 2)).toBe('ack');
    expect(stepDe('triage')).toMatchObject({ status: 'failed', error_code: 'ia_sin_presupuesto' });
  });

  it('estado alterado en la base → failed con estado_invalido', async () => {
    const d = conIA();
    fila.state = { version: 1, n: 3, areas: 'x' };
    fila.status = 'running';
    expect(await pasoWiki(d.env, msg('triage'))).toBe('ack');
    expect(fila.status).toBe('failed');
    expect(stepDe('triage')).toMatchObject({ status: 'failed', error_code: 'estado_invalido' });
  });

  it('mensaje mal formado o de otra org → ack sin tocar nada', async () => {
    const d = conIA();
    expect(await pasoWiki(d.env, { ...msg('arbol'), wiki_run_id: 'no-uuid' })).toBe('ack');
    expect(await pasoWiki(d.env, { ...msg('area') })).toBe('ack');
    expect(await pasoWiki(d.env, { ...msg('arbol'), org_id: '0f6c0000-0000-4000-8000-000000000009' })).toBe('ack');
    expect(avances()).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('corrida ya cerrada → ack sin trabajar', async () => {
    const d = conIA();
    fila.status = 'failed';
    expect(await pasoWiki(d.env, msg('arbol'))).toBe('ack');
    expect([avances().length, urls.length]).toEqual([0, 0]);
  });
});

describe('el PAT de GitHub', () => {
  it('se usa en las peticiones a GitHub, pero nunca aparece en state, steps, doc, logs, mensajes ni prompts', async () => {
    const d = conIA();
    await correrCola(d, [msg('arbol')]);
    expect(fila.status).toBe('succeeded');
    expect(urls.some((u) => u.auth?.includes(PAT))).toBe(true);
    expect(urls.every((u) => u.url.startsWith(API) || u.url.startsWith(RAW))).toBe(true);
    expect(JSON.stringify(fila)).not.toContain(PAT);
    expect(JSON.stringify(doble.rpcs)).not.toContain(PAT);
    expect(lineas.join('\n')).not.toContain(PAT);
    expect(JSON.stringify(d.enviados)).not.toContain(PAT);
    expect(JSON.stringify(ia.llamar.mock.calls)).not.toContain(PAT);
    expect(lineas.join('\n')).not.toContain(MARCA);
  });
});

describe('DLQ (vg-jobs-dlq)', () => {
  it('un paso sin hacer → failed con dlq', async () => {
    const d = conIA();
    await pasoWiki(d.env, msg('arbol'));
    expect(await cierreWikiDlq(d.env, msg('triage'))).toBe('ack');
    expect(fila.status).toBe('failed');
    expect(stepDe('triage')).toMatchObject({ status: 'failed', error_code: 'dlq' });
    expect(fila.error).toContain('varias veces');
  });

  it('el último paso hecho (falló el envío) → reencola el siguiente en vez de fallar', async () => {
    const d = conIA();
    d.cola.send.mockRejectedValueOnce(new Error('cola')).mockRejectedValueOnce(new Error('cola'));
    await pasoWiki(d.env, msg('arbol'));
    expect(await cierreWikiDlq(d.env, msg('arbol'))).toBe('ack');
    expect(fila.status).toBe('running');
    expect(d.enviados).toEqual([msg('triage')]);
  });

  it('una síntesis que otra entrega sigue pagando no se pisa: reintenta cuando venza la marca', async () => {
    const d = conIA();
    await correrCola(d, [msg('arbol')], (m) => m.paso === 'sintesis');
    fila.state = { ...fila.state!, sintesis_iniciada: new Date().toISOString() };
    const r = await cierreWikiDlq(d.env, msg('sintesis'));
    expect(r).toEqual({ retry: expect.any(Number) });
    expect(fila.status).toBe('running');
  });

  it('corrida cerrada o base caída', async () => {
    const d = conIA();
    fila.status = 'succeeded';
    expect(await cierreWikiDlq(d.env, msg('triage'))).toBe('ack');
    fila.status = 'running';
    fila.state = null;
    fallaAvanzar = 2;
    expect(await cierreWikiDlq(d.env, msg('arbol'))).toEqual({ retry: 30 });
  });
});

it('REINTENTOS_WIKI = max_retries de vg-jobs', () => {
  expect(REINTENTOS_WIKI).toBe(MAX_REINTENTOS_COLA);
});
