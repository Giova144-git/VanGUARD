import { describe, expect, it } from 'vitest';
import { caminoValido, esId } from './ids';

describe('esId', () => {
  it('acepta UUID en minúsculas y mayúsculas', () => {
    expect(esId('9e0b0000-0000-4000-8000-000000000001')).toBe(true);
    expect(esId('9E0B0000-0000-4000-8000-00000000000A')).toBe(true);
  });
  it.each(['', '..', '../../me', '..%2F..%2Fme', 'x?y', 'x#y', '<script>alert(1)</script>', '9e0b0000-0000-4000-8000-000000000001/../x', 'a'.repeat(2048)])(
    'rechaza %j', (v) => expect(esId(v)).toBe(false));
  it('rechaza null y undefined', () => {
    expect(esId(null)).toBe(false);
    expect(esId(undefined)).toBe(false);
  });
});

describe('caminoValido', () => {
  it.each(['/api/me', '/api/orgs/00000000-0000-4000-a000-00000000de00/findings/f0000000-0000-4000-8000-000000000001/fix-prompt',
    '/api/orgs/o/export?format=md', '/api/orgs/o/wiki/runs?repo=equipo22-demo%2Fvanguard.web'])('acepta %s', (r) => expect(caminoValido(r)).toBe(true));
  it.each(['/api/orgs/o/findings/../../me', '/api/orgs/o/findings/./x', '/api/orgs/o/findings/%2e%2e/x', '/api/orgs/o/findings/..%2F..%2Fme',
    '/api//me', '/api/orgs/o/findings/x\\..\\y', '/api/orgs/o/findings/x#/fix-prompt', '/apix/me', '/ingest/x', 'https://evil.test/api/me', '//evil.test/api/me'])(
    'rechaza %s', (r) => expect(caminoValido(r)).toBe(false));
});
