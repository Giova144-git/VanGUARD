// Los fixtures de la wiki (packages/contracts/src/fixtures/wiki.ts) son lo que ve el FRONT en modo sin BACK. Aquí se
// comprueba que el motor de verdad puede producirlos: si no, el FRONT se diseñaría con una demo que no ocurre en vivo.
import { describe, expect, it } from 'vitest';
import { fixtures as fx } from '@vanguard/contracts';
import { avisoTecho, techoDesglose } from './estimar.ts';
import { agruparEnAreas, rutaExcluida } from './filtros.ts';
import { AVISOS, detalleInicio, LIMITES_POR_DEFECTO, paginaDeRuta, progreso, slugDeArea } from './pipeline.ts';
import { limpiarTitulo, SECCIONES } from './prompts.ts';
import { sanearMarkdown, validarMermaid } from './sanitizar.ts';
import type { EstadoWiki } from './tipos.ts';

const doc = fx.wikiDoc;
const est = fx.wikiEstimate;
const archivos = doc.paginas.flatMap((p) => p.archivos);
const areas = agruparEnAreas(archivos, LIMITES_POR_DEFECTO.maxAreas);

describe('fixtures de la wiki = salida posible del motor', () => {
  it('ninguna página cita un archivo que los filtros excluyen', () => {
    for (const a of archivos) expect(rutaExcluida(a), a).toBe(false);
    expect(doc.stats.files_leidos).toBe(archivos.length);
  });

  it('las áreas, su orden y sus ids son los de agruparEnAreas y slugDeArea', () => {
    expect(doc.paginas.map((p) => p.area)).toEqual(areas.map((a) => a.nombre));
    expect(doc.paginas.map((p) => p.id)).toEqual(areas.map((a) => slugDeArea(a.nombre)));
    doc.paginas.forEach((p, i) => expect([...p.archivos].sort()).toEqual([...(areas[i]?.archivos ?? [])].sort()));
    expect(est.areas_max).toBeGreaterThanOrEqual(doc.paginas.length);
  });

  it('títulos, resúmenes y documento son un punto fijo del saneo del motor', () => {
    for (const p of doc.paginas) {
      expect(limpiarTitulo(p.titulo), p.id).toBe(p.titulo);
      const palabras = p.titulo.split(' ').length;
      expect(palabras, p.titulo).toBeGreaterThanOrEqual(2);
      expect(palabras, p.titulo).toBeLessThanOrEqual(6);
      expect(sanearMarkdown(p.resumen_md, 4000), p.id).toBe(p.resumen_md);
      expect(p.resumen_md, p.id).not.toContain('\n');   // un solo párrafo, sin «Para el negocio:» aparte
    }
    expect(sanearMarkdown(doc.overview_md)).toBe(doc.overview_md);
    expect(validarMermaid(doc.mermaid ?? '')).toEqual({ ok: true, motivo: null });
    const secciones = doc.overview_md.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
    expect(secciones).toEqual([...SECCIONES]);
  });

  it('«Las piezas principales» nombra cada parte con el título de su página', () => {
    const md = doc.overview_md;
    const piezas = md.slice(md.indexOf('## Las piezas principales'), md.indexOf('## Mapa visual'));
    const nombres = [...piezas.matchAll(/^- \*\*(.+?):\*\*/gm)].map((m) => m[1]);
    expect(new Set(nombres)).toEqual(new Set(doc.paginas.map((p) => p.titulo)));
  });

  it('los avisos son los textos exactos del motor, en su orden', () => {
    const omitidos = AVISOS.omitidos(est.files_total - est.files_candidatos, est.files_total);
    expect(doc.avisos).toEqual([
      AVISOS.leidos(doc.stats.files_leidos, est.files_candidatos), AVISOS.auditoria('24/10/2026'),
      omitidos, AVISOS.claves(1), AVISOS.redaccion(1),
    ]);
    expect(est.avisos).toEqual([omitidos, AVISOS.claves(1), avisoTecho(techoDesglose(est.est.desglose))]);
  });

  it('el paso en curso trae el detalle y el progreso que calcula el motor', () => {
    const estado = { areas, pendientes: areas.slice(2).map((a) => a.nombre), resumenes: [], candidatos: [] } as unknown as EstadoWiki;
    const paso = fx.wikiRunRunning.steps.find((s) => s.name === 'area');
    expect(paso?.detalle).toBe(detalleInicio({ paso: 'area', area: areas[2]?.nombre ?? '' }, estado));
    expect(fx.wikiRunRunning.progress).toBe(progreso(estado, true));
  });

  it('cada hallazgo de código de la demo cae en una página con paginaDeRuta', () => {
    for (const f of fx.findings.filter((x) => x.module === 'codebase')) {
      const ruta = (f.evidence as { path?: unknown }).path;
      expect(typeof ruta, f.rule_id).toBe('string');
      expect(paginaDeRuta(ruta as string, doc.paginas), String(ruta)).not.toBeNull();
    }
  });
});
