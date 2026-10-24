import { describe, expect, it } from 'vitest';
import { arregloDe, cmpVersion, dedupeAvisos, filaDep, type Dep } from './osv.ts';

// Fixtures JSON sin red (§15.13: dos ids con el mismo alias CVE → un hallazgo).
const lodash: Dep = { ecosystem: 'npm', name: 'lodash', version: '4.17.15', dev: false };
const rango = (intro: string, fixed: string, name = 'lodash') =>
  ({ package: { name, ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: intro }, { fixed }] }] });

describe('osv', () => {
  it('compara versiones por segmentos numéricos', () => {
    expect(cmpVersion('1.10.0', '1.9.9')).toBe(1);
    expect(cmpVersion('4.17.15', '4.17.21')).toBe(-1);
    expect(cmpVersion('v2.5.2', '2.5.2')).toBe(0);
  });

  it('dos ids con el mismo alias CVE son un solo aviso', () => {
    const a = [
      { id: 'GO-2021-0113', aliases: ['CVE-2021-38561'] },
      { id: 'GHSA-ppp9-7jff-5vj2', aliases: ['CVE-2021-38561'], database_specific: { severity: 'HIGH' } },
    ];
    expect(dedupeAvisos(a)).toHaveLength(1);
    expect(filaDep(lodash, a).evidence.n_avisos).toBe(1);
  });

  it('el arreglo sale solo del rango del mismo paquete que contiene la versión', () => {
    const aviso = { id: 'GHSA-x', affected: [rango('0', '4.17.21'), rango('0', '9.9.9', 'lodash-es')] };
    expect(arregloDe(aviso, lodash)).toBe('4.17.21');
    expect(arregloDe({ id: 'GHSA-y', affected: [rango('4.18.0', '4.18.1')] }, lodash)).toBeNull();
  });

  it('un hallazgo por paquete con la mayor severidad, el mayor arreglo, CVE visible y ≤ 10 avisos', () => {
    const avisos = Array.from({ length: 12 }, (_, i) => ({
      id: `GHSA-${i}`, aliases: [`CVE-2026-${1000 + i}`],
      database_specific: { severity: i === 3 ? 'HIGH' : 'MODERATE' },
      affected: [rango('0', i === 5 ? '4.18.0' : '4.17.21')],
    }));
    const f = filaDep(lodash, avisos);
    expect(f.rule_id).toBe('CB_DEP_VULN');
    expect(f.severity).toBe('high');
    expect(f.resource).toBe('npm:lodash@4.17.15');
    expect(f.evidence.version_arreglo).toBe('4.18.0');
    expect(f.evidence.n_avisos).toBe(12);
    expect((f.evidence.avisos as unknown[]).length).toBe(10);
    expect((f.evidence.avisos as { id: string }[])[0]?.id).toBe('CVE-2026-1003');
    expect(f.evidence.urgencia).toBe('hoy');
  });

  it('MAL-* es critical con urgencia ahora; sin severidad es medium por defecto', () => {
    expect(filaDep(lodash, [{ id: 'MAL-2026-1' }]).severity).toBe('critical');
    expect(filaDep(lodash, [{ id: 'MAL-2026-1' }]).evidence.urgencia).toBe('ahora');
    const sin = filaDep(lodash, [{ id: 'PYSEC-1' }]);
    expect(sin.severity).toBe('medium');
    expect((sin.evidence.avisos as { severidad_por_defecto?: boolean }[])[0]?.severidad_por_defecto).toBe(true);
  });
});
