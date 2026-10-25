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
  it('raw.githubusercontent.com pasa (DeepWiki, paso area); sus vecinos de LFS y objetos no', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(assertAllowedUrl(`https://raw.githubusercontent.com/acme/web/${sha}/src/a.ts`).hostname).toBe('raw.githubusercontent.com');
    expect(() => assertAllowedUrl(`http://raw.githubusercontent.com/acme/web/${sha}/src/a.ts`)).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl(`https://media.githubusercontent.com/media/acme/web/${sha}/a.bin`)).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://objects.githubusercontent.com/x')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://raw.githubusercontent.com.evil.example/acme/web')).toThrow('EGRESS_BLOCKED');
  });
  it('servidor de voz: un subdominio de una etiqueta de onrender.com pasa; anidados, sufijos, http y Railway no', () => {
    expect(assertAllowedUrl('https://vanguard-voz.onrender.com/operator/api/outbound/call').hostname)
      .toBe('vanguard-voz.onrender.com');
    expect(() => assertAllowedUrl('https://a.b.onrender.com/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://onrender.com/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://x.onrender.com.evil.example/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://x-onrender.com/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('http://x.onrender.com/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://-x.onrender.com/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://x.up.railway.app/')).toThrow('EGRESS_BLOCKED');
  });
  it('servidor de voz en Hugging Face Spaces: <usuario>-vanguard-voz.hf.space pasa; anidados, sufijos y http no', () => {
    expect(assertAllowedUrl('https://giova-vanguard-voz.hf.space/healthz').hostname).toBe('giova-vanguard-voz.hf.space');
    expect(() => assertAllowedUrl('https://a.b.hf.space/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://hf.space/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://x.hf.space.evil.example/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://x-hf.space/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('http://x.hf.space/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://x.hf.space:8443/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://huggingface.co/')).toThrow('EGRESS_BLOCKED');
  });
  it('servidor de voz en un GitHub Codespace: <codespace>-8080.app.github.dev pasa; anidados, sufijos, github.dev y http no', () => {
    expect(assertAllowedUrl('https://glorious-space-guide-x7w9q4-8080.app.github.dev/healthz').hostname)
      .toBe('glorious-space-guide-x7w9q4-8080.app.github.dev');
    expect(() => assertAllowedUrl('https://a.b.app.github.dev/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://app.github.dev/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://x.github.dev/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://x.app.github.dev.evil.example/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://x-app.github.dev/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('http://x-8080.app.github.dev/')).toThrow('EGRESS_BLOCKED');
    expect(() => assertAllowedUrl('https://x-8080.app.github.dev:8080/')).toThrow('EGRESS_BLOCKED');
  });
  it('el error no repite la URL (podría llevar un secreto en la query)', () => {
    expect(() => assertAllowedUrl('https://evil.example/?token=SECRETO123')).toThrow(/^EGRESS_BLOCKED:host$/);
  });
  it('todos los hosts de la lista pasan', () => {
    for (const h of HOSTS_SALIDA) expect(() => assertAllowedUrl(`https://${h}/`)).not.toThrow();
  });
});
