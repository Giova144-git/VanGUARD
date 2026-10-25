// Los fixtures son el contrato que ve el FRONT en modo sin BACK (S14 §14.19): si uno deja de
// cumplir su esquema, o falta una clave, el FRONT se rompe en silencio. Este test lo impide.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as c from './index.ts';
import * as ids from './fixtures/ids.ts';

const fx = c.fixtures;

const CLAVES_ESPERADAS = [
  'me', 'meViewer', 'overview', 'overviewVacio', 'moduleState', 'connections', 'permChecks', 'scanRunning', 'scanDone',
  'findings', 'fixPrompt', 'incidents', 'incidentDetail', 'traffic', 'actionProposal', 'contacts', 'aiUsage', 'perfRuns',
  'exportMd', 'mcpTokens', 'wikiEstimate', 'wikiRunRunning', 'wikiRunDone', 'wikiRuns', 'wikiDoc',
  'codeReviewState', 'codeReviewSaved', 'alertPrefs', 'hallazgoRevision',
  'conexionGithub2', 'scanDoneDosRepos', 'codeReviewStateRepo2',
  'codeReviewStateBloqueo', 'mergeGateSaved',
  'auditDelta', 'evolution', 'hallazgosCorregidos', 'deltasRevision',
  'underAttackOffer', 'underAttackOfferUnaIp', 'underAttackOfferSinPermiso', 'underAttackProposal',
];

const casos: [string, z.ZodType, unknown][] = [
  ['me', c.Me, fx.me],
  ['underAttackOffer', c.UnderAttackOffer, fx.underAttackOffer],
  ['underAttackOfferUnaIp', c.UnderAttackOffer, fx.underAttackOfferUnaIp],
  ['underAttackOfferSinPermiso', c.UnderAttackOffer, fx.underAttackOfferSinPermiso],
  ['underAttackProposal', c.UnderAttackProposal, fx.underAttackProposal],
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
  ['codeReviewStateBloqueo', c.CodeReviewState, fx.codeReviewStateBloqueo],
  ['mergeGateSaved', c.MergeGateSaved, fx.mergeGateSaved],
  ['codeReviewSaved', c.CodeReviewSaved, fx.codeReviewSaved],
  ['alertPrefs', c.AlertPrefs, fx.alertPrefs],
  ['hallazgoRevision', c.Finding, fx.hallazgoRevision],
  ['conexionGithub2', c.ConnectionPublic, fx.conexionGithub2],
  ['scanDoneDosRepos', c.ScanRun, fx.scanDoneDosRepos],
  ['codeReviewStateRepo2', c.CodeReviewState, fx.codeReviewStateRepo2],
  ['auditDelta', c.AuditDelta, fx.auditDelta],
  ['evolution', c.Evolution, fx.evolution],
  ['hallazgosCorregidos', z.array(c.Finding), fx.hallazgosCorregidos],
  ['deltasRevision', z.record(c.Id, c.CodeReviewDelta), fx.deltasRevision],
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

describe('bloqueo de merge', () => {
  const gate = fx.mergeGateSaved.gate;
  it('el contexto es exactamente VanGUARD', () => {
    expect(c.GATE_CONTEXT).toBe('VanGUARD');
    expect(c.MergeGateConfig.safeParse({ ...gate, context: 'vanguard/revision' }).success).toBe(false);
  });
  it('P0 sin protección leída y P1 con ella cumplen MergeGateConfig', () => {
    expect(c.MergeGateConfig.safeParse({ ...gate, state: 'unchecked', protection: null }).success).toBe(true);
    const p1 = { ...gate, state: 'active', protection: { required: 'yes', admins: 'bypass', pr_required: 'unknown',
      checked_at: '2026-10-24T19:41:00.000Z' } };
    expect(c.MergeGateConfig.safeParse(p1).success).toBe(true);
  });
  it('last_error es solo del token: un 422 no pasa a la config', () => {
    expect(c.MergeGateConfig.safeParse({ ...gate, state: 'error', last_error: 'forbidden' }).success).toBe(true);
    expect(c.MergeGateConfig.safeParse({ ...gate, state: 'error', last_error: 'limite' }).success).toBe(false);
  });
  it('MergeGatePut admite el cambio sin token y rechaza un token corto', () => {
    expect(c.MergeGatePut.safeParse({ enabled: true, min_severity: 'critical' }).success).toBe(true);
    expect(c.MergeGatePut.safeParse({ enabled: true, min_severity: 'medium' }).success).toBe(false);
    expect(c.MergeGatePut.safeParse({ enabled: true, min_severity: 'high', statuses_pat: 'corto' }).success).toBe(false);
  });
  it('MergeGateSaved: sin token, probe_sha y probe_state van null', () => {
    expect(c.MergeGateSaved.safeParse({ ...fx.mergeGateSaved, probe_sha: null, probe_state: null }).success).toBe(true);
    expect(c.MergeGateSaved.safeParse({ ...fx.mergeGateSaved, probe_state: 'aprobado' }).success).toBe(false);
  });
  it('MergeGateAction: override exige motivo; un op desconocido no pasa', () => {
    expect(c.MergeGateAction.safeParse({ op: 'override', reason: 'ok' }).success).toBe(false);
    expect(c.MergeGateAction.safeParse({ op: 'override', reason: 'clave de prueba documentada' }).success).toBe(true);
    expect(c.MergeGateAction.safeParse({ op: 'revert' }).success).toBe(true);
    expect(c.MergeGateAction.safeParse({ op: 'borrar' }).success).toBe(false);
  });
  it('una revisión sin gate (antes de 0016) sigue cumpliendo CodeReview', () => {
    const [primera] = fx.codeReviewState.recent;
    expect(c.CodeReview.safeParse(primera).success).toBe(true);
    expect('gate' in (primera ?? {})).toBe(false);
  });
  it('blocking no es counts: un error de publicación es un código corto', () => {
    const r = c.CodeReview.parse(fx.codeReviewStateBloqueo.recent[0]);
    expect(c.CodeReview.safeParse({ ...r, gate: { ...r.gate!, error: 'Forbidden 403' } }).success).toBe(false);
    expect(c.CodeReview.safeParse({ ...r, gate: { ...r.gate!, state: null, error: 'sin_token' } }).success).toBe(true);
  });
  it('un pr_action o un whatsapp_action desconocido sale null y no tumba la revisión', () => {
    const r = c.CodeReview.parse(fx.codeReviewStateBloqueo.recent[0]);
    const conGate = c.CodeReview.parse({ ...r, gate: { ...r.gate!, pr_action: 'merged_by_bot' } });
    expect(conGate.gate?.pr_action).toBeNull();
    expect(c.CodeReview.parse({ ...r, gate: { ...r.gate!, pr_action: 'closed' } }).gate?.pr_action).toBe('closed');
    const alerta = c.CodeReviewAlert.parse({ ...r.alert, whatsapp_action: 'uat_activado' });
    expect(alerta.whatsapp_action).toBeNull();
    const estado = c.CodeReviewState.parse({ ...fx.codeReviewStateBloqueo,
      recent: [{ ...r, alert: { ...r.alert, whatsapp_action: 'otra_accion' } }] });
    expect(estado.recent[0]?.alert.whatsapp_action).toBeNull();
  });
});

// Evolución (E51, E52 y la foto de cada push en E45): los fixtures cuentan la misma historia que hallazgos.ts,
// auditoria.ts, resumen.ts, revision.ts e incidentes.ts.
describe('evolución', () => {
  const SEV = c.Severity.options;
  const MOD = c.Module.options;
  const total = (m: c.MatrizHallazgos | null) => (m ? MOD.reduce((a, k) => a + SEV.reduce((b, s) => b + m[k][s], 0), 0) : NaN);
  const suma = (r: Record<c.Severity, number>) => SEV.reduce((a, s) => a + r[s], 0);
  const esClave = (rule: string) => rule.startsWith('CB_SECRET_') || rule === 'CB_ENV_COMMITTED';
  const d = fx.auditDelta;
  const evo = fx.evolution;
  const todos: c.EvolutionPoint[] = evo.points;
  const pts = todos.filter((p) => p.snapshot);
  const ultimo = pts[pts.length - 1]!;

  it('open del último punto = hallazgos open de hallazgos.ts; puntaje y conteos = Resumen', () => {
    const abiertos = fx.findings.filter((f) => f.status === 'open');
    for (const k of MOD) for (const s of SEV) {
      expect(ultimo.open![k][s], `${k}.${s}`).toBe(abiertos.filter((f) => f.module === k && f.severity === s).length);
    }
    expect(ultimo.score).toBe(fx.overview.score);
    expect(ultimo.scan_run_id).toBe(fx.scanDone.id);
    expect(todos[todos.length - 1]).toBe(ultimo);
    for (const s of SEV) expect(MOD.reduce((a, k) => a + ultimo.open![k][s], 0)).toBe(fx.overview.counts[s]);
  });

  it('cada punto con foto cuadra con el anterior: open = open anterior + new − fixed − ignored − gone', () => {
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1]!, pts[i]!];
      expect(total(b.open), b.scan_run_id).toBe(total(a.open) + total(b.new) - total(b.fixed) - b.ignored - b.gone);
      expect(b.first).toBe(false);
    }
    expect(pts[0]!.first).toBe(true);
    expect(total(pts[0]!.new) + total(pts[0]!.fixed)).toBe(0);
    for (let i = 1; i < todos.length; i++) expect(Date.parse(todos[i]!.at)).toBeGreaterThan(Date.parse(todos[i - 1]!.at));
    for (const p of todos.filter((x) => !x.snapshot)) {
      expect([p.open, p.new, p.fixed, p.first, p.ignored, p.gone, p.fixed_checked]).toEqual([null, null, null, false, 0, 0, 0]);
    }
  });

  it('el delta cuadra: listas = conteos, kept = open − new, comprobados sin claves y = último punto', () => {
    if (!d.available) throw new Error('auditDelta debe estar disponible');
    for (const k of ['new', 'kept', 'fixed', 'ignored'] as const) {
      expect(d[k].total, k).toBe(total(d.counts[k]));
      expect(d[k].items.length, k).toBe(d[k].total);
    }
    for (const k of MOD) for (const s of SEV) {
      expect(d.counts.kept[k][s], `${k}.${s}`).toBe(d.counts.open[k][s] - d.counts.new[k][s]);
    }
    expect(d.counts.open).toEqual(ultimo.open);
    expect([d.ignored.total, d.gone, d.fixed_checked]).toEqual([ultimo.ignored, ultimo.gone, ultimo.fixed_checked]);
    expect(d.fixed_checked).toBe(d.fixed.items.filter((x) => x.status === 'verified' && !esClave(x.rule_id)).length);
    expect(d.previous?.scan_run_id).toBe(pts[pts.length - 2]!.scan_run_id);
    expect(d.previous?.score).toBe(pts[pts.length - 2]!.score);
    for (const x of [...d.new.items, ...d.kept.items]) expect(x.status).toBe('open');
  });

  it('totals = sumas de las fotos del periodo (sin recorte); incidentes = los de incidentes.ts', () => {
    expect(evo.truncated).toBe(false);
    const comp = pts.filter((p) => !p.first);
    expect([evo.totals.versions, evo.totals.snapshots, evo.totals.score_first]).toEqual([todos.length, pts.length, todos[0]!.score]);
    expect(total(evo.totals.new)).toBe(comp.reduce((a, p) => a + total(p.new), 0));
    expect(total(evo.totals.fixed)).toBe(comp.reduce((a, p) => a + total(p.fixed), 0));
    expect(evo.totals.fixed_checked).toBe(comp.reduce((a, p) => a + p.fixed_checked, 0));
    expect(evo.totals.ignored).toBe(comp.reduce((a, p) => a + p.ignored, 0));
    for (let i = 1; i < evo.incidents.length; i++) expect(evo.incidents[i]!.day > evo.incidents[i - 1]!.day).toBe(true);
    for (const s of SEV) {
      expect(evo.incidents.reduce((a, x) => a + x.counts[s], 0), s).toBe(fx.incidents.filter((i) => i.severity === s).length);
    }
  });

  it('revisiones de más vieja a más nueva; la foto de cada push encadena con la del push anterior', () => {
    const r = evo.reviews;
    for (let i = 1; i < r.length; i++) expect(Date.parse(r[i]!.at)).toBeGreaterThan(Date.parse(r[i - 1]!.at));
    for (const x of fx.codeReviewState.recent) {
      expect(r.find((y) => y.review_id === x.id)?.head_sha7).toBe(x.head_sha.slice(0, 7));
      expect(r.find((y) => y.review_id === x.id)?.delta).toEqual(fx.deltasRevision[x.id]);
    }
    const pushes = r.filter((x) => x.event === 'push' && x.delta);
    expect(pushes[0]!.delta!.first).toBe(true);
    for (let i = 0; i < pushes.length; i++) {
      const x = pushes[i]!.delta!;
      expect(x.kept, pushes[i]!.review_id).toBe(x.open - suma(pushes[i]!.new));   // kept = open − nuevos de este push
      if (x.first) expect([x.fixed, x.fixed_checked, x.ignored, x.previous_review_id]).toEqual([0, 0, 0, null]);
      else expect(x.previous_review_id).toBe(pushes[i - 1]!.review_id);
      expect(x.fixed_checked).toBeLessThanOrEqual(x.fixed);
    }
    const ultimaRev = pushes[pushes.length - 1]!.delta!;
    expect(ultimaRev.open).toBe(fx.findings.filter((f) => f.status === 'open' && f.module === 'codebase').length + 1);
  });

  it('CodeReview acepta delta, delta null y sin delta (un BACK de antes de 0015)', () => {
    const [primera] = fx.codeReviewState.recent;
    expect(c.CodeReview.safeParse(primera).success).toBe(true);
    expect(c.CodeReview.safeParse({ ...primera, delta: null }).success).toBe(true);
    expect(c.CodeReview.safeParse({ ...primera, delta: fx.deltasRevision[primera!.id] }).success).toBe(true);
    expect(c.CodeReview.safeParse({ ...primera, delta: { first: false } }).success).toBe(false);
  });

  it('AuditDelta acepta available:false con su motivo y rechaza un motivo desconocido', () => {
    const base = { available: false, scan_run_id: fx.scanDone.id };
    expect(c.AuditDelta.safeParse({ ...base, reason: 'en_curso' }).success).toBe(true);
    expect(c.AuditDelta.safeParse({ ...base, reason: 'otro' }).success).toBe(false);
  });

  it('una matriz sin un módulo o sin una severidad no pasa (zod 4 exige todas las claves)', () => {
    if (!d.available) throw new Error('auditDelta debe estar disponible');
    const { performance: _, ...sinModulo } = d.counts.open;
    expect(c.MatrizHallazgos.safeParse(sinModulo).success).toBe(false);
    const { info: __, ...sinInfo } = d.counts.open.supabase;
    expect(c.MatrizHallazgos.safeParse({ ...d.counts.open, supabase: sinInfo }).success).toBe(false);
  });

  it('las horas van con Z (la base las da con to_char) y un día de incidente es AAAA-MM-DD', () => {
    const conZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const p of todos) expect(p.at).toMatch(conZ);
    for (const x of evo.reviews) expect(x.at).toMatch(conZ);
    if (d.available) expect(d.taken_at).toMatch(conZ);
    expect(c.EvolutionIncidentDay.safeParse({ day: '24-10-2026', counts: evo.incidents[0]!.counts }).success).toBe(false);
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

describe('modo bajo ataque', () => {
  it('UnderAttackPropose: host por defecto y sin campo hostname', () => {
    expect(c.UnderAttackPropose.parse({})).toEqual({ scope: 'host' });
    expect(c.UnderAttackPropose.safeParse({ scope: 'zona' }).success).toBe(false);
    expect('hostname' in c.UnderAttackPropose.parse({ hostname: 'evil.example.com' })).toBe(false);
  });
  it('UnderAttackProposal rechaza un target de más de 120 caracteres o un ttl fuera de 300..3600', () => {
    const p = fx.underAttackProposal;
    expect(c.UnderAttackProposal.safeParse({ ...p, target: 'a'.repeat(115) + '.test1' }).success).toBe(false);
    expect(c.UnderAttackProposal.safeParse({ ...p, ttl_s: 7200 }).success).toBe(false);
  });
  it('la propuesta sigue siendo un ProposeResponse (la pinta <Propuesta/> de BloquearIp)', () => {
    expect(c.ProposeResponse.safeParse(fx.underAttackProposal).success).toBe(true);
  });
  it('UnderAttackOffer: activo exige retirada_fallida e ips es obligatorio', () => {
    const activo = { action_id: 'ac000000-0000-4000-8000-000000000001', scope: 'host', target: 'demo.officialvanguard.com',
      created_at: '2026-10-24T19:12:00.000Z', expires_at: '2026-10-24T19:42:00.000Z', retirada_fallida: true };
    expect(c.UnderAttackOffer.safeParse({ ...fx.underAttackOffer, activo }).success).toBe(true);
    const { retirada_fallida: _, ...sinCampo } = activo;
    expect(c.UnderAttackOffer.safeParse({ ...fx.underAttackOffer, activo: sinCampo }).success).toBe(false);
    const { ips: __, ...sinIps } = fx.underAttackOffer;
    expect(c.UnderAttackOffer.safeParse(sinIps).success).toBe(false);
  });
});

// Las cuatro funciones de la noche juntas (asignaciones/RECONCILIACION-CONTRATO.md): ni tsc ni las pruebas de cada una
// ven un id de fixture repetido (el router del FRONT vería dos entidades con el mismo id) ni una revisión con los dos
// campos opcionales nuevos a la vez.
describe('convivencia de las funciones nuevas', () => {
  it('ningún id de fixture de ids.ts se repite', () => {
    const uuids = Object.entries(ids).filter(([, v]) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v));
    const porValor = new Map<unknown, string[]>();
    for (const [k, v] of uuids) porValor.set(v, [...(porValor.get(v) ?? []), k]);
    expect([...porValor.values()].filter((ks) => ks.length > 1)).toEqual([]);
  });
  it('una revisión lleva gate y delta a la vez; el estado del bloqueo con la foto de cada push cumple E45', () => {
    const [pr, ...pushes] = fx.codeReviewStateBloqueo.recent;
    const conFoto = { ...fx.codeReviewStateBloqueo,
      recent: [{ ...pr!, delta: null }, ...pushes.map((r) => ({ ...r, delta: fx.deltasRevision[r.id] ?? null }))] };
    expect(c.CodeReviewState.safeParse(conFoto).success).toBe(true);
    // Los dos campos a la vez solo en un push (en un PR, delta es null): el push de la clave con el bloqueo ya encendido.
    const push = pushes[0]!;
    const lo = push.findings.map((f) => ({ ...f, finding_id: null }));   // en gate.findings, finding_id siempre null
    const ambos = { ...push, gate: { ...c.CodeReview.parse(pr).gate!, findings: lo }, delta: fx.deltasRevision[push.id] };
    expect(push.event).toBe('push');
    expect(c.CodeReview.parse(ambos)).toMatchObject({ gate: { state: 'failure' }, delta: { first: false } });
    expect(c.CodeReviewQuery.parse({})).toEqual({});   // el FRONT de hoy llama a E45 sin ?connection_id
  });
});

describe('E57 simular ataque', () => {
  it('kind por defecto ip_flood (la única crítica) y solo los tres tipos', () => {
    expect(c.SimulateAttackIn.parse({}).kind).toBe('ip_flood');
    expect(c.SimulateAttackIn.safeParse({ kind: 'ddos' }).success).toBe(false);
  });
  it('la respuesta dice qué hizo cada canal', () => {
    const r = { incident_id: '00000000-0000-4000-a000-0000000000a1', code: 'AB12CD', whatsapp: 'queued', voice: 'skipped' };
    expect(c.SimulateAttackOut.parse(r)).toEqual(r);
    expect(c.SimulateAttackOut.safeParse({ ...r, voice: 'sent' }).success).toBe(false);
  });
});
