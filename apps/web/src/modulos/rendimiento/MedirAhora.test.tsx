// «Medir ahora» (F-17): quién puede medir (solo owner y admin; el viewer y el anónimo no ven nada), el campo libre con sus
// sugerencias y su ejemplo, sin zona de Cloudflare, el cuerpo exacto de E11 y la navegación, los errores del servidor en
// su sitio (422, 409, 429) y la bandera por 404. Sin jsdom: renderToStaticMarkup con la caché a mano y api() mockeada.
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, type Query, type QueryKey } from '@tanstack/react-query';
import { fixtures as fx, ScanAccepted, type PerfRunExt, type ScanRun } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { PantallaModulo } from '@/componentes/vg/PantallaModulo';
import { useScan } from '@/lib/consultas';
import { ApiError } from '@/lib/errores';
import { TEXTO_ROL } from '@/lib/severidad';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import { AvisoMedir, MedirAhora } from './MedirAhora';
import { cuerpoMedir, EN_CURSO, errorMedir, etiquetaPrevia, medir, puedeMedir, urlsConocidas, URL_VICTIMA_DEMO } from './medir';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/componentes/vg/GraficaComparativa', () => ({ GraficaComparativa: () => null }));
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api }));
const { default: PaginaRendimiento } = await import('./PaginaRendimiento');

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', me: fx.meViewer, puedeEscribir: false };
const ROL_ADMIN: OrgActual = { ...ADMIN, role: 'admin' };
// El anónimo de «Ver demo» con un rol de escritura: RequireOrg le da puedeEscribir false.
const ANONIMO: OrgActual = { ...ADMIN, me: fx.meViewer, puedeEscribir: false };
const OTRA: OrgActual = { ...ADMIN, id: 'f1000000-0000-4000-8000-0000000000a1', name: 'Tienda propia', is_demo: false };
const RUNS = fx.perfRuns as PerfRunExt[];
const URL_DEMO = 'https://demo.officialvanguard.com/';
const SCAN = 'c5000000-0000-4000-8000-000000000001';

function pintar(nodo: ReactNode, o: { org?: OrgActual; datos?: [QueryKey, unknown][]; error?: [QueryKey, ApiError]; ruta?: string; patron?: string } = {}) {
  const org = o.org ?? ADMIN;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  for (const [k, v] of o.datos ?? []) qc.setQueryData(k, v);
  if (o.error) qc.getQueryCache().build(qc, { queryKey: o.error[0] }).setState({ status: 'error', error: o.error[1], fetchStatus: 'idle' });
  const ruta = o.ruta ?? `/o/${org.id}/performance`;
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}>
        <OrgDePrueba org={org}>{o.patron ? <Routes><Route path={o.patron} element={nodo} /></Routes> : nodo}</OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const conRuns = (runs: unknown, org = ADMIN): [QueryKey, unknown][] => [
  [['org', org.id, 'module', 'performance'], fx.moduleState.performance], [['org', org.id, 'connections'], fx.connections],
  [['org', org.id, 'perf'], runs]];
// La etiqueta de apertura del <button type="submit"> de «Medir ahora».
const botonMedir = (html: string) => html.match(/<button[^>]*type="submit"[^>]*>(?=(?:(?!<\/button>).)*Medir ahora<\/button>)/s)?.[0] ?? '';
// La página sin la sección de «Medir ahora» (no lleva <section> anidadas).
const sinMedir = (html: string) => html.replace(/<section[^>]*aria-labelledby="t-medir"[^>]*>[\s\S]*?<\/section>/, '');

describe('Medir ahora · quién y qué trae por defecto', () => {
  it('owner y admin: botón principal de 56 px habilitado, con la URL y la etiqueta de la última medición', () => {
    const html = pintar(<PaginaRendimiento />, { datos: conRuns(RUNS) });
    const b = botonMedir(html);
    expect(b).toContain('h-14');
    expect(b).not.toContain('disabled=""');
    expect(html).toContain(`value="${URL_DEMO}"`);
    expect(html).toContain('value="v2-regresion"');
    expect(html).toMatch(/aria-label="Estrategia de la medición"><button type="button" aria-pressed="true"[^>]*><span class="block truncate"><bdi dir="ltr">Móvil</);   // Móvil por defecto
    expect(html).not.toContain('Solo un admin puede medir');
  });

  it('solo owner y admin: el viewer y el anónimo de «Ver demo» no ven ni el botón ni el formulario; el resto, igual', () => {
    expect([ADMIN, ROL_ADMIN, VIEWER, ANONIMO].map(puedeMedir)).toEqual([true, true, false, false]);
    expect(botonMedir(pintar(<PaginaRendimiento />, { org: ROL_ADMIN, datos: conRuns(RUNS, ROL_ADMIN) }))).not.toContain('disabled=""');
    const admin = pintar(<PaginaRendimiento />, { datos: conRuns(RUNS) });
    for (const org of [VIEWER, ANONIMO]) {
      expect(pintar(<MedirAhora />, { org, datos: conRuns(RUNS, org) })).toBe('');
      const html = pintar(<PaginaRendimiento />, { org, datos: conRuns(RUNS, org) });
      expect(html).not.toContain('aria-labelledby="t-medir"');
      expect(html).not.toContain('type="submit"');
      expect(html).not.toContain('<datalist');
      expect(html).not.toContain('Solo un admin puede medir');
      expect(html).toContain('aria-labelledby="t-historico"');
      expect(html).toBe(sinMedir(admin));                                    // el resto de Rendimiento, idéntico
    }
  });

  it('un admin de una org sin la demo, sin mediciones: «Medir ahora» sigue arriba de «Aún no medimos tu web»', () => {
    const vacio = { ...fx.moduleState.performance, cifras: fx.moduleState.performance.cifras.map((c) => ({ ...c, n: null })) };
    const html = pintar(<PaginaRendimiento />, { datos: [...conRuns([]).slice(1), [['org', ORG, 'module', 'performance'], vacio]] });
    expect(html).toContain('Aún no medimos tu web');
    expect(html.indexOf('Medir ahora')).toBeLessThan(html.indexOf('Aún no medimos tu web'));
    expect(html).toContain('value=""');
  });

  it('no exige zona de Cloudflare: sin ella, el mismo formulario, sin aviso ni «Conectar Cloudflare»; dice qué se puede medir', () => {
    const sinCf = (fx.connections as { provider: string }[]).filter((c) => c.provider !== 'cloudflare');
    const datos: [QueryKey, unknown][] = [...conRuns(RUNS).filter(([k]) => k[2] !== 'connections'), [['org', ORG, 'connections'], sinCf]];
    const html = pintar(<MedirAhora />, { datos });
    expect(html).toBe(pintar(<MedirAhora />, { datos: conRuns(RUNS) }));
    expect(html).not.toMatch(/zona|Conectar Cloudflare|\/connections/);
    expect(botonMedir(html)).not.toContain('disabled=""');
    expect(html).toContain('Cualquier web pública con https://. No medimos IPs, localhost ni webs de VanGUARD.');
    expect(html).toContain('aria-describedby="medir-url-ayuda"');
    expect(html).toContain('Lighthouse vía PageSpeed Insights, una estrategia cada vez: suele tardar menos de un minuto.');
    expect(html).not.toMatch(/repetici|mediana|~1 min/);
  });

  it('el ejemplo del campo: en la org de demo, la víctima real; en otra org, uno neutro', () => {
    expect(URL_VICTIMA_DEMO).toBe('https://vanguard-demo-victima.pages.dev/');
    expect(pintar(<MedirAhora />, { datos: conRuns([]) })).toContain(`placeholder="${URL_VICTIMA_DEMO}"`);
    const otra = pintar(<MedirAhora />, { org: OTRA, datos: conRuns([], OTRA) });
    expect(otra).toContain('placeholder="https://tusitio.com/"');
    expect(otra).not.toContain('vanguard-demo-victima');
    expect(otra).not.toContain('<datalist');                                      // sin mediciones, sin sugerencias
  });

  it('campo de texto libre: la más reciente por defecto y las ya medidas como sugerencias (<datalist>); nunca una con bidi', () => {
    const otra = RUNS.map((r) => ({ ...r, id: r.id.replace(/.$/, 'f'), url: 'https://www.officialvanguard.com/precios', created_at: '2026-10-24T22:00:00.000Z' }));
    const bidi = { ...RUNS[0]!, url: `https://demo.officialvanguard.com/${String.fromCodePoint(0x202e)}x`, created_at: '2026-10-25T00:00:00.000Z' };
    expect(urlsConocidas([bidi, ...RUNS, ...otra])).toEqual(['https://www.officialvanguard.com/precios', URL_DEMO]);
    expect(urlsConocidas([{ ...RUNS[0]!, url: 'http://demo.officialvanguard.com/' }, 'x', null])).toEqual([]);
    expect(urlsConocidas({ no: 'lista' })).toEqual([]);
    // Ni lo que el servidor nunca mediría ni guarda así: IPs, nombres reservados o internos, puertos, credenciales, query.
    const nunca = ['https://127.0.0.1/', 'https://localhost/', 'https://nas.local/', 'https://evil.test/x', 'https://tienda.com:8443/',
      'https://yo:clave@tienda.com/', 'https://tienda.com/?utm=1', 'https://TIENDA.com/'];
    expect(urlsConocidas(nunca.map((url, i) => ({ ...RUNS[0]!, url, created_at: `2026-10-25T0${i}:00:00.000Z` })))).toEqual([]);
    const html = pintar(<MedirAhora />, { datos: conRuns([bidi, ...RUNS, ...otra]) });
    expect(html).toMatch(/<input[^>]*id="medir-url"[^>]*type="url"[^>]*list="medir-urls"[^>]*value="https:\/\/www\.officialvanguard\.com\/precios"/);
    expect(html).toContain(`<datalist id="medir-urls"><option value="https://www.officialvanguard.com/precios"></option><option value="${URL_DEMO}"></option></datalist>`);
    expect(html).not.toContain('aria-label="URL ya medidas"');                   // ya no es un grupo de botones
    expect(html).not.toMatch(/\u202e|⟨U\+202E⟩x/i);
    expect(etiquetaPrevia(RUNS, URL_DEMO)).toBe('v2-regresion');
    expect(etiquetaPrevia([{ ...RUNS[0]!, version_label: '<img src=x>' }], URL_DEMO)).toBe('');
  });
});

describe('Medir ahora · cuerpo de E11 y navegación', () => {
  it('cuerpo plano {kind, url, strategy}; version_label solo si se escribe; la URL se valida antes de salir', () => {
    expect(cuerpoMedir(` ${URL_DEMO} `, 'mobile', '')).toStrictEqual({ body: { kind: 'lighthouse', url: URL_DEMO, strategy: 'mobile' } });
    expect(cuerpoMedir(URL_DEMO, 'desktop', 'v3')).toStrictEqual({ body: { kind: 'lighthouse', url: URL_DEMO, strategy: 'desktop', version_label: 'v3' } });
    expect(cuerpoMedir('http://demo.officialvanguard.com/', 'mobile', '')).toEqual({ errores: { url: 'Solo medimos URLs que empiezan por https://' } });
    expect(cuerpoMedir('', 'mobile', '')).toEqual({ errores: { url: 'Escribe la URL que quieres medir' } });
    expect(cuerpoMedir(URL_DEMO, 'mobile', 'v 3')).toEqual({ errores: { version_label: 'Hasta 40 letras, números, «.», «_» o «-»' } });
  });

  it('POST a /scans con ese cuerpo exacto y, con el 202, a /o/:org/audit/:id; el histórico queda para releerse', async () => {
    api.mockReset();
    api.mockResolvedValueOnce({ scan_run_id: SCAN });
    const qc = new QueryClient();
    qc.setQueryData(['org', ORG, 'perf'], RUNS);
    qc.setQueryData(['org', ORG, 'module', 'performance'], fx.moduleState.performance);
    const navegar = vi.fn();
    const body = { kind: 'lighthouse' as const, url: URL_DEMO, strategy: 'mobile' as const };
    expect(await medir(ORG, body, qc, navegar)).toEqual({ tipo: 'creada', ruta: `/o/${ORG}/audit/${SCAN}` });
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(`/api/orgs/${ORG}/scans`, { method: 'POST', body, esquema: ScanAccepted });
    expect(api.mock.calls[0]![1].body).toStrictEqual({ kind: 'lighthouse', url: URL_DEMO, strategy: 'mobile' });
    expect(navegar).toHaveBeenCalledWith(`/o/${ORG}/audit/${SCAN}`);
    expect(qc.getQueryState(['org', ORG, 'perf'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['org', ORG, 'module', 'performance'])?.isInvalidated).toBe(true);
  });

  it('un scan_run_id que no es uuid no entra en la ruta', async () => {
    api.mockReset();
    api.mockResolvedValueOnce({ scan_run_id: '../../me' });
    const navegar = vi.fn();
    const r = await medir(ORG, { kind: 'lighthouse', url: URL_DEMO, strategy: 'mobile' }, new QueryClient(), navegar);
    expect(r.tipo).toBe('aviso');
    expect(navegar).not.toHaveBeenCalled();
  });
});

const avisoDe = (r: ReturnType<typeof errorMedir>) => {
  if (r.tipo !== 'aviso') throw new Error(`se esperaba un aviso y llegó ${r.tipo}`);
  return r.aviso;
};

describe('Medir ahora · errores del servidor en su sitio', () => {
  const e = (status: number, code: string, message: string, details?: Record<string, unknown>, retryAfter?: number) =>
    new ApiError(status, code, message, 'req_1', details, retryAfter);

  it('422 not_available (el BACK de hoy): «La medición en vivo llega pronto», sin rojo; el botón sigue', () => {
    const r = errorMedir(e(422, 'invalid_body', 'Medir con Lighthouse llega en la siguiente versión', { reason: 'not_available' }));
    expect(r).toEqual({ tipo: 'aviso', aviso: { texto: 'La medición en vivo llega pronto', rol: 'info' } });
    const html = renderToStaticMarkup(<MemoryRouter><AvisoMedir org={ORG} aviso={avisoDe(r)} /></MemoryRouter>);
    expect(html).toContain('role="status"');
    expect(html).not.toContain(TEXTO_ROL.mal);
  });

  it('otro 422: bajo la URL, el message del servidor (con los controles bidi a la vista) o su field_errors', () => {
    const rlo = String.fromCodePoint(0x202e);
    // El UrlNoMedible de urlMedibleOrg: field_errors.url = [message] y su motivo en reason.
    const ip = 'No medimos direcciones IP: usa el dominio del sitio';
    expect(errorMedir(e(422, 'invalid_body', ip, { reason: 'ip', field_errors: { url: [ip] } }))).toEqual({ tipo: 'campo', errores: { url: ip } });
    expect(errorMedir(e(422, 'invalid_body', 'Esa URL es de VanGUARD: mide la de tu sitio', { reason: 'propio', field_errors: { url: ['Esa URL es de VanGUARD: mide la de tu sitio'] } })))
      .toEqual({ tipo: 'campo', errores: { url: 'Esa URL es de VanGUARD: mide la de tu sitio' } });
    // looks_like_secret no trae field_errors: el message, bajo la URL.
    expect(errorMedir(e(422, 'invalid_body', 'La petición trae algo que parece un secreto sin enmascarar', { reason: 'looks_like_secret' })))
      .toEqual({ tipo: 'campo', errores: { url: 'La petición trae algo que parece un secreto sin enmascarar' } });
    expect(errorMedir(e(422, 'invalid_body', `No medimos ${rlo}PI`))).toEqual({ tipo: 'campo', errores: { url: 'No medimos ⟨U+202E⟩PI' } });
    expect(errorMedir(e(422, 'invalid_body', 'Revisa los campos marcados', { field_errors: { url: [`solo ${rlo}https`] } })))
      .toEqual({ tipo: 'campo', errores: { url: 'solo ⟨U+202E⟩https' } });
    expect(errorMedir(e(422, 'invalid_body', 'Revisa los campos marcados', { field_errors: { version_label: ['Formato'] } })))
      .toEqual({ tipo: 'campo', errores: { version_label: 'Formato' } });
  });

  it('429: «Espera un minuto», o lo que diga Retry-After; el tope diario, con el mensaje del servidor', () => {
    const texto = (x: ApiError) => avisoDe(errorMedir(x)).texto;
    expect(texto(e(429, 'rate_limited', 'Demasiadas auditorías seguidas. Espera un minuto.'))).toBe('Espera un minuto');
    expect(texto(e(429, 'rate_limited', 'x', undefined, 60))).toBe('Espera un minuto');
    expect(texto(e(429, 'rate_limited', 'x', undefined, 30))).toBe('Espera 30 s');
    expect(texto(e(429, 'rate_limited', 'x', undefined, 150))).toBe('Espera 3 min');
    const tope = 'Ya hiciste 10 mediciones de rendimiento hoy, el máximo diario. Vuelve mañana.';
    expect(avisoDe(errorMedir(e(429, 'budget_exceeded', tope)))).toEqual({ texto: tope, rol: 'aviso' });
    const html = renderToStaticMarkup(<MemoryRouter><AvisoMedir org={ORG} aviso={avisoDe(errorMedir(e(429, 'budget_exceeded', tope)))} /></MemoryRouter>);
    expect(html).toContain(tope);
    expect(html).not.toContain(TEXTO_ROL.mal);
  });

  it('409: «Ya hay una medición en curso: espera a que termine para medir la otra», neutro, con enlace si llega su uuid', () => {
    const PERF_EN_CURSO = 'Ya hay una medición de rendimiento en curso: espera a que termine';
    expect(EN_CURSO).toBe('Ya hay una medición en curso: espera a que termine para medir la otra');
    const r = errorMedir(e(409, 'conflict', PERF_EN_CURSO, { scan_run_id: SCAN }));
    expect(r).toEqual({ tipo: 'aviso', aviso: { texto: EN_CURSO, rol: 'info', enCurso: SCAN } });
    const html = renderToStaticMarkup(<MemoryRouter><AvisoMedir org={ORG} aviso={avisoDe(r)} /></MemoryRouter>);
    expect(html).toContain(`href="/o/${ORG}/audit/${SCAN}"`);
    expect(html).toContain('Ver la medición');
    expect(html).toContain('role="status"');
    expect(html).not.toContain(TEXTO_ROL.mal);
    // Sin details (el 23505 del índice 0019) o con un id que no es uuid: el mismo aviso, sin enlace, nunca en rojo.
    for (const d of [undefined, { scan_run_id: '../../me' }]) {
      const a = avisoDe(errorMedir(e(409, 'conflict', PERF_EN_CURSO, d)));
      expect(a).toEqual({ texto: EN_CURSO, rol: 'info' });
      const h = renderToStaticMarkup(<MemoryRouter><AvisoMedir org={ORG} aviso={a} /></MemoryRouter>);
      expect(h).not.toContain('href=');
      expect(h).not.toContain(TEXTO_ROL.mal);
    }
  });
});

describe('Medir ahora · bandera por 404', () => {
  it('E24 (perf/runs) en 404: no se pinta', () => {
    const html = pintar(<PaginaRendimiento />, { datos: conRuns(undefined).slice(0, 2), error: [['org', ORG, 'perf'], new ApiError(404, 'not_found', 'Ruta inexistente')] });
    expect(html).toContain('Puntaje móvil');
    expect(html).not.toContain('aria-labelledby="t-medir"');
  });

  it('E11 en 404: medir() lo dice y desde entonces no se pinta nada en esa org', async () => {
    const otra: OrgActual = { ...ADMIN, id: 'f1000000-0000-4000-8000-000000000404' };
    expect(pintar(<MedirAhora />, { org: otra, datos: conRuns(RUNS, otra) })).toContain('Medir ahora');
    api.mockReset();
    api.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Ruta inexistente'));
    const navegar = vi.fn();
    expect(await medir(otra.id, { kind: 'lighthouse', url: URL_DEMO, strategy: 'mobile' }, new QueryClient(), navegar)).toEqual({ tipo: 'oculto' });
    expect(navegar).not.toHaveBeenCalled();
    expect(pintar(<MedirAhora />, { org: otra, datos: conRuns(RUNS, otra) })).toBe('');
    expect(pintar(<MedirAhora />, { datos: conRuns(RUNS) })).toContain('Medir ahora');   // las demás orgs, igual
  });
});

describe('Auditoría de una medición (kind lighthouse)', () => {
  const run = (o: Partial<ScanRun>): ScanRun => ({
    id: SCAN, kind: 'lighthouse', status: 'running', progress: 40, step: 'psi', steps: [{ name: 'psi', status: 'running' }],
    score: null, coverage: null, summary: null, error: null, created_at: '2026-10-25T12:00:00.000Z', started_at: '2026-10-25T12:00:00.000Z',
    finished_at: null, ...o });
  const ver = (r: ScanRun) => pintar(<PaginaAuditoria />, { ruta: `/o/${ORG}/audit/${SCAN}`, patron: '/o/:orgId/audit/:scanId',
    datos: [[['org', ORG, 'scan', SCAN], r], [['org', ORG, 'findings', { status: 'open' }], fx.findings]] });

  it('en curso: su título, el paso de rendimiento y lo que tarda de verdad (una pasada, sin «3 repeticiones»)', () => {
    const html = ver(run({}));
    expect(html).toContain('Medición de rendimiento');
    expect(html).toContain('Paso actual: midiendo con PageSpeed Insights (suele tardar menos de un minuto)');
    expect(html).not.toMatch(/repetici|~1 min/);
    expect(html).toContain('Lighthouse con PageSpeed Insights');
    expect(html).toContain('aria-label="Progreso de la medición"');
  });

  it('terminada: lleva a Rendimiento, sin resumen de IA y solo con los hallazgos de Rendimiento', () => {
    const html = ver(run({ status: 'succeeded', progress: 100, step: null, steps: [{ name: 'psi', status: 'done' }], finished_at: '2026-10-25T12:01:00.000Z' }));
    expect(html).toContain('Medición terminada');
    expect(html).toContain(`href="/o/${ORG}/performance"`);
    expect(html).not.toContain('Resumen con IA');
    for (const f of fx.findings as { id: string; module: string }[]) if (f.module !== 'performance') expect(html).not.toContain(`?finding=${f.id}`);
  });

  it('fallida: su error y «Volver a Rendimiento», nunca «Reintentar auditoría» (lanzaría un full_audit)', () => {
    const html = ver(run({ status: 'failed', step: null, steps: [{ name: 'psi', status: 'failed' }], error: 'La página no cargó para Lighthouse (NO_FCP)' }));
    expect(html).toContain('La página no cargó para Lighthouse (NO_FCP)');
    expect(html).toContain('Volver a Rendimiento');
    expect(html).not.toContain('Reintentar auditoría');
    expect(ver(run({ status: 'failed', step: null, error: null }))).toContain('La medición falló');
  });
});

describe('Auditoría de una medición · sondeo', () => {
  // refetchInterval es una función de la consulta: se evalúa como haría QueryObserver (igual que idor.test.tsx).
  function intervalo(datos: Partial<ScanRun>) {
    const qc = new QueryClient();
    qc.setQueryData(['org', ORG, 'scan', SCAN], { ...fx.scanRunning, id: SCAN, ...datos });
    const Sonda = () => { useScan(ORG, SCAN); return null; };
    renderToStaticMarkup(<QueryClientProvider client={qc}><Sonda /></QueryClientProvider>);
    const q = qc.getQueryCache().find({ queryKey: ['org', ORG, 'scan', SCAN], exact: true })!;
    return ((q.options as { refetchInterval: (q: Query) => number | false }).refetchInterval)(q);
  }
  it('una medición en curso se mira cada 2 s; una auditoría, cada 10 s; terminada, nada', () => {
    expect(intervalo({ kind: 'lighthouse', status: 'running' })).toBe(2_000);
    expect(intervalo({ kind: 'full_audit', status: 'running' })).toBe(10_000);
    expect(intervalo({ kind: 'lighthouse', status: 'succeeded' })).toBe(false);
  });
});

// Verificación adversarial: lo que llega del servidor con controles bidi o «<script>» nunca sale crudo; el viewer no ve
// la sección; con E24 en 404 la pantalla es la de antes; y la forma del BACK (step = 'psi', error_code 'runtime_error')
// se lee en español.
describe('Medir ahora · verificación', () => {
  const RLO = String.fromCodePoint(0x202e);
  const CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
  const SCRIPT = '<script>alert(1)</script>';
  const limpio = (html: string) => {
    expect(html).not.toMatch(CONTROL);
    expect(html).not.toContain('<script');
  };

  it('URLs y etiquetas de E24 con bidi o <script>: la medible va escapada, la de controles ni sale, la etiqueta mala no se prellena', () => {
    const conScript = { ...RUNS[0]!, id: RUNS[0]!.id.replace(/.$/, 'e'), url: `https://demo.officialvanguard.com/${SCRIPT}`,
      version_label: `v9${RLO}`, created_at: '2026-10-25T01:00:00.000Z' };
    const conBidi = { ...RUNS[0]!, id: RUNS[0]!.id.replace(/.$/, 'd'), url: `https://demo.officialvanguard.com/${RLO}gpj.x`,
      created_at: '2026-10-25T02:00:00.000Z' };
    const html = pintar(<PaginaRendimiento />, { datos: conRuns([conBidi, conScript, ...RUNS]) });
    limpio(html);
    expect(html).toContain('value="https://demo.officialvanguard.com/&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).not.toContain('gpj.x"');
    expect(html).toMatch(/placeholder="v3" value=""/);
  });

  it('mensajes y field_errors del servidor con bidi o <script>: se ven escapados, sin controles crudos', () => {
    const m = `${SCRIPT} ${RLO}moc.live`;
    for (const err of [new ApiError(409, 'conflict', m), new ApiError(429, 'budget_exceeded', m), new ApiError(403, 'forbidden', m)]) {
      limpio(renderToStaticMarkup(<MemoryRouter><AvisoMedir org={ORG} aviso={avisoDe(errorMedir(err))} /></MemoryRouter>));
    }
    const campo = errorMedir(new ApiError(422, 'invalid_body', 'x', undefined, { field_errors: { url: [m] } }));
    expect(campo.tipo === 'campo' && campo.errores.url).toBe(`${SCRIPT} ⟨U+202E⟩moc.live`);
  });

  it('auditoría de una medición con step y error del servidor con bidi o <script>: nada crudo', () => {
    const run = { ...fx.scanRunning, id: SCAN, kind: 'lighthouse' as const, step: `psi${RLO}${SCRIPT}`, steps: [{ name: 'psi' as const, status: 'running' as const }],
      score: null, coverage: null, summary: null };
    const ver = (r: ScanRun) => pintar(<PaginaAuditoria />, { ruta: `/o/${ORG}/audit/${SCAN}`, patron: '/o/:orgId/audit/:scanId',
      datos: [[['org', ORG, 'scan', SCAN], r], [['org', ORG, 'findings', { status: 'open' }], []]] });
    limpio(ver(run));
    limpio(ver({ ...run, status: 'failed', step: null, error: `${SCRIPT}${RLO}PCF_ON` }));
    expect(ver({ ...run, status: 'failed', step: null, error: `${SCRIPT}${RLO}PCF_ON` })).toContain('⟨U+202E⟩PCF_ON');
  });

  it('viewer de la demo: la sección no se pinta (ni campos, ni botón, ni sugerencias, ni enlaces)', () => {
    const html = pintar(<MedirAhora />, { org: VIEWER, datos: conRuns([...RUNS, { ...RUNS[0]!, id: RUNS[0]!.id.replace(/.$/, 'c'), url: 'https://www.officialvanguard.com/precios' }], VIEWER) });
    expect(html).toBe('');
  });

  it('E24 en 404: Rendimiento queda igual que la pantalla genérica, sin la sección ni un hueco', () => {
    const o = { datos: conRuns(undefined).slice(0, 2), error: [['org', ORG, 'perf'], new ApiError(404, 'not_found', 'Ruta inexistente')] as [QueryKey, ApiError] };
    expect(pintar(<PaginaRendimiento />, o)).toBe(pintar(<PantallaModulo modulo="performance" proveedor={null} />, o));
  });

  it('el BACK de hoy: step «psi» se lee como medición y un runtime_error no sale como «Hecho» en verde', () => {
    const base = { ...fx.scanRunning, id: SCAN, kind: 'lighthouse' as const, score: null, coverage: null, summary: null };
    const ver = (r: ScanRun) => pintar(<PaginaAuditoria />, { ruta: `/o/${ORG}/audit/${SCAN}`, patron: '/o/:orgId/audit/:scanId',
      datos: [[['org', ORG, 'scan', SCAN], r], [['org', ORG, 'findings', { status: 'open' }], []]] });
    const corriendo = ver({ ...base, status: 'running', step: 'psi', steps: [{ name: 'psi', status: 'running' }] });
    expect(corriendo).toContain('Paso actual: midiendo con PageSpeed Insights (suele tardar menos de un minuto)');
    const sinCifras = ver({ ...base, status: 'succeeded', progress: 100, step: null, finished_at: '2026-10-25T12:01:00.000Z',
      steps: [{ name: 'psi', status: 'done', error_code: 'runtime_error' }] });
    expect(sinCifras).toContain('Hecho en parte');
    expect(sinCifras).toContain('Lighthouse no pudo cargar la página: esta medición quedó sin cifras');
    expect(ver({ ...fx.scanRunning, id: SCAN, step: 'psi', status: 'running' })).toContain('Paso actual: Rendimiento');   // full_audit, igual que antes
  });
});
