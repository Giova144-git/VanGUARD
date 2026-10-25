// Pruebas mínimas de B2 (asignaciones/bloqueo-merge-criticos.md §10.5) y del texto de cierre del PR (anexo
// bloqueo-merge-cierre-pr.md) para revision/bloqueo.ts.
import { describe, expect, it } from 'vitest';
import { bloqueantes, CONTEXTO_BLOQUEO, esRepoDelProducto, estadoCommit, LIM_BLOQUEO, nuevosBloqueo, PARCIAL_BLOQUEA,
  superaBloqueo, textoCierrePr, type FilaBloqueo, type Ignorado, type RevisionBloqueo } from './bloqueo.ts';

const fila = (rule_id: string, severity: string, dedupe_key: string, fp: string | null, resource = `src/${dedupe_key}.ts:3`):
  FilaBloqueo => ({ rule_id, severity, title: `Hallazgo ${rule_id}`, resource, dedupe_key,
  evidence: fp === null ? { path: resource } : { path: resource, fingerprint_short: fp } });
const ign = (rule_id: string, dedupe_key: string, fp: string | null): Ignorado => ({ rule_id, dedupe_key, fp });
const rev = (o: Partial<RevisionBloqueo> = {}): RevisionBloqueo => ({ status: 'done', partial: false, error_code: null,
  gate_blocking: 0, reglas: [], gate_override_at: null, ...o });

describe('bloqueantes', () => {
  const clave = fila('CB_SECRET_STRIPE_LIVE', 'critical', 'k1', 'aaaaaaaa');
  it('lo open bloquea: sin ignorados, toda fila ≥ umbral cuenta (no es counts)', () => {
    expect(bloqueantes([clave], [], 'critical')).toEqual([clave]);
  });
  it('un ignored con la misma huella en el mismo sitio tapa; con otra huella en el mismo sitio no', () => {
    expect(bloqueantes([clave], [ign('CB_SECRET_STRIPE_LIVE', 'k1', 'aaaaaaaa')], 'critical')).toEqual([]);
    expect(bloqueantes([clave], [ign('CB_SECRET_STRIPE_LIVE', 'k1', 'bbbbbbbb')], 'critical')).toEqual([clave]);
  });
  it('mismo rule_id y huella en otro sitio tapa; otra regla con esa huella no', () => {
    expect(bloqueantes([clave], [ign('CB_SECRET_STRIPE_LIVE', 'otro', 'aaaaaaaa')], 'critical')).toEqual([]);
    expect(bloqueantes([clave], [ign('CB_SECRET_GITHUB_PAT', 'otro', 'aaaaaaaa')], 'critical')).toEqual([clave]);
  });
  it('sin huella en un lado tapa en el mismo sitio, pero nunca en otro sitio', () => {
    const env = fila('CB_ENV_COMMITTED', 'critical', 'env', null, '.env');
    expect(bloqueantes([env], [ign('CB_ENV_COMMITTED', 'env', null)], 'critical')).toEqual([]);
    expect(bloqueantes([clave], [ign('CB_SECRET_STRIPE_LIVE', 'k1', null)], 'critical')).toEqual([]);
    expect(bloqueantes([env], [ign('CB_ENV_COMMITTED', 'otro', null)], 'critical')).toEqual([env]);
  });
  it('umbral high incluye high; critical no; medium nunca; una severidad rara no bloquea', () => {
    const alta = fila('CB_SECRET_POSTGRES_URL', 'high', 'k2', 'cccccccc');
    const media = fila('CB_SECRET_GENERIC', 'medium', 'k3', 'dddddddd');
    const rara = fila('CB_SECRET_GENERIC', 'urgente', 'k4', 'eeeeeeee');
    expect(bloqueantes([media, alta, clave, rara], [], 'high').map((f) => f.dedupe_key)).toEqual(['k1', 'k2']);
    expect(bloqueantes([media, alta, clave, rara], [], 'critical').map((f) => f.dedupe_key)).toEqual(['k1']);
    expect([superaBloqueo('high', 'high'), superaBloqueo('high', 'critical'), superaBloqueo('x', 'high')])
      .toEqual([true, false, false]);
  });
  it('sin duplicados por dedupe_key, ordenadas por severidad y después por dedupe_key', () => {
    const b = fila('CB_SECRET_AWS', 'critical', 'b', '11111111');
    const a = fila('CB_SECRET_AWS', 'critical', 'a', '22222222');
    const h = fila('CB_SECRET_POSTGRES_URL', 'high', '0', '33333333');
    expect(bloqueantes([h, b, a, { ...b }], [], 'high').map((f) => f.dedupe_key)).toEqual(['a', 'b', '0']);
  });
});

describe('estadoCommit', () => {
  const RUTA = /[\w.-]+\/[\w./-]*|\.ts:\d+|:\d+/;
  it('done limpio → success; umbral high lo dice; contexto VanGUARD y PARCIAL_BLOQUEA = D2 (a)', () => {
    expect(estadoCommit(rev(), 'critical')).toEqual({ state: 'success', description: 'Sin hallazgos críticos en lo añadido' });
    expect(estadoCommit(rev(), 'high').description).toBe('Sin hallazgos críticos ni altos en lo añadido');
    expect(CONTEXTO_BLOQUEO).toBe('VanGUARD');
    expect(PARCIAL_BLOQUEA).toBe(true);
  });
  it('≥ 1 bloqueante → failure con categoría en singular y plural (completa o parcial)', () => {
    expect(estadoCommit(rev({ gate_blocking: 1, reglas: ['CB_SECRET_STRIPE_LIVE'] }), 'critical')).toEqual({
      state: 'failure', description: '1 crítico: clave o token en el código. Detalle en VanGUARD' });
    expect(estadoCommit(rev({ gate_blocking: 2, reglas: ['CB_SECRET_AWS', 'CB_ENV_COMMITTED'] }), 'critical').description)
      .toBe('2 críticos: clave o token en el código, archivo .env subido. Detalle en VanGUARD');
    expect(estadoCommit(rev({ gate_blocking: 3, reglas: ['CB_SECRET_AWS', 'CB_SECRET_OPENAI', 'CB_ENV_COMMITTED'],
      partial: true, error_code: 'diff_grande' }), 'high')).toEqual({ state: 'failure',
      description: '3 hallazgos críticos o altos: claves o tokens en el código, archivo .env subido. Detalle en VanGUARD' });
    expect(estadoCommit(rev({ gate_blocking: 1, reglas: ['SB_RLS_DISABLED'] }), 'high').description)
      .toBe('1 hallazgo crítico o alto: hallazgo de seguridad. Detalle en VanGUARD');
  });
  it('parcial diff_grande y binario dan textos distintos y el de binario no dice «grande»; truncados → success', () => {
    const grande = estadoCommit(rev({ partial: true, error_code: 'diff_grande' }), 'critical');
    const binario = estadoCommit(rev({ partial: true, error_code: 'binario' }), 'critical');
    expect([grande.state, binario.state]).toEqual(['error', 'error']);
    expect(grande.description).toContain('demasiado grande');
    expect(binario.description).not.toBe(grande.description);
    expect(binario.description).not.toMatch(/grande/i);
    expect(binario.description).toContain('rutas con acentos');
    expect(estadoCommit(rev({ partial: true, error_code: 'hallazgos_truncados' }), 'critical').state).toBe('success');
  });
  it('parcial con parcialBloquea false → success «(revisión incompleta)»', () => {
    expect(estadoCommit(rev({ partial: true, error_code: 'binario' }), 'critical', { parcialBloquea: false })).toEqual({
      state: 'success', description: 'Sin críticos en lo revisado (revisión incompleta)' });
  });
  it('failed → error; queued/running → pending; done sin cálculo → error; «Dar por bueno» manda', () => {
    expect(estadoCommit(rev({ status: 'failed', gate_blocking: null }), 'critical')).toEqual({ state: 'error',
      description: 'No pudimos revisar este cambio. Reenvía la entrega o mira VanGUARD' });
    expect(estadoCommit(rev({ status: 'running' }), 'critical').state).toBe('pending');
    expect(estadoCommit(rev({ gate_blocking: null }), 'critical').state).toBe('error');
    expect(estadoCommit(rev({ gate_blocking: 4, reglas: ['CB_SECRET_AWS'], gate_override_at: '2026-10-24T20:00:00Z' }),
      'critical')).toEqual({ state: 'success', description: 'Aprobado a mano en VanGUARD por un admin' });
    expect(estadoCommit(rev({ status: 'failed', gate_override_at: '2026-10-24T20:00:00Z' }), 'critical').state).toBe('success');
  });
  it('≤ 140 siempre, también con 20 reglas de todas las categorías; sin rutas, «/» ni resource', () => {
    const reglas = Array.from({ length: 20 }, (_, i) => ['CB_SECRET_AWS', 'CB_ENV_COMMITTED', 'CB_DEP_VULN',
      'CB_GITIGNORE_NO_ENV', 'SB_RLS_DISABLED'][i % 5]!);
    for (const umbral of ['critical', 'high'] as const) {
      const e = estadoCommit(rev({ gate_blocking: 1234, reglas }), umbral);
      expect(e.state).toBe('failure');
      expect(e.description.length).toBeLessThanOrEqual(LIM_BLOQUEO.descripcion);
      expect(e.description).toMatch(/Detalle en VanGUARD$/);
      expect(e.description).not.toMatch(RUTA);
    }
    const casos: RevisionBloqueo[] = [rev(), rev({ partial: true, error_code: 'binario' }), rev({ status: 'failed' }),
      rev({ gate_blocking: 1, reglas: ['CB_SECRET_STRIPE_LIVE'] }), rev({ partial: true, error_code: 'raro' })];
    for (const r of casos) {
      const d = estadoCommit(r, 'critical').description;
      expect(d.length).toBeLessThanOrEqual(140);
      expect(d).not.toContain('/');
      expect(d).not.toMatch(RUTA);
      expect(d).not.toContain('src');
    }
  });
});

describe('esRepoDelProducto', () => {
  it('los dos repos del producto en cualquier mezcla de mayúsculas → true; el de la demo → false', () => {
    for (const r of ['platanus-hack/platanus-hack-26-ve-team-22', 'Platanus-Hack/PLATANUS-HACK-26-VE-TEAM-22',
      'Giova144-git/VanGUARD', 'giova144-GIT/vanguard', ' giova144-git/vanguard ']) expect(esRepoDelProducto(r)).toBe(true);
    for (const r of ['gabriel/vanguard-demo-victima', 'Giova144-git/VanGUARD-demo', 'otro/vanguard']) {
      expect(esRepoDelProducto(r)).toBe(false);
    }
  });
});

describe('cierre del PR (anexo)', () => {
  it('nuevosBloqueo: críticos nuevos (y altos con umbral high); lo que no es número no cuenta', () => {
    const c = { critical: 2, high: 3, medium: 1, low: 0, info: 0 };
    expect([nuevosBloqueo(c, 'critical'), nuevosBloqueo(c, 'high')]).toEqual([2, 5]);
    expect(nuevosBloqueo({ critical: 0, high: 0 }, 'high')).toBe(0);
    expect(nuevosBloqueo({ critical: '9', high: -1 }, 'high')).toBe(0);
    expect(nuevosBloqueo(null, 'critical')).toBe(0);
  });
  it('textoCierrePr: texto fijo con singular y plural, el enlace del panel y sin nada más', () => {
    const url = 'https://officialvanguard.com/o/0f6c/codebase?revision=c400';
    expect(textoCierrePr(1, 'critical', url)).toBe('VanGUARD cerró este pull request: trae 1 hallazgo crítico nuevo. '
      + `Corrige el código, rota las claves expuestas y vuelve a abrirlo. Detalle: ${url}`);
    expect(textoCierrePr(3, 'critical', url)).toContain('trae 3 hallazgos críticos nuevos.');
    expect(textoCierrePr(2, 'high', url)).toContain('trae 2 hallazgos críticos o altos nuevos.');
    expect(textoCierrePr(1, 'critical', '')).not.toContain('Detalle');
  });
});
