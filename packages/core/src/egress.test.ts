// Casos de S15 15.13 / S06 06.3 para egress.ts.
import { describe, it, expect } from 'vitest';
import { assertAllowedUrl, HOSTS_SALIDA } from './egress.ts';

describe('assertAllowedUrl', () => {
  it('https://api.github.com/repos/acme/web pasa', () => {
    expect(assertAllowedUrl('https://api.github.com/repos/acme/web').hostname).toBe('api.github.com');
    expect(() => assertAllowedUrl(new URL('https://api.supabase.com/v1/projects/abc/health'))).not.toThrow();
  });
  it('http://, credenciales en la URL, host ajeno y sufijo engañoso lanzan', () => {
    expect(() => assertAllowedUrl('http://api.github.com/repos/acme/web')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://user:pw@api.github.com/repos/acme/web')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://evil.example/x')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://api.github.com.evil.example/repos/acme/web')).toThrow('EGRESS_BLOCKED');
  });
  it('tampoco pasan: solo usuario, puerto explícito, subdominio, URL inválida ni hosts fuera por A7', () => {
    expect(() => assertAllowedUrl('https://user@api.github.com/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://api.github.com:8443/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://x.api.github.com/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('no es una url')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://codeload.github.com/acme/web/zip/main')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://www.cisa.gov/kev.json')).toThrow('EGRESS_BLOCKED');
  });
  it('el error no repite la URL (podría llevar un secreto en la query)', () => {
    expect(() => assertAllowedUrl('https://evil.example/?token=SECRETO123')).toThrow(/^EGRESS_BLOCKED:host$/);
  });
  it('todos los hosts de la lista pasan', () => {
    for (const h of HOSTS_SALIDA) expect(() => assertAllowedUrl(`https://${h}/`)).not.toThrow();
  });
});
