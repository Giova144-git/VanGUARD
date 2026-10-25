// Pruebas de §10 (core) de asignaciones/modo-bajo-ataque.md: host canónico, la regla de 2 IPs, las guardas, la
// expresión con la caducidad dentro y los textos (los de la demo, idénticos a los fixtures del contrato).
import { describe, expect, it } from 'vitest';
import { fixtures } from '@vanguard/contracts';
import {
  CADUCIDAD_EN_REGLA, CUPO_REGLAS_CONFIG, expresionBajoAtaque, hostCanonico, MIN_IPS_BAJO_ATAQUE, notasBajoAtaque,
  ofreceBajoAtaque, pasosManualesBajoAtaque, pasosRetirarBajoAtaque, refBajoAtaque, reglaBajoAtaque, simularBajoAtaque,
  textoCodigoBajoAtaque, TTL_BAJO_ATAQUE_S,
} from './bajo-ataque.ts';

const HOST = 'demo.officialvanguard.com';
const ZONA = 'officialvanguard.com';
const APR = '5f2c9a10-0000-4000-8000-000000000002';
const HASTA = new Date('2026-10-24T23:42:00Z');
const PROTEGIDOS = [ZONA, `www.${ZONA}`];
const sim = (o: Partial<Parameters<typeof simularBajoAtaque>[0]> = {}) => simularBajoAtaque({ scope: 'host', host: HOST,
  zona: ZONA, protegidos: PROTEGIDOS, zonaProducto: ZONA, plan: 'free', reglasUsadas: null, ttl_s: TTL_BAJO_ATAQUE_S, ...o });
const inc = (o: { status?: string; rule_ids?: string[]; host?: unknown } = {}) =>
  ({ status: o.status ?? 'open', rule_ids: o.rule_ids ?? ['CF_IP_FLOOD'], details: { host: 'host' in o ? o.host : HOST } });

describe('constantes', () => {
  it('30 min, dos IPs, cupos por plan y caducidad en la regla', () => {
    expect([TTL_BAJO_ATAQUE_S, MIN_IPS_BAJO_ATAQUE, CADUCIDAD_EN_REGLA]).toEqual([1800, 2, true]);
    expect(CUPO_REGLAS_CONFIG).toEqual({ free: 10, pro: 25, business: 50, enterprise: 300 });
  });
});

describe('hostCanonico', () => {
  it('normaliza mayúsculas, espacios y el punto final', () => {
    expect(hostCanonico('Demo.OfficialVanguard.com.')).toBe(HOST);
    expect(hostCanonico('  a-b.c0.io ')).toBe('a-b.c0.io');
  });
  it('rechaza lo que no es un host suelto', () => {
    const largo = 'a'.repeat(60) + '.' + 'b'.repeat(56) + '.com';                     // 121 caracteres
    expect(largo).toHaveLength(121);
    for (const malo of ['Tienda Demo', '*.x.com', 'a"b.com', 'x.com:443', 'x.com/a', '203.0.113.7', 'localhost', largo,
      'a'.repeat(64) + '.com', '-a.com', 'a-.com', 'a..com', '', 'ab', 'x.123', 'x.c\nom', null, 42, undefined])
      expect(hostCanonico(malo), String(malo)).toBeNull();
    expect(hostCanonico('a'.repeat(63) + '.com')).toBe('a'.repeat(63) + '.com');
  });
});

describe('ofreceBajoAtaque (la regla)', () => {
  it('CF_IP_FLOOD con 2 IPs → ofrece; con 1 → una_ip', () => {
    expect(ofreceBajoAtaque(inc(), 2)).toEqual({ ofrece: true, host: HOST });
    expect(ofreceBajoAtaque(inc(), 1)).toEqual({ ofrece: false, motivo: 'una_ip', host: HOST });
    expect(ofreceBajoAtaque(inc(), 0)).toMatchObject({ motivo: 'una_ip' });
  });
  it('escaneo o /admin abierto (aunque sea critical) no son una inundación → no_aplica', () => {
    expect(ofreceBajoAtaque(inc({ rule_ids: ['CF_ADMIN_EXPOSED'] }), 5)).toMatchObject({ ofrece: false, motivo: 'no_aplica' });
    expect(ofreceBajoAtaque(inc({ rule_ids: ['CF_PATH_SCAN'] }), 5)).toMatchObject({ ofrece: false, motivo: 'no_aplica' });
  });
  it('varias reglas con CF_IP_FLOOD y 3 IPs → ofrece; resuelto → cerrado; nombre de ingesta que no es host → sin_host', () => {
    expect(ofreceBajoAtaque(inc({ rule_ids: ['CF_UA_TOOL', 'CF_IP_FLOOD'] }), 3)).toEqual({ ofrece: true, host: HOST });
    expect(ofreceBajoAtaque(inc({ status: 'resolved' }), 3)).toMatchObject({ ofrece: false, motivo: 'cerrado' });
    expect(ofreceBajoAtaque(inc({ host: 'Tienda Demo' }), 3)).toEqual({ ofrece: false, motivo: 'sin_host', host: null });
    expect(ofreceBajoAtaque(inc({ host: undefined }), 3)).toMatchObject({ motivo: 'sin_host' });
  });
  it('el orden manda: no_aplica antes que cerrado, cerrado antes que sin_host', () => {
    expect(ofreceBajoAtaque(inc({ rule_ids: ['CF_PATH_SCAN'], status: 'resolved', host: 'x' }), 0)).toMatchObject({ motivo: 'no_aplica' });
    expect(ofreceBajoAtaque(inc({ status: 'resolved', host: 'x' }), 0)).toMatchObject({ motivo: 'cerrado' });
  });
});

describe('simularBajoAtaque (guardas y textos)', () => {
  it('caso de la demo: efecto y avisos exactos del fixture (salvo el del dry_run, que añade E56)', () => {
    const p = fixtures.underAttackProposal;
    expect(sim()).toEqual({ ok: true, target: HOST, efecto: p.efecto, avisos: p.avisos.slice(0, 3) });
    expect(p.avisos[3]).toBe('Cloudflare validó la regla sin publicarla');
  });
  it('VanGUARD nunca se pone bajo ataque: la zona del producto y su www → host_protegido', () => {
    expect(sim({ host: ZONA })).toEqual({ ok: false, reason: 'host_protegido' });
    expect(sim({ host: `WWW.${ZONA}` })).toEqual({ ok: false, reason: 'host_protegido' });
  });
  it('host de otra zona → fuera_de_zona (también un sufijo que no es etiqueta); host que no es host → host_invalido', () => {
    expect(sim({ host: 'demo.otra.com' })).toEqual({ ok: false, reason: 'fuera_de_zona' });
    expect(sim({ host: 'demo.xofficialvanguard.com' })).toEqual({ ok: false, reason: 'fuera_de_zona' });
    expect(sim({ zona: 'tu zona' })).toEqual({ ok: false, reason: 'fuera_de_zona' });
    expect(sim({ host: 'Tienda Demo' })).toEqual({ ok: false, reason: 'host_invalido' });
  });
  it('cupo: 10 de 10 en Free → sin_cupo; 9 de 10 pasa; sin plan conocido no se comprueba ni se avisa', () => {
    expect(sim({ reglasUsadas: 10 })).toEqual({ ok: false, reason: 'sin_cupo' });
    expect(sim({ reglasUsadas: 9 }).ok).toBe(true);
    const sinPlan = sim({ plan: null, reglasUsadas: 99 });
    expect(sinPlan.ok && sinPlan.avisos).toHaveLength(2);
    const pro = sim({ plan: 'Pro', reglasUsadas: 24 });
    expect(pro.ok && pro.avisos[2]).toBe('Usa 1 de las 25 reglas de configuración de tu plan Pro');
  });
  it('alcance zone (P1): nunca en la zona del producto; fuera de ella, el aviso de toda la zona', () => {
    expect(sim({ scope: 'zone' })).toEqual({ ok: false, reason: 'zona_del_producto' });
    expect(sim({ scope: 'zone', zona: 'cliente.com', host: 'x.cliente.com' })).toEqual({ ok: true, target: 'cliente.com',
      efecto: 'Modo bajo ataque en toda la zona cliente.com durante 30 min',
      avisos: ['Afecta a todos los hosts de cliente.com, también a tu web principal y a tu API'] });
  });
});

describe('la regla de Cloudflare', () => {
  it('expresión con la caducidad dentro (epoch en segundos) y sin ella', () => {
    expect(expresionBajoAtaque(HOST, HASTA))
      .toBe('(http.host eq "demo.officialvanguard.com" and http.request.timestamp.sec lt 1792885320)');
    expect(expresionBajoAtaque(HOST, null)).toBe('http.host eq "demo.officialvanguard.com"');
    expect(expresionBajoAtaque(HOST, new Date(HASTA.getTime() + 999))).toContain('lt 1792885320)');
  });
  it('no arma una expresión con un host sin canonizar (comillas, espacios, mayúsculas)', () => {
    for (const malo of ['a" or true or "b.com', 'Demo.officialvanguard.com', 'x.com ', 'x.com) or (1']) {
      expect(() => expresionBajoAtaque(malo, HASTA), malo).toThrow(RangeError);
    }
  });
  it('ref de 38 caracteres, notas con código, 8 hex y hora (≤ 120), y la regla set_config completa', () => {
    expect(refBajoAtaque(APR)).toBe('vg_ua_5f2c9a10000040008000000000000002');
    expect(refBajoAtaque(APR)).toHaveLength(38);
    const notas = notasBajoAtaque('A1F3C9', APR, HASTA);
    expect(notas).toBe('VanGUARD #A1F3C9 · bajo ataque · 5f2c9a10 · hasta 2026-10-24T23:42:00Z');
    expect(notas.length).toBeLessThanOrEqual(120);
    expect(notasBajoAtaque('no es', 'zz', HASTA)).toBe('VanGUARD #------ · bajo ataque · -------- · hasta 2026-10-24T23:42:00Z');
    expect(reglaBajoAtaque(HOST, refBajoAtaque(APR), notas, HASTA)).toEqual({ ref: refBajoAtaque(APR), description: notas,
      expression: expresionBajoAtaque(HOST, HASTA), action: 'set_config', action_parameters: { security_level: 'under_attack' },
      enabled: true });
  });
});

describe('textos', () => {
  it('pasos manuales: idénticos al fixture underAttackOfferSinPermiso; sin zona no la nombra', () => {
    expect(pasosManualesBajoAtaque(HOST, ZONA)).toBe(fixtures.underAttackOfferSinPermiso.copiar);
    expect(pasosManualesBajoAtaque(HOST, null).split('\n')[0]).toBe('Para activarlo a mano en Cloudflare:');
  });
  it('pasos para retirar: con la hora de caducidad o «sigue activa»; la descripción no cuela saltos ni comillas', () => {
    const notas = notasBajoAtaque('A1F3C9', APR, HASTA);
    expect(pasosRetirarBajoAtaque(notas, ZONA, HASTA, HASTA.getTime())).toBe(`En Cloudflare (zona ${ZONA}): Rules → `
      + `Configuration Rules → borra la regla «${notas}».\n`
      + 'Ya no actúa desde las 23:42 UTC del 2026-10-24; solo ocupa una regla de tu plan.');
    // Antes de caducar (una huérfana que no se pudo retirar a los 3 min) la regla aún actúa: no se dice «Ya no actúa».
    expect(pasosRetirarBajoAtaque(notas, ZONA, HASTA, HASTA.getTime() - 60_000).split('\n')[1])
      .toBe('Sigue activa hasta las 23:42 UTC del 2026-10-24; después solo ocupa una regla de tu plan.');
    expect(pasosRetirarBajoAtaque(notas, ZONA, null).split('\n')[1]).toBe('Sigue activa hasta que la borres.');
    const bidi = String.fromCharCode(0x202e);
    const sucio = pasosRetirarBajoAtaque(`VanGUARD${bidi} «x»\n<b>`, null, null);
    expect(sucio).toBe('En Cloudflare: Rules → Configuration Rules → borra la regla «VanGUARD xb».\nSigue activa hasta que la borres.');
  });
  it('código por WhatsApp: 6 dígitos y host canónico, o lanza', () => {
    expect(textoCodigoBajoAtaque('483920', HOST))
      .toBe('Código 483920 para activar el modo bajo ataque en demo.officialvanguard.com durante 30 min. Vence en 10 min.');
    expect(() => textoCodigoBajoAtaque('48392', HOST)).toThrow(RangeError);
    expect(() => textoCodigoBajoAtaque('483920', 'Tienda Demo')).toThrow(RangeError);
  });
});
