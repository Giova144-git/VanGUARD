import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@vanguard/contracts';
import { destinoTrasEntrar, esOrgDeDemo, nextDe } from './aterrizaje';

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
    expect(destinoTrasEntrar(me([]), '/o/x/overview?finding=y')).toBe('/o/x/overview?finding=y');
    expect(destinoTrasEntrar(me([]), '//evil')).toBe('/start');
    expect(destinoTrasEntrar(me([]), '/\\evil')).toBe('/start');                 // el navegador lee /\ como //
    expect(destinoTrasEntrar(me([]), 'https://evil')).toBe('/start');
  });
  it('decide con el parser de URL: ni controles que el navegador borra ni rutas que normalizan a //host', () => {
    // El parser quita tab, LF y CR: '/\t/evil' sería //evil.
    for (const n of ['/\t/evil', '/\n/evil', '/\r/evil', '/\r\\evil', '/\t\\evil', '/\u0000/evil', '/\u007f/evil', 'o/x', ''])
      expect(destinoTrasEntrar(me([]), n), JSON.stringify(n)).toBe('/start');
    // '..' y '.' se resuelven antes de mirar la ruta: '/..//evil' queda en //evil.
    for (const n of ['/..//evil', '/.//evil', '/%2e%2e//evil', '/o/../..//evil'])
      expect(destinoTrasEntrar(me([]), n), n).toBe('/start');
    // next sale de params.get('next'), que ya decodifica una vez: %09 en la URL llega como un tab.
    expect(destinoTrasEntrar(me([]), new URLSearchParams('next=%2F%09%2Fevil').get('next'))).toBe('/start');
    expect(destinoTrasEntrar(me([]), new URLSearchParams('next=/%09/evil').get('next'))).toBe('/start');
    // Doblemente codificado llega como '%09' literal: el navegador no lo decodifica en la ruta y se queda en el sitio.
    expect(destinoTrasEntrar(me([]), new URLSearchParams('next=%2F%2509%2Fevil').get('next'))).toBe('/%09/evil');
    expect(destinoTrasEntrar(me([]), '/%2F%2Fevil')).toBe('/%2F%2Fevil');
  });
  it('devuelve la ruta interna ya normalizada, con su consulta y su ancla', () => {
    expect(destinoTrasEntrar(me([]), '/o/x/audit?run=r1&estado=abierto')).toBe('/o/x/audit?run=r1&estado=abierto');
    expect(destinoTrasEntrar(me([]), '/o/x/overview#ahora')).toBe('/o/x/overview#ahora');
    expect(destinoTrasEntrar(me([]), '/o/x/../y/overview')).toBe('/o/y/overview');
    expect(destinoTrasEntrar(me([]), '/o/x/wiki?repo=a b')).toBe('/o/x/wiki?repo=a%20b');
    expect(destinoTrasEntrar(me([]), '/')).toBe('/');
  });
  it('usa la última org si sigue en me.orgs', () => {
    guardado['vg-ultima-org'] = 'b';
    expect(destinoTrasEntrar(me([org('a', false), org('b', false)]), null)).toBe('/o/b');
    guardado['vg-ultima-org'] = 'zz';
    expect(destinoTrasEntrar(me([org('a', false)]), null)).toBe('/o/a');
  });
  it('ignora una última org que sea la demo o una sandbox, o que ya no exista, y prefiere la propia', () => {
    const copia = { ...org('sb', false), sandbox: true };
    guardado['vg-ultima-org'] = 'sb';
    expect(destinoTrasEntrar(me([copia, org('mia', false)]), null)).toBe('/o/mia');
    guardado['vg-ultima-org'] = 'demo';
    expect(destinoTrasEntrar(me([org('demo', true, 'viewer'), org('mia', false)]), null)).toBe('/o/mia');
    guardado['vg-ultima-org'] = 'borrada';
    expect(destinoTrasEntrar(me([copia, org('mia', false)]), null)).toBe('/o/mia');
    // Solo con su copia temporal (que es «owner»): a /start, no a la sandbox.
    expect(destinoTrasEntrar(me([copia]), null)).toBe('/start');
    // El equipo, dueño de la demo compartida, sigue entrando a ella.
    expect(destinoTrasEntrar(me([copia, org('demo', true, 'owner')]), null)).toBe('/o/demo');
  });
  it('esOrgDeDemo: la demo compartida y la sandbox', () => {
    expect(esOrgDeDemo({ is_demo: true })).toBe(true);
    expect(esOrgDeDemo({ is_demo: false, sandbox: true })).toBe(true);
    expect(esOrgDeDemo({ is_demo: false })).toBe(false);
  });
  it('prefiere una org propia a la de demo y manda a /start si solo es viewer de la demo', () => {
    expect(destinoTrasEntrar(me([org('demo', true, 'viewer'), org('mia', false)]), null)).toBe('/o/mia');
    expect(destinoTrasEntrar(me([org('demo', true, 'viewer')]), null)).toBe('/start');
  });
});

describe('nextDe', () => {
  it('quita los parámetros que deja un canje PKCE fallido y conserva los de la app', () => {
    expect(nextDe('/o/x/overview', '?finding=y')).toBe('/o/x/overview?finding=y');
    expect(nextDe('/o/x/overview', '')).toBe('/o/x/overview');
    expect(nextDe('/o/x', '?code=abc&flow_id=f&error=e&error_code=c&error_description=d')).toBe('/o/x');
    expect(nextDe('/o/x/audit', '?code=abc&run=r1&estado=abierto')).toBe('/o/x/audit?run=r1&estado=abierto');
  });
});
