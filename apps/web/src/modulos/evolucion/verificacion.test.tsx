// Verificación adversarial de la evolución (asignaciones/evolucion-entre-revisiones.md §6 y §7): carga XSS y controles
// bidi en las cuatro listas de E51 y en E52 (fuera de contrato, como si api() la dejara pasar), enums con claves del
// prototipo, ids con «../» en los enlaces, solo lectura del viewer, un 404 que no deja huecos y el sondeo de E51.
// Sin jsdom: renderToStaticMarkup y caché a mano, como Cambios.test.tsx.
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, type Query, type QueryKey } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, AuditDelta, ConnectionPublic, Evolution, Finding, Overview, type DeltaItem, type DeltaLista } from '@vanguard/contracts';
import AppShell from '@/app/AppShell';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { useDeltaAuditoria } from '@/lib/consultas';
import { ApiError } from '@/lib/errores';
import { Cambios } from '@/modulos/auditoria/Cambios';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import PaginaResumen from '@/modulos/resumen/PaginaResumen';
import PaginaEvolucion from './PaginaEvolucion';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
// Plegadas no pintan su cuerpo: aquí todas abiertas, para revisar también Corregidos, Se mantienen e Ignorados.
vi.mock('@/componentes/vg/SectorPlegable', async () => {
  const { createElement } = await import('react');
  return { SectorPlegable: ({ titulo, children }: { titulo: string; children: ReactNode }) => createElement('section', null, createElement('h3', null, titulo), children) };
});

const ORG = fx.me.orgs[0]!.id;
const ID = fx.scanDone.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', me: fx.meViewer, puedeEscribir: false };
type ConFoto = Extract<AuditDelta, { available: true }>;
const DELTA = AuditDelta.parse(fx.auditDelta) as ConFoto;
const EVO = Evolution.parse(fx.evolution);
const CLAVE_DELTA = ['org', ORG, 'scan', ID, 'delta'];
const NO_DESPLEGADO = new ApiError(404, 'not_found', 'Ruta inexistente', 'req_evo_404');

const CARGA = '<script>alert(1)</script><img src=x onerror=alert(1)>‮exe.txt';
const ID_MALO = '../../me?x=1#y';
// Como escapa React el texto (escapeTextForBrowser).
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
const enBdiLtr = (html: string) => [...html.matchAll(/<bdi dir="ltr">([\s\S]*?)<\/bdi>/g)].map((m) => m[1]!);
const texto = (html: string) => html.replace(/<[^>]+>/g, '');

function sinPeligro(html: string) {
  for (const x of ['<script', '<img', '‮', 'javascript:']) expect(html, x).not.toContain(x);
  expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);                  // ningún atributo on*= (como texto escapado, sí)
  for (const h of hrefs(html)) expect(h, h).not.toMatch(/\.\.\/|\?x=1#y/);   // un id malo solo llega codificado
}

function pintar(nodo: ReactNode, o: { ruta: string; patron: string; datos?: [QueryKey, unknown][]; delta?: unknown; org?: OrgActual }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  for (const [k, v] of o.datos ?? []) qc.setQueryData(k, v);
  if (o.delta instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: CLAVE_DELTA }).setState({ status: 'error', error: o.delta, fetchStatus: 'idle' });
  else if (o.delta !== undefined) qc.setQueryData(CLAVE_DELTA, o.delta);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[o.ruta]}>
      <OrgDePrueba org={o.org ?? ADMIN}><Routes><Route path={o.patron} element={nodo} /></Routes></OrgDePrueba>
    </MemoryRouter></QueryClientProvider>);
}
const cambios = (delta: unknown, org?: OrgActual) => pintar(<Cambios scanId={ID} />, { ruta: `/o/${ORG}/audit/${ID}`, patron: '/o/:orgId/audit/:scanId', delta, org });
const evolucion = (evo: unknown, org?: OrgActual) =>
  pintar(<PaginaEvolucion />, { ruta: `/o/${ORG}/evolution`, patron: '/o/:orgId/evolution', datos: [[['org', ORG, 'evolution', 30], evo]], org });

// Cada fila de las cuatro listas con la carga en título y recurso (marcados con su sitio) y un id con «../».
const envenenar = (l: DeltaLista, k: string): DeltaLista => ({ ...l, items: l.items.map((i, n): DeltaItem =>
  ({ ...i, finding_id: `${ID_MALO}${k}${n}`, title: `${CARGA}⟦${k}${n}.title⟧`, resource: `src/${CARGA}⟦${k}${n}.resource⟧` })) });
const LISTAS = ['new', 'kept', 'fixed', 'ignored'] as const;
const DELTA_MALO = { ...DELTA, ...Object.fromEntries(LISTAS.map((k) => [k, envenenar(DELTA[k], k)])) } as ConFoto;

describe('verificación · XSS y bidi', () => {
  it('Cambios: título y recurso de las cuatro listas salen escapados, con los controles bidi a la vista y el recurso en <bdi dir="ltr">', () => {
    const html = cambios(DELTA_MALO);
    sinPeligro(html);
    const bdi = enBdiLtr(html);
    for (const k of LISTAS) DELTA_MALO[k].items.forEach((i) => {
      expect(html).toContain(esc(sinBidi(i.title)));
      expect(bdi).toContain(esc(sinBidi(i.resource)));
      expect(hrefs(html)).toContain(`/o/${ORG}/audit/${ID}?finding=${encodeURIComponent(i.finding_id)}`);
    });
  });

  it('Cambios: enums con claves del prototipo caen a su respaldo sin romper el render', () => {
    const raro = { ...DELTA.new.items[0]!, module: '__proto__', severity: 'constructor', status: 'toString', rule_id: 'valueOf' } as unknown as DeltaItem;
    const html = cambios({ ...DELTA, previous: { ...DELTA.previous!, kind: '__proto__' }, modules_seen: ['constructor'],
      new: { total: 1, items: [raro] }, fixed: { total: 1, items: [{ ...raro, status: '__proto__' }] } });
    sinPeligro(html);
    const t = texto(html);
    expect(t).toContain('(Auditoría)');                                  // tipoAuditoria con su respaldo
    expect(t).not.toMatch(/function|\[object|undefined|NaN/);
    expect(cambios({ available: false, scan_run_id: ID, reason: '__proto__' })).toContain('no hay cambios que mostrar');
  });

  it('Evolución: el commit corto (fuera de contrato), el tipo y los ids de E52 no inyectan nada y los enlaces van codificados', () => {
    const evo = { ...EVO, points: EVO.points.map((p, n) => ({ ...p, scan_run_id: `${ID_MALO}p${n}`, kind: '__proto__' })),
      reviews: EVO.reviews.map((r, n) => ({ ...r, review_id: `${ID_MALO}r${n}`, head_sha7: `${CARGA}⟦r${n}⟧` })),
      incidents: EVO.incidents.map((d) => ({ ...d, day: CARGA })) };
    const html = evolucion(evo);
    sinPeligro(html);
    for (const r of evo.reviews) {
      expect(enBdiLtr(html)).toContain(esc(sinBidi(r.head_sha7)));
      expect(hrefs(html)).toContain(`/o/${ORG}/codebase?revision=${encodeURIComponent(r.review_id)}`);
    }
    for (const p of evo.points) expect(hrefs(html)).toContain(`/o/${ORG}/audit/${encodeURIComponent(p.scan_run_id)}`);
    expect(texto(html)).toContain('Auditoría');
  });
});

describe('verificación · viewer y anónimo de la demo', () => {
  const soloLectura = (html: string) => {
    // Los únicos botones activos son filtros de la vista (aria-pressed) o leen sin escribir («Ver», «Ver todos»).
    for (const b of html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []) {
      if (/disabled=""/.test(b) || /aria-pressed=/.test(b)) continue;
      expect(texto(b), b).toMatch(/^(Ver|Ver todos \(\d+\))$/);
    }
    for (const h of hrefs(html)) expect(h, h).toMatch(new RegExp(`^(\\?finding=|/o/${ORG}/(audit|codebase|evolution)\\b)`));
    expect(html).not.toMatch(/webhook|vgi_|whsec_|sk_live_|ingest_secret/i);       // nada de URLs de webhook ni secretos
  };
  it('Evolución con datos, y vacía con «Auditar todo» apagado', () => {
    soloLectura(evolucion(EVO, VIEWER));
    const vacia = evolucion({ ...EVO, points: [], reviews: [], incidents: [] }, VIEWER);
    expect(vacia).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Auditar todo/);
    soloLectura(vacia);
  });
  it('Cambios: lo mismo que el admin, sin enlaces a Ajustes ni Conexiones', () => {
    const html = cambios(DELTA, VIEWER);
    expect(html).toBe(cambios(DELTA, ADMIN));
    soloLectura(html);
  });
});

describe('verificación · bandera por 404 (E51 sin desplegar)', () => {
  const OVERVIEW = Overview.parse({ ...fx.overview, last_scan: { id: ID, status: 'succeeded', finished_at: fx.scanDone.finished_at } });
  const resumen = (delta: unknown, org?: OrgActual) => pintar(<PaginaResumen />, { ruta: `/o/${ORG}/overview`, patron: '/o/:orgId/overview', delta, org,
    datos: [[['org', ORG, 'overview'], OVERVIEW], [['org', ORG, 'connections'], z.array(ConnectionPublic).parse(fx.connections)]] });
  const abiertos = z.array(Finding).parse(fx.findings).filter((f) => f.status === 'open');
  const auditoria = (delta: unknown) => pintar(<PaginaAuditoria />, { ruta: `/o/${ORG}/audit/${ID}`, patron: '/o/:orgId/audit/:scanId', delta,
    datos: [[['org', ORG, 'scan', ID], fx.scanDone], [['org', ORG, 'findings', { status: 'open' }], abiertos], [['org', ORG, 'overview'], OVERVIEW]] });

  it('Resumen y Auditoría con 404 o 500 pintan exactamente lo de antes de la función (sin títulos vacíos ni huecos)', () => {
    for (const org of [ADMIN, VIEWER]) {
      expect(resumen(NO_DESPLEGADO, org)).toBe(resumen(undefined, org));
      expect(resumen(new ApiError(500, 'internal', 'x', 'req_evo_500'), org)).toBe(resumen(undefined, org));
    }
    const antes = auditoria(undefined);
    expect(auditoria(NO_DESPLEGADO)).toBe(antes);
    expect(auditoria(new ApiError(500, 'internal', 'x', 'req_evo_500'))).toBe(antes);
    expect(antes).not.toContain('req_evo');
  });
});

describe('verificación · E51 se sondea solo con en_curso y nunca tras un 404', () => {
  function Sonda() { useDeltaAuditoria(ORG, ID, true); return null; }
  async function intervalo(datos?: AuditDelta, error?: ApiError) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (datos) qc.setQueryData(CLAVE_DELTA, datos);
    if (error) await qc.prefetchQuery({ queryKey: CLAVE_DELTA, queryFn: () => Promise.reject(error) });
    renderToStaticMarkup(<QueryClientProvider client={qc}><Sonda /></QueryClientProvider>);
    const q = qc.getQueryCache().find({ queryKey: CLAVE_DELTA, exact: true })!;
    return ((q.options as { refetchInterval?: unknown }).refetchInterval as (q: Query) => number | false)(q);
  }
  const EN_CURSO: AuditDelta = { available: false, scan_run_id: ID, reason: 'en_curso' };
  it('10 s con en_curso; nada con la foto, con sin_foto ni con un 404 aunque quede en_curso de antes', async () => {
    expect(await intervalo(EN_CURSO)).toBe(10_000);
    expect(await intervalo(DELTA)).toBe(false);
    expect(await intervalo({ ...EN_CURSO, reason: 'sin_foto' })).toBe(false);
    expect(await intervalo(EN_CURSO, NO_DESPLEGADO)).toBe(false);
  });
});

describe('verificación · diseño a 375 px y a 1280×720', () => {
  it('la chapa larga de una clave corregida puede partirse: no desborda la fila', () => {
    const clave = { ...DELTA.fixed.items[0]!, rule_id: 'CB_SECRET_STRIPE_LIVE', status: 'verified' as const };
    const html = cambios({ ...DELTA, fixed: { total: 1, items: [clave] } });
    expect(html).toMatch(/<span class="[^"]*\bmax-w-full\b[^"]*\bwhitespace-normal\b[^"]*">Ya no está en el código · rota la clave<\/span>/);
  });

  it('el riel, con Evolución tras Auditoría, se desplaza dentro de su columna (13 entradas no caben en 720 px)', () => {
    const html = pintar(<AppShell />, { ruta: `/o/${ORG}/overview`, patron: '/o/:orgId/*', datos: [[['org', ORG, 'overview'], fx.overview]] });
    expect(html).toMatch(/<aside class="[^"]*\bh-svh\b[^"]*\boverflow-y-auto\b/);
    const riel = texto(html.match(/<nav aria-label="Módulos"[\s\S]*?<\/nav>/)?.[0] ?? '');
    expect(riel).toMatch(/Auditoría.*Evolución.*Incidentes/);
  });
});
