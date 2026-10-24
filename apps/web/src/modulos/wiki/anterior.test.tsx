import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { fixtures as fx, type WikiEstimate, type WikiRun } from '@vanguard/contracts';
import { hace } from '@/lib/formato';
import { wikiAnterior } from './texto';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const { Estimacion } = await import('./PaginaWiki');

const E = { ...(fx.wikiEstimate as WikiEstimate), cached_run_id: null, commit_sha: 'b'.repeat(40) };
const base = (fx.wikiRuns as WikiRun[])[0]!;
const run = (id: string, c: Partial<WikiRun>): WikiRun => ({ ...base, id, repo_full_name: E.repo_full_name, ...c });

describe('hace', () => {
  const ahora = new Date('2026-10-24T15:00:00Z');
  it.each([
    ['2026-10-24T14:59:40Z', 'hace un momento'], ['2026-10-24T14:55:00Z', 'hace 5 min'],
    ['2026-10-24T12:00:00Z', 'hace 3 h'], ['2026-10-22T15:00:00Z', 'hace 2 d'],
  ])('%s → %s', (t, txt) => expect(hace(t, ahora)).toBe(txt));
  it('sin fecha o con una inválida → —', () => { expect(hace(null, ahora)).toBe('—'); expect(hace('x', ahora)).toBe('—'); });
});

describe('wikiAnterior', () => {
  const vieja = run('00000000-0000-4000-8000-0000000000a1', { status: 'succeeded', commit_sha: 'a'.repeat(40), finished_at: '2026-10-24T10:00:00Z' });
  const nueva = run('00000000-0000-4000-8000-0000000000a2', { status: 'succeeded', commit_sha: 'c'.repeat(40), finished_at: '2026-10-24T12:00:00Z' });
  it('la terminada más reciente del mismo repo y de otro commit', () => expect(wikiAnterior([vieja, nueva], E)?.id).toBe(nueva.id));
  it('también la del mismo commit (la caché incluye la huella de los hallazgos)', () => {
    const misma = run('00000000-0000-4000-8000-0000000000a3', { status: 'succeeded', commit_sha: E.commit_sha, finished_at: '2026-10-24T13:00:00Z' });
    expect(wikiAnterior([vieja, nueva, misma], E)?.id).toBe(misma.id);
  });
  it('ignora fallidas, en curso y de otro repo', () => {
    expect(wikiAnterior([
      run('00000000-0000-4000-8000-0000000000b1', { status: 'failed', commit_sha: 'a'.repeat(40) }),
      run('00000000-0000-4000-8000-0000000000b2', { status: 'running', commit_sha: 'a'.repeat(40) }),
      run('00000000-0000-4000-8000-0000000000b3', { status: 'succeeded', repo_full_name: 'otro/repo', commit_sha: 'a'.repeat(40) }),
    ], E)).toBeNull();
  });
});

describe('Estimacion sin caché', () => {
  const pintar = (anterior: WikiRun | null) => renderToStaticMarkup(
    <Estimacion e={E} ocupado={false} alGenerar={() => {}} alRegenerar={async () => {}} alVer={() => {}} anterior={anterior} />);
  it('con una wiki anterior: «Generar» y, al lado, verla gratis con su commit corto', () => {
    const html = pintar(run('00000000-0000-4000-8000-0000000000a2', { status: 'succeeded', commit_sha: 'c'.repeat(40), finished_at: new Date(Date.now() - 2 * 3_600_000).toISOString() }));
    expect(html).toContain('Generar wiki');
    expect(html).toMatch(/Ver la wiki del commit .*ccccccc.*, de hace 2 h \(gratis\)/);
  });
  it('del mismo commit: «Ver la wiki anterior de este commit»', () => {
    const html = pintar(run('00000000-0000-4000-8000-0000000000a3', { status: 'succeeded', commit_sha: E.commit_sha, finished_at: new Date(Date.now() - 5 * 60_000).toISOString() }));
    expect(html).toContain('Ver la wiki anterior de este commit, de hace 5 min (gratis)');
  });
  it('sin wiki anterior: solo «Generar»', () => expect(pintar(null)).not.toContain('Ver la wiki'));
});
