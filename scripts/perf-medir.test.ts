// Pruebas de scripts/perf-medir.ts (§10.11, RND-06) con fetch simulado: sin red, sin clave real y escribiendo solo en
// una carpeta temporal. Los LHR de aquí son FICTICIOS (forma mínima de Lighthouse 13), nunca se siembran.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PerfRunExt } from '../packages/contracts/src/perf.ts';
import {
  COLUMNAS, ENCABEZADO_SQL, ESPERAS_MS, ORG_DEMO, armarMedicion, bloqueSql, cargarDiagnostico, fusionarResumen, fusionarSql,
  leerCarpeta, lineasResumen, lit, main, medirConReintentos, ocultar, pedirPsi, pickRepresentative, summarize, toPerfRow,
  urlMedible, uuidFrom, versionDeLaVictima, versionesEnNombres,
  type Dependencias, type Lhr, type Rep, type Strategy,
} from './perf-medir.ts';

const RAIZ_REPO = fileURLToPath(new URL('..', import.meta.url));
const URL_V = 'https://demo.officialvanguard.com/';
const CLAVE = 'clave-de-prueba-' + 'no-real-0001'; // no tiene forma de clave de Google
const CLAVE_GOOGLE = 'AI' + 'za' + 'X'.repeat(35); // forma AIza… armada en tiempo de ejecución, solo para el redactor

type Opc = { t: string; s?: Strategy; perf?: number; lcp?: number; tbt?: number; cls?: number; ttfb?: number | null;
  error?: string; url?: string };
function lhrFalso(o: Opc) {
  const url = o.url ?? URL_V;
  return {
    fetchTime: o.t, lighthouseVersion: '13.0.1', requestedUrl: url, finalUrl: url, finalDisplayedUrl: url,
    configSettings: { formFactor: o.s ?? 'mobile' },
    categories: { performance: { score: o.perf ?? 0.97 }, accessibility: { score: 0.91 }, 'best-practices': { score: 1 }, seo: { score: 0.92 } },
    audits: {
      'largest-contentful-paint': { numericValue: o.lcp ?? 1450.4 }, 'total-blocking-time': { numericValue: o.tbt ?? 40 },
      'cumulative-layout-shift': { numericValue: o.cls ?? 0.012345 }, 'first-contentful-paint': { numericValue: 900.6 },
      'speed-index': { numericValue: 1300 }, interactive: { numericValue: 1500 }, 'server-response-time': { numericValue: 99 },
      metrics: { details: { items: o.ttfb === null ? [{}] : [{ timeToFirstByte: o.ttfb ?? 120.2 }] } },
      'resource-summary': { details: { items: [{ resourceType: 'total', transferSize: 70_000, requestCount: 5 },
        { resourceType: 'script', transferSize: 2_000, requestCount: 1 }] } },
    },
    ...(o.error ? { runtimeError: { code: o.error, message: 'fallo de prueba' } } : {}),
  };
}
const psiFalso = (o: Opc) => ({ kind: 'pagespeedonline#result', id: o.url ?? URL_V, lighthouseResult: lhrFalso(o),
  loadingExperience: { id: o.url ?? URL_V } });
const rep = (o: Opc): Rep => ({ lhr: lhrFalso(o) as Lhr, field: null, crudo: psiFalso(o) });

/** fetch simulado: una cola de respuestas por estrategia; anota cada URL pedida. */
function fetchFalso(colas: Partial<Record<Strategy, (() => Response | Promise<Response>)[]>>) {
  const pedidas: URL[] = [];
  const f = (async (entrada: string | URL | Request) => {
    const u = new URL(String(entrada));
    pedidas.push(u);
    const s: Strategy = u.searchParams.get('strategy') === 'MOBILE' ? 'mobile' : 'desktop';
    const siguiente = colas[s]?.shift();
    if (!siguiente) throw new Error(`sin respuesta para ${u.href}`); // el mensaje cita la URL con la clave a propósito
    return siguiente();
  }) as typeof fetch;
  return { f, pedidas };
}
const ok = (o: Opc) => () => Response.json(psiFalso(o));
const sinEspera = async () => {};

describe('uuidFrom y urlMedible', () => {
  it('uuidFrom es estable y válido para z.uuid()', () => {
    const a = uuidFrom('seed|x'), b = uuidFrom('seed|x');
    expect(a).toBe(b);
    expect(a).not.toBe(uuidFrom('seed|y'));
    expect(PerfRunExt.shape.run_group.parse(a)).toBe(a);
  });

  it('urlMedible normaliza y rechaza lo que §10.13 pide rechazar', () => {
    expect(urlMedible('https://demo.officialvanguard.com')).toBe(URL_V);
    expect(urlMedible('https://Demo.OfficialVanguard.com./precios?x=1#y')).toBe('https://demo.officialvanguard.com/precios');
    expect(urlMedible('https://officialvanguard.com/')).toBe('https://officialvanguard.com/');
    for (const mala of ['http://demo.officialvanguard.com/', 'https://1.2.3.4/', 'https://demo.officialvanguard.com:8443/',
      'https://evil-officialvanguard.com/', 'https://officialvanguard.com.evil.com/', 'https://u:p@demo.officialvanguard.com/', 'nada']) {
      expect(() => urlMedible(mala), mala).toThrow();
    }
  });
});

describe('summarize y toPerfRow', () => {
  it('scores con las claves del LHR y metrics de §10.3 redondeadas', () => {
    const { scores, metrics } = summarize(lhrFalso({ t: '2026-10-24T20:30:00.000Z' }) as Lhr);
    expect(scores).toEqual({ performance: 0.97, accessibility: 0.91, 'best-practices': 1, seo: 0.92 });
    expect(metrics).toEqual({ lcp_ms: 1450, tbt_ms: 40, cls: 0.0123, fcp_ms: 901, si_ms: 1300, ttfb_ms: 120,
      tti_ms: 1500, total_bytes: 70_000, script_bytes: 2_000, request_count: 5 });
  });

  it('TTFB cae a server-response-time y un audit que falta queda null', () => {
    const lhr = lhrFalso({ t: '2026-10-24T20:30:00.000Z', ttfb: null }) as Lhr;
    delete lhr.audits!['interactive'];
    delete lhr.audits!['resource-summary'];
    const { metrics } = summarize(lhr);
    expect(metrics.ttfb_ms).toBe(99);
    expect(metrics.tti_ms).toBeNull();
    expect(metrics.total_bytes).toBeNull();
    expect(summarize({}).metrics.lcp_ms).toBeNull();
  });

  it('toPerfRow arma una fila seed que valida con PerfRunExt y conserva sus campos', () => {
    const f = toPerfRow({ orgId: ORG_DEMO, url: URL_V, strategy: 'mobile', runGroup: uuidFrom('g'), rep: 2, version: 'v1-sana',
      lhr: lhrFalso({ t: '2026-10-24T20:30:00Z', error: 'NO_FCP' }) as Lhr, field: null });
    expect(f).toMatchObject({ trigger: 'seed', scan_run_id: null, commit_sha: null, source: 'psi', rep: 2,
      created_at: '2026-10-24T20:30:00.000Z', runtime_error: 'NO_FCP', final_url: URL_V, lighthouse_version: '13.0.1' });
    const p = PerfRunExt.parse(f);
    expect(p).toMatchObject({ run_group: f.run_group, rep: 2, trigger: 'seed', version_label: 'v1-sana', runtime_error: 'NO_FCP' });
    expect(Object.keys(f).sort()).toEqual([...COLUMNAS].sort());
  });
});

describe('pedirPsi (misma lógica que fetchPsi de vg-psi)', () => {
  it('pide la estrategia en mayúsculas, las 4 categorías, locale es y la clave', async () => {
    const { f, pedidas } = fetchFalso({ desktop: [ok({ t: '2026-10-24T20:30:00Z', s: 'desktop' })] });
    const r = await pedirPsi(URL_V, 'desktop', CLAVE, f);
    expect('lhr' in r).toBe(true);
    const q = pedidas[0]!.searchParams;
    expect(pedidas[0]!.origin + pedidas[0]!.pathname).toBe('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    expect(q.get('url')).toBe(URL_V);
    expect(q.get('strategy')).toBe('DESKTOP');
    expect(q.getAll('category')).toEqual(['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']);
    expect(q.get('locale')).toBe('es');
    expect(q.get('key')).toBe(CLAVE);
  });

  it('clasifica 429/5xx/red como transitorios y 400/LH_*/sin LHR como fatales', async () => {
    const r = (fn: () => Response | Promise<Response>) => pedirPsi(URL_V, 'mobile', CLAVE, fetchFalso({ mobile: [fn] }).f);
    expect(await r(() => new Response('{}', { status: 429 }))).toEqual({ transient: 'PSI_429' });
    expect(await r(() => new Response('', { status: 503 }))).toEqual({ transient: 'PSI_503' });
    expect(await r(() => { throw new Error('red caída'); })).toEqual({ transient: 'PSI_RED' });
    expect(await r(() => Response.json({ error: { message: 'x' } }, { status: 400 }))).toEqual({ fatal: 'PSI_400' });
    expect(await r(() => Response.json({ error: { message: 'Lighthouse returned error: NO_FCP. y más' } }, { status: 500 })))
      .toEqual({ fatal: 'LH_NO_FCP' });
    expect(await r(() => Response.json({ kind: 'x' }))).toEqual({ fatal: 'PSI_NO_LHR' });
  });

  it('reintenta solo lo transitorio, con 20 s y 40 s de espera', async () => {
    const esperas: number[] = [];
    const esperar = async (ms: number) => { esperas.push(ms); };
    const { f, pedidas } = fetchFalso({ mobile: [() => new Response('', { status: 429 }), () => new Response('', { status: 502 }),
      ok({ t: '2026-10-24T20:30:00Z' })] });
    expect('lhr' in (await medirConReintentos(URL_V, 'mobile', CLAVE, f, esperar))).toBe(true);
    expect(pedidas).toHaveLength(3);
    expect(esperas).toEqual(ESPERAS_MS);

    const fatal = fetchFalso({ mobile: [() => new Response('{}', { status: 400 }), ok({ t: '2026-10-24T20:30:00Z' })] });
    expect(await medirConReintentos(URL_V, 'mobile', CLAVE, fatal.f, esperar)).toEqual({ fatal: 'PSI_400' });
    expect(fatal.pedidas).toHaveLength(1);
  });
});

describe('armarMedicion y pickRepresentative', () => {
  const base = { orgId: ORG_DEMO, url: URL_V, strategy: 'mobile' as const, version: 'v1-sana' };

  it('la misma corrida en caché (mismo fetchTime) cuenta una vez y rep se numera por hora', () => {
    const { filas } = armarMedicion({ ...base, reps: [rep({ t: '2026-10-24T20:30:40Z' }), rep({ t: '2026-10-24T20:30:01Z' }),
      rep({ t: '2026-10-24T20:30:40.000Z' }), { transient: 'PSI_429' }] });
    expect(filas.map((f) => [f.rep, f.created_at])).toEqual([[1, '2026-10-24T20:30:01.000Z'], [2, '2026-10-24T20:30:40.000Z']]);
    expect(new Set(filas.map((f) => f.run_group)).size).toBe(1);
  });

  it('run_group determinista: no depende del orden ni de la hora de ejecución', () => {
    const a = armarMedicion({ ...base, reps: [rep({ t: '2026-10-24T20:30:02Z' }), rep({ t: '2026-10-24T20:30:01Z' })] });
    const b = armarMedicion({ ...base, reps: [rep({ t: '2026-10-24T20:30:01Z' }), rep({ t: '2026-10-24T20:30:02Z' })] });
    expect(a.filas[0]!.run_group).toBe(b.filas[0]!.run_group);
    expect(a.filas.map((f) => f.id)).toEqual(b.filas.map((f) => f.id));
    const otra = armarMedicion({ ...base, strategy: 'desktop', reps: [rep({ t: '2026-10-24T20:30:01Z', s: 'desktop' })] });
    expect(otra.filas[0]!.run_group).not.toBe(a.filas[0]!.run_group);
  });

  it('representativa = la más cercana a la mediana; empate → menor LCP; runtime_error nunca', () => {
    const { filas } = armarMedicion({ ...base, reps: [rep({ t: '2026-10-24T20:30:01Z', perf: 0.9, lcp: 1500 }),
      rep({ t: '2026-10-24T20:30:02Z', perf: 0.96, lcp: 1400 }), rep({ t: '2026-10-24T20:30:03Z', perf: 0.98, lcp: 1300 }),
      rep({ t: '2026-10-24T20:30:04Z', perf: 0.97, lcp: 1, error: 'NO_FCP' })] });
    expect(filas.filter((f) => f.is_representative).map((f) => f.rep)).toEqual([2]);
    const empate = armarMedicion({ ...base, reps: [rep({ t: '2026-10-24T20:30:01Z', perf: 0.9, lcp: 2000 }),
      rep({ t: '2026-10-24T20:30:02Z', perf: 1, lcp: 1000 })] });
    expect(empate.filas.find((f) => f.is_representative)!.rep).toBe(2);
    expect(pickRepresentative(armarMedicion({ ...base, reps: [rep({ t: '2026-10-24T20:30:01Z', error: 'NO_FCP' })] }).filas)).toBe(-1);
  });

  it('sin respuestas útiles devuelve los motivos y ninguna fila', () => {
    expect(armarMedicion({ ...base, reps: [{ fatal: 'LH_NO_FCP' }, { transient: 'PSI_RED' }] }))
      .toEqual({ filas: [], motivos: ['LH_NO_FCP', 'PSI_RED'] });
  });

  it('diagnosis solo en la representativa, y nunca si pasa de 8 KB', () => {
    const reps = [rep({ t: '2026-10-24T20:30:01Z', perf: 0.9 }), rep({ t: '2026-10-24T20:30:02Z', perf: 0.95 }), rep({ t: '2026-10-24T20:30:03Z', perf: 1 })];
    const diag = { lcp: { dominant: null, selector: null, parts: [] }, causes: [] };
    const { filas } = armarMedicion({ ...base, reps, diagnosticar: () => diag });
    expect(filas.map((f) => f.diagnosis)).toEqual([null, diag, null]);
    const grande = armarMedicion({ ...base, reps, diagnosticar: () => ({ x: 'a'.repeat(9000) }) });
    expect(grande.filas.every((f) => f.diagnosis === null)).toBe(true);
    expect(grande.motivos).toContain('DIAGNOSIS_MAYOR_DE_8KB');
    const roto = armarMedicion({ ...base, reps, diagnosticar: () => { throw new Error('x'); } });
    expect(roto.motivos).toContain('DIAGNOSE_FALLO');
  });

  it('el tope de 8 KB cuenta bytes UTF-8, no caracteres', () => {
    const reps = [rep({ t: '2026-10-24T20:30:01Z' })];
    const tildes = armarMedicion({ ...base, reps, diagnosticar: () => ({ x: 'á'.repeat(5000) }) }); // ~5 000 caracteres, ~10 000 bytes
    expect(tildes.filas[0]!.diagnosis).toBeNull();
    expect(tildes.motivos).toContain('DIAGNOSIS_MAYOR_DE_8KB');
  });
});

describe('versión de la medición', () => {
  it('versionesEnNombres lee <versión>-<estrategia>-<rep>.json y no cuenta sin-version', () => {
    expect(versionesEnNombres(['v1-sana-mobile-1.json', 'v1-sana-desktop-3.json', 'cualquiera.json', 'resumen.json'])).toEqual(['v1-sana']);
    expect(versionesEnNombres(['v1-sana-mobile-1.json', 'v2-regresion-mobile-1.json'])).toEqual(['v1-sana', 'v2-regresion']);
    expect(versionesEnNombres(['sin-version-mobile-1.json'])).toEqual([]);
  });

  it('versionDeLaVictima lee PERF_VERSION del repo (y null si no está)', () => {
    expect(versionDeLaVictima(RAIZ_REPO)).toMatch(/^v\d-[a-z]+$/);
    expect(versionDeLaVictima(join(tmpdir(), 'no-existe-perf-medir'))).toBeNull();
  });
});

describe('SQL de demo/seed-perf.sql', () => {
  const filas = () => armarMedicion({ orgId: ORG_DEMO, url: URL_V, strategy: 'mobile', version: 'v1-sana',
    reps: [rep({ t: '2026-10-24T20:30:01Z' }), rep({ t: '2026-10-24T20:30:02Z' }), rep({ t: '2026-10-24T20:30:03Z' })] }).filas;

  it('lit dobla comillas y manda objetos como jsonb', () => {
    expect(lit("O'Reilly")).toBe("'O''Reilly'");
    expect(lit(null)).toBe('null');
    expect(lit(true)).toBe('true');
    expect(lit(0.0123)).toBe('0.0123');
    expect(lit({ 'best-practices': 1, a: "x'y" })).toBe(`'{"best-practices":1,"a":"x''y"}'::jsonb`);
    expect(() => lit(Number.NaN)).toThrow();
    const nul = lit({ a: 'x\u0000y', b: '\\u0000' }); // un NUL real se quita; el texto «\u0000» escrito tal cual se conserva
    expect(nul).toBe(`'{"a":"xy","b":"\\\\u0000"}'::jsonb`);
    expect(JSON.parse(nul.slice(1, -8))).toEqual({ a: 'xy', b: '\\u0000' });
  });

  it('un bloque borra su run_group e inserta todas las columnas', () => {
    const f = filas(), sql = bloqueSql(f);
    expect(sql).toContain(`delete from public.perf_runs where org_id = '${ORG_DEMO}' and run_group = '${f[0]!.run_group}';`);
    expect(sql).toContain(`insert into public.perf_runs (${COLUMNAS.join(', ')}) values`);
    expect(sql.match(/^ \('/gm)).toHaveLength(3);
    expect(sql).toContain(`'seed'`);
    expect(sql).toMatch(/-- >>> medicion [0-9a-f-]{36}\n[\s\S]*-- <<< medicion [0-9a-f-]{36}\n$/);
  });

  it('regenerar reemplaza el bloque (también con CRLF) y otra medición se añade', () => {
    const f = filas(), b = { runGroup: f[0]!.run_group, sql: bloqueSql(f) };
    const una = fusionarSql(null, [b]);
    expect(una.startsWith(ENCABEZADO_SQL)).toBe(true);
    expect(fusionarSql(una, [b])).toBe(una);
    expect(fusionarSql(una.replace(/\n/g, '\r\n'), [b]).match(/-- >>> medicion/g)).toHaveLength(1);
    const otra = armarMedicion({ orgId: ORG_DEMO, url: URL_V, strategy: 'desktop', version: 'v1-sana',
      reps: [rep({ t: '2026-10-24T20:30:05Z', s: 'desktop' })] }).filas;
    const dos = fusionarSql(una, [{ runGroup: otra[0]!.run_group, sql: bloqueSql(otra) }]);
    expect(dos.match(/-- >>> medicion/g)).toHaveLength(2);
  });

  it('demo/seed-perf.sql del repo empieza con el encabezado del script', () => {
    const real = readFileSync(join(RAIZ_REPO, 'demo', 'seed-perf.sql'), 'utf8').replace(/\r\n/g, '\n');
    expect(real.startsWith(ENCABEZADO_SQL)).toBe(true);
  });

  it('las columnas existen en el DDL de perf_runs (0007)', () => {
    const ddl = readFileSync(join(RAIZ_REPO, 'supabase', 'migrations', '0007_ai_config_perf.sql'), 'utf8');
    for (const c of COLUMNAS) expect(ddl, c).toMatch(new RegExp(`(^|\\s)${c} (uuid|text|jsonb|timestamptz|smallint|boolean)\\b`, 'm'));
  });
});

describe('resumen.json', () => {
  it('una línea por repetición, solo cifras, y reemplaza por run_group', () => {
    const f = armarMedicion({ orgId: ORG_DEMO, url: URL_V, strategy: 'mobile', version: 'v1-sana',
      reps: [rep({ t: '2026-10-24T20:30:01Z' }), rep({ t: '2026-10-24T20:30:02Z' })] }).filas;
    const l = lineasResumen(f);
    expect(Object.keys(l[0]!).sort()).toEqual(['cls', 'fetchTime', 'lcp_ms', 'lighthouseVersion', 'perf_score', 'rep',
      'run_group', 'runtime_error', 'strategy', 'tbt_ms', 'url', 'version']);
    expect(l[0]!.perf_score).toBe(97);
    const t = fusionarResumen(null, l);
    expect(t.split('\n').filter((x) => x.startsWith('  {'))).toHaveLength(2);
    expect(fusionarResumen(t, l)).toBe(t);
    expect(() => fusionarResumen('{"no":"lista"}', l)).toThrow();
  });
});

describe('ocultar', () => {
  it('quita la clave, el parámetro key= y cualquier clave con forma de Google', () => {
    expect(ocultar(`https://x/y?url=a&key=${CLAVE}&locale=es`, CLAVE)).toBe('https://x/y?url=a&key=[clave]&locale=es');
    expect(ocultar(`fallo con ${CLAVE}`, CLAVE)).toBe('fallo con [clave]');
    expect(ocultar(`otra ${CLAVE_GOOGLE} aquí`)).toBe('otra [clave] aquí');
  });
});

describe('main de punta a punta (carpeta temporal)', () => {
  let raiz: string;
  let salida: string[];
  const deps = (extra: Partial<Dependencias> = {}): Partial<Dependencias> => ({ raiz, esperar: sinEspera, diagnosticar: null,
    prepararTls: () => {}, ahora: () => new Date('2026-10-24T20:30:00Z'), env: { PSI_API_KEY: CLAVE },
    log: (t) => salida.push(t), error: (t) => salida.push(t), ...extra });
  beforeEach(() => { raiz = mkdtempSync(join(tmpdir(), 'perf-medir-')); salida = []; });
  afterEach(() => rmSync(raiz, { recursive: true, force: true }));

  it('mide 3 × 2, guarda los crudos, escribe SQL y resumen, y la clave no aparece en ningún lado', async () => {
    const { f, pedidas } = fetchFalso({
      mobile: [ok({ t: '2026-10-24T20:30:20Z', perf: 0.96 }), ok({ t: '2026-10-24T20:30:21Z', perf: 0.97 }),
        () => new Response('', { status: 429 }), ok({ t: '2026-10-24T20:31:10Z', perf: 0.98 })],
      desktop: [ok({ t: '2026-10-24T20:30:22Z', s: 'desktop', perf: 1 }), ok({ t: '2026-10-24T20:30:23Z', s: 'desktop', perf: 1 }),
        () => { throw new Error(`fallo de red en https://www.googleapis.com/x?key=${CLAVE}`); },
        () => { throw new Error('otra vez'); }, () => { throw new Error('y otra'); }],
    });
    const codigo = await main(['--url', 'https://demo.officialvanguard.com', '--version', 'v1-sana'], deps({ fetch: f }));
    expect(codigo).toBe(0);
    expect(pedidas.length).toBe(6 + 1 + 2); // un 429 en móvil y un desktop que agota sus 2 reintentos

    const carpeta = join(raiz, 'demo', 'perf-lhr', 'v1-sana', '20261024T2030Z');
    expect(readdirSync(carpeta).sort()).toEqual(['v1-sana-desktop-1.json', 'v1-sana-desktop-2.json',
      'v1-sana-mobile-1.json', 'v1-sana-mobile-2.json', 'v1-sana-mobile-3.json']);
    const sql = readFileSync(join(raiz, 'demo', 'seed-perf.sql'), 'utf8');
    expect(sql.startsWith(ENCABEZADO_SQL)).toBe(true);
    expect(sql.match(/-- >>> medicion/g)).toHaveLength(2);
    expect(sql.match(/^ \('/gm)).toHaveLength(5);
    const resumen = JSON.parse(readFileSync(join(raiz, 'demo', 'perf-lhr', 'resumen.json'), 'utf8')) as { strategy: string }[];
    expect(resumen.map((l) => l.strategy)).toEqual(['mobile', 'mobile', 'desktop', 'desktop', 'mobile']);
    expect(salida.join('\n')).toMatch(/desktop: 2 repeticiones \(2 válidas, «indicativo»\)[\s\S]*PSI_RED/);
    expect(salida.join('\n')).toContain('.gitignore no excluye demo/perf-lhr');

    const todo = [sql, readFileSync(join(raiz, 'demo', 'perf-lhr', 'resumen.json'), 'utf8'), salida.join('\n'),
      ...readdirSync(carpeta).map((n) => readFileSync(join(carpeta, n), 'utf8'))].join('\n');
    expect(todo).not.toContain(CLAVE);
    expect(todo).not.toMatch(/key=(?!\[clave\])/);
  });

  it('regenerar desde la carpeta (plan C, sin clave) da los mismos run_group y no duplica', async () => {
    const { f } = fetchFalso({ mobile: [1, 2, 3].map((i) => ok({ t: `2026-10-24T20:30:0${i}Z` })),
      desktop: [1, 2, 3].map((i) => ok({ t: `2026-10-24T20:30:0${i}Z`, s: 'desktop' })) });
    expect(await main(['--url', URL_V, '--version', 'v1-sana'], deps({ fetch: f }))).toBe(0);
    const rutaSql = join(raiz, 'demo', 'seed-perf.sql'), rutaRes = join(raiz, 'demo', 'perf-lhr', 'resumen.json');
    const antes = readFileSync(rutaSql, 'utf8'), resAntes = readFileSync(rutaRes, 'utf8');

    const sinRed = (() => { throw new Error('no debe pedir nada'); }) as unknown as typeof fetch;
    const desdeCarpeta = ['--url', URL_V, '--version', 'v1-sana', '--from-dir', 'demo/perf-lhr/v1-sana/20261024T2030Z'];
    expect(await main(desdeCarpeta, deps({ fetch: sinRed, env: {} }))).toBe(0);
    expect(readFileSync(rutaSql, 'utf8')).toBe(antes);
    expect(readFileSync(rutaRes, 'utf8')).toBe(resAntes);
  });

  it('plan C con JSON de curl: estrategia del LHR; rechaza otra URL o un error de PSI', async () => {
    const dir = join(raiz, 'curl');
    mkdirSync(dir);
    writeFileSync(join(dir, 'v2-regresion-mobile-1.json'), JSON.stringify(psiFalso({ t: '2026-10-24T22:00:01Z', perf: 0.41 })));
    writeFileSync(join(dir, 'cualquiera.json'), JSON.stringify(psiFalso({ t: '2026-10-24T22:00:02Z', s: 'desktop' })));
    const r = leerCarpeta(dir, URL_V);
    expect([r.mobile.length, r.desktop.length]).toEqual([1, 1]);
    expect(await main(['--url', URL_V, '--version', 'v2-regresion', '--from-dir', dir], deps({ env: {} }))).toBe(0);

    writeFileSync(join(dir, 'ajena.json'), JSON.stringify(psiFalso({ t: '2026-10-24T22:00:03Z', url: 'https://officialvanguard.com/' })));
    expect(() => leerCarpeta(dir, URL_V)).toThrow(/midió https:\/\/officialvanguard\.com\//);
    rmSync(join(dir, 'ajena.json'));
    writeFileSync(join(dir, 'error.json'), JSON.stringify({ error: { code: 429, message: 'Quota' } }));
    expect(await main(['--url', URL_V, '--from-dir', dir], deps({ env: {} }))).toBe(1);
  });

  it('sin clave, URL ajena o versión inválida: sale sin escribir nada', async () => {
    const nada = fetchFalso({}).f;
    expect(await main(['--url', URL_V, '--version', 'v1-sana'], deps({ fetch: nada, env: {} }))).toBe(1);
    expect(salida.join('\n')).toContain('Falta PSI_API_KEY');
    expect(await main(['--url', 'https://example.com/'], deps({ fetch: nada }))).toBe(2);
    expect(await main(['--url', URL_V, '--version', "v1'; drop"], deps({ fetch: nada }))).toBe(2);
    expect(await main(['--url', URL_V, '--reps', '9'], deps({ fetch: nada }))).toBe(2);
    expect(await main(['--nada'], deps({ fetch: nada }))).toBe(2);
    expect(readdirSync(raiz)).toEqual([]);
  });

  it('--from-dir con otra versión que la de los nombres no escribe nada', async () => {
    const dir = join(raiz, 'v2');
    mkdirSync(dir);
    writeFileSync(join(dir, 'v2-regresion-mobile-1.json'), JSON.stringify(psiFalso({ t: '2026-10-24T22:00:01Z', perf: 0.41 })));
    expect(await main(['--url', URL_V, '--version', 'v1-sana', '--from-dir', dir], deps({ env: {} }))).toBe(2);
    expect(await main(['--url', URL_V, '--from-dir', dir], deps({ env: {} }))).toBe(2);
    expect(salida.join('\n')).toContain('los JSON dicen v2-regresion');
    expect(readdirSync(raiz)).toEqual(['v2']);
  });

  it('sin --version toma PERF_VERSION de la víctima; si no coincide, avisa', async () => {
    mkdirSync(join(raiz, 'apps', 'victima', 'src'), { recursive: true });
    writeFileSync(join(raiz, 'apps', 'victima', 'src', 'perf-version.ts'), "export const PERF_VERSION = 'v2-regresion';\n");
    const una = () => fetchFalso({ mobile: [ok({ t: '2026-10-24T22:00:01Z' })] }).f;
    expect(await main(['--url', URL_V, '--reps', '1', '--solo', 'mobile'], deps({ fetch: una() }))).toBe(0);
    expect(readdirSync(join(raiz, 'demo', 'perf-lhr'))).toContain('v2-regresion');
    expect(readFileSync(join(raiz, 'demo', 'seed-perf.sql'), 'utf8')).toContain(`'v2-regresion'`);
    expect(await main(['--url', URL_V, '--version', 'v1-sana', '--reps', '1', '--solo', 'mobile'], deps({ fetch: una() }))).toBe(0);
    expect(salida.join('\n')).toContain('perf-version.ts dice v2-regresion');
  });

  it('carga diagnose/locateAll de core/perf y solo siembra una diagnosis que cumple PerfDiagnosis', async () => {
    const diag = { lcp: { dominant: 'resourceLoadDelay', selector: 'img', parts: [] }, causes: [] };
    const core = (r: string, locate: string) => { // una raíz por caso: ESM guarda en caché cada módulo por su URL
      const perf = join(r, 'packages', 'core', 'src', 'perf');
      mkdirSync(perf, { recursive: true });
      writeFileSync(join(perf, 'diagnose.ts'), `export function diagnose() { return ${JSON.stringify(diag)}; }\n`);
      writeFileSync(join(perf, 'locate.ts'), locate);
      return r;
    };
    const buena = await cargarDiagnostico(core(join(raiz, 'a'), 'export function locateAll(d) { return { ...d, causes: [] }; }\n'), () => {});
    expect(buena!(lhrFalso({ t: '2026-10-24T22:00:01Z' }) as Lhr)).toEqual(diag);
    const mala = await cargarDiagnostico(core(join(raiz, 'b'), 'export function locateAll() { return { otra: "forma" }; }\n'), () => {});
    const { filas, motivos } = armarMedicion({ orgId: ORG_DEMO, url: URL_V, strategy: 'mobile', version: 'v1-sana',
      reps: [rep({ t: '2026-10-24T22:00:01Z' })], diagnosticar: mala });
    expect(filas[0]!.diagnosis).toBeNull();
    expect(motivos).toContain('DIAGNOSE_FALLO');
  });

  it('si ninguna repetición sirve, no toca el SQL', async () => {
    const { f } = fetchFalso({ mobile: [() => Response.json({ error: { message: 'Lighthouse returned error: NO_FCP' } }, { status: 500 })] });
    expect(await main(['--url', URL_V, '--version', 'v1-sana', '--reps', '1', '--solo', 'mobile'], deps({ fetch: f }))).toBe(1);
    expect(salida.join('\n')).toMatch(/LH_NO_FCP \(Lighthouse no pudo cargar la página\)/);
    expect(readdirSync(join(raiz, 'demo'))).toEqual(['perf-lhr']); // solo la carpeta vacía de crudos
  });
});

describe('CLI con Node (type stripping, sin vitest)', () => {
  const correr = (...args: string[]) => spawnSync(process.execPath, [join(RAIZ_REPO, 'scripts', 'perf-medir.ts'), ...args],
    { cwd: RAIZ_REPO, encoding: 'utf8', env: { ...process.env, PSI_API_KEY: '' }, timeout: 30_000 });

  it('--help sale con 0 y sin clave no mide ni escribe', () => {
    const h = correr('--help');
    expect(h.status).toBe(0);
    expect(h.stdout).toContain('--from-dir');
    const s = correr('--url', URL_V, '--version', 'v1-sana');
    expect(s.status).toBe(1);
    expect(s.stderr).toContain('Falta PSI_API_KEY');
  });
});
