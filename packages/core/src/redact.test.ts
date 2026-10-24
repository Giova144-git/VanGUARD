// Casos de S15 15.11/15.13, S06 06.5 y S13 13.2 para redact.ts. Todo valor con forma de secreto se construye en tiempo
// de ejecución (S06 06.4, prueba 10): ningún escáner, ni el nuestro ni el del jurado, encuentra literales en el repo.
import { describe, it, expect } from 'vitest';
import { redact, redactString, redactForExport, PATRONES_SECRETO } from './redact.ts';

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const R = (n: number, base = 'Ab1Cd2Ef3Gh4') => base.repeat(Math.ceil(n / base.length)).slice(0, n);

// [nombre, secreto en claro, texto que lo contiene, marcador esperado]
const CASOS: Array<[string, string, string]> = [
  ['jwt', b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ role: 'service_role', iss: 'supabase' }) + '.' + R(43), '[REDACTADO:jwt]'],
  ['sb_secret_', 'sb_' + 'secret_' + R(32), '[REDACTADO:supabase]'],
  ['sb_publishable_', 'sb_' + 'publishable_' + R(32), '[REDACTADO:supabase]'],
  ['sbp_', 'sb' + 'p_fc' + R(40, 'a1b2c3'), '[REDACTADO:supabase]'],
  ['github_pat_', 'github_' + 'pat_' + R(60), '[REDACTADO:github]'],
  ['gh[pousr]_', 'gh' + 'p_' + R(36), '[REDACTADO:github]'],
  ['sk-ant-', 'sk-' + 'ant-api03-' + R(80), '[REDACTADO:api_key]'],
  ['sk-proj-', 'sk-' + 'proj-' + R(48), '[REDACTADO:api_key]'],
  ['sk- genérico', 'sk-' + R(48), '[REDACTADO:api_key]'],
  ['sk_live_', 'sk' + '_live_' + R(24), '[REDACTADO:api_key]'],
  ['xox', 'xo' + 'xb-' + R(30, '1234-abcd'), '[REDACTADO:token]'],
  ['vgk_', 'vg' + 'k_' + R(40), '[REDACTADO:token]'],
  ['vgi_', 'vg' + 'i_' + R(43), '[REDACTADO:token]'],
  ['vgs_', 'vg' + 's_' + R(32), '[REDACTADO:token]'],
  ['cfk_', 'cf' + 'k_' + R(40), '[REDACTADO:cloudflare]'],
  ['cfut_', 'cf' + 'ut_' + R(40), '[REDACTADO:cloudflare]'],
  ['cfat_', 'cf' + 'at_' + R(40), '[REDACTADO:cloudflare]'],
  ['AIza', 'AI' + 'za' + R(35), '[REDACTADO:api_key]'],
  ['AKIA', 'AK' + 'IA' + R(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'), '[REDACTADO:token]'],
  ['ASIA', 'AS' + 'IA' + R(16, 'QRSTUVWXYZ234567'), '[REDACTADO:token]'],
  ['Bearer', 'Bea' + 'rer ' + R(40), 'Bearer [REDACTADO]'],
  ['clave privada', '-----BEGIN ' + 'PRIVATE KEY-----\n' + R(64) + '\n-----END ' + 'PRIVATE KEY-----', '[REDACTADO:clave_privada]'],
];

describe('redactString: cada patrón de 15.11 queda enmascarado', () => {
  for (const [nombre, secreto, marcador] of CASOS)
    it(nombre, () => {
      const out = redactString(`antes ${secreto} después`);
      expect(out).not.toContain(secreto);
      expect(out).toContain(marcador);
      expect(redactString(out)).toBe(out);   // idempotente
    });
  it('key= de la URL de PSI y el parámetro suelto', () => {
    const k = 'AI' + 'za' + R(35);
    const out = redactString(`GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=x&key=${k} y /run?key=otro${R(10)}`);
    expect(out).not.toContain(k);
    expect(out).not.toContain('otro' + R(10));
    expect(out).toContain('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  });
  it('postgres(ql)://usuario:clave@ deja usuario y tapa la clave', () => {
    const clave = 'Cl4ve' + R(12);
    expect(redactString(`postgresql://admin:${clave}@db.example.com:5432/app`)).toBe('postgresql://admin:[REDACTADO]@db.example.com:5432/app');
    expect(redactString(`postgres://u:${clave}@h/db`)).not.toContain(clave);
  });
  it('correos → a***@dominio; teléfonos E.164 → +58•••4567; query strings fuera', () => {
    expect(redactString('escribe a alice.smith@example.com')).toBe('escribe a a***@example.com');
    expect(redactString('llama al +584121234567')).toBe('llama al +58•••4567');
    expect(redactString('ver https://app.example.com/a/b?token=abc123&x=1#frag')).toBe('ver https://app.example.com/a/b#frag');
  });
  it('hay un caso positivo por cada patrón de PATRONES_SECRETO', () => {
    for (const [re] of PATRONES_SECRETO) {
      const casa = CASOS.some(([, s]) => new RegExp(re.source).test(s))
        || new RegExp(re.source).test('?key=x')
        || new RegExp(re.source).test('postgres://u:p@h');
      expect(casa, re.source).toBe(true);
    }
  });
});

describe('redactString: falsos positivos que NO cambian', () => {
  const intactos = [
    '3f2b8c1e-9d4a-4f6b-8a2e-1c5d7e9f0a3b',                                      // UUID
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',          // SHA-256 hex
    'sb_publishable_',                                                           // sin sufijo
    'lodash@4.17.21',
    '@scope/pkg@1.0.0',
    '@supabase/supabase-js@2.118.0',
    'versión 2.0.0.1 y /api/users',
  ];
  for (const s of intactos) it(s, () => expect(redactString(s)).toBe(s));
});

describe('redact: pasada por clave y por patrón', () => {
  it('claves secretas por segmento → [REDACTADO]; path, input_tokens y max_tokens intactas', () => {
    const out = redact({
      read_token: 'x1', KAPSO_API_KEY: 'x2', secret__token_llamada: 'x3', Authorization: 'x4', sealed: { a: 1 }, wdek: 'x5',
      path: 'src/db.ts', input_tokens: 5, max_tokens: 1024, vacio_token: '',
    });
    expect(out).toEqual({
      read_token: '[REDACTADO]', KAPSO_API_KEY: '[REDACTADO]', secret__token_llamada: '[REDACTADO]', Authorization: '[REDACTADO]',
      sealed: '[REDACTADO]', wdek: '[REDACTADO]', path: 'src/db.ts', input_tokens: 5, max_tokens: 1024, vacio_token: '',
    });
  });
  it('claves de teléfono sin + (Kapso) se enmascaran solo si el valor es un número', () => {
    expect(redact({ from: '584121234567', to: 'in_app', wa_id: '+584129876543' }))
      .toEqual({ from: '+58•••4567', to: 'in_app', wa_id: '+58•••6543' });
  });
  it('recorre arrays y objetos anidados; corta a profundidad 8', () => {
    const s = 'sb_' + 'secret_' + R(32);
    expect(JSON.stringify(redact({ a: [{ b: `log ${s}` }] }))).not.toContain(s);
    let hondo: unknown = 'fin';
    for (let i = 0; i < 10; i++) hondo = { n: hondo };
    expect(JSON.stringify(redact(hondo))).toContain('[demasiado profundo]');
  });
  it('lodash@4.17.21 no se toma por correo dentro de la evidencia', () => {
    expect(redact({ paquete: 'lodash@4.17.21', path: 'package-lock.json' })).toEqual({ paquete: 'lodash@4.17.21', path: 'package-lock.json' });
  });
});

describe('redactForExport (S13 13.2)', () => {
  const s = 'sb_' + 'secret_' + R(32);
  const snap = {
    title: `Clave ${s} en el repo`,
    resource: 'ip:186.92.14.7',
    evidence: {
      path: 'src/lib/db.ts', paths_4xx: ['/.env'], dedupe_key: 'a'.repeat(64), rule_id: 'CB_SECRET_GENERIC', fingerprint_short: 'abcd1234',
      read_token: 'x', password: 'y', api_key: 'z', KAPSO_API_KEY: 'w', correo: 'bob@example.org', version: '2.0.0.1',
      ip: '186.92.14.7', ips: ['186.92.14.7', '2800:3f0::1'], client_ip: '203.0.113.7', top_ips: [{ ip: '198.51.100.23', n: 40 }],
    },
    actions: [{ target: '186.92.14.7' }, { target: 'zona-x' }],
    fix: { text: 'p'.repeat(5000) },
  };
  it('patrones de redact(), clave anclada e IP a /24 solo por posición', () => {
    const out = redactForExport(snap, { ips: 'mask_24' });
    const j = JSON.stringify(out);
    expect(j).not.toContain(s);
    expect(out.title).toBe('Clave [REDACTADO:supabase] en el repo');
    expect(out.resource).toBe('ip:186.92.14.0/24');
    expect(out.evidence).toMatchObject({
      path: 'src/lib/db.ts', paths_4xx: ['/.env'], dedupe_key: 'a'.repeat(64), rule_id: 'CB_SECRET_GENERIC', fingerprint_short: 'abcd1234',
      read_token: '[REDACTADO]', password: '[REDACTADO]', api_key: '[REDACTADO]', KAPSO_API_KEY: '[REDACTADO]',
      correo: 'b***@example.org', version: '2.0.0.1',
      ip: '186.92.14.0/24', ips: ['186.92.14.0/24', '2800:3f0:0::/48'], client_ip: '203.0.113.0/24', top_ips: [{ ip: '198.51.100.0/24', n: 40 }],
    });
    expect(out.actions).toEqual([{ target: '186.92.14.0/24' }, { target: 'zona-x' }]);
    expect(out.fix.text).toHaveLength(5000);                       // fix.text admite hasta 12000
  });
  it('ips:"full" no toca las IP', () => {
    const out = redactForExport(snap, { ips: 'full' });
    expect(out.evidence.ip).toBe('186.92.14.7');
    expect(out.resource).toBe('ip:186.92.14.7');
    expect(out.evidence.read_token).toBe('[REDACTADO]');
  });
  it('idempotente: f(f(x)) === f(x), también con recortes', () => {
    const largo = { title: 't'.repeat(500), resource: 'r'.repeat(400), evidence: { log: 'x'.repeat(3000) }, fix: { text: 'f'.repeat(13000) } };
    for (const v of [snap, largo]) for (const ips of ['mask_24', 'full'] as const) {
      const una = redactForExport(v, { ips });
      expect(JSON.stringify(redactForExport(una, { ips }))).toBe(JSON.stringify(una));
    }
    const out = redactForExport(largo, { ips: 'mask_24' });
    expect(out.title).toHaveLength(300);
    expect(out.title.endsWith('…[truncado]')).toBe(true);
    expect(out.resource).toHaveLength(300);
    expect(out.evidence.log).toHaveLength(2000);
    expect(out.fix.text).toHaveLength(12000);
  });
  it('claves ordenadas y entrada sin mutar', () => {
    const v = { z: 1, a: { y: 2, b: 3 } };
    expect(JSON.stringify(redactForExport(v, { ips: 'mask_24' }))).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(Object.keys(v)).toEqual(['z', 'a']);
  });
});
