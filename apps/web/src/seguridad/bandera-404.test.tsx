// Bandera por 404 de las cinco funciones juntas (integración del FRONT): con TODAS las rutas nuevas de lectura en 404
// (E24, E51, E52, E55; E53, E54 y E56 son escrituras que solo ofrecen esas tarjetas) y E45 con la forma de un BACK de
// antes (sin gate, delta ni la acción de WhatsApp), cada pantalla pinta lo mismo que sin esas consultas, sin títulos
// vacíos ni huecos, y nada de evolución, bloqueo, bajo ataque ni «Medir ahora».
// Cada función ya lo prueba sola; aquí van a la vez, en la misma caché. Sin jsdom: renderToStaticMarkup y caché a mano.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, CodeReviewState, ConnectionPublic, Finding, IncidentDetail, Overview } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { NOTA_FOTO_PUSH } from '@/lib/evolucion';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import { TarjetaRevisionCodigo } from '@/modulos/codebase/TarjetaRevisionCodigo';
import PaginaIncidente from '@/modulos/incidentes/PaginaIncidente';
import PaginaRendimiento from '@/modulos/rendimiento/PaginaRendimiento';
import PaginaResumen from '@/modulos/resumen/PaginaResumen';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/supabase-doble', () => ({ tipoSesionFalsa: () => 'correo' }));
// Nada sale a la red: lo que no está en la caché se queda en vuelo, sin datos ni error que pintar.
vi.mock('@/lib/api', () => ({ api: () => new Promise<never>(() => {}) }));
vi.mock('@/componentes/vg/GraficaComparativa', () => ({ GraficaComparativa: () => null }));

const ORG = fx.me.orgs[0]!.id;
const ID = fx.scanDone.id;
const INC = fx.incidentDetail.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', me: fx.meViewer, puedeEscribir: false };
const CONEXIONES = z.array(ConnectionPublic).parse(fx.connections);
const GH = CONEXIONES.find((c) => c.provider === 'github')!;
const OVERVIEW = Overview.parse({ ...fx.overview, last_scan: { id: ID, status: 'succeeded', finished_at: fx.scanDone.finished_at } });
const ABIERTOS = z.array(Finding).parse(fx.findings).filter((f) => f.status === 'open');

// Las consultas de las rutas nuevas que se pintan en estas pantallas, todas con el 404 de un BACK sin desplegar.
const NUEVAS: QueryKey[] = [
  ['org', ORG, 'scan', ID, 'delta'],        // E51 (evolución: Resumen y Auditoría)
  ['org', ORG, 'evolution', 30],            // E52 (evolución)
  ['org', ORG, 'under-attack', INC],        // E55 (modo bajo ataque)
  ['org', ORG, 'perf'],                     // E24 (Medir ahora)
];
const NO_DESPLEGADO = () => new ApiError(404, 'not_found', 'Ruta inexistente', 'req_bandera_404');

// E45 como lo daba el BACK de antes de 0015/0016 y del anexo de botones: sin gate, delta, whatsapp_action ni muted_until.
const E45_ANTES = CodeReviewState.parse(fx.codeReviewState);
for (const r of E45_ANTES.recent) { delete r.gate; delete r.delta; delete r.alert.whatsapp_action; delete r.alert.whatsapp_action_at; }
delete E45_ANTES.config?.gate; delete E45_ANTES.config?.muted_until;

function pintar(nodo: ReactNode, o: { ruta: string; patron: string; datos: [QueryKey, unknown][]; con404: boolean; org?: OrgActual }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  for (const [k, v] of o.datos) qc.setQueryData(k, v);
  if (o.con404) for (const k of NUEVAS) qc.getQueryCache().build(qc, { queryKey: k }).setState({ status: 'error', error: NO_DESPLEGADO(), fetchStatus: 'idle' });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[o.ruta]}>
      <OrgDePrueba org={o.org ?? ADMIN}><Routes><Route path={o.patron} element={nodo} /></Routes></OrgDePrueba>
    </MemoryRouter></QueryClientProvider>);
}

// Lo que pinta cualquiera de las funciones nuevas cuando su ruta existe.
const MEDIR = /Medir ahora/;
const NUEVO = [/Desde la auditoría anterior/, /Cambios desde la auditoría anterior/, /t-cambios/, /Ver evolución/, /bajo ataque/i,
  /t-medir/, MEDIR, /t-bloqueo-/, /VanGUARD” en GitHub/, /Silenciado hasta/, /desde WhatsApp/i, /req_bandera_404/];
function sinNada(html: string, excepto: RegExp[] = []) {
  expect(html.length).toBeGreaterThan(200);                  // la pantalla se pinta (no es un hueco)
  for (const x of NUEVO.filter((n) => !excepto.includes(n))) expect(html, String(x)).not.toMatch(x);
  expect(html).not.toContain(NOTA_FOTO_PUSH.slice(0, 30));
}

describe('bandera por 404 · las cinco funciones a la vez', () => {
  // Reloj quieto: «hace N min» y los cronómetros no cambian entre los dos renders que se comparan.
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-24T19:30:00.000Z')); });
  afterAll(() => { vi.useRealTimers(); });

  it('Resumen (admin y viewer): igual que sin E51 ni E52, sin «Desde la auditoría anterior»', () => {
    for (const org of [ADMIN, VIEWER]) {
      const o = { ruta: `/o/${ORG}/overview`, patron: '/o/:orgId/overview', org,
        datos: [[['org', ORG, 'overview'], OVERVIEW], [['org', ORG, 'connections'], CONEXIONES]] as [QueryKey, unknown][] };
      const html = pintar(<PaginaResumen />, { ...o, con404: true });
      expect(html).toBe(pintar(<PaginaResumen />, { ...o, con404: false }));
      sinNada(html);
    }
  });

  it('Auditoría terminada: igual que sin E51, sin «Cambios» ni la etiqueta «Nuevo»', () => {
    const o = { ruta: `/o/${ORG}/audit/${ID}`, patron: '/o/:orgId/audit/:scanId',
      datos: [[['org', ORG, 'scan', ID], fx.scanDone], [['org', ORG, 'findings', { status: 'open' }], ABIERTOS], [['org', ORG, 'overview'], OVERVIEW]] as [QueryKey, unknown][] };
    const html = pintar(<PaginaAuditoria />, { ...o, con404: true });
    expect(html).toBe(pintar(<PaginaAuditoria />, { ...o, con404: false }));
    expect(html).toContain('Hallazgos abiertos');
    expect(html).not.toMatch(/>Nuevo</);
    sinNada(html);
  });

  it('Incidente con inundación: igual que sin E55, sin la tarjeta de bajo ataque (Bloquear IP sigue)', () => {
    const o = { ruta: `/o/${ORG}/incidents/${INC}`, patron: '/o/:orgId/incidents/:incidentId',
      datos: [[['org', ORG, 'incident', INC], IncidentDetail.parse(fx.incidentDetail)], [['org', ORG, 'connections'], CONEXIONES]] as [QueryKey, unknown][] };
    const html = pintar(<PaginaIncidente />, { ...o, con404: true });
    expect(html).toBe(pintar(<PaginaIncidente />, { ...o, con404: false }));
    expect(html).toContain('Bloquear esta IP');
    sinNada(html);
  });

  // La guía del módulo (texto fijo de S10 §10.10) sí nombra «Medir ahora»: en producción E24 existe y la bandera no salta.
  it('Rendimiento: sin la sección «Medir ahora» ni su botón (solo la guía lo nombra)', () => {
    const html = pintar(<PaginaRendimiento />, { ruta: `/o/${ORG}/performance`, patron: '/o/:orgId/performance', con404: true,
      datos: [[['org', ORG, 'module', 'performance'], fx.moduleState.performance], [['org', ORG, 'connections'], CONEXIONES]] });
    sinNada(html, [MEDIR]);
    expect(html.match(/Medir ahora/g)).toHaveLength(1);
    expect(html).toMatch(/[Pp]ulsa «Medir ahora»/);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*Medir ahora/s);
  });

  it('Codebase, tarjeta de revisión con el E45 de antes (y la fila del push abierta): sin bloqueo, foto ni acción de WhatsApp', () => {
    const push = E45_ANTES.recent[0]!.id;
    for (const org of [ADMIN, VIEWER]) for (const ruta of [`/o/${ORG}/codebase`, `/o/${ORG}/codebase?revision=${push}`]) {
      const html = pintar(<TarjetaRevisionCodigo conexion={GH} />, { ruta, patron: '/o/:orgId/codebase', org, con404: true,
        datos: [[['org', ORG, 'revision', GH.id], E45_ANTES], [['org', ORG, 'alert-prefs'], fx.alertPrefs]] });
      expect(html).toContain('id="revision-codigo"');
      expect(html).not.toMatch(/role="tablist"/);           // un solo repo: sin pestañas (varias-codebases)
      sinNada(html);
    }
  });
});

// Una medición de «Medir ahora» (kind lighthouse) usa la pantalla de la auditoría, pero no es una auditoría: ni pide E51
// ni pinta «Cambios»; la comparación con la anterior está en Rendimiento.
describe('convivencia · medición y evolución en la auditoría', () => {
  const MED = 'c5000000-0000-4000-8000-0000000000c1';
  const CLAVE = ['org', ORG, 'scan', MED, 'delta'];
  it('una medición terminada no pide E51 ni pinta «Cambios», aunque la caché trajera una foto', () => {
    const run = { ...fx.scanDone, id: MED, kind: 'lighthouse' as const, score: null, coverage: null, summary: null,
      steps: [{ name: 'psi' as const, status: 'done' as const }] };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    qc.setQueryData(['org', ORG, 'scan', MED], run);
    qc.setQueryData(['org', ORG, 'findings', { status: 'open' }], ABIERTOS);
    qc.setQueryData(CLAVE, { ...fx.auditDelta, scan_run_id: MED });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}><MemoryRouter initialEntries={[`/o/${ORG}/audit/${MED}`]}>
        <OrgDePrueba org={ADMIN}><Routes><Route path="/o/:orgId/audit/:scanId" element={<PaginaAuditoria />} /></Routes></OrgDePrueba>
      </MemoryRouter></QueryClientProvider>);
    expect(html).toContain('Ver en Rendimiento');
    expect(html).not.toContain('t-cambios');
    expect(html).not.toMatch(/>Nuevo</);
    // La consulta de E51 que dejó el render está apagada: al montarse no pediría nada.
    expect(qc.getQueryCache().find({ queryKey: CLAVE, exact: true })?.options).toMatchObject({ enabled: false });
  });
});
