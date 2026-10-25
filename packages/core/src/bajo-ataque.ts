// «Modo bajo ataque» de Cloudflare (asignaciones/modo-bajo-ataque.md §7): puro, sin red. La REGLA decide si se ofrece
// (≥ 2 incidentes CF_IP_FLOOD no resueltos con el mismo host: varias IPs inundan ese host), las guardas acotan el host
// (canónico, de la zona de la conexión y nunca uno de VanGUARD) y aquí se arman la Configuration Rule (set_config,
// security_level under_attack) con la caducidad DENTRO de su expresión, sus notas y los textos para la app y el código.
// El host ya pasó hostCanonico antes de entrar en una expresión: sin comillas ni espacios, no admite inyección.
// textoCodigoBajoAtaque vive aquí y no en templates/whatsapp.ts: la mensajería no se toca (§7).

export const TTL_BAJO_ATAQUE_S = 1800;
/** Configuration Rules por plan [verificado: developers.cloudflare.com/rules/configuration-rules/]. */
export const CUPO_REGLAS_CONFIG: Readonly<Record<string, number>> = { free: 10, pro: 25, business: 50, enterprise: 300 };
/** Solo la inundación: Cloudflare pide Under Attack solo ante un DDoS (§1.5). Escaneo y /admin abierto no lo son. */
export const REGLAS_QUE_OFRECEN: readonly string[] = ['CF_IP_FLOOD'];
/** Con una sola IP basta Bloquear IP: se ofrece con ≥ 2 incidentes CF_IP_FLOOD no resueltos del mismo host. */
export const MIN_IPS_BAJO_ATAQUE = 2;
/** true: la caducidad va en la expresión (http.request.timestamp.sec, §1.6). Si la sonda, E56 o B6 muestran que
 *  Cloudflare no la admite en http_config_settings, el BACK la pone en false y la retirada depende solo de housekeeping. */
export const CADUCIDAD_EN_REGLA = true;
export type MotivoBajoAtaque = 'host_invalido' | 'host_protegido' | 'fuera_de_zona' | 'zona_del_producto' | 'sin_cupo';

const ETIQUETA = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** trim, minúsculas, sin punto final; 3..120 car.; ≥ 2 etiquetas /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/; la última con
 *  alguna letra (una IPv4 no pasa); sin '*', comillas, espacios, barras ni puerto. null si no. «Tienda Demo» → null. */
export function hostCanonico(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const h = s.trim().toLowerCase().replace(/\.$/, '');
  if (h.length < 3 || h.length > 120) return null;
  const etiquetas = h.split('.');
  if (etiquetas.length < 2 || !etiquetas.every((e) => ETIQUETA.test(e))) return null;
  return /[a-z]/.test(etiquetas[etiquetas.length - 1]!) ? h : null;
}

/** La REGLA, en este orden: no_aplica (sin CF_IP_FLOOD en rule_ids) → cerrado (status 'resolved') → sin_host
 *  (details.host no pasa hostCanonico) → una_ip (ips < MIN_IPS_BAJO_ATAQUE). ips = incidentes CF_IP_FLOOD no resueltos
 *  de la org con el mismo details.host, este incluido. No mira module ni severity: CF_IP_FLOOD ya es de Cloudflare y
 *  `module` no es columna de incidents (incidente.ts:77). */
export function ofreceBajoAtaque(inc: { status: string; rule_ids: readonly string[]; details: Record<string, unknown> },
  ips: number): { ofrece: true; host: string }
  | { ofrece: false; motivo: 'no_aplica' | 'cerrado' | 'sin_host' | 'una_ip'; host: string | null } {
  const host = hostCanonico(inc.details.host);
  if (!inc.rule_ids.some((r) => REGLAS_QUE_OFRECEN.includes(r))) return { ofrece: false, motivo: 'no_aplica', host };
  if (inc.status === 'resolved') return { ofrece: false, motivo: 'cerrado', host };
  if (!host) return { ofrece: false, motivo: 'sin_host', host: null };
  if (!(ips >= MIN_IPS_BAJO_ATAQUE)) return { ofrece: false, motivo: 'una_ip', host };
  return { ofrece: true, host };
}

const minutos = (ttl_s: number) => Math.max(1, Math.round(ttl_s / 60));
const nombrePlan = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);
const enZona = (host: string, zona: string) => host === zona || host.endsWith(`.${zona}`);

/** Guardas y textos de la simulación. protegidos = [host de APP_ORIGIN, 'www.' + ese host]. host: debe ser la zona o
 *  terminar en '.' + zona. zone: zona ≠ zonaProducto y zonaProducto no termina en '.' + zona. sin_cupo: reglasUsadas ≥
 *  CUPO_REGLAS_CONFIG[plan]. Avisos en español, listos para pintar (ProposeResponse.avisos). */
export function simularBajoAtaque(o: { scope: 'host' | 'zone'; host: string; zona: string; protegidos: readonly string[];
  zonaProducto: string | null; plan: string | null; reglasUsadas: number | null; ttl_s: number })
  : { ok: true; target: string; efecto: string; avisos: string[] } | { ok: false; reason: MotivoBajoAtaque } {
  const min = minutos(o.ttl_s);
  const zona = hostCanonico(o.zona);
  if (o.scope === 'zone') {
    const producto = hostCanonico(o.zonaProducto);
    if (!zona) return { ok: false, reason: 'fuera_de_zona' };
    if (producto && enZona(producto, zona)) return { ok: false, reason: 'zona_del_producto' };
    return { ok: true, target: zona, efecto: `Modo bajo ataque en toda la zona ${zona} durante ${min} min`,
      avisos: [`Afecta a todos los hosts de ${zona}, también a tu web principal y a tu API`] };
  }
  const host = hostCanonico(o.host);
  if (!host) return { ok: false, reason: 'host_invalido' };
  if (o.protegidos.some((p) => hostCanonico(p) === host)) return { ok: false, reason: 'host_protegido' };
  if (!zona || !enZona(host, zona)) return { ok: false, reason: 'fuera_de_zona' };
  const plan = o.plan ? o.plan.trim().toLowerCase() : null;
  const cupo = plan ? CUPO_REGLAS_CONFIG[plan] : undefined;
  if (cupo !== undefined && o.reglasUsadas !== null && o.reglasUsadas >= cupo) return { ok: false, reason: 'sin_cupo' };
  const avisos = [
    host === zona ? `Los subdominios de ${zona} no cambian: solo ${host}`
      : `El resto de ${zona} no cambia: tu app, tu API y tus webhooks siguen igual`,
    `Rompe las llamadas de API, webhooks y apps móviles a ${host}: no resuelven el desafío`,
  ];
  if (plan && cupo !== undefined) avisos.push(`Usa 1 de las ${cupo} reglas de configuración de tu plan ${nombrePlan(plan)}`);
  return { ok: true, target: host,
    efecto: `Modo bajo ataque solo en ${host} durante ${min} min: cada visitante pasará un desafío de Cloudflare`, avisos };
}

/** Sin fecha: `http.host eq "<host>"`. Con fecha: `(http.host eq "<host>" and http.request.timestamp.sec lt <epoch>)`,
 *  epoch = Math.floor(hasta / 1000). El host ya pasó hostCanonico (sin comillas): la expresión no admite inyección; si
 *  no lo pasó, lanza en lugar de armarla. */
export function expresionBajoAtaque(host: string, hasta: Date | null): string {
  if (hostCanonico(host) !== host) throw new RangeError('HOST_BAJO_ATAQUE');
  const base = `http.host eq "${host}"`;
  if (!hasta) return base;
  const epoch = Math.floor(hasta.getTime() / 1000);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new RangeError('HASTA_BAJO_ATAQUE');
  return `(${base} and http.request.timestamp.sec lt ${epoch})`;
}

/** ref de la regla: 'vg_ua_' + los 32 hex del approval_id (38 car.). Con él se reconcilia tras una caída. */
export const refBajoAtaque = (approvalId: string) => 'vg_ua_' + approvalId.replace(/-/g, '');

const isoSinMs = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** «VanGUARD #A1F3C9 · bajo ataque · 5f2c9a10 · hasta 2026-10-24T23:42:00Z» (≤ 120; 8 hex del approval_id para
 *  reconciliar sin depender del ref; nada personal). */
export function notasBajoAtaque(code: string | null, approvalId: string, hasta: Date): string {
  const c = code && /^[A-Z0-9]{6}$/.test(code) ? code : '------';
  const hex = approvalId.replace(/-/g, '').slice(0, 8).toLowerCase();
  const h = /^[0-9a-f]{8}$/.test(hex) ? hex : '--------';
  return `VanGUARD #${c} · bajo ataque · ${h} · hasta ${isoSinMs(hasta)}`.slice(0, 120);
}

export type ReglaBajoAtaque = {
  ref: string; description: string; expression: string; action: 'set_config';
  action_parameters: { security_level: 'under_attack' }; enabled: true;
};
export function reglaBajoAtaque(host: string, ref: string, description: string, hasta: Date | null): ReglaBajoAtaque {
  return { ref, description: description.slice(0, 120), expression: expresionBajoAtaque(host, hasta), action: 'set_config',
    action_parameters: { security_level: 'under_attack' }, enabled: true };
}

/** Texto de UnderAttackOffer.copiar (≤ 1500) para activarlo a mano, como el fixture underAttackOfferSinPermiso. Sin
 *  zona conocida (falta el Modo blindaje) la primera línea no la nombra. */
export function pasosManualesBajoAtaque(host: string, zona: string | null): string {
  return [
    zona ? `Para activarlo a mano en Cloudflare (zona ${zona}):` : 'Para activarlo a mano en Cloudflare:',
    '1. Rules → Configuration Rules → Create rule.',
    `2. If incoming requests match: Hostname · equals · ${host}.`,
    '3. Then the settings are: I\'m Under Attack → On. Deploy.',
    '4. Cuando pase el ataque, borra la regla.',
    'Para hacerlo desde VanGUARD: añade Zone · Config Rules · Edit al token de Modo blindaje y pulsa «Probar conexión».',
  ].join('\n').slice(0, 1500);
}

/** Texto de copiar cuando la retirada falló: «En Cloudflare (zona …): Rules → Configuration Rules → borra la regla
 *  «<descripcion>».» Con caducoEn ya pasada (≤ ahora) añade «Ya no actúa desde <hora UTC>; solo ocupa una regla de tu
 *  plan.»; aún por llegar (una huérfana que no se pudo retirar a los pocos minutos), «Sigue activa hasta las <hora UTC>;
 *  después solo ocupa una regla de tu plan.»; sin ella, «Sigue activa hasta que la borres.» (≤ 1500). La descripción
 *  viene de la fila: solo pasan letras, cifras y # · : . - */
export function pasosRetirarBajoAtaque(descripcion: string, zona: string | null, caducoEn: Date | null,
  ahora: number = Date.now()): string {
  const d = descripcion.replace(/[^\p{L}\p{N} #·:.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 120)
    || 'VanGUARD · bajo ataque';
  const donde = zona ? `En Cloudflare (zona ${zona})` : 'En Cloudflare';
  const t = caducoEn ? caducoEn.getTime() : NaN;
  const iso = Number.isFinite(t) ? new Date(t).toISOString() : null;
  const hora = iso ? `las ${iso.slice(11, 16)} UTC del ${iso.slice(0, 10)}` : '';
  const fin = !iso ? 'Sigue activa hasta que la borres.'
    : t <= ahora ? `Ya no actúa desde ${hora}; solo ocupa una regla de tu plan.`
    : `Sigue activa hasta ${hora}; después solo ocupa una regla de tu plan.`;
  return `${donde}: Rules → Configuration Rules → borra la regla «${d}».\n${fin}`.slice(0, 1500);
}

/** WhatsApp: «Código 483920 para activar el modo bajo ataque en demo.officialvanguard.com durante 30 min. Vence en 10
 *  min.» Lanza si el código no son 6 dígitos (como textoCodigoBloqueo) o si el host no es canónico. */
export function textoCodigoBajoAtaque(code: string, host: string): string {
  if (!/^\d{6}$/.test(code)) throw new RangeError('CODIGO_BAJO_ATAQUE');
  if (hostCanonico(host) !== host) throw new RangeError('HOST_BAJO_ATAQUE');
  return `Código ${code} para activar el modo bajo ataque en ${host} durante ${minutos(TTL_BAJO_ATAQUE_S)} min. `
    + 'Vence en 10 min.';
}
