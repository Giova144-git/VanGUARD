// Controles bidi (Trojan Source, CVE-2021-42574) en los componentes de vg/: el texto del servidor (o de la URL) se pinta
// con sinBidi (lib/bidi.ts), así «src/lib/U+202E sj.nimda» se ve «src/lib/⟨U+202E⟩sj.nimda» y nunca el control crudo.
// Etiqueta y Cifra lo hacen por dentro, para que ningún llamador tenga que acordarse. Sin jsdom: renderToStaticMarkup,
// como PantallaModulo.test.tsx.
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic, EstadoModulo, type GrupoDato, type Module, type TimelineItem } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { Bandeja } from './Bandeja';
import { ChecksEnCero } from './ChecksEnCero';
import { Cifra } from './Cifra';
import { DiagramaWiki } from './DiagramaWiki';
import { Etiqueta } from './Etiqueta';
import { LineaTiempo } from './LineaTiempo';
import { ListaChecks } from './ListaChecks';
import { PantallaModulo } from './PantallaModulo';
import { PuntajeBlindaje } from './PuntajeBlindaje';
import { ErrorBloque } from './Vacio';

// supabase-js pide VITE_SUPABASE_URL al importarse; aquí no hay red ni sesión.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
// Plegado no se renderiza el cuerpo: aquí se abre siempre, como en src/seguridad/xss.test.tsx.
vi.mock('@/componentes/vg/SectorPlegable', () => ({
  SectorPlegable: ({ titulo, children }: { titulo: string; children: ReactNode }) => createElement('section', null, createElement('h3', null, titulo), children),
}));

const RLO = String.fromCodePoint(0x202e);
const VISTO = '⟨U+202E⟩';
const ORG = fx.me.orgs[0]!.id;
const ORG_ACTUAL: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const CONEXIONES = z.array(ConnectionPublic).parse(fx.connections);
type Estado = z.infer<typeof EstadoModulo>;

function conTodo(nodo: ReactNode, ruta = `/o/${ORG}/supabase`, datos: [unknown[], unknown][] = [], org: OrgActual = ORG_ACTUAL): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [k, v] of datos) qc.setQueryData(k, v);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}><OrgDePrueba org={org}>{nodo}</OrgDePrueba></MemoryRouter>
    </QueryClientProvider>,
  );
}
const sinCrudo = (html: string) => expect(html, 'un U+202E llegó crudo al HTML').not.toContain(RLO);

describe('vg · controles bidi a la vista', () => {
  it('Etiqueta: el texto pasa por sinBidi dentro del componente', () => {
    const html = renderToStaticMarkup(<Etiqueta texto={`abc${RLO}def`} />);
    sinCrudo(html);
    expect(html).toContain(`abc${VISTO}def`);
  });

  it('Cifra: etiqueta y sub pasan por sinBidi dentro del componente', () => {
    const html = renderToStaticMarkup(<Cifra etiqueta={`Hallazgos ${RLO}x`} n={3} sub={`lighthouse ${RLO}12`} />);
    sinCrudo(html);
    expect(html).toContain(`Hallazgos ${VISTO}x`);
    expect(html).toContain(`lighthouse ${VISTO}12`);
  });

  it('PantallaModulo: el ?filtro= de la URL se ve en <bdi dir="ltr"> y en el aria-label, sin el control crudo', () => {
    const filtro = `src/lib/${RLO}sj.nimda`;
    const html = conTodo(<PantallaModulo modulo="supabase" proveedor="supabase" />, `/o/${ORG}/supabase?filtro=${encodeURIComponent(filtro)}`,
      [[['org', ORG, 'module', 'supabase'], fx.moduleState.supabase], [['org', ORG, 'connections'], CONEXIONES]]);
    sinCrudo(html);
    expect(html).toContain(`<bdi dir="ltr">src/lib/${VISTO}sj.nimda</bdi>`);
    expect(html).toContain(`aria-label="Quitar filtro: src/lib/${VISTO}sj.nimda"`);
  });

  it('PantallaModulo: cifras y checks del estado del servidor salen con el control a la vista', () => {
    const base = fx.moduleState.supabase as Estado;
    const estado: Estado = { ...base,
      cifras: base.cifras.map((c, i) => (i === 0 ? { ...c, etiqueta: `Cifra ${RLO}a`, sub: `sub ${RLO}b` } : c)),
      checks: [{ nombre: `RLS ${RLO}c`, codigo: `SB_${RLO}d`, n: 0, comprobado: true }] };
    const html = conTodo(<PantallaModulo modulo="supabase" proveedor="supabase" />, `/o/${ORG}/supabase`,
      [[['org', ORG, 'module', 'supabase'], estado], [['org', ORG, 'connections'], CONEXIONES]]);
    sinCrudo(html);
    for (const s of [`Cifra ${VISTO}a`, `sub ${VISTO}b`, `RLS ${VISTO}c`, `title="SB_${VISTO}d"`]) expect(html).toContain(s);
  });

  it('Bandeja: aria-label del grupo, chapas, chips y el verbo de cada acción', () => {
    const grupos: GrupoDato[] = [{ grupo: 'g1', etiqueta: `Grupo ${RLO}x`, rol: 'mal', n: 1, chapas: [`chapa ${RLO}1`], filas: [{
      clave: 'f1', modulo: 'supabase', tipo: 't', rol: 'mal', etiqueta: 'Fila', chips: [`chip ${RLO}2`], acciones: [
        { verbo: `Ver ${RLO}3`, clase: 'navegar', destino: { modulo: 'findings' } },
        { verbo: `Prompt ${RLO}4`, clase: 'prompt', args: { finding_id: 'f-1' } },
        { verbo: `Copiar ${RLO}5`, clase: 'copiar', copiar: 'valor' },
        { verbo: `Bloquear ${RLO}6`, clase: 'confirmar', args: { kind: 'block_ip', incident_id: 'i-1' } },
      ] }] }];
    for (const puedeEscribir of [true, false]) {
      const html = conTodo(<Bandeja grupos={grupos} puedeEscribir={puedeEscribir} />);
      sinCrudo(html);
      // El verbo del prompt solo lo ve quien puede generarlo; el viewer ve «Ver detalle» (UX P1-9).
      for (const s of [`aria-label="Grupo ${VISTO}x"`, `chapa ${VISTO}1`, `chip ${VISTO}2`, `Ver ${VISTO}3`, puedeEscribir ? `Prompt ${VISTO}4` : 'Ver detalle', `Copiar ${VISTO}5`, `Bloquear ${VISTO}6`])
        expect(html, `${s} (puedeEscribir=${puedeEscribir})`).toContain(s);
    }
  });

  it('LineaTiempo: el label del resto de timeline[] y un kind fuera de contrato', () => {
    const resto: TimelineItem[] = [{ t: '2026-10-24T19:00:00.000Z', ms: 1200, kind: 'whatsapp_read', label: `Leído por +56 ${RLO}9` },
      { t: '2026-10-24T19:00:01.000Z', ms: 2400, kind: `zzz${RLO}` as TimelineItem['kind'] }];
    const html = renderToStaticMarkup(<LineaTiempo hitos={[]} resto={resto} />);
    sinCrudo(html);
    expect(html).toContain(`Leído por +56 ${VISTO}9`);
    expect(html).toContain(`zzz${VISTO}`);
  });

  it('DiagramaWiki: un Mermaid que no parsea cae a <pre dir="ltr"> con el control a la vista', () => {
    const html = renderToStaticMarkup(<DiagramaWiki fuente={`flowchart LR\nA[${RLO}exe.txt] --> B[Fin]`} />);
    sinCrudo(html);
    expect(html).toMatch(/^<pre dir="ltr"[^>]*>flowchart LR\n/);
    expect(html).toContain(`A[${VISTO}exe.txt]`);
  });

  it('ListaChecks: un permiso fuera de PERMISOS sale tal cual, con el control a la vista y en <bdi dir="ltr">', () => {
    const html = renderToStaticMarkup(<ListaChecks checks={[{ permission: `zone_${RLO}read`, ok: false }]} />);
    sinCrudo(html);
    expect(html.split(`<bdi dir="ltr">zone_${VISTO}read</bdi>`)).toHaveLength(3);   // el nombre y el «marcando «…»»
  });

  it('PuntajeBlindaje: un módulo fuera de contrato en «Falta» sale con el control a la vista', () => {
    const html = conTodo(<PuntajeBlindaje score={70} band="amber" enlaceConectar={`/o/${ORG}/connections`}
      coverage={{ seen: 2, total: 4, missing: ['supabase', `x${RLO}y` as Module] }} />);
    sinCrudo(html);
    expect(html).toContain(`Sin revisar: Supabase, x${VISTO}y`);
  });

  it('ErrorBloque: el mensaje y el request_id de un ApiError ya llegan saneados (lib/errores.ts), una sola vez', () => {
    const html = renderToStaticMarkup(<ErrorBloque error={new ApiError(500, 'internal', `Falló ${RLO}m`, `req_${RLO}1`)} />);
    sinCrudo(html);
    expect(html).toContain(`Falló ${VISTO}m`);
    expect(html).toContain(`· req_${VISTO}1`);
  });
});
