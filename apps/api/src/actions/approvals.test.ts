import { describe, expect, it } from 'vitest';
import { parsearBoton } from './approvals.ts';

describe('parsearBoton (regex de S15 15.10)', () => {
  const nonce = 'Zx9kQm2Lp0Ab7Yt4cD3eFg';

  it('lee las cinco acciones con su código de incidente y nonce', () => {
    for (const accion of ['ack', 'snz', 'ok', 'no', 'blk'] as const) {
      expect(parsearBoton(`${accion}:A1F3C9:${nonce}`)).toEqual({ accion, codigo: 'A1F3C9', nonce });
    }
  });

  it('rechaza acciones desconocidas, códigos en minúsculas, nonces cortos o con otros caracteres y textos libres', () => {
    for (const p of [`del:A1F3C9:${nonce}`, `ack:a1f3c9:${nonce}`, 'ack:A1F3C9:corto', `ack:A1F3C9:${nonce}!`, 'noop',
      'VERIFICAR 1A2B3C', `ack:A1F3C9:${nonce}:extra`]) {
      expect(parsearBoton(p)).toBeNull();
    }
  });
});
