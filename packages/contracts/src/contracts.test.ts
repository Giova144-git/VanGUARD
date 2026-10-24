// Los fixtures son el contrato que ve el FRONT en modo sin BACK (S14 §14.19): si uno deja de
// cumplir su esquema, o falta una clave, el FRONT se rompe en silencio. Este test lo impide.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as c from './index.ts';

const fx = c.fixtures;

const CLAVES_ESPERADAS = [
  'me', 'meViewer', 'overview', 'overviewVacio', 'moduleState', 'connections', 'permChecks', 'scanRunning', 'scanDone',
  'findings', 'fixPrompt', 'incidents', 'incidentDetail', 'traffic', 'actionProposal', 'contacts', 'aiUsage', 'perfRuns',
  'exportMd', 'mcpTokens', 'wikiEstimate', 'wikiRunRunning', 'wikiRunDone', 'wikiRuns', 'wikiDoc',
];

const casos: [string, z.ZodType, unknown][] = [
  ['me', c.Me, fx.me],
  ['meViewer', c.Me, fx.meViewer],
  ['overview', c.Overview, fx.overview],
  ['overviewVacio', c.Overview, fx.overviewVacio],
  ['moduleState.supabase', c.EstadoModulo, fx.moduleState.supabase],
  ['moduleState.cloudflare', c.EstadoModulo, fx.moduleState.cloudflare],
  ['moduleState.codebase', c.EstadoModulo, fx.moduleState.codebase],
  ['moduleState.performance', c.EstadoModulo, fx.moduleState.performance],
  ['connections', z.array(c.ConnectionPublic), fx.connections],
  ['permChecks', z.array(c.PermCheck), fx.permChecks],
  ['scanRunning', c.ScanRun, fx.scanRunning],
  ['scanDone', c.ScanRun, fx.scanDone],
  ['findings', z.array(c.Finding), fx.findings],
  ['fixPrompt', c.FixPromptResponse, fx.fixPrompt],
  ['incidents', z.array(c.Incident), fx.incidents],
  ['incidentDetail', c.IncidentDetail, fx.incidentDetail],
  ['traffic', c.Traffic, fx.traffic],
  ['actionProposal', c.ProposeResponse, fx.actionProposal],
  ['contacts', z.array(c.Contact), fx.contacts],
  ['aiUsage', c.AiUsage, fx.aiUsage],
  ['perfRuns', z.array(c.PerfRunExt), fx.perfRuns],
  ['exportMd', z.string().min(1), fx.exportMd],
  ['mcpTokens', z.array(c.McpTokenPublic), fx.mcpTokens],
  ['wikiEstimate', c.WikiEstimate, fx.wikiEstimate],
  ['wikiRunRunning', c.WikiRun, fx.wikiRunRunning],
  ['wikiRunDone', c.WikiRun, fx.wikiRunDone],
  ['wikiRuns', z.array(c.WikiRun), fx.wikiRuns],
  ['wikiDoc', c.WikiDoc, fx.wikiDoc],
];

describe('fixtures', () => {
  it('tienen exactamente las claves que espera el FRONT', () => {
    expect(Object.keys(fx).sort()).toEqual([...CLAVES_ESPERADAS].sort());
    expect(Object.keys(fx.moduleState).sort()).toEqual([...c.Module.options].sort());
  });

  for (const [nombre, esquema, valor] of casos) {
    it(`${nombre} cumple su esquema`, () => {
      const r = esquema.safeParse(valor);
      expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 2)).toBe(true);
    });
  }

  it('la evidencia de los hallazgos de codebase cumple CodebaseEvidence', () => {
    const codebase = fx.findings.filter((f) => f.module === 'codebase');
    expect(codebase.length).toBeGreaterThan(0);
    for (const f of codebase) {
      const r = c.CodebaseEvidence.safeParse(f.evidence);
      expect(r.success, `${f.rule_id}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
    }
  });

  it('las corridas de rendimiento cumplen PerfRunExt', () => {
    const r = z.array(c.PerfRunExt).safeParse(fx.perfRuns);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 2)).toBe(true);
  });
});

// La wiki de los fixtures es la referencia que copia el pipeline de packages/deepwiki: si deja de cumplir las reglas de
// salida (secciones, lista blanca de Mermaid, saneado, costos), el FRONT enseñaría algo que el motor nunca produce.
describe('fixtures de la wiki', () => {
  const doc = fx.wikiDoc;
  // Precios de la spec en USD por millón de tokens (sin caché); tabla propia para no validar el fixture consigo mismo.
  const PRECIO: Record<string, [number, number]> = { 'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10] };

  it('overview_md tiene un título y las 5 secciones en orden, sin el bloque Mermaid', () => {
    const titulos = doc.overview_md.split('\n').filter((l) => l.startsWith('#'));
    expect(titulos[0]).toMatch(/^# \S/);
    expect(titulos.slice(1)).toEqual(['## Qué es y para qué sirve', '## Cómo funciona, en simple',
      '## Las piezas principales', '## Mapa visual', '## Riesgos y puntos de atención']);
    expect(doc.overview_md).not.toContain('```');
  });

  it('el Mermaid pasa la lista blanca del CLI deepwiki (flowchart LR de 6 nodos)', () => {
    // Misma línea segura que deepwiki/src/index.mjs (commit 14c229a).
    const SEGURA = /^\s*(flowchart LR|[A-Za-z0-9_]+(\[[A-Za-z0-9 ]{1,40}\])?\s*(-->(\|[A-Za-z0-9 ]{1,30}\|)?\s*[A-Za-z0-9_]+(\[[A-Za-z0-9 ]{1,40}\])?)?)\s*$/;
    const lineas = (doc.mermaid ?? '').split('\n').filter((l) => l.trim());
    expect(doc.mermaid_descartado).toBe(false);
    expect(lineas[0]).toBe('flowchart LR');
    for (const l of lineas) expect(l, l).toMatch(SEGURA);
    const nodos = new Set(lineas.slice(1).flatMap((l) => l.replace(/\[[^\]]*\]|\|[^|]*\|/g, '').split('-->').map((n) => n.trim())));
    expect(nodos.size).toBe(6);
  });

  it('el texto sale saneado: sin HTML, enlaces, imágenes ni URLs', () => {
    for (const t of [doc.overview_md, ...doc.paginas.map((p) => p.resumen_md), ...doc.avisos]) {
      expect(t).not.toMatch(/<[^>]*>|\]\(|https?:\/\/|www\./);
    }
  });

  it('las páginas no leen archivos que los filtros locales excluyen y cuadran con stats', () => {
    const leidos = doc.paginas.flatMap((p) => p.archivos);
    expect(new Set(leidos).size).toBe(leidos.length);
    for (const a of leidos) expect(a).not.toMatch(/(^|\/)\.env|(-lock\.json|\.lock|lock\.yaml)$/);
    expect(doc.paginas.length).toBeGreaterThanOrEqual(4);
    expect(doc.paginas.length).toBeLessThanOrEqual(6);
    expect(new Set(doc.paginas.map((p) => p.id)).size).toBe(doc.paginas.length);
    expect(doc.stats.areas).toBe(doc.paginas.length);
    expect(doc.stats.files_leidos).toBe(leidos.length);
    expect(doc.stats.files_total).toBe(fx.wikiEstimate.files_total);
  });

  it('la estimación cuadra con los precios y queda por encima del costo real', () => {
    const { est } = fx.wikiEstimate;
    for (const p of est.desglose) {
      const [entrada, salida] = PRECIO[p.modelo]!;
      expect(p.usd).toBeCloseTo((p.input_tokens * entrada + p.output_tokens * salida) / 1e6, 6);
    }
    expect(est.usd).toBeCloseTo(est.desglose.reduce((a, p) => a + p.usd, 0), 6);
    expect(est.input_tokens).toBe(est.desglose.reduce((a, p) => a + p.input_tokens, 0));
    expect(est.output_tokens).toBe(est.desglose.reduce((a, p) => a + p.output_tokens, 0));
    expect(doc.stats.cost_usd).toBeGreaterThan(0);
    expect(doc.stats.cost_usd).toBeLessThanOrEqual(est.usd);
    expect(doc.stats.input_tokens).toBeLessThanOrEqual(est.input_tokens);
    expect(doc.stats.output_tokens).toBeLessThanOrEqual(est.output_tokens);
  });

  it('las corridas cuentan la misma historia que el documento', () => {
    const [cache, real] = fx.wikiRuns;
    expect(fx.wikiRunRunning.id).toBe(fx.wikiRunDone.id);
    expect(real).toEqual(fx.wikiRunDone);
    expect(doc.run_id).toBe(real!.id);
    expect(real!.cost_usd).toBe(doc.stats.cost_usd);
    expect(fx.wikiRunRunning.cost_usd).toBeLessThan(doc.stats.cost_usd);
    expect(cache!.cached).toBe(true);
    expect(cache!.cost_usd).toBe(0);
    expect(cache!.commit_sha).toBe(doc.commit_sha);
    expect(Date.parse(cache!.created_at)).toBeGreaterThan(Date.parse(real!.created_at));
    expect(fx.wikiEstimate.commit_sha).toBe(doc.commit_sha);
  });
});
