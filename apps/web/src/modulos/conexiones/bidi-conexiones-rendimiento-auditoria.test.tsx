// Controles bidi (Trojan Source, CVE-2021-42574) en Conexiones, Cloudflare, Rendimiento y Auditoría: un U+202E que llega
// del servidor se ve como «⟨U+202E⟩» (lib/bidi.ts) y el texto técnico va aislado en <bdi dir="ltr">. Sin jsdom:
// renderToStaticMarkup con la caché precargada, como src/modulos/codebase/AnalizarZip.test.tsx.
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { Database } from 'lucide-react';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic, ConnectionCreated, type ScanRun } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import PaginaCloudflare from '@/modulos/cloudflare/PaginaCloudflare';
import PaginaRendimiento from '@/modulos/rendimiento/PaginaRendimiento';
import { Resultado } from './Asistente';
import { TarjetaConexion, TarjetaIngesta } from './TarjetaConexion';

// supabase-js pide VITE_SUPABASE_URL al importarse; aquí no hay red ni sesión.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
// La gráfica del histórico es de componentes/vg (otra zona, con su propio arreglo): aquí solo cuenta lo que pinta la página.
vi.mock('@/componentes/vg/GraficaComparativa', () => ({ GraficaComparativa: () => null }));

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const CONEXIONES = z.array(ConnectionPublic).parse(fx.connections);
const RLO = String.fromCodePoint(0x202e);
const VISTO = '⟨U+202E⟩';
const con = (s: string) => `${s}${RLO}gnp.exe`;                     // «…exe.png» se leería al revés sin el arreglo
const visto = (s: string) => `${s}${VISTO}gnp.exe`;

function pintar(nodo: ReactNode, o: { ruta?: string; patron?: string; datos?: [QueryKey, unknown][] } = {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [k, v] of o.datos ?? []) qc.setQueryData(k, v);
  const ruta = o.ruta ?? `/o/${ORG}/connections`;
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}>
        <OrgDePrueba org={ADMIN}>
          {o.patron ? <Routes><Route path={o.patron} element={nodo} /></Routes> : nodo}
        </OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Ningún control crudo y, para cada valor técnico, el control a la vista dentro de <bdi dir="ltr">.
function revisar(html: string, libres: string[], tecnicos: string[]) {
  expect(html).not.toContain(RLO);
  for (const s of libres) expect(html).toContain(s);
  for (const s of tecnicos) expect(html).toContain(`<bdi dir="ltr">${s}</bdi>`);
}

describe('bidi · Conexiones', () => {
  it('TarjetaConexion y TarjetaIngesta: meta, last4, alcances y el nombre de la app', () => {
    const cx = CONEXIONES.map((c) => ({
      ...c,
      label: con(`app-${c.provider}-`),
      last4: `${RLO}z`,
      scopes: [...c.scopes, con('scope-')],
      meta: Object.fromEntries(Object.entries(c.meta).map(([k, v]) => [k, typeof v === 'string' ? con(`${k}-`) : v])),
    }));
    const html = pintar(<>
      <TarjetaConexion proveedor="supabase" conexiones={cx} descripcion="d" icono={Database} />
      <TarjetaConexion proveedor="cloudflare" conexiones={cx} descripcion="d" icono={Database} />
      <TarjetaConexion proveedor="github" conexiones={cx} descripcion="d" icono={Database} />
      <TarjetaIngesta conexiones={cx} />
    </>, { datos: [[['org', ORG, 'connections'], cx]] });
    revisar(html, [visto('app-ingest-'), visto('scope-')],
      [`${VISTO}z`, visto('project_ref-'), visto('project_name-'), visto('zone_name-'), visto('plan-'), visto('repo_full_name-'),
        visto('default_branch-'), visto('hostname-')]);
    // Cada valor en su <bdi>, con su rótulo fuera: un control no arrastra a «Rama:» ni al « · » de al lado.
    expect(html).toContain(`</bdi> · Rama: <bdi dir="ltr">${visto('default_branch-')}</bdi></p>`);
  });

  it('Resultado del asistente: ••••last4 a la vista y aislado', () => {
    const r = ConnectionCreated.parse({ connection: CONEXIONES[4]!, action_connection: null, checks: fx.permChecks, ingest_secret: null });
    const html = renderToStaticMarkup(<Resultado r={{ ...r, connection: { ...r.connection, last4: `a${RLO}b` } }} alTerminar={() => {}} />);
    revisar(html, [], [`a${VISTO}b`]);
  });
});

describe('bidi · Cloudflare', () => {
  it('«Tu zona»: el nombre de la zona en <bdi dir="ltr"> y el plan, con el control a la vista', () => {
    const cx = CONEXIONES.map((c) => (c.provider === 'cloudflare' && c.kind === 'read'
      ? { ...c, meta: { ...c.meta, zone_name: con('zona-'), plan: con('plan-') } } : c));
    const html = pintar(<PaginaCloudflare />, { ruta: `/o/${ORG}/cloudflare`, datos: [
      [['org', ORG, 'module', 'cloudflare'], fx.moduleState.cloudflare], [['org', ORG, 'traffic'], fx.traffic],
      [['org', ORG, 'connections'], cx], [['org', ORG, 'incidents', 'open'], fx.incidents]] });
    revisar(html, [`plan ${visto('plan-')}`], [visto('zona-')]);
  });
});

describe('bidi · Rendimiento', () => {
  const datos = (runs: unknown): [QueryKey, unknown][] => [
    [['org', ORG, 'module', 'performance'], fx.moduleState.performance], [['org', ORG, 'connections'], CONEXIONES], [['org', ORG, 'perf'], runs]];
  const envenenadas = (url: string, sufijo = '') => fx.perfRuns.map((r) => ({
    ...r, id: r.id + sufijo, run_group: r.run_group ? r.run_group + sufijo : r.run_group, url,
    version_label: r.version_label ? con(`${r.version_label}-`) : r.version_label, lighthouse_version: con('13.5.0-'),
  }));

  it('una URL: la URL, la versión y la de Lighthouse a la vista y en <bdi dir="ltr">', () => {
    const html = pintar(<PaginaRendimiento />, { ruta: `/o/${ORG}/performance`, datos: datos(envenenadas(con('https://web.test/'))) });
    revisar(html, [], [visto('https://web.test/'), visto('v1-sana-'), visto('v2-regresion-'), visto('13.5.0-')]);
  });

  it('dos URL: los botones del grupo «URL» con el control a la vista', () => {
    const runs = [...envenenadas(con('https://a.test/')), ...envenenadas(con('https://b.test/'), 'b')];
    const html = pintar(<PaginaRendimiento />, { ruta: `/o/${ORG}/performance`, datos: datos(runs) });
    revisar(html, [], [visto('a.test/'), visto('b.test/')]);
  });
});

describe('bidi · Auditoría', () => {
  it('resumen de la IA (párrafos, por_que, explicacion, modelo) y hallazgos abiertos (título y recurso)', () => {
    const hs = fx.findings.map((f, i) => ({ ...f, title: con(`titulo${i}-`), resource: con(`recurso${i}-`) }));
    const s = fx.scanDone.summary;
    const run = {
      ...fx.scanDone,
      summary: { ...s, resumen: `${con('parrafo1-')}\n${con('parrafo2-')}`, model: con('modelo-'),
        top: s.top.map((t) => ({ ...t, por_que: con('porque-') })), relaciones: s.relaciones.map((r) => ({ ...r, explicacion: con('explica-') })) },
    } as ScanRun;
    const top = hs.findIndex((f) => f.id === s.top[0]!.finding_id);
    const html = pintar(<PaginaAuditoria />, { ruta: `/o/${ORG}/audit/${run.id}`, patron: '/o/:orgId/audit/:scanId', datos: [
      [['org', ORG, 'scan', run.id], run], [['org', ORG, 'findings', { status: 'open' }], hs], [['org', ORG, 'overview'], fx.overview]] });
    revisar(html, [visto('parrafo1-'), visto('parrafo2-'), visto('porque-'), visto('explica-'), visto(`titulo${top}-`)],
      [visto('modelo-'), ...hs.map((_, i) => visto(`recurso${i}-`))]);
  });
});
