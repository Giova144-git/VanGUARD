import { describe, expect, it } from 'vitest';
import { extraerRepoYRama } from '@/lib/pre-guardas';
import { consultaHistorial } from './texto';

describe('extraerRepoYRama', () => {
  it.each([
    ['a/b', 'a/b', null],
    ['  a/b/  ', 'a/b', null],
    ['https://github.com/a/b', 'a/b', null],
    ['https://github.com/acme/tienda.git', 'acme/tienda', null],
    ['https://github.com/acme/tienda.git/', 'acme/tienda', null],
    ['github.com/acme/tienda', 'acme/tienda', null],
    ['https://www.github.com/acme/tienda/tree/main', 'acme/tienda', 'main'],
    ['https://github.com/acme/tienda/tree/feature/login/', 'acme/tienda', 'feature/login'],
  ])('%j → %s (rama %s)', (entrada, repo, rama) => expect(extraerRepoYRama(entrada)).toEqual({ repo, rama }));

  it.each(['', 'foo', 'acme/..', 'acme/.', 'https://gitlab.com/a/b', 'https://github.com/a/b/blob/main/x.ts', 'a.b/c'])(
    '%j → null', (entrada) => expect(extraerRepoYRama(entrada)).toBeNull());

  it('una rama con «..» no se acepta, pero el repo sí', () =>
    expect(extraerRepoYRama('https://github.com/a/b/tree/../../x')).toEqual({ repo: 'a/b', rama: null }));
});

// Los cuatro casos de producción: E43 respondía 422 a la URL pegada, al texto a medias y a ?repo= vacío.
describe('consultaHistorial', () => {
  it('campo vacío: todas las wikis de la org, sin ?repo=', () => expect(consultaHistorial('')).toEqual({ repo: null, consultar: true }));
  it('solo espacios: igual que vacío', () => expect(consultaHistorial('   ')).toEqual({ repo: null, consultar: true }));
  it('texto a medio escribir: no se consulta', () => expect(consultaHistorial('foo')).toEqual({ repo: null, consultar: false }));
  it('URL de GitHub pegada: se normaliza a owner/repo', () =>
    expect(consultaHistorial('https://github.com/a/b')).toEqual({ repo: 'a/b', consultar: true }));
  it('owner/repo: tal cual', () => expect(consultaHistorial('a/b')).toEqual({ repo: 'a/b', consultar: true }));
});
