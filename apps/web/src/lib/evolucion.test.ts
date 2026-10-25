// lib/evolucion.ts con los fixtures de la historia de «Tienda Demo» (asignaciones/evolucion-entre-revisiones.md §9.3).
import { describe, expect, it } from 'vitest';
import { fixtures as fx, CodeReviewState, Evolution, type CodeReview, type CodeReviewDelta } from '@vanguard/contracts';
import {
  cifras, esClave, etiquetaCorregido, etiquetaVersion, horas, lineaFoto, porSeveridad, serieAbiertos, serieCambios,
  serieIncidentes, seriePuntaje, signo, totalMatriz,
} from './evolucion';

const EVO = Evolution.parse(fx.evolution);
const [martes, miercoles] = EVO.points;
const sabado = EVO.points.at(-1)!;
const recientes = CodeReviewState.parse(fx.codeReviewState).recent;
const conFoto = (r: CodeReview): CodeReview => ({ ...r, delta: fx.deltasRevision[r.id] ?? null });
const deltaBase: CodeReviewDelta = { first: false, previous_review_id: null, previous_at: null, open: 7, kept: 7, fixed: 0, fixed_checked: 0, ignored: 0 };
const push = (delta: Partial<CodeReviewDelta> | null, counts: CodeReview['counts'] = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }) =>
  ({ event: 'push' as const, counts, delta: delta && { ...deltaBase, ...delta } });

describe('cifras', () => {
  it('salen de totals y del último punto: 20 en la última, 12 abiertos, 8 nuevos y 6 corregidos (5 comprobados)', () => {
    expect(cifras(EVO)).toEqual({ puntaje: 20, cambio: 0, abiertos: 12, criticos: porSeveridad(sabado.open).critical, nuevos: 8,
      corregidos: 6, comprobados: 5, mttr: { media: 43.2, mediana: 48, n: 5 } });
  });
  it('con la gráfica recortada (truncated) no suma points: siguen las del periodo entero', () => {
    const recortada = { ...EVO, points: EVO.points.slice(-1), truncated: true };
    expect(cifras(recortada)).toMatchObject({ nuevos: 8, corregidos: 6, comprobados: 5, abiertos: 12 });
    expect(totalMatriz(sabado.new)).toBe(7);
  });
  it('por módulo: los conteos se filtran; el puntaje y lo comprobado no se parten', () => {
    const c = cifras(EVO, 'supabase');
    expect(c.puntaje).toBe(20);
    expect(c.comprobados).toBeNull();
    expect(c.nuevos).toBe(totalMatriz(EVO.totals.new, 'supabase'));
    expect(c.nuevos + cifras(EVO, 'cloudflare').nuevos + cifras(EVO, 'codebase').nuevos).toBe(8);
  });
  it('un último punto sin foto no inventa abiertos; un solo punto no tiene cambio', () => {
    const solo = { ...EVO, points: [martes!] };
    expect(cifras(solo)).toMatchObject({ puntaje: 20, cambio: null, abiertos: null, criticos: null });
    expect(signo(22)).toBe('+22');
    expect(signo(-37)).toBe('−37');
    expect(signo(0)).toBe('igual');
  });
});

describe('series', () => {
  it('el punto anterior al historial entra en la del puntaje (20 → 20 → 42 → 57 → 20)', () => {
    const s = seriePuntaje(EVO.points);
    expect(s.map((p) => p.score)).toEqual([20, 20, 42, 57, 20]);
    expect(s[0]).toMatchObject({ id: martes!.scan_run_id, snapshot: false });
  });
  it('nuevos y corregidos: solo puntos con foto y con anterior; corregidos en negativo', () => {
    expect(serieCambios(EVO.points).map((p) => [p.nuevos, p.corregidos])).toEqual([[0, -2], [1, -2], [7, -2]]);
    expect(serieCambios(EVO.points).some((p) => p.id === miercoles!.scan_run_id)).toBe(false);   // first:true
  });
  it('abiertos por severidad: los puntos con foto; baja e info juntas', () => {
    const s = serieAbiertos(EVO.points);
    expect(s).toHaveLength(4);
    expect(s.map((p) => p.critical + p.high + p.medium + p.low)).toEqual([11, 9, 8, 12]);
    expect(serieAbiertos(EVO.points, 'codebase').at(-1)).toMatchObject({ critical: porSeveridad(sabado.open, 'codebase').critical });
  });
  it('incidentes por día: un día por barra hasta hoy en Caracas, los días sin incidentes en 0', () => {
    const s = serieIncidentes(EVO.incidents, 7, Date.parse('2026-10-25T03:00:00.000Z'));   // 24-oct 23:00 en Caracas
    expect(s).toHaveLength(7);
    expect(s.at(-1)!.dia).toBe('2026-10-24');
    expect(s[0]!.dia).toBe('2026-10-18');
    const total = (d: (typeof s)[number]) => d.critical + d.high + d.medium + d.low;
    expect(total(s.at(-1)!)).toBe(fx.incidents.length);
    expect(s.slice(0, -1).every((d) => total(d) === 0)).toBe(true);
  });
  it('incidentes por día: el primer día del periodo móvil (a medias) sale solo si trajo alguno, y la gráfica cuenta lo mismo que E52', () => {
    const ahora = Date.parse('2026-10-25T01:00:00.000Z');                 // 24-oct 21:00 en Caracas: el periodo de 7 días empieza el 17 a las 21:00
    const del17 = [{ day: '2026-10-17', counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 } }, ...EVO.incidents];
    const s = serieIncidentes(del17, 7, ahora);
    expect(s).toHaveLength(8);
    expect(s[0]).toMatchObject({ dia: '2026-10-17', high: 1 });
    expect(s.reduce((a, d) => a + d.critical + d.high + d.medium + d.low, 0)).toBe(fx.incidents.length + 1);
    expect(serieIncidentes(EVO.incidents, 7, ahora)).toHaveLength(7);
    expect(serieIncidentes([{ day: '2026-07-26', counts: del17[0]!.counts }], 90, ahora)).toHaveLength(91);   // tope del contrato
  });
});

describe('textos', () => {
  it('horas: 43,2 → «1 d 19 h»; menos de un día en horas; nada → «—»', () => {
    expect(horas(43.2)).toBe('1 d 19 h');
    expect(horas(48)).toBe('2 d');
    expect(horas(23.6)).toBe('1 d');
    expect(horas(5.2)).toBe('5 h');
    expect(horas(0.25)).toBe('15 min');
    expect(horas(null)).toBe('—');
  });
  it('etiquetaVersion en hora de Caracas', () => {
    expect(etiquetaVersion(miercoles!.at)).toMatch(/^mié\.? 21 · 14:03$/);
    expect(etiquetaVersion('no-es-fecha')).toBe('—');
  });
  it('etiquetaCorregido: una clave verificada no está «comprobada»; mapa cerrado', () => {
    expect(esClave('CB_SECRET_STRIPE_LIVE')).toBe(true);
    expect(esClave('CB_ENV_COMMITTED')).toBe(true);
    expect(esClave('SB_RLS_DISABLED')).toBe(false);
    expect(etiquetaCorregido({ status: 'verified', rule_id: 'CB_SECRET_GENERIC' })).toEqual({ texto: 'Ya no está en el código · rota la clave', rol: 'aviso' });
    expect(etiquetaCorregido({ status: 'verified', rule_id: 'SB_ADVISOR_UNUSED_INDEX' })).toEqual({ texto: 'Comprobado', rol: 'bien' });
    expect(etiquetaCorregido({ status: 'fixed', rule_id: 'CB_SECRET_GENERIC' })).toEqual({ texto: 'Marcado a mano', rol: 'neutra' });
    expect(etiquetaCorregido({ status: 'open', rule_id: 'SB_RLS_DISABLED' })).toEqual({ texto: 'Volvió a aparecer', rol: 'aviso' });
    expect(etiquetaCorregido({ status: 'ignored', rule_id: 'SB_RLS_DISABLED' })).toBeNull();
    expect(etiquetaCorregido({ status: 'verified', rule_id: 'SB_RLS_DISABLED' }, 'new')).toEqual({ texto: 'Ya corregido', rol: 'neutra' });
    expect(etiquetaCorregido({ status: 'open', rule_id: 'SB_RLS_DISABLED' }, 'new')).toBeNull();
    expect(etiquetaCorregido({ status: 'verified', rule_id: 'SB_RLS_DISABLED' }, 'kept')).toBeNull();
    expect(etiquetaCorregido({ status: '__proto__' as never, rule_id: 'SB_RLS_DISABLED' })).toBeNull();
  });
});

describe('lineaFoto (fila de cada push)', () => {
  it('el push de las 19:20Z: «1 nuevo · 7 siguen abiertos · 0 corregidos desde el push anterior»', () => {
    const secreto = recientes.find((r) => r.id === fx.codeReviewState.recent[0]!.id)!;
    expect(lineaFoto(conFoto(secreto))).toBe('1 nuevo · 7 siguen abiertos · 0 corregidos desde el push anterior');
  });
  it('con corregidos y comprobados: el push limpio del sábado', () => {
    const limpio = recientes.find((r) => r.id === fx.codeReviewState.recent[1]!.id)!;
    expect(lineaFoto(conFoto(limpio))).toBe('0 nuevos · 7 siguen abiertos · 2 corregidos desde el push anterior (1 comprobado por una auditoría)');
    expect(lineaFoto(push({ fixed: 3, fixed_checked: 2, ignored: 1, kept: 1 })))
      .toBe('0 nuevos · 1 sigue abierto · 3 corregidos desde el push anterior (2 comprobados por una auditoría) · 1 ignorado');
  });
  it('primer push con foto (first:true): punto de partida', () => {
    const r = EVO.reviews[0]!;                                  // E52 trae los nuevos en `new`
    const jueves = { event: r.event, counts: r.new, delta: r.delta };
    expect(jueves.delta?.first).toBe(true);
    expect(lineaFoto(jueves)).toBe('3 siguen abiertos en Codebase · desde el próximo push verás los corregidos');
    expect(lineaFoto(jueves, true)).toBe('3 siguen abiertos en Codebase (todos los repos) · desde el próximo push verás los corregidos');
  });
  it('con varios repos lo dice; un PR o un push sin foto, nada', () => {
    expect(lineaFoto(push({}, { critical: 0, high: 2, medium: 0, low: 0, info: 0 }), true))
      .toBe('2 nuevos · 7 siguen abiertos en Codebase (todos los repos) · 0 corregidos desde el push anterior');
    expect(lineaFoto(push(null))).toBeNull();
    expect(lineaFoto({ ...push({}), delta: undefined })).toBeNull();
    expect(lineaFoto({ ...push({}), event: 'pull_request' })).toBeNull();
  });
});
