// E45 tolerante: un valor nuevo del BACK degrada su pieza en vez de dejar sin tarjeta de revisión (riesgo (a)).
import { describe, expect, it } from 'vitest';
import { fixtures as fx, CodeReviewState } from '@vanguard/contracts';
import { CodeReviewStateTolerante } from './revision-tolerante';
import { chipBloqueo, chipHook } from './revision';

const BASE = CodeReviewState.parse(fx.codeReviewStateBloqueo);
const conGate = BASE.recent.find((r) => r.gate)!;
const crudo = () => structuredClone(BASE) as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('CodeReviewStateTolerante', () => {
  it('un cuerpo que cumple el contrato sale igual', () => {
    expect(CodeReviewStateTolerante.parse(structuredClone(BASE))).toEqual(BASE);
  });

  it('gate.error con otro formato y un CommitStatusState nuevo no tumban la tarjeta', () => {
    const c = crudo();
    const i = BASE.recent.indexOf(conGate);
    c.recent[i].gate.error = 'Otro-Formato';
    c.recent[i].gate.state = 'queued';
    expect(CodeReviewState.safeParse(c).success).toBe(false);
    const r = CodeReviewStateTolerante.parse(c);
    expect(r.recent).toHaveLength(BASE.recent.length);
    expect(r.recent[i]!.gate).toMatchObject({ state: null, error: 'otro' });
    expect(chipBloqueo(r.recent[i]!)).toMatchObject({ rol: 'neutra' });
  });

  it('un estado del hook nuevo pasa tal cual y su chip sale «—»; last_error desconocido, null', () => {
    const c = crudo();
    c.config.state = 'suspended';
    c.config.last_error = 'cuota';
    const r = CodeReviewStateTolerante.parse(c);
    expect(r.config!.last_error).toBeNull();
    expect(chipHook(r.config!, () => '')).toEqual({ texto: '—', rol: 'neutra' });
  });

  it('config.gate fuera de contrato se quita; el resto de la config sigue', () => {
    const c = crudo();
    c.config.gate = { ...c.config.gate, state: 'nuevo_estado' };
    const r = CodeReviewStateTolerante.parse(c);
    expect(r.config!.gate).toBeUndefined();
    expect(r.config!.repo_full_name).toBe(BASE.config!.repo_full_name);
  });

  it('una revisión rota de verdad se salta sin perder las demás', () => {
    const c = crudo();
    c.recent[0].status = 'cancelada';
    const r = CodeReviewStateTolerante.parse(c);
    expect(r.recent).toHaveLength(BASE.recent.length - 1);
  });

  it('un cuerpo que no es E45 sigue fallando', () => {
    expect(CodeReviewStateTolerante.safeParse({ nada: true }).success).toBe(false);
  });
});
