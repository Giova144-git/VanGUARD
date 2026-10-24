// «Analizar un ZIP» (F-18) pintado con renderToStaticMarkup, sin jsdom, como PantallaModulo.test.tsx: dónde aparece la
// sección con y sin GitHub, el modo de solo lectura y la vista previa (L3, L5, L9 y controles bidi).
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic } from '@vanguard/contracts';
import { OrgDePrueba, SOLO_LECTURA, type OrgActual } from '@/app/guardas';
import { TINTE } from '@/lib/severidad';
import { VistaPrevia } from './AnalizarZip';
import PaginaCodebase from './PaginaCodebase';
import type { Analisis } from './zip/tipos';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const CONEXIONES = z.array(ConnectionPublic).parse(fx.connections);
const RLO = String.fromCodePoint(0x202e);
const TEXTO_FIJO = 'Tu código nunca sale de tu navegador: abrimos el ZIP aquí, en tu equipo, y solo nos llega la lista de '
  + 'dependencias y los secretos encontrados, ya tapados.';

function pagina(conexiones: ConnectionPublic[], org: OrgActual = ADMIN): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['org', ORG, 'module', 'codebase'], fx.moduleState.codebase);
  qc.setQueryData(['org', ORG, 'connections'], conexiones);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/o/${ORG}/codebase`]}>
        <OrgDePrueba org={org}><PaginaCodebase /></OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const cuenta = (html: string, s: string) => html.split(s).length - 1;

describe('PaginaCodebase · Analizar un ZIP', () => {
  it('con GitHub, una sola sección junto a «Repositorio», con el texto fijo y el input de .zip', () => {
    const html = pagina(CONEXIONES);
    expect(html).toContain('>Repositorio<');
    expect(cuenta(html, '>Analizar un ZIP</h3>')).toBe(1);
    expect(html).not.toContain('O analiza un ZIP en tu navegador');
    expect(html).toContain(TEXTO_FIJO);
    expect(cuenta(html, 'type="file"')).toBe(1);
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="\.zip,application\/zip"/);
    expect(html).toContain('Arrastra aquí el ZIP de tu proyecto o elígelo');
  });

  it('sin GitHub, el vacío «Conecta GitHub…» y debajo «O analiza un ZIP en tu navegador», una sola vez', () => {
    const html = pagina(CONEXIONES.filter((c) => c.provider !== 'github'));
    expect(html).toContain('Conecta GitHub para ver este módulo');
    expect(cuenta(html, 'O analiza un ZIP en tu navegador')).toBe(1);
    expect(html).not.toContain('>Analizar un ZIP</h3>');
    expect(cuenta(html, 'type="file"')).toBe(1);
  });

  it('en solo lectura no hay input y el botón dice por qué está apagado', () => {
    const html = pagina(CONEXIONES, { ...ADMIN, puedeEscribir: false });
    expect(html).not.toContain('type="file"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Analizar un ZIP<\/button>/);
    expect(html).toContain(SOLO_LECTURA);
  });
});

const ANALISIS: Analisis = {
  resultado: {
    files_seen: 1234,
    deps: [{ ecosystem: 'npm', name: 'react', version: '19.3.1', dev: false }, { ecosystem: 'Packagist', name: 'laravel/framework', version: '10.0.0', dev: true }],
    findings: [
      { rule_id: 'CB_SECRET_AWS', severity: 'critical', title: 'Clave de AWS en src/a.ts', resource: 'src/a.ts:3',
        evidence: { path: `src/${RLO}st.nimda`, line: 3, preview: 'AKIA…WXYZ' } },
      { rule_id: 'CB_ENV_COMMITTED', severity: 'critical', title: 'Archivo .env subido al repositorio', resource: '.env', evidence: { path: '.env' } },
    ],
    analyzer: 'core@0.1.0',
  },
  avisos: [{ codigo: 'CB_ZIP_HAS_GIT', texto: 'Tu ZIP lleva la carpeta .git con el historial.' }],
  resumen: { archivos: 40, deps: 2, lockfiles: 2, secretos: 1, env: 1 },
};
const vista = (o: { analisis?: Analisis; verJson?: boolean; error?: string | null } = {}) => renderToStaticMarkup(
  <VistaPrevia archivo={{ filename: 'proyecto.zip', size_bytes: 3_355_443 }} analisis={o.analisis ?? ANALISIS} verJson={o.verJson ?? false}
    alVerJson={() => {}} envio={{ ocupado: false, error: o.error ?? null }} alSubir={() => {}} alElegir={() => {}} />,
);

describe('VistaPrevia', () => {
  it('resume lo que se enviará con plurales y lista hallazgos, dependencias y avisos', () => {
    const html = vista();
    expect(html).toContain('Esto es lo que enviaremos: 2 dependencias de 2 lockfiles · 1 secreto, tapado · 1 .env subido');
    expect(html).toContain('proyecto.zip');
    expect(html).toContain('3,2 MB');
    expect(html).toContain('1.234 entradas');
    expect(html).toContain('Clave de AWS en src/a.ts');
    expect(html).toContain('Hay una clave en tu código');                       // porQueImporta
    expect(html).toContain('AKIA…WXYZ');
    expect(html).toContain('Dependencias (2)');
    expect(html).toContain('Tu ZIP lleva la carpeta .git con el historial.');
    expect(html).toContain('Ver lo que se envía');
    expect(html).not.toContain('<pre');                                          // el JSON solo al pedirlo
  });

  it('en singular y plural', () => {
    const html = vista({ analisis: { ...ANALISIS, resumen: { archivos: 1, deps: 1, lockfiles: 1, secretos: 3, env: 2 } } });
    expect(html).toContain('1 dependencia de 1 lockfile · 3 secretos, tapados · 2 .env subidos');
  });

  it('los controles bidi de una ruta se ven y no reordenan el texto, tampoco en el JSON', () => {
    const html = vista({ verJson: true });
    expect(html).not.toContain(RLO);
    expect(html).toContain('<bdi dir="ltr">src/⟨U+202E⟩st.nimda:3</bdi>');
    expect(html).toContain('src/\\u202est.nimda');                                // mismo JSON, con escape
    expect(html).toMatch(/<pre id="zip-json" dir="ltr"[^>]*>\{\n {2}&quot;files_seen&quot;: 1234,/);
  });

  it('sin rojo ni ámbar sin acción (L3) y un único botón sólido de marca (L5)', () => {
    const html = vista();
    expect(html).not.toContain(TINTE.mal);
    expect(html).not.toContain('bg-aviso-relleno');
    expect(cuenta(html, 'bg-marca')).toBe(1);
    expect(html).toMatch(/bg-marca[^>]*>.*?Subir resultado<\/button>/);
    expect(html).toContain('Elegir otro archivo');
  });

  it('el error del envío ocupa la línea reservada', () => {
    expect(vista({ error: 'Hay demasiados resultados para enviarlos' })).toContain('role="alert" class="min-h-5 text-sm text-mal">Hay demasiados resultados para enviarlos</p>');
    expect(vista()).toContain('role="alert" class="min-h-5 text-sm text-mal"></p>');
  });

  it('sin hallazgos lo dice en neutro', () => {
    const html = vista({ analisis: { ...ANALISIS, resultado: { ...ANALISIS.resultado, findings: [] } } });
    expect(html).toContain('No encontramos secretos ni archivos .env subidos.');
  });
});
