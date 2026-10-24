// Guardas puras de «Bloquear IP» (S08 08.8, S15 E20): puro, sin `node:net`; port de las salvaguardas de KUADRA.
// E20 responde 422 con details.reason = MotivoRechazoIp; si pasa, devuelve la simulación (efecto + avisos en español).
// También dan las listas de redes privadas y de documentación que el pulso excluye antes de evaluar reglas (08.4).

// ── IPv4 (literal de 08.8; `?? ''` por noUncheckedIndexedAccess) ──────────────────────────────────────────────────
const v4 = (s: string) => { const p = s.split('.'); if (p.length !== 4 || p.some(x => !/^(0|[1-9]\d{0,2})$/.test(x) || +x > 255)) return null;
  return p.reduce((a, x) => (a << 8 | +x) >>> 0, 0); };
const enRed = (ip: number, red: string) => { const [b, m] = red.split('/'); const base = v4(b ?? '')!; const bits = +(m ?? 32);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return ((ip & mask) >>> 0) === ((base & mask) >>> 0); };
export const PRIVADAS_V4 = ['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','127.0.0.0/8','169.254.0.0/16','100.64.0.0/10','0.0.0.0/8','224.0.0.0/4','240.0.0.0/4'];
export const DOC_V4 = ['192.0.2.0/24','198.51.100.0/24','203.0.113.0/24'];

// ── IPv6: 8 grupos de 16 bits en un BigInt; prefijos comparados con máscara ───────────────────────────────────────
export const PRIVADAS_V6 = ['fc00::/7', 'fe80::/10', '::1/128', '::/128'];
export const DOC_V6 = ['2001:db8::/32'];
const MAPEADA_V6 = '::ffff:0:0/96';                                     // IPv4 mapeada: not_an_ip (08.8)
function v6(s: string): bigint | null {                                 // sin zona (%eth0) ni IPv4 incrustada (1.2.3.4)
  if (!s.includes(':') || !/^[0-9a-f:]+$/i.test(s)) return null;
  const partes = s.split('::');
  if (partes.length > 2) return null;
  const izq = partes[0] ? partes[0].split(':') : [];
  const der = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  if ([...izq, ...der].some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const faltan = 8 - izq.length - der.length;
  if (partes.length === 2 ? faltan < 1 : faltan !== 0) return null;
  const grupos = [...izq, ...Array<string>(partes.length === 2 ? faltan : 0).fill('0'), ...der];
  return grupos.reduce((a, g) => (a << 16n) | BigInt('0x' + g), 0n);
}
/** Forma corta canónica (RFC 5952): minúsculas, sin ceros a la izquierda, `::` en la racha de ceros más larga (≥ 2). */
function textoV6(n: bigint): string {
  const g = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(112 - 16 * i)) & 0xffffn));
  let ini = -1, largo = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i; while (j < 8 && g[j] === 0) j++;
    if (j - i >= 2 && j - i > largo) { ini = i; largo = j - i; }
    i = j;
  }
  const h = g.map((x) => x.toString(16));
  return ini < 0 ? h.join(':') : h.slice(0, ini).join(':') + '::' + h.slice(ini + largo).join(':');
}

export type Ip = { v: 4; n: number } | { v: 6; n: bigint };
/** IPv4 sin ceros a la izquierda o IPv6 en hex; null si no es una IP suelta (sin máscara). */
export function parseIp(s: string): Ip | null {
  const a = v4(s);
  if (a !== null) return { v: 4, n: a };
  const b = v6(s);
  return b === null ? null : { v: 6, n: b };
}
export const isIp = (s: string): boolean => parseIp(s.trim()) !== null;
export const textoIp = (ip: Ip): string => (ip.v === 4 ? [24, 16, 8, 0].map((d) => (ip.n >>> d) & 255).join('.') : textoV6(ip.n));
/** ¿La IP está dentro del CIDR (o es la IP suelta)? Familias distintas o CIDR inválido → false. */
export function enCidr(ip: Ip, cidr: string): boolean {
  const [b, m, extra] = cidr.trim().split('/');
  if (extra !== undefined || !b) return false;
  const base = parseIp(b);
  if (!base || base.v !== ip.v) return false;
  const max = ip.v === 4 ? 32 : 128;
  const bits = m === undefined ? max : /^\d{1,3}$/.test(m) ? +m : NaN;
  if (!(bits >= 0 && bits <= max)) return false;
  if (ip.v === 4) return enRed(ip.n, `${b}/${bits}`);
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (ip.n & mask) === ((base.n as bigint) & mask);
}
const enAlguna = (ip: Ip, redes: readonly string[]) => redes.some((r) => enCidr(ip, r));
const misma = (ip: Ip, otra: string) => { const o = parseIp(otra.trim()); return !!o && o.v === ip.v && o.n === ip.n; };

/** Para excluir del pulso (08.4) y de la simulación: privada/reservada, de documentación o ninguna. */
export function ipReservada(ip: Ip): 'private_ip' | 'documentation_range' | null {
  if (enAlguna(ip, ip.v === 4 ? PRIVADAS_V4 : PRIVADAS_V6)) return 'private_ip';
  if (enAlguna(ip, ip.v === 4 ? DOC_V4 : DOC_V6)) return 'documentation_range';
  return null;
}

// ── Simulación de E20 ─────────────────────────────────────────────────────────────────────────────────────────────
export type MotivoRechazoIp = 'not_an_ip' | 'private_ip' | 'documentation_range' | 'own_ip' | 'allowlisted' | 'range_too_wide' | 'cloudflare_ip';
export type OpcionesBloqueo = {
  zona: string;                          // zone_name de la conexión `action`
  ipOperador?: string | null;            // cf-connecting-ip de quien propone o confirma (no aplica al botón `blk` de WhatsApp)
  cloudflare?: readonly string[];        // rangos de GET /client/v4/ips (v4 y v6)
  permitidas?: readonly string[];        // lista de la org (P2): IPs o CIDR
  yaBloqueadas?: ReadonlySet<string>;    // valores con access rule vigente en la zona
  host?: string | null;                  // hostname atacado; si no es la zona, se avisa de que el bloqueo es de toda la zona
};
export type SimulacionBloqueo =
  | { ok: true; target: 'ip' | 'ip6'; value: string; efecto: string; avisos: string[] }
  | { ok: false; reason: MotivoRechazoIp };

export function simularBloqueo(entrada: string, o: OpcionesBloqueo): SimulacionBloqueo {
  const no = (reason: MotivoRechazoIp): SimulacionBloqueo => ({ ok: false, reason });
  const [dir, mascara, extra] = entrada.trim().split('/');
  if (extra !== undefined || !dir) return no('not_an_ip');
  const ip = parseIp(dir);
  if (!ip || (ip.v === 6 && enCidr(ip, MAPEADA_V6))) return no('not_an_ip');
  const bits = ip.v === 4 ? 32 : 128;
  if (mascara !== undefined) {
    if (!/^\d{1,3}$/.test(mascara)) return no('not_an_ip');
    if (+mascara !== bits) return no('range_too_wide');                 // P0: solo /32 y /128, también en IPv6
  }
  const reservada = ipReservada(ip);
  if (reservada) return no(reservada);
  if (o.ipOperador && misma(ip, o.ipOperador)) return no('own_ip');
  if (enAlguna(ip, o.permitidas ?? [])) return no('allowlisted');
  if (enAlguna(ip, o.cloudflare ?? [])) return no('cloudflare_ip');
  const value = textoIp(ip);
  const avisos = ['Solo afecta a esta IP'];
  if ([...(o.yaBloqueadas ?? [])].some((x) => misma(ip, x))) avisos.push('Esta IP ya tiene una regla tuya en Cloudflare');
  if (o.host && o.host.toLowerCase() !== o.zona.toLowerCase())
    avisos.push(`Bloquea la IP en toda la zona ${o.zona}, también en tu web principal`);
  return { ok: true, target: ip.v === 4 ? 'ip' : 'ip6', value, efecto: `Bloquear ${value} (/${bits}) en la zona ${o.zona} durante 1 h`, avisos };
}
