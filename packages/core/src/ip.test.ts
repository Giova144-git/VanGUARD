// Casos de S15 15.13 y S08 08.8/CF-05 para ip.ts: cada `reason` de E20, IPv6, cero a la izquierda y máscaras.
import { describe, it, expect } from 'vitest';
import { simularBloqueo, parseIp, isIp, textoIp, enCidr, ipReservada, type OpcionesBloqueo } from './ip.ts';

const Z: OpcionesBloqueo = { zona: 'officialvanguard.com' };
const motivo = (e: string, o: Partial<OpcionesBloqueo> = {}) => { const r = simularBloqueo(e, { ...Z, ...o }); return r.ok ? 'ok' : r.reason; };

describe('simularBloqueo: casos de 15.13', () => {
  for (const e of ['10.0.0.1', '192.168.1.1', '::1', 'fe80::1'])
    it(`${e} → private_ip`, () => expect(motivo(e)).toBe('private_ip'));
  it('203.0.113.7 → documentation_range', () => expect(motivo('203.0.113.7')).toBe('documentation_range'));
  it('186.92.14.7 → válida, /32, con efecto y aviso', () => {
    expect(simularBloqueo('186.92.14.7', Z)).toEqual({ ok: true, target: 'ip', value: '186.92.14.7',
      efecto: 'Bloquear 186.92.14.7 (/32) en la zona officialvanguard.com durante 1 h', avisos: ['Solo afecta a esta IP'] });
  });
  it('2800:3f0::1 → válida, ip6 /128', () => {
    const r = simularBloqueo('2800:3f0::1', Z);
    expect(r).toMatchObject({ ok: true, target: 'ip6', value: '2800:3f0::1' });
    expect(r.ok && r.efecto).toBe('Bloquear 2800:3f0::1 (/128) en la zona officialvanguard.com durante 1 h');
  });
});

describe('simularBloqueo: el resto de motivos de E20', () => {
  it('privadas y reservadas de 08.8', () => {
    for (const e of ['172.16.5.4', '172.31.255.255', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.1.2.3', '224.0.0.1', '255.255.255.255', 'fc00::1', 'fd12:3456::1', 'febf::1', '::'])
      expect(motivo(e), e).toBe('private_ip');
    expect(motivo('172.32.0.1')).toBe('ok');                               // fuera de 172.16/12
    expect(motivo('100.128.0.1')).toBe('ok');                              // fuera de 100.64/10
    expect(motivo('fec0::1')).toBe('ok');                                  // fuera de fe80::/10
  });
  it('documentación v4 y v6', () => {
    for (const e of ['192.0.2.1', '198.51.100.200', '2001:db8::1', '2001:DB8:ffff::9']) expect(motivo(e), e).toBe('documentation_range');
    expect(motivo('2001:db9::1')).toBe('ok');
  });
  it('not_an_ip: basura, cero a la izquierda, IPv4 mapeada, zona v6, dos barras', () => {
    for (const e of ['', 'hola', '1.2.3', '1.2.3.4.5', '256.1.1.1', '010.0.0.1', '1.2.3.04', '::ffff:1.2.3.4', '::ffff:102:304',
      'fe80::1%eth0', '1:2:3:4:5:6:7:8:9', '1::2::3', '12345::1', '186.92.14.7/32/1', '186.92.14.7/abc', '/32'])
      expect(motivo(e), e).toBe('not_an_ip');
  });
  it('range_too_wide: solo /32 y /128', () => {
    expect(motivo('186.92.14.0/24')).toBe('range_too_wide');
    expect(motivo('186.92.0.0/16')).toBe('range_too_wide');
    expect(motivo('2800:3f0::/64')).toBe('range_too_wide');
    expect(motivo('2800:3f0::1/32')).toBe('range_too_wide');               // /32 en IPv6 no vale
    expect(motivo('186.92.14.7/32')).toBe('ok');
    expect(motivo('2800:3f0::1/128')).toBe('ok');
  });
  it('own_ip: la cf-connecting-ip del operador, también con otra escritura en IPv6', () => {
    expect(motivo('186.92.14.7', { ipOperador: '186.92.14.7' })).toBe('own_ip');
    expect(motivo('2800:3f0::1', { ipOperador: '2800:03F0:0:0:0:0:0:1' })).toBe('own_ip');
    expect(motivo('186.92.14.7', { ipOperador: '186.92.14.8' })).toBe('ok');
  });
  it('allowlisted: IP suelta o CIDR de la org', () => {
    expect(motivo('186.92.14.7', { permitidas: ['186.92.0.0/16'] })).toBe('allowlisted');
    expect(motivo('2800:3f0::1', { permitidas: ['2800:3f0::1'] })).toBe('allowlisted');
  });
  it('cloudflare_ip: rangos de GET /ips', () => {
    const cloudflare = ['173.245.48.0/20', '104.16.0.0/13', '2606:4700::/32'];
    expect(motivo('104.21.3.4', { cloudflare })).toBe('cloudflare_ip');
    expect(motivo('2606:4700:3030::ac43:1', { cloudflare })).toBe('cloudflare_ip');
    expect(motivo('186.92.14.7', { cloudflare })).toBe('ok');
  });
  it('avisos: regla ya existente y bloqueo de toda la zona desde un subdominio', () => {
    const r = simularBloqueo(' 2800:03f0:0::1 ', { ...Z, yaBloqueadas: new Set(['2800:3f0::1']), host: 'demo.officialvanguard.com' });
    expect(r).toEqual({ ok: true, target: 'ip6', value: '2800:3f0::1',
      efecto: 'Bloquear 2800:3f0::1 (/128) en la zona officialvanguard.com durante 1 h',
      avisos: ['Solo afecta a esta IP', 'Esta IP ya tiene una regla tuya en Cloudflare',
        'Bloquea la IP en toda la zona officialvanguard.com, también en tu web principal'] });
    expect(simularBloqueo('186.92.14.7', { ...Z, host: 'officialvanguard.com' })).toMatchObject({ ok: true, avisos: ['Solo afecta a esta IP'] });
  });
});

describe('primitivas', () => {
  it('parseIp / textoIp normalizan IPv6 (RFC 5952)', () => {
    const t = (s: string) => { const p = parseIp(s); return p && textoIp(p); };
    expect(t('2001:0DB8:0000:0000:0001:0000:0000:0001')).toBe('2001:db8::1:0:0:1');
    expect(t('0:0:0:0:0:0:0:0')).toBe('::');
    expect(t('1:0:2:3:4:5:6:7')).toBe('1:0:2:3:4:5:6:7');                   // un solo cero no se comprime
    expect(t('186.92.14.7')).toBe('186.92.14.7');
  });
  it('isIp: para la redacción por posición del export (13.2)', () => {
    expect(isIp('186.92.14.7')).toBe(true);
    expect(isIp('2800:3f0::1')).toBe(true);
    expect(isIp('2.0.0.1.5')).toBe(false);
    expect(isIp('lodash@4.17.21')).toBe(false);
  });
  it('enCidr: familias distintas o CIDR inválido → false', () => {
    const ip = parseIp('10.1.2.3')!;
    expect(enCidr(ip, '10.0.0.0/8')).toBe(true);
    expect(enCidr(ip, '0.0.0.0/0')).toBe(true);
    expect(enCidr(ip, 'fc00::/7')).toBe(false);
    expect(enCidr(ip, '10.0.0.0/33')).toBe(false);
    expect(enCidr(ip, 'x/8')).toBe(false);
  });
  it('ipReservada', () => {
    expect(ipReservada(parseIp('192.168.0.9')!)).toBe('private_ip');
    expect(ipReservada(parseIp('203.0.113.7')!)).toBe('documentation_range');
    expect(ipReservada(parseIp('186.92.14.7')!)).toBeNull();
  });
});
