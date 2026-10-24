import { describe, expect, it } from 'vitest';
import { AuditSummary, fixtures } from '@vanguard/contracts';
import { ETIQUETA_RESUMEN_SIN_IA, type HallazgoResumen, plantillaResumen, resumenPlantilla } from './summary.ts';

// Entrada de IA-2 (S11 11.12): hallazgos open, sin evidencia, finding_id = findings.id.
const abiertos: HallazgoResumen[] = fixtures.findings.filter((f) => f.status === 'open')
  .map(({ id, module, rule_id, severity, confirmed, title, resource }) => ({ finding_id: id, module, rule_id, severity, confirmed, title, resource }));
const victima = { score: 20, band: 'red' as const, coverage: { seen: 4, total: 4, missing: [] }, hallazgos: abiertos };

describe('plantillaResumen', () => {
  it('valida contra AuditSummary, con model:"template" y sin relaciones', () => {
    const s = plantillaResumen(victima);
    expect(AuditSummary.parse(s)).toEqual(s);
    expect(s.model).toBe('template');
    expect(s.relaciones).toEqual([]);
    expect('suspected_injection' in s).toBe(false);
  });
  it('texto de S11 11.12 precedido de «Resumen automático · sin IA»', () => {
    const s = plantillaResumen(victima);
    const nc = abiertos.filter((h) => h.severity === 'critical').length, nh = abiertos.filter((h) => h.severity === 'high').length;
    const primero = abiertos.find((h) => h.severity === 'critical' && h.confirmed)!;
    expect(s.resumen).toBe(`${ETIQUETA_RESUMEN_SIN_IA}. Puntaje de blindaje 20/100 (rojo). Revisamos 4 de 4 fuentes. `
      + `Tienes ${nc} hallazgos críticos y ${nh} altos abiertos. Empieza por: ${primero.title}.`);
  });
  it('top: 5 por severidad y luego confirmado, con por_que «{severidad}{, confirmado por regla}: {title}»', () => {
    const s = plantillaResumen(victima);
    expect(s.top).toHaveLength(5);
    const ids = s.top.map((t) => abiertos.find((h) => h.finding_id === t.finding_id)!);
    // En la víctima hay 5 critical confirmados: SB_RPC_ANON_NO_LIMIT (critical sin confirmar) queda fuera del top.
    expect(ids.every((h) => h.severity === 'critical' && h.confirmed)).toBe(true);
    expect(ids.some((h) => h.rule_id === 'SB_RPC_ANON_NO_LIMIT')).toBe(false);
    expect(s.top[0]!.por_que).toBe(`Crítica, confirmado por regla: ${ids[0]!.title}`);
    const rpc = abiertos.find((h) => h.rule_id === 'SB_RPC_ANON_NO_LIMIT')!;
    const pol = abiertos.find((h) => h.rule_id === 'SB_POLICY_ALLOW_ALL')!;
    const t = plantillaResumen({ ...victima, hallazgos: [pol, rpc] }).top;
    expect(t.map((x) => x.por_que)).toEqual([`Crítica: ${rpc.title}`, `Alta, confirmado por regla: ${pol.title}`]);
  });
  it('fuentes que faltan, puntaje nulo, singulares y sin hallazgos', () => {
    const s = plantillaResumen({ score: null, band: null, coverage: { seen: 2, total: 4, missing: ['cloudflare', 'performance'] },
      hallazgos: [abiertos.find((h) => h.severity === 'critical')!, abiertos.find((h) => h.severity === 'high')!] });
    expect(s.resumen).toContain('Puntaje de blindaje sin calcular. Revisamos 2 de 4 fuentes; no pudimos revisar Cloudflare y Rendimiento.');
    expect(s.resumen).toContain('Tienes 1 hallazgo crítico y 1 alto abiertos.');
    const vacio = plantillaResumen({ ...victima, hallazgos: [] });
    expect(vacio.resumen.endsWith('No tienes hallazgos abiertos.')).toBe(true);
    expect(vacio.top).toEqual([]);
    expect(AuditSummary.safeParse(vacio).success).toBe(true);
  });
  it('si la IA cayó por el filtro de salida, suspected_injection', () => {
    expect(plantillaResumen({ ...victima, motivos: ['url_no_permitida'] }).suspected_injection).toBe(true);
    expect('suspected_injection' in plantillaResumen({ ...victima, motivos: [] })).toBe(false);
  });
  it('determinista, no muta la entrada y respeta los topes', () => {
    const copia = structuredClone(abiertos);
    expect(plantillaResumen(victima)).toEqual(plantillaResumen(victima));
    const tres = ['low', 'critical', 'high'].map((sev) => abiertos.find((h) => h.severity === sev)!);
    expect(plantillaResumen({ ...victima, hallazgos: tres })).toEqual(plantillaResumen({ ...victima, hallazgos: [...tres].reverse() }));
    expect(abiertos).toEqual(copia);
    const largo = { ...abiertos[0]!, title: 't'.repeat(5000) };
    const s = plantillaResumen({ ...victima, hallazgos: [largo, largo] });
    expect(s.resumen.length).toBeLessThanOrEqual(2000);
    expect(s.top).toHaveLength(1);                                            // finding_id repetido
    expect(s.top[0]!.por_que.length).toBeLessThanOrEqual(300);
    expect(AuditSummary.safeParse(s).success).toBe(true);
    expect(resumenPlantilla).toBe(plantillaResumen);
  });
});
