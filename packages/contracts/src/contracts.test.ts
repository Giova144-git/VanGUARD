// Los fixtures son el contrato que ve el FRONT en modo sin BACK (S14 §14.19): si uno deja de
// cumplir su esquema, o falta una clave, el FRONT se rompe en silencio. Este test lo impide.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as c from './index.ts';

const fx = c.fixtures;

const CLAVES_ESPERADAS = [
  'me', 'meViewer', 'overview', 'overviewVacio', 'moduleState', 'connections', 'permChecks', 'scanRunning', 'scanDone',
  'findings', 'fixPrompt', 'incidents', 'incidentDetail', 'traffic', 'actionProposal', 'contacts', 'aiUsage', 'perfRuns',
  'exportMd', 'mcpTokens',
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
  ['perfRuns', z.array(c.PerfRun), fx.perfRuns],
  ['exportMd', z.string().min(1), fx.exportMd],
  ['mcpTokens', z.array(c.McpTokenPublic), fx.mcpTokens],
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
