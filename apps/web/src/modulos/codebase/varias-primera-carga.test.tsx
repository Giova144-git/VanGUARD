// Varias codebases sube a producción por partes y la condición del ORQUESTADOR es que la bandera oculte también un 500,
// la red o una forma fuera de contrato en la PRIMERA carga, no solo el 404. Cada consulta nueva o cambiada que se pinta
// en una página que ya existía (E45 ?connection_id= de la tarjeta y de las chapas de las pestañas de Codebase, E43 ?repo=
// de cada fila de repos de la wiki) se pone a mano en error en la caché: la página da el MISMO HTML que con 404 (la
// función sin desplegar), sin ErrorBloque ni role="alert" de más ni el título de la función. Un fallo DESPUÉS de una
// lectura buena sigue mostrando lo último que hubo. retryOnMount: false deja la consulta como la ve la página ya montada
// cuando llega el error (sin él, un error sin datos se pinta como «cargando» y la prueba no prueba nada).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { MutationObserver, QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { fixtures as fx, CodeReviewState, ConnectionPublic, Finding, Overview, ScanRun, WikiDoc, WikiRun } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { opcionesGuardarRevision, tomarSecreto } from '@/lib/mutaciones';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import { DetalleHallazgo } from '@/modulos/hallazgos/DetalleHallazgo';
import PaginaResumen from '@/modulos/resumen/PaginaResumen';
import { wikiAnterior } from '@/modulos/wiki/texto';
import PaginaWiki from '@/modulos/wiki/PaginaWiki';
import PaginaCodebase from './PaginaCodebase';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api }));

// «probado hace N min» sale de Date.now(): con la hora quieta, dos pintadas del mismo estado dan el mismo HTML.
beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-25T09:00:00.000Z')); });
afterAll(() => { vi.useRealTimers(); });

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', puedeEscribir: false };
const CX = z.array(ConnectionPublic).parse(fx.connections);
const GH = CX.find((c) => c.provider === 'github')!;
const GH2 = ConnectionPublic.parse(fx.conexionGithub2);
const REPO = GH.meta.repo_full_name as string;
const REPO_2 = GH2.meta.repo_full_name as string;
const ESTADO_1 = CodeReviewState.parse(fx.codeReviewState);
const ESTADO_2 = CodeReviewState.parse(fx.codeReviewStateRepo2);
const RUNS = z.array(WikiRun).parse(fx.wikiRuns);
const LISTA = wikiAnterior(RUNS, { repo_full_name: REPO })!;

// 404 = la función aún sin desplegar: la referencia. Los demás, lo que puede llegar en la primera carga.
const NO_EXISTE = new ApiError(404, 'not_found', 'Ruta inexistente');
const ERRORES: [string, unknown][] = [
  ['500', new ApiError(500, 'internal', 'Algo falló', 'req_0123456789')],
  ['503 sin cuerpo', new ApiError(503, 'internal', 'Algo falló')],
  ['red (ApiError 0 de lib/api.ts)', new ApiError(0, 'network', 'Sin conexión con VanGUARD')],
  ['TypeError de fetch', new TypeError('Failed to fetch')],
  ['ZodError del parse del queryFn', CodeReviewState.safeParse({ available: 'sí', recent: 7 }).error],
  ['contract_mismatch de api() en desarrollo', new ApiError(200, 'contract_mismatch', 'La respuesta de /api/orgs/x no cumple el contrato')],
];

type Estado = { data: unknown } | { error: unknown } | { data: unknown; error: unknown };
function cliente(estados: [QueryKey, Estado][]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  for (const [k, e] of estados) {
    if ('error' in e) qc.getQueryCache().build(qc, { queryKey: k }).setState({ status: 'error', error: e.error as Error, fetchStatus: 'idle',
      ...('data' in e ? { data: e.data, dataUpdatedAt: Date.now() - 60_000 } : {}) });
    else qc.setQueryData(k, e.data);
  }
  return qc;
}
const pintar = (qc: QueryClient, nodo: ReactNode, ruta: string, patron: string, org: OrgActual = ADMIN) => renderToStaticMarkup(
  <QueryClientProvider client={qc}>
    <MemoryRouter initialEntries={[ruta]}><OrgDePrueba org={org}><Routes><Route path={patron} element={nodo} /></Routes></OrgDePrueba></MemoryRouter>
  </QueryClientProvider>,
);
// Lo que nunca puede aparecer en una página que ya existía por una función que falla o aún no existe. La caja roja de
// ErrorBloque por su clase (bg-mal-relleno a secas también lo llevan la chapa «Reconectar» y el contador de críticos).
const ERROR_BLOQUE = 'rounded-xl border border-mal-borde bg-mal-relleno px-4 py-3';
function sinRastro(html: string) {
  expect(html).not.toContain(ERROR_BLOQUE);
  expect(html).not.toContain('Reintentar');
  expect(html).not.toContain('Revisión automática de código');
  expect(html).not.toContain('Algo falló');
  expect(html).not.toContain('Sin conexión con VanGUARD');
  expect(html).not.toContain('req_0123456789');
}

describe('Codebase · E45 por conexión (?connection_id=) en la primera carga', () => {
  function codebase(conexiones: ConnectionPublic[], revisiones: [string, Estado][], ruta = `/o/${ORG}/codebase`, org: OrgActual = ADMIN) {
    const qc = cliente([
      [['org', ORG, 'module', 'codebase'], { data: fx.moduleState.codebase }],
      [['org', ORG, 'connections'], { data: conexiones }],
      [['org', ORG, 'alert-prefs'], { data: fx.alertPrefs }],
      ...revisiones.map(([id, e]): [QueryKey, Estado] => [['org', ORG, 'revision', id], e]),
    ]);
    return pintar(qc, <PaginaCodebase />, ruta, '/o/:orgId/codebase', org);
  }

  it('la referencia: con 404 la página de Codebase no promete la revisión, con uno y con dos repos', () => {
    const uno = codebase(CX, [[GH.id, { error: NO_EXISTE }]]);
    expect(uno).toContain('Analizar repo ahora');
    sinRastro(uno);
    const dos = codebase([...CX, GH2], [[GH.id, { error: NO_EXISTE }], [GH2.id, { error: NO_EXISTE }]]);
    expect(dos).toContain('role="tablist"');
    sinRastro(dos);
  });

  it.each(ERRORES)('un repo · %s: el mismo HTML que con 404', (_n, error) => {
    const html = codebase(CX, [[GH.id, { error }]]);
    expect(html).toBe(codebase(CX, [[GH.id, { error: NO_EXISTE }]]));
    sinRastro(html);
  });

  it.each(ERRORES)('un repo, viewer · %s: el mismo HTML que con 404', (_n, error) => {
    expect(codebase(CX, [[GH.id, { error }]], undefined, VIEWER)).toBe(codebase(CX, [[GH.id, { error: NO_EXISTE }]], undefined, VIEWER));
  });

  it.each(ERRORES)('dos repos · %s en los dos (tarjeta y chapas de las pestañas): el mismo HTML que con 404', (_n, error) => {
    for (const ruta of [`/o/${ORG}/codebase`, `/o/${ORG}/codebase?repo=${GH2.id}`, `/o/${ORG}/codebase?revision=${ESTADO_1.recent[0]!.id}`]) {
      const html = codebase([...CX, GH2], [[GH.id, { error }], [GH2.id, { error }]], ruta);
      expect(html).toBe(codebase([...CX, GH2], [[GH.id, { error: NO_EXISTE }], [GH2.id, { error: NO_EXISTE }]], ruta));
      sinRastro(html);
    }
  });

  it.each(ERRORES)('dos repos · %s solo en la pestaña elegida: su chapa «—» y sin tarjeta, como con 404; la otra intacta', (_n, error) => {
    const ruta = `/o/${ORG}/codebase?repo=${GH2.id}`;
    const html = codebase([...CX, GH2], [[GH.id, { data: ESTADO_1 }], [GH2.id, { error }]], ruta);
    expect(html).toBe(codebase([...CX, GH2], [[GH.id, { data: ESTADO_1 }], [GH2.id, { error: NO_EXISTE }]], ruta));
    expect(html).toContain('Activa');                                       // la chapa del repo que sí respondió
    expect(html).not.toContain('Revisión automática de código');
  });

  it.each(ERRORES)('dos repos · %s solo en la otra pestaña: la elegida pinta su tarjeta, la otra «—», como con 404', (_n, error) => {
    const html = codebase([...CX, GH2], [[GH.id, { data: ESTADO_1 }], [GH2.id, { error }]]);
    expect(html).toBe(codebase([...CX, GH2], [[GH.id, { data: ESTADO_1 }], [GH2.id, { error: NO_EXISTE }]]));
    expect(html.match(/Revisión automática de código/g)).toHaveLength(1);
    expect(html).not.toContain(ERROR_BLOQUE);
  });

  it('un fallo DESPUÉS de una lectura buena sigue mostrando lo último que hubo', () => {
    const html = codebase(CX, [[GH.id, { data: ESTADO_1, error: new ApiError(500, 'internal', 'Algo falló') }]]);
    expect(html).toContain('Revisión automática de código');
    expect(html).not.toContain(ERROR_BLOQUE);
    const dos = codebase([...CX, GH2], [[GH.id, { data: ESTADO_1, error: new ApiError(0, 'network', 'Sin conexión con VanGUARD') }],
      [GH2.id, { data: ESTADO_2, error: new ApiError(0, 'network', 'Sin conexión con VanGUARD') }]]);
    expect(dos).toContain('Activa');
    expect(dos).toContain('Apagada');
    expect(dos).not.toContain('Sin conexión con VanGUARD');
  });
});

describe('Wiki · E43 ?repo= de cada fila de repos en la primera carga', () => {
  function wiki(org: OrgActual, runs1: Estado, runs2: Estado, ruta = `/o/${ORG}/wiki`) {
    const qc = cliente([
      [['org', ORG, 'connections'], { data: [...CX, GH2] }],
      [['org', ORG, 'wiki', 'runs', REPO], runs1],
      [['org', ORG, 'wiki', 'runs', REPO_2], runs2],
      [['org', ORG, 'wiki', 'run', LISTA.id], { data: LISTA }],
      [['org', ORG, 'wiki', 'doc', LISTA.id], { data: WikiDoc.parse({ ...fx.wikiDoc, run_id: LISTA.id }) }],
    ]);
    return pintar(qc, <PaginaWiki />, ruta, '/o/:orgId/wiki', org);
  }
  const lista = (html: string) => html.match(/<ul[^>]*aria-label="Repos conectados"[\s\S]*?<\/ul>/)?.[0] ?? '';

  it.each(ERRORES)('%s en la fila de otro repo: el mismo HTML que con 404 y sin «No pudimos leer»', (_n, error) => {
    for (const org of [ADMIN, VIEWER]) {
      const html = wiki(org, { data: RUNS }, { error });
      expect(html).toBe(wiki(org, { data: RUNS }, { error: NO_EXISTE }));
      expect(html).not.toContain('No pudimos leer');
      expect(html).not.toContain(ERROR_BLOQUE);
      expect(html).toContain('Wiki lista');                               // la del repo que sí respondió
    }
  });

  it.each(ERRORES)('%s en la fila del repo elegido: la lista de repos es la misma que con 404 (el historial es el de siempre)', (_n, error) => {
    const html = wiki(VIEWER, { error }, { data: [] });
    expect(lista(html)).not.toBe('');
    expect(lista(html)).toBe(lista(wiki(VIEWER, { error: NO_EXISTE }, { data: [] })));
    expect(lista(html)).not.toContain('No pudimos leer');
  });

  it('un cuerpo fuera de contrato en la fila de otro repo (api() en producción lo deja pasar) no tumba la página', () => {
    for (const cuerpo of [{ runs: RUNS }, 'texto', [null, 7, 'x']]) {
      expect(() => wiki(VIEWER, { data: RUNS }, { data: cuerpo })).not.toThrow();
      const html = wiki(VIEWER, { data: RUNS }, { data: cuerpo });
      expect(html).toContain('aria-label="Wiki del repo"');               // la wiki del repo elegido se abre igual
      expect(html).not.toContain(ERROR_BLOQUE);
    }
  });

  it('un fallo DESPUÉS de una lectura buena sigue mostrando lo último que hubo', () => {
    const html = wiki(VIEWER, { data: RUNS }, { data: RUNS.map((r) => ({ ...r, repo_full_name: REPO_2 })), error: new ApiError(500, 'internal', 'Algo falló') });
    expect(lista(html).match(/Wiki lista/g)).toHaveLength(2);
  });

  // La última wiki lista se abre sola (F3) y pide E44 de esa corrida y de su documento sin que nadie lo haya pedido.
  function abierta(org: OrgActual, corrida: Estado | null, documento: Estado | null, ruta = `/o/${ORG}/wiki`) {
    const qc = cliente([
      [['org', ORG, 'connections'], { data: [...CX, GH2] }],
      [['org', ORG, 'wiki', 'runs', REPO], { data: RUNS }],
      [['org', ORG, 'wiki', 'runs', REPO_2], { data: [] }],
      ...(corrida ? [[['org', ORG, 'wiki', 'run', LISTA.id], corrida] as [QueryKey, Estado]] : []),
      ...(documento ? [[['org', ORG, 'wiki', 'doc', LISTA.id], documento] as [QueryKey, Estado]] : []),
    ]);
    return pintar(qc, <PaginaWiki />, ruta, '/o/:orgId/wiki', org);
  }

  it.each([['404', NO_EXISTE] as [string, unknown], ...ERRORES])('%s en E44 de la corrida que se abre sola: como si no se hubiera abierto', (_n, error) => {
    for (const org of [ADMIN, VIEWER]) {
      const html = abierta(org, { error }, null);
      expect(html).toBe(abierta(org, null, null));                       // E44 aún sin responder: no se pinta nada de la corrida
      expect(html).not.toContain(ERROR_BLOQUE);
      expect(html).not.toContain('Esta wiki no existe');
    }
  });

  it.each(ERRORES)('%s en el documento de la que se abre sola: el mismo HTML que con 404 y sin ErrorBloque', (_n, error) => {
    const html = abierta(VIEWER, { data: LISTA }, { error });
    expect(html).toBe(abierta(VIEWER, { data: LISTA }, { error: NO_EXISTE }));
    expect(html).not.toContain(ERROR_BLOQUE);
  });

  it('pedida por la URL (?run=), la wiki que falla sí lo dice, como antes de varias codebases', () => {
    const ruta = `/o/${ORG}/wiki?run=${LISTA.id}`;
    expect(abierta(VIEWER, { error: new ApiError(500, 'internal', 'Algo falló') }, null, ruta)).toContain(ERROR_BLOQUE);
    expect(abierta(VIEWER, { error: NO_EXISTE }, null, ruta)).toContain('Esta wiki no existe');
    expect(abierta(VIEWER, { data: LISTA }, { error: new ApiError(500, 'internal', 'Algo falló') }, ruta)).toContain(ERROR_BLOQUE);
  });
});

describe('E7 fuera de contrato en las páginas que ya existían (api() en producción deja pasar el cuerpo)', () => {
  // Una conexión sin `meta`: Resumen, auditoría y el detalle del hallazgo no leían meta antes de varias codebases.
  const SIN_META = [{ ...GH, meta: undefined }, { ...GH2, meta: null }] as unknown as ConnectionPublic[];
  const HALLAZGOS = z.array(Finding).parse(fx.findings);

  it('Resumen, auditoría y detalle del hallazgo no se caen y no pintan chip de repo', () => {
    const run = ScanRun.parse(fx.scanDone);
    const f = HALLAZGOS.find((x) => x.connection_id === GH.id)!;
    const casos: [ReactNode, string, string, [QueryKey, Estado][]][] = [
      [<PaginaResumen />, `/o/${ORG}/overview`, '/o/:orgId/overview', [[['org', ORG, 'overview'], { data: Overview.parse(fx.overview) }]]],
      [<PaginaAuditoria />, `/o/${ORG}/audit/${run.id}`, '/o/:orgId/audit/:scanId', [[['org', ORG, 'scan', run.id], { data: run }],
        [['org', ORG, 'findings', { status: 'open' }], { data: HALLAZGOS.filter((x) => x.status === 'open') }]]],
      [<DetalleHallazgo org={ORG} id={f.id} puedeEscribir />, `/o/${ORG}/findings/${f.id}`, '/o/:orgId/findings/:id', [[['org', ORG, 'finding', f.id], { data: f }]]],
    ];
    for (const [nodo, ruta, patron, datos] of casos) {
      const qc = () => cliente([[['org', ORG, 'connections'], { data: SIN_META }], ...datos]);
      expect(() => pintar(qc(), nodo, ruta, patron)).not.toThrow();
      expect(pintar(qc(), nodo, ruta, patron)).not.toContain(ERROR_BLOQUE);
    }
  });

  it.each(ERRORES)('E7 con %s en la primera carga: el Resumen sin chip de repo ni «N repos», igual que con 404', (_n, error) => {
    const o = Overview.parse({ ...fx.overview,
      ahora: fx.overview.ahora.map((a) => (a.kind === 'finding' ? { ...a, connection_id: GH.id } : a)) });
    const resumen = (e: unknown) => pintar(cliente([[['org', ORG, 'connections'], { error: e }], [['org', ORG, 'overview'], { data: o }]]),
      <PaginaResumen />, `/o/${ORG}/overview`, '/o/:orgId/overview');
    const html = resumen(error);
    expect(html).toBe(resumen(NO_EXISTE));
    expect(html).not.toContain('Repo: ');
    expect(html).not.toMatch(/\d repos/);
  });
});

describe('E46 (PUT de la revisión) fuera de contrato', () => {
  it('una respuesta sin config no hace fallar la mutación ni pierde el secreto: va por la conexión pedida', async () => {
    const secreto = `vgw_${'B'.repeat(43)}`;
    api.mockResolvedValueOnce({ webhook_secret: secreto });
    const qc = new QueryClient();
    qc.setQueryData(['org', ORG, 'revision', GH.id], ESTADO_1);
    await expect(new MutationObserver(qc, opcionesGuardarRevision(ORG, qc)).mutate({ connection_id: GH.id, enabled: true })).resolves.toBeTruthy();
    expect(tomarSecreto(ORG, GH.id)).toBe(secreto);
    expect(qc.getQueryData(['org', ORG, 'revision', GH.id])).toEqual(ESTADO_1);
  });
});
