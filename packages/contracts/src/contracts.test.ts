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
  'codeReviewState', 'codeReviewSaved', 'alertPrefs', 'hallazgoRevision',
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
  ['codeReviewState', c.CodeReviewState, fx.codeReviewState],
  ['codeReviewSaved', c.CodeReviewSaved, fx.codeReviewSaved],
  ['alertPrefs', c.AlertPrefs, fx.alertPrefs],
  ['hallazgoRevision', c.Finding, fx.hallazgoRevision],
];

describe('revisión de código', () => {
  const base = fx.codeReviewSaved;
  it('CodeReviewSaved acepta vgw_ + 43 de base64url', () => {
    expect(c.CodeReviewSaved.safeParse({ ...base, webhook_secret: 'vgw_' + 'aB3-_'.repeat(8) + 'xyz' }).success).toBe(true);
  });
  it('CodeReviewSaved rechaza un secreto sin vgw_, con otro prefijo o de otro largo', () => {
    for (const s of ['aB3-_'.repeat(9) + 'xy', 'vgi_' + 'a'.repeat(43), 'vgw_' + 'a'.repeat(32)]) {
      expect(c.CodeReviewSaved.safeParse({ ...base, webhook_secret: s }).success).toBe(false);
    }
  });
  it('la URL del webhook solo admite https', () => {
    const config = { ...base.config, webhook_url: 'http://officialvanguard.com/webhooks/github/x' };
    expect(c.CodeReviewConfig.safeParse(config).success).toBe(false);
  });
});

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

  it('el Mermaid pasa la lista blanca del motor (flowchart LR de 6 nodos)', () => {
    // Misma lista que validarMermaid (packages/deepwiki/src/sanitizar.ts): etiquetas con tildes y eñe, 40 en nodos y
    // 30 en flechas. Una conexión por línea, como en el fixture.
    const SEGURA = /^\s*(flowchart LR|[A-Za-z0-9_]+(\[[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ ]{1,40}\])?\s*(-->(\|[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ ]{1,30}\|)?\s*[A-Za-z0-9_]+(\[[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ ]{1,40}\])?)?)\s*$/;
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
    for (const a of leidos) expect(a).not.toMatch(/(^|\/)(tsconfig\.json|\.gitignore)$/);   // también los excluye el motor
    expect(doc.paginas.length).toBeGreaterThanOrEqual(4);
    expect(doc.paginas.length).toBeLessThanOrEqual(13);   // WikiDoc.paginas: 12 áreas + «(otros)»
    expect(new Set(doc.paginas.map((p) => p.id)).size).toBe(doc.paginas.length);
    expect(doc.stats.areas).toBe(doc.paginas.length);
    expect(doc.stats.files_leidos).toBe(leidos.length);
    expect(doc.stats.files_total).toBe(fx.wikiEstimate.files_total);
  });

  it('«Riesgos» cita cada hallazgo crítico o alto de la auditoría y no usa su evidencia', () => {
    const riesgos = doc.overview_md.slice(doc.overview_md.indexOf('## Riesgos y puntos de atención'));
    // Qué frase del texto cubre cada hallazgo grave (clave: regla y recurso). Si aparece un grave nuevo en
    // hallazgos.ts sin su frase aquí, la prueba falla: hay que nombrarlo también en la wiki.
    const CITA: Record<string, string> = {
      'CB_SECRET_SUPABASE_SERVICE_ROLE src/lib/supabaseAdmin.ts:4': 'llave maestra de la base de datos',
      'CB_ENV_COMMITTED .env': 'archivo .env',
      'CB_SECRET_POSTGRES_URL .env:3': 'contraseña de la base de datos',
      'CB_DEP_VULN Packagist:facade/ignition@2.5.1': 'tomar el control del servidor',
      'CB_DEP_VULN npm:lodash@4.17.15': 'lodash',
      'SB_RLS_DISABLED public.pedidos': 'tabla de pedidos',
      'SB_RPC_ANON_NO_LIMIT public.enviar_otp': 'sin sesión y sin límite',
      'SB_POLICY_ALLOW_ALL public.perfiles': 'leer los perfiles',
    };
    const graves = fx.findings.filter((f) => f.severity === 'critical' || f.severity === 'high')
      .map((f) => `${f.rule_id} ${f.resource}`);
    expect(Object.keys(CITA).sort()).toEqual([...graves].sort());
    for (const [clave, frase] of Object.entries(CITA)) expect(riesgos, clave).toContain(frase);
    // Lo que no sale de un hallazgo va como observación, y nada de la evidencia (filas, ubicaciones) ni marcas [Hn].
    expect(riesgos).toMatch(/^Observación \(no es un hallazgo de la auditoría\):/m);
    expect(riesgos).not.toMatch(/500|archivo de configuración|\[H\d/);
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

// GrupoDato.orden (estado.ts): el servidor entrega `ahora` de mayor a menor y el FRONT no reordena; los fixtures igual.
describe('orden de los grupos en los estados de módulo', () => {
  const estados = Object.values(fx.moduleState as Record<string, { ahora?: { grupo: string; orden?: number }[] }>);
  it('hay estados con grupos que revisar', () => expect(estados.some((e) => (e.ahora?.length ?? 0) > 1)).toBe(true));
  it('orden no crece a lo largo de ahora', () => {
    for (const e of estados) {
      const ordenes = (e.ahora ?? []).map((g) => g.orden ?? 0);
      for (let i = 1; i < ordenes.length; i++) expect(ordenes[i], JSON.stringify(ordenes)).toBeLessThanOrEqual(ordenes[i - 1]!);
    }
  });
});
