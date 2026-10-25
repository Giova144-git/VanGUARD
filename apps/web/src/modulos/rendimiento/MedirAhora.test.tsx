// «Medir ahora» (F-17): quién puede medir, la URL por defecto, el cuerpo exacto de E11 y la navegación, los cuatro errores
// del servidor en su sitio y la bandera por 404. Sin jsdom: renderToStaticMarkup con la caché a mano y api() mockeada.
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, type Query, type QueryKey } from '@tanstack/react-query';
import { fixtures as fx, ScanAccepted, type PerfRunExt, type ScanRun } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { useScan } from '@/lib/consultas';
import { ApiError } from '@/lib/errores';
import { TEXTO_ROL } from '@/lib/severidad';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import { AvisoMedir, MedirAhora } from './MedirAhora';
import { cuerpoMedir, errorMedir, etiquetaPrevia, medir, urlsConocidas } from './medir';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/componentes/vg/GraficaComparativa', () => ({ GraficaComparativa: () => null }));
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api }));
const { default: PaginaRendimiento } = await import('./PaginaRendimiento');

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', me: fx.meViewer, puedeEscribir: false };
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

  it('viewer y anónimo de la demo: deshabilitado con «Solo un admin puede medir. Estás viendo la demo.»', () => {
    const html = pintar(<PaginaRendimiento />, { org: VIEWER, datos: conRuns(RUNS, VIEWER) });
    expect(botonMedir(html)).toContain('disabled=""');
    expect(html).toContain('Solo un admin puede medir. Estás viendo la demo.');
  });

  it('un admin de una org sin la demo, sin mediciones: «Medir ahora» sigue arriba de «Aún no medimos tu web»', () => {
    const vacio = { ...fx.moduleState.performance, cifras: fx.moduleState.performance.cifras.map((c) => ({ ...c, n: null })) };
    const html = pintar(<PaginaRendimiento />, { datos: [...conRuns([]).slice(1), [['org', ORG, 'module', 'performance'], vacio]] });
    expect(html).toContain('Aún no medimos tu web');
    expect(html.indexOf('Medir ahora')).toBeLessThan(html.indexOf('Aún no medimos tu web'));
    expect(html).toContain('value=""');
  });

  it('sin zona de Cloudflare activa: lo dice y el admin tiene «Conectar Cloudflare»; el viewer, solo el texto', () => {
    const sinCf = (fx.connections as { provider: string }[]).filter((c) => c.provider !== 'cloudflare');
    const datos = (org: OrgActual): [QueryKey, unknown][] => [...conRuns(RUNS, org).filter(([k]) => k[2] !== 'connections'), [['org', org.id, 'connections'], sinCf]];
    const admin = pintar(<MedirAhora />, { datos: datos(ADMIN) });
    expect(admin).toContain('Para medir necesitamos saber que el dominio es tuyo: conecta tu zona de Cloudflare.');
    expect(admin).toContain(`href="/o/${ORG}/connections/cloudflare"`);
    expect(botonMedir(admin)).not.toContain('disabled=""');                       // quien decide es el servidor
    const viewer = pintar(<MedirAhora />, { org: VIEWER, datos: datos(VIEWER) });
    expect(viewer).toContain('conecta tu zona de Cloudflare');
    expect(viewer).not.toContain('/connections/cloudflare');
    expect(pintar(<MedirAhora />, { datos: conRuns(RUNS) })).not.toContain('conecta tu zona de Cloudflare');
  });

  it('varias URL conocidas: la más reciente por defecto y las demás a un toque; nunca una con controles bidi', () => {
    const otra = RUNS.map((r) => ({ ...r, id: r.id.replace(/.$/, 'f'), url: 'https://www.officialvanguard.com/precios', created_at: '2026-10-24T22:00:00.000Z' }));
    const bidi = { ...RUNS[0]!, url: `https://demo.officialvanguard.com/${String.fromCodePoint(0x202e)}x`, created_at: '2026-10-25T00:00:00.000Z' };
    expect(urlsConocidas([bidi, ...RUNS, ...otra])).toEqual(['https://www.officialvanguard.com/precios', URL_DEMO]);
    expect(urlsConocidas([{ ...RUNS[0]!, url: 'http://demo.officialvanguard.com/' }, 'x', null])).toEqual([]);
    expect(urlsConocidas({ no: 'lista' })).toEqual([]);
    const html = pintar(<PaginaRendimiento />, { datos: conRuns([...RUNS, ...otra]) });
    expect(html).toContain('value="https://www.officialvanguard.com/precios"');
    expect(html).toContain('aria-label="URL ya medidas"');
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
    expect(errorMedir(e(422, 'invalid_body', `Solo dominios de tus zonas: ${rlo}moc.x`))).toEqual({ tipo: 'campo', errores: { url: 'Solo dominios de tus zonas: ⟨U+202E⟩moc.x' } });
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
    expect(texto(e(429, 'budget_exceeded', 'Ya hiciste 10 mediciones hoy. Vuelve mañana.'))).toBe('Ya hiciste 10 mediciones hoy. Vuelve mañana.');
  });

  it('409 con scan_run_id: «Ya hay una medición en curso» con enlace a su auditoría; un id que no es uuid no se enlaza', () => {
    const r = errorMedir(e(409, 'conflict', 'Ya hay una auditoría de este tipo en curso', { scan_run_id: SCAN }));
    expect(r).toEqual({ tipo: 'aviso', aviso: { texto: 'Ya hay una medición en curso', rol: 'info', enCurso: SCAN } });
    const html = renderToStaticMarkup(<MemoryRouter><AvisoMedir org={ORG} aviso={avisoDe(r)} /></MemoryRouter>);
    expect(html).toContain(`href="/o/${ORG}/audit/${SCAN}"`);
    expect(errorMedir(e(409, 'conflict', 'Hay un modo bajo ataque activo', { scan_run_id: '../../me' })))
      .toEqual({ tipo: 'aviso', aviso: { texto: 'Hay un modo bajo ataque activo', rol: 'mal' } });
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
    id: SCAN, kind: 'lighthouse', status: 'running', progress: 40, step: 'psi-mobile', steps: [{ name: 'psi', status: 'running' }],
    score: null, coverage: null, summary: null, error: null, created_at: '2026-10-25T12:00:00.000Z', started_at: '2026-10-25T12:00:00.000Z',
    finished_at: null, ...o });
  const ver = (r: ScanRun) => pintar(<PaginaAuditoria />, { ruta: `/o/${ORG}/audit/${SCAN}`, patron: '/o/:orgId/audit/:scanId',
    datos: [[['org', ORG, 'scan', SCAN], r], [['org', ORG, 'findings', { status: 'open' }], fx.findings]] });

  it('en curso: su título, el paso de rendimiento y «midiendo móvil (3 repeticiones)»', () => {
    const html = ver(run({}));
    expect(html).toContain('Medición de rendimiento');
    expect(html).toContain('Paso actual: midiendo móvil (3 repeticiones)… ~1 min');
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
