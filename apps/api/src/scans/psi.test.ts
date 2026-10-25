import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PerfRunExt, type ScanStep } from '@vanguard/contracts';
import type { MsgScan } from '../jobs.ts';
import { dbDoble, eqDe, type Op } from '../test/db-doble.ts';
import { envDoble, mensajeDoble } from '../test/dobles.ts';

// Paso psi de «Medir ahora» (§10.2–10.5) sin red: PSI con fetch simulado (cuerpos con la forma que devuelve `fields`),
// supabase-js con el doble (perf_runs y scan_runs en memoria) y la cola de verdad (guarded) para reintentos y cierre.
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const { CAMPOS_PSI, HOSTS_PROPIOS, HOST_VICTIMA_DEMO, TOPE_CUERPO_PSI, UrlNoMedible, hostsPropios, pasoPsi, resumirLhr, urlMedible,
  urlPsi, uuidFrom } = await import('./psi.ts');
const { guarded, registrarPaso } = await import('../jobs.ts');
const { ProviderError } = await import('../lib/http.ts');
const { app } = await import('../app.ts');
registrarPaso('psi', pasoPsi);

const SCAN = '5a1c0000-0000-4000-8000-0000000000c1';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const ANA = '7b1e0000-0000-4000-8000-000000000001';
// Sin forma AIza…: si el código la registrara, redact() no la taparía y la prueba de «nunca en logs» lo vería.
const CLAVE = 'clave-psi-de-prueba-7f3a9c41d2';
const OBJETIVO = 'https://tienda.example.com/ofertas';
const env = { PSI_API_KEY: CLAVE, APP_ORIGIN: 'https://officialvanguard.com',
  SUPABASE_URL: 'https://accshmgmfrqrxubpuxcl.supabase.co' } as CloudflareBindings;
const msg = (): MsgScan => ({ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: 'psi' });

// Lo que PSI devuelve con CAMPOS_PSI (forma del LHR de Lighthouse 13; valores de la v2-regresion móvil de la siembra).
const CUERPO = {
  lighthouseResult: {
    lighthouseVersion: '13.0.1', fetchTime: '2026-10-25T12:00:41.512Z', finalUrl: OBJETIVO, finalDisplayedUrl: `${OBJETIVO}?utm=x`,
    categories: { performance: { score: 0.41 }, accessibility: { score: 0.91 }, 'best-practices': { score: 0.96 }, seo: { score: 0.92 } },
    audits: {
      'largest-contentful-paint': { numericValue: 6200.4492 }, 'total-blocking-time': { numericValue: 819.5 },
      'cumulative-layout-shift': { numericValue: 0.309712 }, 'first-contentful-paint': { numericValue: 3100.2 },
      'speed-index': { numericValue: 5600.83 }, 'server-response-time': { numericValue: 141.2 }, interactive: { numericValue: 7203.9 },
      metrics: { details: { items: [{ timeToFirstByte: 130.37 }, {}] } },
      'resource-summary': { details: { items: [
        { resourceType: 'total', transferSize: 4351870, requestCount: 24 }, { resourceType: 'image', transferSize: 3721004, requestCount: 3 },
        { resourceType: 'script', transferSize: 268311, requestCount: 7 }, { resourceType: 'stylesheet', transferSize: 151200, requestCount: 2 },
        { resourceType: 'document', transferSize: 9120, requestCount: 1 }, { resourceType: 'font', transferSize: 0, requestCount: 0 },
        { resourceType: 'media', transferSize: 0, requestCount: 0 }, { resourceType: 'other', transferSize: 2235, requestCount: 3 },
        { resourceType: 'third-party', transferSize: 0, requestCount: 0 }] } },
    },
  },
};

// Lo que de verdad llega con la máscara: categories y audits ENTEROS (≈150 auditorías con texto, details y tablas; ≈330 KB,
// como la medición del ORQUESTADOR con example.com). Las métricas de §10.3 son las de CUERPO.
const cuerpoReal = () => {
  const audits: Record<string, unknown> = { ...CUERPO.lighthouseResult.audits };
  for (let i = 0; i < 150; i++) {
    audits[`auditoria-${i}`] = { id: `auditoria-${i}`, title: `Auditoría ${i}`, score: 0.5, scoreDisplayMode: 'numeric',
      description: 'Texto de ayuda de Lighthouse con un [enlace](https://developer.chrome.com/docs/lighthouse/). '.repeat(4),
      numericValue: i * 10.5, displayValue: `${i} ms`,
      details: { type: 'table', headings: [{ key: 'url', valueType: 'url', label: 'URL' }],
        items: Array.from({ length: 14 }, (_, k) => ({ url: `https://tienda.example.com/estaticos/recurso-${k}.js`,
          wastedMs: k * 12.5, totalBytes: k * 1024, wastedBytes: k * 512 })) } };
  }
  const categories = Object.fromEntries(Object.entries(CUERPO.lighthouseResult.categories).map(([k, c]) => [k, { ...c, id: k,
    title: k, auditRefs: Array.from({ length: 40 }, (_, i) => ({ id: `auditoria-${i}`, weight: 1, group: 'diagnostics' })) }]));
  return { lighthouseResult: { ...CUERPO.lighthouseResult, categories, audits } };
};

type Fila = Record<string, unknown>;
let params: unknown;
let steps: ScanStep[];
let estadoScan: string;
let errorScan: string | null;
let perf: Fila[];
let errorInsert: { code: string } | null;
let esDemo: boolean;                         // orgs.is_demo de ORG
let doble: ReturnType<typeof dbDoble>;
let salida: string[];
let urls: string[];
let responder: (url: string) => Response | Promise<Response>;
let f: Mock<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
const activa = () => estadoScan === 'queued' || estadoScan === 'running';

beforeEach(() => {
  params = { perf: { url: OBJETIVO, strategy: 'mobile', version_label: 'v2-regresion', trigger: 'manual' } };
  steps = [{ name: 'psi', status: 'pending' }];
  estadoScan = 'queued';
  errorScan = null;
  perf = [];
  errorInsert = null;
  esDemo = false;
  urls = [];
  responder = () => Response.json(CUERPO);
  doble = dbDoble({
    claims: (tok) => (tok === 'ana' ? { sub: ANA, email: 'ana@acme.dev', is_anonymous: false } : null),
    tabla: (op: Op) => {
      if (op.table === 'org_members') return { data: eqDe(op, 'org_id') === ORG ? { role: 'viewer' } : null };
      if (op.table === 'orgs') return { data: eqDe(op, 'id') === ORG ? { is_demo: esDemo } : null };
      if (op.table === 'scan_runs' && op.action === 'select') {
        if (eqDe(op, 'org_id') !== ORG || eqDe(op, 'id') !== SCAN) return { data: null };
        if ((op.columns ?? '').includes('steps')) return { data: { id: SCAN, org_id: ORG, kind: 'lighthouse', status: estadoScan, steps } };
        return { data: { params } };
      }
      if (op.table === 'scan_runs' && op.action === 'update') {
        const p = op.payload as { status?: string; error?: string };
        if (p.status && activa()) { estadoScan = p.status; errorScan = p.error ?? null; }
        return {};
      }
      if (op.table === 'perf_runs' && op.action === 'select') {
        const casan = perf.filter((x) => op.filters.every(([c, o, v]) => o !== 'eq' || x[c] === v));
        return { data: op.single ? (casan[0] ?? null) : casan };
      }
      if (op.table === 'perf_runs' && op.action === 'insert') {
        if (errorInsert) return { error: errorInsert };
        const nueva = op.payload as Fila;
        if (perf.some((x) => x.id === nueva.id)) return { error: { code: '23505' } };
        perf.push({ created_at: new Date().toISOString(), ...nueva });   // default now() de Postgres si no viene
        return {};
      }
      return undefined;
    },
    rpc: (name, a) => {
      if (name === 'vg_claim_step') {
        const s = steps.find((x) => x.name === a.p_paso);
        const gana = activa() && !!s && (s.status === 'pending' || (a.p_retomar === true && s.status === 'running'));
        if (gana) { steps = steps.map((x) => (x.name === a.p_paso ? { ...x, status: 'running' } : x)); estadoScan = 'running'; }
        return { data: gana };
      }
      if (name === 'vg_mark_step') {
        if (!activa()) return { data: false };
        const patch = a.p_patch as Partial<ScanStep>;
        if (patch.status) steps = steps.map((x) => (x.name === a.p_paso ? { ...patch, name: x.name } as ScanStep : x));
        return { data: true };
      }
      return undefined;
    },
  });
  estado.client = doble.client;
  salida = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { salida.push(a.map(String).join(' ')); });
  f = vi.fn(async (url: RequestInfo | URL) => { urls.push(String(url)); return responder(String(url)); });
  vi.stubGlobal('fetch', f);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const errorGoogle = (status: number, message: string) =>
  Response.json({ error: { code: status, message, status: 'INVALID_ARGUMENT' } }, { status });
const fallo = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as InstanceType<typeof ProviderError>; }
  throw new Error('no lanzó');
};
const inserts = () => doble.ops.filter((o) => o.table === 'perf_runs' && o.action === 'insert');
const fin = () => salida.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } })
  .filter((l) => l.event === 'psi.fin');
const correr = async (attempts = 1) => {
  const m = Object.assign(mensajeDoble(msg()), { attempts });
  await guarded(env, m, msg());
  return m;
};

describe('urlMedible (E11 y el paso)', () => {
  it('acepta https público y lo deja como https://host/ruta (sin query ni fragmento, punto final ni :443)', () => {
    expect(urlMedible('https://Tienda.Example.com./ofertas?utm=1&token=x#arriba')).toBe(OBJETIVO);
    expect(urlMedible('https://tienda.example.com')).toBe('https://tienda.example.com/');
    expect(urlMedible('https://tienda.example.com:443/a%20b')).toBe('https://tienda.example.com/a%20b');
    expect(urlMedible('https://español.com/')).toBe('https://xn--espaol-zwa.com/');
    // Parecidos a los propios que no lo son, y workers.dev de otra cuenta.
    for (const u of ['https://evil-officialvanguard.com/', 'https://officialvanguard.com.evil.com/', 'https://app.otra-cuenta.workers.dev/']) {
      expect(urlMedible(u), u).toBe(u);
    }
  });

  it('rechaza con su motivo: http, IPs (también las que URL normaliza), internos, puertos, credenciales y hosts de VanGUARD', () => {
    const casos: [string, string][] = [
      ['http://tienda.example.com/', 'https'], ['ftp://tienda.example.com/', 'https'], ['no es una url', 'url'],
      ['https://127.0.0.1/', 'ip'], ['https://10.0.0.5/admin', 'ip'], ['https://8.8.8.8/', 'ip'], ['https://2130706433/', 'ip'],
      ['https://0x7f.1/', 'ip'], ['https://[::1]/', 'ip'], ['https://[2001:4860:4860::8888]/', 'ip'],
      ['https://localhost/', 'interno'], ['https://app.localhost/', 'interno'], ['https://impresora.local/', 'interno'],
      ['https://db.internal/', 'interno'], ['https://router.lan/', 'interno'], ['https://intranet/', 'host'],
      ['https://mi_sitio.example.com/', 'host'],
      ['https://tienda.example.com:8443/', 'puerto'], ['https://tienda.example.com:80/', 'puerto'],
      ['https://ana:secreta@tienda.example.com/', 'credenciales'], ['https://ana@tienda.example.com/', 'credenciales'],
      ['https://officialvanguard.com/', 'propio'], ['https://demo.officialvanguard.com/', 'propio'],
      ['https://OFFICIALVANGUARD.COM./', 'propio'],
      ['https://www.officialvanguard.com/api/health', 'propio'], ['https://vanguard.giovannizm14.workers.dev/', 'propio'],
      ['https://accshmgmfrqrxubpuxcl.supabase.co/rest/v1/', 'propio'],
      [`https://tienda.example.com/${'a'.repeat(2048)}`, 'largo'], [`https://tienda.example.com/ghp_${'A'.repeat(36)}`, 'secreto'],
    ];
    for (const [u, motivo] of casos) {
      let e: unknown = null;
      try { urlMedible(u); } catch (x) { e = x; }
      expect(e, u).toBeInstanceOf(UrlNoMedible);
      expect((e as InstanceType<typeof UrlNoMedible>).motivo, u).toBe(motivo);
    }
  });

  it('hostsPropios suma los hosts de APP_ORIGIN y SUPABASE_URL a la lista fija', () => {
    const propios = hostsPropios({ APP_ORIGIN: 'https://staging.vanguard.dev', SUPABASE_URL: 'https://otroproyecto.supabase.co' });
    expect(propios).toEqual(expect.arrayContaining([...HOSTS_PROPIOS, 'staging.vanguard.dev', 'otroproyecto.supabase.co']));
    expect(() => urlMedible('https://staging.vanguard.dev/', propios)).toThrow(UrlNoMedible);
    expect(hostsPropios({ APP_ORIGIN: 'no es url' })).toEqual([...HOSTS_PROPIOS]);
  });

  it('permitidos salta SOLO la regla de host propio y solo para ese host exacto', () => {
    const p = [HOST_VICTIMA_DEMO];
    expect(urlMedible('https://Demo.OfficialVanguard.com./a?b=1', HOSTS_PROPIOS, p)).toBe('https://demo.officialvanguard.com/a');
    for (const [u, motivo] of [['https://officialvanguard.com/', 'propio'], ['https://x.demo.officialvanguard.com/', 'propio'],
      ['http://demo.officialvanguard.com/', 'https'], ['https://demo.officialvanguard.com:8443/', 'puerto'],
      ['https://ana@demo.officialvanguard.com/', 'credenciales']] as const) {
      let e: unknown = null;
      try { urlMedible(u, HOSTS_PROPIOS, p); } catch (x) { e = x; }
      expect((e as InstanceType<typeof UrlNoMedible>).motivo, u).toBe(motivo);
    }
  });
});

describe('petición a PSI', () => {
  it('estrategia explícita, las 4 categorías, locale es, fields, prettyPrint=false y la clave solo en la query de googleapis', () => {
    for (const s of ['mobile', 'desktop'] as const) {
      const u = new URL(urlPsi(OBJETIVO, s, CLAVE));
      expect(u.origin + u.pathname).toBe('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
      expect(u.searchParams.get('url')).toBe(OBJETIVO);
      expect(u.searchParams.get('strategy')).toBe(s.toUpperCase());
      expect(u.searchParams.getAll('category')).toEqual(['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']);
      expect(u.searchParams.get('locale')).toBe('es');
      expect(u.searchParams.get('fields')).toBe(CAMPOS_PSI);
      expect(u.searchParams.get('prettyPrint')).toBe('false');
      expect(u.searchParams.get('key')).toBe(CLAVE);
    }
  });

  it('fields pide categories y audits ENTEROS (Google no deja elegir claves de un mapa), versión, runtimeError y finalUrl', () => {
    // «audits(largest-contentful-paint/numericValue,…)» da 400 INVALID_ARGUMENT: audits es un mapa (probado por el ORQUESTADOR).
    expect(CAMPOS_PSI).toBe('lighthouseResult(lighthouseVersion,fetchTime,finalUrl,finalDisplayedUrl,runtimeError,categories,audits)');
    expect(CAMPOS_PSI).not.toMatch(/\/|\*|loadingExperience|i18n|fullPageScreenshot|entities|stackPacks/);
  });
});

describe('resumirLhr y costo del parseo', () => {
  it('scores con las claves del LHR y metrics redondeadas como la siembra (TTFB de metrics, contexto de resource-summary)', () => {
    expect(resumirLhr(CUERPO.lighthouseResult)).toEqual({
      scores: { performance: 0.41, accessibility: 0.91, 'best-practices': 0.96, seo: 0.92 },
      metrics: { lcp_ms: 6200, tbt_ms: 820, cls: 0.3097, fcp_ms: 3100, si_ms: 5601, ttfb_ms: 130, tti_ms: 7204,
        total_bytes: 4351870, script_bytes: 268311, request_count: 24 },
    });
    // Sin el item de metrics, TTFB sale de server-response-time; lo que falta va null, nunca 0.
    const a = { ...CUERPO.lighthouseResult.audits, metrics: undefined, 'total-blocking-time': {} };
    expect(resumirLhr({ ...CUERPO.lighthouseResult, audits: a }).metrics).toMatchObject({ ttfb_ms: 141, tbt_ms: null });
  });

  it('JSON.parse + resumirLhr de una respuesta real de la máscara (≈330 KB, cabe en el tope): < 8 ms (mediana de 60 vueltas)', () => {
    const crudo = JSON.stringify(cuerpoReal());
    expect(crudo.length).toBeGreaterThan(250_000);
    expect(crudo.length).toBeLessThan(TOPE_CUERPO_PSI / 2);
    const t: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      resumirLhr((JSON.parse(crudo) as typeof CUERPO).lighthouseResult);
      t.push(performance.now() - t0);
    }
    t.sort((x, y) => x - y);
    expect(t[30]!).toBeLessThan(8);   // el ORQUESTADOR midió ≈ 1 ms en V8; 8 deja margen con la suite en paralelo
  });
});

describe('pasoPsi', () => {
  it('200 recortado por fields → una fila de perf_runs como la siembra, con trigger manual y run_group = el scan', async () => {
    expect(await pasoPsi(env, msg())).toEqual({ status: 'done' });
    expect(f).toHaveBeenCalledTimes(1);
    const u = new URL(urls[0]!);
    expect(u.host).toBe('www.googleapis.com');
    expect(u.searchParams.get('url')).toBe(OBJETIVO);
    expect(u.searchParams.get('strategy')).toBe('MOBILE');
    expect(inserts()).toHaveLength(1);
    expect(perf[0]).toEqual({ id: await uuidFrom(`${SCAN}|psi|1`), org_id: ORG, scan_run_id: SCAN, url: OBJETIVO, strategy: 'mobile',
      source: 'psi', lighthouse_version: '13.0.1', scores: { performance: 0.41, accessibility: 0.91, 'best-practices': 0.96, seo: 0.92 },
      metrics: { lcp_ms: 6200, tbt_ms: 820, cls: 0.3097, fcp_ms: 3100, si_ms: 5601, ttfb_ms: 130, tti_ms: 7204, total_bytes: 4351870,
        script_bytes: 268311, request_count: 24 },
      run_group: SCAN, rep: 1, is_representative: true, trigger: 'manual', version_label: 'v2-regresion', final_url: OBJETIVO,
      runtime_error: null, created_at: '2026-10-25T12:00:41.512Z' });
    // Las lecturas van con org_id (anti-IDOR).
    for (const o of doble.ops.filter((x) => x.action === 'select')) expect(eqDe(o, 'org_id'), o.table).toBe(ORG);
  });

  it('escritorio: strategy=DESKTOP y sin etiqueta de versión → version_label null', async () => {
    params = { perf: { url: OBJETIVO, strategy: 'desktop', trigger: 'manual' } };
    await pasoPsi(env, msg());
    expect(new URL(urls[0]!).searchParams.get('strategy')).toBe('DESKTOP');
    expect(perf[0]).toMatchObject({ strategy: 'desktop', version_label: null });
  });

  it('429, 5xx, red y plazo vencido → ProviderError transitorio (la cola reintenta) y nada escrito', async () => {
    const casos: [() => Response | Promise<Response>, string][] = [
      [() => errorGoogle(429, 'Quota exceeded'), 'rate_limited'], [() => errorGoogle(500, 'Internal error'), 'unavailable'],
      [() => new Response('x', { status: 503 }), 'unavailable'],
      [() => { throw new TypeError('fetch failed'); }, 'unavailable'],
      [() => { throw new DOMException('signal timed out', 'TimeoutError'); }, 'timeout'],
    ];
    for (const [r, code] of casos) {
      responder = r;
      expect((await fallo(pasoPsi(env, msg()))).code, code).toBe(code);
    }
    expect(perf).toEqual([]);
  });

  it('por la cola: 429 reintenta a 20 s y 40 s (R_PSI) y a la 3.ª el paso queda failed y el scan cerrado como failed', async () => {
    responder = () => errorGoogle(429, 'Quota exceeded');
    const m1 = await correr(1);
    expect(m1.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    const m2 = await correr(2);
    expect(m2.retry).toHaveBeenCalledWith({ delaySeconds: 40 });
    const m3 = await correr(3);
    expect(m3.retry).not.toHaveBeenCalled();
    expect(m3.ack).toHaveBeenCalled();
    expect(steps).toEqual([{ name: 'psi', status: 'failed', error_code: 'rate_limited' }]);
    expect(estadoScan).toBe('failed');
    expect(perf).toEqual([]);
  });

  it('por la cola: 200 → paso done, scan succeeded y psi.fin con ms, estrategia y código HTTP', async () => {
    const m = await correr();
    expect(m.ack).toHaveBeenCalled();
    expect(steps).toEqual([{ name: 'psi', status: 'done' }]);
    expect(estadoScan).toBe('succeeded');
    expect(errorScan).toBeNull();
    expect(fin()).toEqual([expect.objectContaining({ level: 'info', strategy: 'mobile', http: 200, status: 'done', codigo: null })]);
    expect(typeof fin()[0]!.ms).toBe('number');
  });

  it('400 (Google no acepta la URL) → done con runtime_error PSI_400, fila sin métricas y sin reintento', async () => {
    responder = () => errorGoogle(400, 'Invalid value for url parameter');
    const m = await correr();
    expect(m.retry).not.toHaveBeenCalled();
    expect(steps).toEqual([{ name: 'psi', status: 'done', error_code: 'runtime_error' }]);
    expect(estadoScan).toBe('succeeded');
    expect(perf).toHaveLength(1);
    expect(perf[0]).toMatchObject({ runtime_error: 'PSI_400', is_representative: false, scores: {}, lighthouse_version: null,
      metrics: { lcp_ms: null, tbt_ms: null, cls: null, fcp_ms: null, si_ms: null, ttfb_ms: null } });
  });

  it('«Lighthouse returned error» (aunque sea 500) y runtimeError en el LHR → done con el código, sin reintento', async () => {
    responder = () => errorGoogle(500, 'Lighthouse returned error: NO_FCP. The page did not paint any content.');
    expect(await pasoPsi(env, msg())).toEqual({ status: 'done', error_code: 'runtime_error' });
    expect(perf[0]).toMatchObject({ runtime_error: 'NO_FCP', metrics: { lcp_ms: null } });
    perf = [];
    responder = () => Response.json({ lighthouseResult: { ...CUERPO.lighthouseResult, runtimeError: { code: 'ERRORED_DOCUMENT_REQUEST' },
      categories: { performance: { score: null } } } });
    expect(await pasoPsi(env, msg())).toEqual({ status: 'done', error_code: 'runtime_error' });
    expect(perf[0]).toMatchObject({ runtime_error: 'ERRORED_DOCUMENT_REQUEST', lighthouse_version: '13.0.1', is_representative: false,
      metrics: { lcp_ms: null } });
    perf = [];
    responder = () => Response.json({ lighthouseResult: { ...CUERPO.lighthouseResult, runtimeError: { code: 'NO_ERROR' } } });
    expect(await pasoPsi(env, msg())).toEqual({ status: 'done' });
    expect(perf[0]).toMatchObject({ runtime_error: null, is_representative: true });
  });

  it('401/403 (clave) y un fields que Google no acepta → failed sin fila: son nuestros, no de la página', async () => {
    responder = () => errorGoogle(403, 'PageSpeed Insights API has not been used in project 123 before or it is disabled.');
    expect(await pasoPsi(env, msg())).toEqual({ status: 'failed', error_code: 'psi_clave' });
    responder = () => errorGoogle(400, 'Invalid field selection lighthouseResult');
    expect(await pasoPsi(env, msg())).toEqual({ status: 'failed', error_code: 'psi_fields' });
    expect(perf).toEqual([]);
  });

  it('clave mala o caducada: Google da 400 INVALID_ARGUMENT, no 401 → failed psi_clave, sin fila de la página', async () => {
    const info = (reason: string) => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason });
    const claveMala = (message: string, reason: string) => () =>
      Response.json({ error: { code: 400, message, status: 'INVALID_ARGUMENT', details: [info(reason)] } }, { status: 400 });
    for (const [message, reason] of [['API key not valid. Please pass a valid API key.', 'API_KEY_INVALID'],
      ['API key expired. Please renew the API key.', 'API_KEY_EXPIRED']]) {
      responder = claveMala(message!, reason!);
      const m = await correr();
      expect(m.retry, reason).not.toHaveBeenCalled();
      expect(steps, reason).toEqual([{ name: 'psi', status: 'failed', error_code: 'psi_clave' }]);
      expect(estadoScan, reason).toBe('failed');
      expect(perf, reason).toEqual([]);
      steps = [{ name: 'psi', status: 'pending' }];
      estadoScan = 'queued';
    }
    // Solo el motivo: la clave no sale en psi.fin.
    expect(fin().map((l) => l.codigo)).toEqual(['psi_clave', 'psi_clave']);
    expect(salida.join('\n')).not.toContain(CLAVE);
  });

  it('respuesta real de la máscara (categories y audits enteros, ≈330 KB) → se parsea y da la misma fila', async () => {
    responder = () => Response.json(cuerpoReal());
    expect(await pasoPsi(env, msg())).toEqual({ status: 'done' });
    expect(perf).toHaveLength(1);
    expect(perf[0]).toMatchObject({ scores: { performance: 0.41, accessibility: 0.91, 'best-practices': 0.96, seo: 0.92 },
      metrics: { lcp_ms: 6200, tbt_ms: 820, cls: 0.3097, ttfb_ms: 130, total_bytes: 4351870, request_count: 24 },
      runtime_error: null, is_representative: true });
  });

  it('cuerpo gigante (Google mandó otra cosa) → se corta a 1 MB sin JSON.parse de 2 MB y el paso falla sin reintento', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const trozo = new TextEncoder().encode('x'.repeat(64 * 1024));
    let servidos = 0;
    responder = () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { if (servidos++ < 32) c.enqueue(trozo); else c.close(); } }), { status: 200 });   // 2 MB sin content-length
    expect(await pasoPsi(env, msg())).toEqual({ status: 'failed', error_code: 'psi_respuesta_grande' });
    expect(servidos).toBeLessThan(20);   // dejó de leer pasado el tope (16 trozos = 1 MB)
    // Con content-length ni siquiera lee.
    responder = () => new Response('{}', { status: 200, headers: { 'content-length': '1200000' } });
    expect(await pasoPsi(env, msg())).toEqual({ status: 'failed', error_code: 'psi_respuesta_grande' });
    expect(parse.mock.calls.every(([s]) => String(s).length < TOPE_CUERPO_PSI)).toBe(true);
    expect(perf).toEqual([]);
  });

  it('sin PSI_API_KEY, sin params o con una URL que ya no es medible → failed sin llamar a Google', async () => {
    expect(await pasoPsi({ ...env, PSI_API_KEY: ' ' }, msg())).toEqual({ status: 'failed', error_code: 'psi_sin_clave' });
    params = { perf: { url: 'https://demo.officialvanguard.com/', strategy: 'mobile' } };
    expect(await pasoPsi(env, msg())).toEqual({ status: 'failed', error_code: 'url_no_medible' });
    params = { perf: { url: OBJETIVO, strategy: 'tablet' } };
    expect(await pasoPsi(env, msg())).toEqual({ status: 'failed', error_code: 'sin_parametros' });
    expect(f).not.toHaveBeenCalled();
  });

  it('la víctima de la demo: desde la org de demo llega a Google; otro host de VanGUARD nunca; leer la org falla → reintenta', async () => {
    esDemo = true;
    params = { perf: { url: 'https://www.officialvanguard.com/', strategy: 'mobile' } };
    expect(await pasoPsi(env, msg())).toEqual({ status: 'failed', error_code: 'url_no_medible' });
    expect(f).not.toHaveBeenCalled();
    params = { perf: { url: 'https://demo.officialvanguard.com/', strategy: 'mobile', version_label: 'v2-regresion' } };
    expect(await pasoPsi(env, msg())).toEqual({ status: 'done' });
    expect(new URL(urls[0]!).searchParams.get('url')).toBe('https://demo.officialvanguard.com/');
    expect(perf[0]).toMatchObject({ url: 'https://demo.officialvanguard.com/', version_label: 'v2-regresion' });
    // Si no puede leer orgs.is_demo, no lo da por «no medible» (eso cerraría la medición): ProviderError y la cola reintenta.
    perf = [];
    const t = doble.client.from;
    vi.spyOn(doble.client, 'from').mockImplementation(((tabla: string) => (tabla === 'orgs'
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '08006' } }) }) }) }
      : t.call(doble.client, tabla))) as typeof t);
    expect((await fallo(pasoPsi(env, msg()))).code).toBe('unavailable');
    expect(urls).toHaveLength(1);
  });

  it('re-entrega con la fila ya escrita → done sin otra llamada a PSI; un 23505 al insertar también es done', async () => {
    await pasoPsi(env, msg());
    expect(await pasoPsi(env, msg())).toEqual({ status: 'done' });
    expect(f).toHaveBeenCalledTimes(1);
    perf = [];
    errorInsert = { code: '23505' };
    expect(await pasoPsi(env, msg())).toEqual({ status: 'done' });
    errorInsert = { code: '08006' };
    expect((await fallo(pasoPsi(env, msg()))).code).toBe('unavailable');
  });

  it('la clave nunca aparece en logs ni en errores (ni la URL de PSI)', async () => {
    const resultados: unknown[] = [];
    for (const r of [() => Response.json(CUERPO), () => errorGoogle(429, 'q'), () => errorGoogle(400, 'bad'),
      () => { throw new TypeError(`fetch failed ${CLAVE}`); }]) {
      responder = r;
      perf = [];
      resultados.push(await pasoPsi(env, msg()).catch((e: unknown) => ({ name: (e as Error).name, message: (e as Error).message })));
      perf = [];
      steps = [{ name: 'psi', status: 'pending' }];
      estadoScan = 'queued';
      await correr();
    }
    const todo = JSON.stringify(resultados) + salida.join('\n');
    expect(salida.length).toBeGreaterThan(0);
    expect(todo).not.toContain(CLAVE);
    expect(todo).not.toMatch(/runPagespeed|key=|tienda\.example\.com/);
  });
});

describe('E24 lista la medición nueva', () => {
  it('la fila que escribe el paso sale en GET …/perf/runs con PerfRunExt (run_group, rep, trigger, version_label)', async () => {
    await pasoPsi(env, msg());
    const r = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/perf/runs?url=${encodeURIComponent(OBJETIVO)}&strategy=mobile`,
      { headers: { authorization: 'Bearer ana' } }, envDoble().env);
    expect(r.status).toBe(200);
    const runs = PerfRunExt.array().parse(await r.json());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ url: OBJETIVO, strategy: 'mobile', source: 'psi', lighthouse_version: '13.0.1', run_group: SCAN,
      rep: 1, is_representative: true, trigger: 'manual', version_label: 'v2-regresion', runtime_error: null,
      created_at: '2026-10-25T12:00:41.512Z', scores: { performance: 0.41, 'best-practices': 0.96 },
      metrics: { lcp_ms: 6200, tbt_ms: 820, cls: 0.3097, fcp_ms: 3100, si_ms: 5601, ttfb_ms: 130 } });
  });
});
