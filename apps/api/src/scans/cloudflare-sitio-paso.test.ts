import { describe, expect, it } from 'vitest';
import {
  contenidoExpuesto, pareceSecreto, reglasPages, reglasSitio, reglasWorker, RUTAS_EXPUESTAS, type DatosSitio,
} from './cloudflare-sitio-paso.ts';

const HOST = 'mi-app.pages.dev';
const enc = new TextEncoder();
const resp = (status: number, headers: Record<string, string> = {}, cuerpo: string | Uint8Array = '') => ({ status,
  headers: new Headers(headers), cuerpo: typeof cuerpo === 'string' ? enc.encode(cuerpo) : cuerpo,
  location: headers.location ?? null });
const SEGURO = { 'strict-transport-security': 'max-age=31536000; includeSubDomains', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff' };
const datos = (o: Partial<DatosSitio> = {}): DatosSitio => ({ host: HOST, raiz: resp(200, SEGURO, '<!doctype html>'),
  http: resp(301, { location: `https://${HOST}/` }), expuestas: RUTAS_EXPUESTAS.map((ruta) => ({ ruta, r: resp(404) })), ...o });
const reglas = (d: DatosSitio) => reglasSitio(d).map((b) => b.rule_id);

describe('reglas HTTP del sitio (modo url)', () => {
  it('un sitio con cabeceras buenas, redirección a https y nada expuesto no da hallazgos', () => {
    expect(reglasSitio(datos())).toEqual([]);
  });
  it('sin cabeceras: HSTS, CSP, FRAME y NOSNIFF; HSTS de 1 día también cuenta', () => {
    expect(reglas(datos({ raiz: resp(200) }))).toEqual(['CF_SITE_HSTS', 'CF_SITE_CSP', 'CF_SITE_FRAME', 'CF_SITE_NOSNIFF']);
    expect(reglas(datos({ raiz: resp(200, { ...SEGURO, 'strict-transport-security': 'max-age=86400' }) }))).toEqual(['CF_SITE_HSTS']);
    // X-Frame-Options sin frame-ancestors basta para no dar FRAME.
    expect(reglas(datos({ raiz: resp(200, { ...SEGURO, 'content-security-policy': "default-src 'self'", 'x-frame-options': 'DENY' }) }))).toEqual([]);
  });
  it('CORS: * con credenciales es high; * sin credenciales no', () => {
    const cors = reglasSitio(datos({ raiz: resp(200, { ...SEGURO, 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' }) }));
    expect(cors.map((b) => [b.rule_id, b.severity])).toEqual([['CF_SITE_CORS', 'high']]);
    expect(reglas(datos({ raiz: resp(200, { ...SEGURO, 'access-control-allow-origin': '*' }) }))).toEqual([]);
  });
  it('http:// que no redirige a https (200, o redirige a http) → CF_SITE_HTTP', () => {
    expect(reglas(datos({ http: resp(200) }))).toEqual(['CF_SITE_HTTP']);
    expect(reglas(datos({ http: resp(302, { location: `http://${HOST}/inicio` }) }))).toEqual(['CF_SITE_HTTP']);
    expect(reglas(datos({ http: null }))).toEqual([]);   // no se pudo pedir: no se afirma nada
  });
  it('archivos expuestos de verdad → crítico con evidencia sin valores; un fallback de SPA con 200 no cuenta', () => {
    const env = 'DATABASE_URL=postgres://u:pw@db/x\nSTRIPE_KEY=sk_live_algo\n';
    const d = datos({ expuestas: [{ ruta: '/.env', r: resp(200, {}, env) }, { ruta: '/.git/config', r: resp(200, {}, '<!doctype html><html>') },
      { ruta: '/.git/HEAD', r: resp(200, {}, 'ref: refs/heads/main\n') }] });
    const h = reglasSitio(d);
    expect(h.map((b) => [b.rule_id, b.severity, b.resource])).toEqual([['CF_SITE_EXPOSED', 'critical', `site:${HOST}/.env`],
      ['CF_SITE_EXPOSED', 'critical', `site:${HOST}/.git/HEAD`]]);
    expect(h[0]!.evidence).toEqual({ path: '/.env', variables: ['DATABASE_URL', 'STRIPE_KEY'] });
    expect(JSON.stringify(h)).not.toContain('sk_live_algo');
    expect(JSON.stringify(h)).not.toContain('pw@db');
  });
  it('contenidoExpuesto reconoce .DS_Store y un zip por su firma, y no un HTML', () => {
    expect(contenidoExpuesto('/.DS_Store', new Uint8Array([0, 0, 0, 1, 66, 117, 100, 49, 0]))).toBe(true);
    expect(contenidoExpuesto('/backup.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
    expect(contenidoExpuesto('/backup.zip', enc.encode('<html>'))).toBe(false);
    expect(contenidoExpuesto('/.env', enc.encode('<!DOCTYPE html>\nA=1'))).toBe(false);
  });
});

describe('con token: configuración de Pages y Workers', () => {
  it('Pages: variables plain_text que parecen secretos (por nombre o valor), una vez aunque estén en los dos entornos', () => {
    const h = reglasPages(HOST, 'mi-app', { deployment_configs: {
      production: { env_vars: { API_TOKEN: { type: 'plain_text', value: 'abc' }, NODE_VERSION: { type: 'plain_text', value: '20' },
        STRIPE: { type: 'secret_text', value: '' } } },
      preview: { env_vars: { API_TOKEN: { type: 'plain_text', value: 'abc' } } } } });
    expect(h.map((b) => [b.rule_id, b.resource])).toEqual([['CF_PAGES_PLAINTEXT', 'pages:mi-app:API_TOKEN']]);
    expect(JSON.stringify(h)).not.toContain('"abc"');
  });
  it('Worker: plain_text con forma de secreto y workers.dev activo junto a un dominio propio', () => {
    const h = reglasWorker('api.acme.com', 'api', [{ type: 'plain_text', name: 'DB_PASSWORD', text: 'x' },
      { type: 'plain_text', name: 'MODE', text: 'prod' }, { type: 'secret_text', name: 'OTRO' }], true, true);
    expect(h.map((b) => b.rule_id)).toEqual(['CF_WORKER_PLAINTEXT', 'CF_WORKER_DEVSUBDOMAIN']);
    expect(reglasWorker('api.acme.workers.dev', 'api', [], true, false)).toEqual([]);
  });
  it('pareceSecreto: por el nombre o por el escáner de core', () => {
    expect(pareceSecreto('SUPABASE_SERVICE_KEY', '')).toBe(true);
    expect(pareceSecreto('NODE_ENV', 'production')).toBe(false);
  });
});
