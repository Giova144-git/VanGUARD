import { describe, expect, it } from 'vitest';
import { ApiError as ApiErrorBody, Health } from '@vanguard/contracts';
import { app } from './app.ts';
import { envDoble } from './test/dobles.ts';

describe('E1 · GET /api/health', () => {
  it('responde 200 con ok, version "dev" sin VG_VERSION y hora ISO en UTC', async () => {
    const r = await app.request('/api/health', {}, envDoble().env);
    expect(r.status).toBe(200);
    const b = Health.parse(await r.json());
    expect(b.version).toBe('dev');
    expect(b.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('usa VG_VERSION y trata la cadena vacía como "dev"', async () => {
    const con = await app.request('/api/health', {}, envDoble({ VG_VERSION: '3f9c2e1a7b' }).env);
    expect(Health.parse(await con.json()).version).toBe('3f9c2e1a7b');
    const vacia = await app.request('/api/health', {}, envDoble({ VG_VERSION: '' }).env);
    expect(Health.parse(await vacia.json()).version).toBe('dev');
  });

  it('lleva las cabeceras de seguridad de §06 y nunca CORS', async () => {
    const r = await app.request('/api/health', { headers: { 'cf-ray': 'ray-1' } }, envDoble().env);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(r.headers.get('x-request-id')).toBe('ray-1');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('errores con la forma fija del contrato', () => {
  it('ruta /api privada sin sesión → 401 unauthorized con request_id', async () => {
    const r = await app.request('/api/nada', {}, envDoble().env);
    expect(r.status).toBe(401);
    const b = ApiErrorBody.parse(await r.json());
    expect(b.error.code).toBe('unauthorized');
    expect(b.error.request_id).toBe(r.headers.get('x-request-id'));
  });

  it('/.env y /.git/config → 404 JSON (no la portada)', async () => {
    for (const ruta of ['/.env', '/.git/config']) {
      const r = await app.request(ruta, {}, envDoble().env);
      expect(r.status).toBe(404);
      expect(ApiErrorBody.parse(await r.json()).error.code).toBe('not_found');
    }
  });

  it('cuerpo de más de 1 MB en /api/* → 413 invalid_body', async () => {
    const r = await app.request('/api/health', {
      method: 'POST', body: 'x'.repeat(1024 * 1024 + 1), headers: { 'content-type': 'application/json' },
    }, envDoble().env);
    expect(r.status).toBe(413);
    expect(ApiErrorBody.parse(await r.json()).error.code).toBe('invalid_body');
  });
});

describe('POST /api/_humo (temporal, A7.7)', () => {
  it('sin VG_HUMO_TOKEN configurado no existe', async () => {
    const r = await app.request('/api/_humo', { method: 'POST', headers: { authorization: 'Bearer x' } }, envDoble().env);
    expect(r.status).toBe(404);
  });

  it('con un token distinto no existe y no encola nada', async () => {
    const d = envDoble({ VG_HUMO_TOKEN: 'secreto-de-prueba' });
    const r = await app.request('/api/_humo', { method: 'POST', headers: { authorization: 'Bearer otro' } }, d.env);
    expect(r.status).toBe(404);
    expect(d.enviados).toHaveLength(0);
  });

  it('con el token encola 3 mensajes de 40 fetch', async () => {
    const d = envDoble({ VG_HUMO_TOKEN: 'secreto-de-prueba' });
    const r = await app.request('/api/_humo', {
      method: 'POST', headers: { authorization: 'Bearer secreto-de-prueba' },
    }, d.env);
    expect(r.status).toBe(202);
    expect(d.enviados).toEqual([1, 2, 3].map((i) => ({ v: 1, kind: 'humo', i, fetches: 40 })));
  });
});
