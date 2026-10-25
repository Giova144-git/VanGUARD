// Bandera de la tarjeta de revisión en la PRIMERA carga (condición del ORQUESTADOR para subir por partes el bloqueo de
// merge, la foto de cada push y las acciones de WhatsApp). Las tres llegan dentro de E45 (config.gate, delta,
// whatsapp_action y muted_until): si E45 falla sin una lectura buena antes (404, 500, la red o una forma fuera de
// contrato), Codebase pinta EXACTAMENTE lo mismo que con el 404 de «aún sin desplegar»: ni ErrorBloque, ni un role="alert"
// de más, ni el título de la tarjeta o del bloqueo. Tras una lectura buena, un fallo deja lo último que hubo. Un 500 o la
// red de E53/E54 (escrituras) no apagan sus banderas: solo el 404. Sin jsdom: renderToStaticMarkup y la caché a mano, como
// TarjetaRevisionCodigo.test.tsx y pestanas.test.tsx.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { MutationObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, CodeReviewState, ConnectionPublic } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { opcionesAccionBloqueo, opcionesGuardarBloqueo } from '@/lib/mutaciones';
import PaginaCodebase from './PaginaCodebase';
import { TarjetaRevisionCodigo } from './TarjetaRevisionCodigo';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api }));

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', puedeEscribir: false };
const CX = z.array(ConnectionPublic).parse(fx.connections);
const GH = CX.find((c) => c.provider === 'github')!;
const GH2 = ConnectionPublic.parse(fx.conexionGithub2);
const ESTADO_2 = CodeReviewState.parse(fx.codeReviewStateRepo2);

// Las tres funciones a la vez: bloqueo encendido, foto en cada push, una acción desde WhatsApp y el repo silenciado.
const BLOQUEO = CodeReviewState.parse(fx.codeReviewStateBloqueo);
const TODO: CodeReviewState = {
  ...BLOQUEO,
  config: { ...BLOQUEO.config!, gate: { ...BLOQUEO.config!.gate!, close_pr: true, can_close_pr: true }, muted_until: '2099-01-01T00:00:00.000Z' },
  recent: BLOQUEO.recent.map((r) => ({ ...r, delta: fx.deltasRevision[r.id] ?? null,
    alert: { ...r.alert, whatsapp_action: 'fix_sent' as const, whatsapp_action_at: '2026-10-24T19:22:05.000Z' } })),
};
const PUSH = TODO.recent.find((r) => r.event === 'push' && r.delta)!;
const PR = TODO.recent.find((r) => r.event === 'pull_request' && r.gate?.state === 'failure')!;

// Lo que ve quien abre Codebase por primera vez con E45 caído. La forma fuera de contrato es la ZodError que lanza el
// parse del queryFn (lib/consultas.ts): con un campo de siempre y, mientras el contrato los tenga estrictos, con uno de
// las funciones nuevas (si el contrato los relaja, ese cuerpo ya pasa y el caso sobra).
const zodDe = (nombre: string, cuerpo: unknown): [string, Error][] => {
  const r = CodeReviewState.safeParse(cuerpo);
  return r.success ? [] : [[`una forma fuera de contrato ${nombre}`, r.error]];
};
const NO_DESPLEGADO = new ApiError(404, 'not_found', 'Ruta inexistente');
const FALLOS: [string, Error][] = [
  ['500', new ApiError(500, 'internal', 'Algo falló', 'req_tarjeta_500')],
  ['la red (ApiError 0, como lo modela lib/api.ts)', new ApiError(0, 'network', 'Sin conexión con VanGUARD')],
  ['la red (TypeError de fetch)', new TypeError('Failed to fetch')],
  ...zodDe('en lo de siempre', { ...TODO, available: 'si' }),
  ...zodDe('en config.gate', { ...TODO, config: { ...TODO.config!, gate: { ...TODO.config!.gate!, state: 'pausado' } } }),
  ...zodDe('en el delta de un push', { ...TODO, recent: [{ ...PUSH, delta: { ...PUSH.delta!, open: -1 } }] }),
];
const TEXTOS_DE_LA_FUNCION = ['Revisión automática de código', 'Bloquear merges con críticos', 'Check “VanGUARD”', 'siguen abiertos',
  'Arreglo enviado por WhatsApp', 'Silenciado hasta', 'Reintentar', 'req_tarjeta_500', 'Sin conexión con VanGUARD', 'Algo falló', 'no cumple el contrato'];

type Estado = CodeReviewState | { error: Error; data?: CodeReviewState } | 'cargando';
const clave = (id: string) => ['org', ORG, 'revision', id];
function poner(qc: QueryClient, id: string, e: Estado) {
  if (e === 'cargando') { qc.getQueryCache().build(qc, { queryKey: clave(id) }); return; }
  if ('error' in e) {
    qc.getQueryCache().build(qc, { queryKey: clave(id) }).setState({
      status: 'error', error: e.error, fetchStatus: 'idle', fetchFailureCount: 1,
      ...(e.data ? { data: e.data, dataUpdatedAt: Date.now() } : {}),
    });
    return;
  }
  qc.setQueryData(clave(id), e);
}
const nuevoQc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function pagina(conexiones: ConnectionPublic[], uno: Estado, { org = ADMIN, dos = ESTADO_2 as Estado, ruta = `/o/${ORG}/codebase` } = {}) {
  const qc = nuevoQc();
  qc.setQueryData(['org', ORG, 'module', 'codebase'], fx.moduleState.codebase);
  qc.setQueryData(['org', ORG, 'connections'], conexiones);
  qc.setQueryData(['org', ORG, 'alert-prefs'], fx.alertPrefs);
  poner(qc, GH.id, uno);
  poner(qc, GH2.id, dos);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}><OrgDePrueba org={org}><PaginaCodebase /></OrgDePrueba></MemoryRouter>
    </QueryClientProvider>,
  );
}
function tarjeta(estado: Estado, { org = ADMIN, qc = nuevoQc(), ruta = `/o/${ORG}/codebase` } = {}) {
  poner(qc, GH.id, estado);
  qc.setQueryData(['org', ORG, 'alert-prefs'], fx.alertPrefs);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}><OrgDePrueba org={org}><TarjetaRevisionCodigo conexion={GH} /></OrgDePrueba></MemoryRouter>
    </QueryClientProvider>,
  );
}
const alertas = (html: string) => html.split('role="alert"').length - 1;
// El texto de cada pestaña de repo (nombre y chapa), como pestanas.test.tsx.
const pestanas = (html: string) => [...html.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)]
  .map(([, txt]) => txt!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

describe('tarjeta de revisión · primera carga con E45 caído', () => {
  it('cargando (aún sin saber si la ruta existe) y con el 404: la tarjeta no se pinta', () => {
    expect(tarjeta('cargando')).toBe('');
    expect(tarjeta({ error: NO_DESPLEGADO })).toBe('');
  });

  for (const [nombre, error] of FALLOS) {
    it(`con ${nombre}: la tarjeta no se pinta, igual que con el 404`, () => {
      for (const org of [ADMIN, VIEWER]) expect(tarjeta({ error }, { org })).toBe('');
    });

    it(`con ${nombre}: Codebase con un repo da el mismo HTML que con el 404, sin ErrorBloque ni alertas de más`, () => {
      for (const org of [ADMIN, VIEWER]) {
        const antes = pagina(CX, { error: NO_DESPLEGADO }, { org });
        const html = pagina(CX, { error }, { org });
        expect(html).toBe(antes);
        expect(alertas(html)).toBe(alertas(pagina(CX, 'cargando', { org })));
        for (const t of TEXTOS_DE_LA_FUNCION) expect(html).not.toContain(t);
        expect(html).toContain('Analizar repo ahora');   // el resto de la página, como siempre
      }
    });

    it(`con ${nombre}: con dos repos, la pestaña elegida queda como con el 404 y su chapa en «—»`, () => {
      const antes = pagina([...CX, GH2], { error: NO_DESPLEGADO });
      const html = pagina([...CX, GH2], { error });
      expect(html).toBe(antes);
      expect(pestanas(html)).toEqual([`${GH.meta.repo_full_name} —`, `${GH2.meta.repo_full_name} Apagada`]);
      for (const t of TEXTOS_DE_LA_FUNCION) expect(html).not.toContain(t);
      // El otro repo, elegido, sigue con su tarjeta de siempre aunque el primero falle.
      expect(pagina([...CX, GH2], { error }, { ruta: `/o/${ORG}/codebase?repo=${GH2.id}` })).toContain('Revisión automática de código');
    });
  }
});

describe('tarjeta de revisión · un fallo DESPUÉS de una lectura buena', () => {
  for (const [nombre, error] of FALLOS) {
    it(`con ${nombre}: se queda lo último que hubo (bloqueo, foto y WhatsApp), sin ErrorBloque`, () => {
      for (const ruta of [`/o/${ORG}/codebase`, `/o/${ORG}/codebase?revision=${PR.id}`]) {
        const bien = tarjeta(TODO, { ruta });
        expect(tarjeta({ error, data: TODO }, { ruta })).toBe(bien);
        expect(bien).toContain('Bloquear merges con críticos');
        expect(bien).toContain('siguen abiertos');
        expect(bien).toContain('Arreglo enviado por WhatsApp');
        expect(bien).toContain('Silenciado hasta');
        expect(bien).not.toContain('req_tarjeta_500');
      }
    });
  }
});

// Las escrituras del bloqueo no corren en la primera carga, pero sus banderas viven en la caché: solo el 404 de «aún sin
// desplegar» retira la sección (E53) o los botones (E54). Un 500, la red o una respuesta fuera de contrato no tocan nada.
describe('bloqueo de merge · las banderas de E53 y E54 solo con el 404', () => {
  const abierta = `/o/${ORG}/codebase?revision=${PR.id}`;
  const fallosEscritura: [string, Error][] = [
    ['500', new ApiError(500, 'internal', 'Algo falló', 'req_tarjeta_500')],
    ['la red', new ApiError(0, 'network', 'Sin conexión con VanGUARD')],
    ['un TypeError', new TypeError('Failed to fetch')],
    ['un 200 fuera de contrato (api() en desarrollo)', new ApiError(200, 'contract_mismatch', 'La respuesta no cumple el contrato')],
  ];

  for (const [nombre, error] of fallosEscritura) {
    it(`E53 con ${nombre}: la sección sigue igual`, async () => {
      const qc = nuevoQc();
      api.mockRejectedValueOnce(error);
      await new MutationObserver(qc, opcionesGuardarBloqueo(ORG, GH.id, qc)).mutate({ enabled: true, min_severity: 'critical' }).catch(() => {});
      expect(tarjeta(TODO, { qc })).toBe(tarjeta(TODO));
    });

    it(`E54 con ${nombre}: la fila abierta sigue ofreciendo sus botones`, async () => {
      const qc = nuevoQc();
      api.mockRejectedValueOnce(error);
      await new MutationObserver(qc, opcionesAccionBloqueo(ORG, qc)).mutate({ id: PR.id, accion: { op: 'override', reason: 'prueba' } }).catch(() => {});
      const html = tarjeta(TODO, { qc, ruta: abierta });
      expect(html).toBe(tarjeta(TODO, { ruta: abierta }));
      expect(html).toContain('Dar por bueno este commit');
    });
  }

  it('E53 que responde 200 con un gate fuera de contrato (api() en producción no lo impone): E45 no se toca', async () => {
    const qc = nuevoQc();
    qc.setQueryData(clave(GH.id), TODO);
    api.mockResolvedValueOnce({ gate: { ...TODO.config!.gate!, state: 'pausado' }, probe_sha: null, probe_state: null, checks: [] });
    await new MutationObserver(qc, opcionesGuardarBloqueo(ORG, GH.id, qc)).mutate({ enabled: true, min_severity: 'critical' });
    expect(qc.getQueryData<CodeReviewState>(clave(GH.id))?.config?.gate).toEqual(TODO.config!.gate);
    expect(tarjeta(TODO, { qc })).toBe(tarjeta(TODO));
  });
});
