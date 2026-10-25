// «Cambios desde la auditoría anterior» (asignaciones/evolucion-entre-revisiones.md §6.3 y §9.3): los cinco estados, las
// etiquetas, el 404 que no pinta nada, el texto bidi saneado y las notas que solo salen con > 0. Sin jsdom: caché a mano.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, AuditDelta } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { Cambios } from './Cambios';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ID = fx.scanDone.id;
const VIEWER: OrgActual = { ...fx.me.orgs[0]!, role: 'viewer', me: fx.meViewer, puedeEscribir: false };
type ConFoto = Extract<AuditDelta, { available: true }>;
const DELTA = AuditDelta.parse(fx.auditDelta) as ConFoto;

function pintar(datos: AuditDelta | ApiError) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });   // sin retryOnMount: el error se pinta
  const clave = ['org', ORG, 'scan', ID, 'delta'];
  if (datos instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: clave }).setState({ status: 'error', error: datos, fetchStatus: 'idle' });
  else qc.setQueryData(clave, datos);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[`/o/${ORG}/audit/${ID}`]}>
      <OrgDePrueba org={VIEWER}><Cambios scanId={ID} /></OrgDePrueba>
    </MemoryRouter></QueryClientProvider>);
}
const texto = (html: string) => html.replace(/<[^>]+>/g, '');

describe('Cambios', () => {
  it('404 (E51 aún sin desplegar) o un error: no se pinta nada', () => {
    expect(pintar(new ApiError(404, 'not_found', 'Ruta inexistente'))).toBe('');
    expect(pintar(new ApiError(500, 'internal', 'No pudimos leer los cambios de esta auditoría'))).toBe('');
  });

  it('en_curso, sin_foto y la primera foto lo dicen sin cifras', () => {
    const enCurso = pintar({ available: false, scan_run_id: ID, reason: 'en_curso' });
    expect(enCurso).toContain('Cambios desde la auditoría anterior');
    expect(enCurso).toContain('Comparando con la auditoría anterior…');
    expect(pintar({ available: false, scan_run_id: ID, reason: 'sin_foto' })).toContain('Esta auditoría es anterior al historial o no pudo revisar ningún módulo');
    const primera = pintar({ ...DELTA, first: true, previous: null });
    expect(primera).toContain('Es la primera auditoría con historial');
    expect(primera).not.toContain('Se mantienen');
  });

  it('con anterior: cabecera, cifras, módulos y la lista de nuevos abierta (el viewer ve lo mismo)', () => {
    const html = pintar(DELTA);
    const t = texto(html);
    expect(t).toMatch(/Frente a la auditoría anterior \(23-oct 14:04\) · puntaje 57 → 20/);
    expect(t).toContain('Nuevos7');
    expect(t).toContain('Se mantienen5');
    expect(t).toContain('Corregidos2');
    expect(t).toContain('1 comprobado por la auditoría');
    expect(t).toContain('Ignorados: 1');
    expect(html).toContain('text-mal');                         // hay una crítica nueva: rojo, con su «Ver»
    expect(t).toContain('Supabase · ');
    expect(t).toContain('Codebase · ');
    expect(t).not.toContain('Cloudflare · ');                    // sin cambios en Cloudflare: sin fila
    expect(t).not.toContain('no se revisó');
    expect(t).toContain('Nuevos (7)');
    expect(t).toContain('Corregidos (2)');
    expect(t).toContain('Se mantienen (5)');
    expect(t).toContain('Ignorados (1)');
    for (const i of DELTA.new.items) expect(html).toContain(`?finding=${i.finding_id}`);
    expect(html).not.toContain(`?finding=${DELTA.fixed.items[0]!.finding_id}`);   // Corregidos va plegada
    expect(t).not.toContain('cambió de línea');
    expect(t).not.toContain('ya no exist');
    expect(html).not.toContain('<button disabled');
  });

  it('un módulo no revisado lo dice; las claves movidas y las filas borradas solo con > 0', () => {
    const cf = { ...DELTA.counts.new.cloudflare, high: 1 };
    const html = texto(pintar({ ...DELTA, modules_seen: ['supabase', 'codebase'], counts: { ...DELTA.counts, new: { ...DELTA.counts.new, cloudflare: cf } },
      moved: 1, gone: 2 }));
    expect(html).toContain('Cloudflare: no se revisó en esta auditoría; sus cambios vienen de pushes o de marcas a mano.');
    expect(html).toContain('1 clave cambió de línea y sigue abierta: cuenta en «Se mantienen».');
    expect(html).toContain('2 hallazgos ya no existen (se borraron por antigüedad): no cuentan como corregidos.');
  });

  it('la anterior borrada o sin cerrar; sin nuevos graves la cifra no va en rojo', () => {
    const vacios = Object.fromEntries(Object.entries(DELTA.counts.new).map(([k, v]) => [k, Object.fromEntries(Object.keys(v).map((s) => [s, 0]))]));
    const sinGraves = { ...DELTA, counts: { ...DELTA.counts, new: vacios as ConFoto['counts']['new'] } };
    expect(texto(pintar({ ...sinGraves, previous: null }))).toContain('Frente a una auditoría que ya se borró (se guardan 90 días)');
    const abierta = pintar({ ...sinGraves, previous: { ...DELTA.previous!, finished_at: null, kind: 'supabase' } });
    expect(texto(abierta)).toContain('Frente a la auditoría anterior (Solo Supabase) · puntaje 57 → 20');
    expect(abierta).not.toMatch(/text-3xl[^"]*text-mal/);
  });

  it('etiquetas por estado de ahora en Nuevos y título con controles bidi saneado', () => {
    const [a, b] = DELTA.new.items;
    const html = pintar({ ...DELTA, new: { total: 2, items: [{ ...a!, status: 'fixed' }, { ...b!, title: 'Clave en src/‮sj.nimda', resource: 'src/‮sj.nimda:3' }] } });
    expect(html).toContain('Ya corregido');
    expect(html).toContain('⟨U+202E⟩');
    expect(html).not.toContain('‮');
    expect(html).toContain('<bdi dir="ltr">src/⟨U+202E⟩sj.nimda:3</bdi>');
  });

  it('pinta 10 y «Ver todos»; si E51 trae menos que el total, «y N más»', () => {
    const base = DELTA.new.items[0]!;
    const items = Array.from({ length: 12 }, (_, i) => ({ ...base, finding_id: `f0000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}` }));
    const muchos = pintar({ ...DELTA, new: { total: 12, items } });
    expect(muchos.match(/\?finding=/g)).toHaveLength(10);
    expect(texto(muchos)).toContain('Ver todos (12)');
    const recortada = texto(pintar({ ...DELTA, new: { total: 60, items: items.slice(0, 3) } }));
    expect(recortada).toContain('Nuevos (60)');
    expect(recortada).toContain('y 57 más');
  });
});
