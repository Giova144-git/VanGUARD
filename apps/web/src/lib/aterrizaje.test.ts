import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@vanguard/contracts';
import { destinoTrasEntrar } from './aterrizaje';

const org = (id: string, is_demo: boolean, role: 'owner' | 'admin' | 'viewer' = 'owner') => ({ id, name: id, role, is_demo });
const me = (orgs: Me['orgs']): Me => ({ user: { id: 'u', email: 'a@b.c', is_anonymous: false }, orgs });

describe('destinoTrasEntrar', () => {
  let guardado: Record<string, string> = {};
  beforeEach(() => {
    guardado = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => guardado[k] ?? null, setItem: (k: string, v: string) => { guardado[k] = v; } });
  });

  it('respeta next solo si es una ruta interna', () => {
    expect(destinoTrasEntrar(me([]), '/o/x/overview')).toBe('/o/x/overview');
    expect(destinoTrasEntrar(me([]), '//evil.com')).toBe('/start');
    expect(destinoTrasEntrar(me([]), 'https://evil.com')).toBe('/start');
  });
  it('usa la última org si sigue en me.orgs', () => {
    guardado['vg-ultima-org'] = 'b';
    expect(destinoTrasEntrar(me([org('a', false), org('b', false)]), null)).toBe('/o/b');
    guardado['vg-ultima-org'] = 'zz';
    expect(destinoTrasEntrar(me([org('a', false)]), null)).toBe('/o/a');
  });
  it('prefiere una org propia a la de demo y manda a /start si solo es viewer de la demo', () => {
    expect(destinoTrasEntrar(me([org('demo', true, 'viewer'), org('mia', false)]), null)).toBe('/o/mia');
    expect(destinoTrasEntrar(me([org('demo', true, 'viewer')]), null)).toBe('/start');
  });
});
