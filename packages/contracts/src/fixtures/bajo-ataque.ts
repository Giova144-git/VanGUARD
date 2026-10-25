// «Modo bajo ataque» (E55 oferta y E56 simulación; asignaciones/modo-bajo-ataque.md). La regla lo ofrece cuando 2 o más
// IPs inundan el mismo host (incidentes CF_IP_FLOOD no resueltos con el mismo details.host, que es el nombre de la
// conexión de ingesta: demo.officialvanguard.com). La zona es la del producto: el alcance zone no se ofrece nunca.
import type { UnderAttackOffer, UnderAttackProposal } from '../api.ts';
import { APPROVAL_BAJO_ATAQUE, CONN_CF_ACTION, HOST_VICTIMA, T_PROPUESTA, ZONA } from './ids.ts';

export const underAttackOffer = {
  ofrece: true, motivo: null, hostname: HOST_VICTIMA, zone_name: ZONA, connection_id: CONN_CF_ACTION, ips: 2,
  scopes: ['host'], permiso: 'ok', ttl_s: 1800, activo: null, copiar: null,
} satisfies UnderAttackOffer;

// Una sola IP inunda el host: basta «Bloquear IP» y la tarjeta no ofrece el botón.
export const underAttackOfferUnaIp = {
  ...underAttackOffer, ofrece: false, motivo: 'una_ip', ips: 1, scopes: [],
} satisfies UnderAttackOffer;

// Token de Modo blindaje sin Config Rules · Edit: el botón no sirve; se ofrecen los pasos para el panel de Cloudflare.
export const underAttackOfferSinPermiso = {
  ...underAttackOffer, motivo: 'sin_permiso', scopes: [], permiso: 'falta',
  copiar: [
    `Para activarlo a mano en Cloudflare (zona ${ZONA}):`,
    '1. Rules → Configuration Rules → Create rule.',
    `2. If incoming requests match: Hostname · equals · ${HOST_VICTIMA}.`,
    '3. Then the settings are: I\'m Under Attack → On. Deploy.',
    '4. Cuando pase el ataque, borra la regla.',
    'Para hacerlo desde VanGUARD: añade Zone · Config Rules · Edit al token de Modo blindaje y pulsa «Probar conexión».',
  ].join('\n'),
} satisfies UnderAttackOffer;

// OJO: expires_at FIJA (T_PROPUESTA + 10 min), como actionProposal: el router de fixtures la reescribe con Date.now().
export const underAttackProposal = {
  approval_id: APPROVAL_BAJO_ATAQUE,
  efecto: `Modo bajo ataque solo en ${HOST_VICTIMA} durante 30 min: cada visitante pasará un desafío de Cloudflare`,
  avisos: [
    `El resto de ${ZONA} no cambia: tu app, tu API y tus webhooks siguen igual`,
    `Rompe las llamadas de API, webhooks y apps móviles a ${HOST_VICTIMA}: no resuelven el desafío`,
    'Usa 1 de las 10 reglas de configuración de tu plan Free',
    'Cloudflare validó la regla sin publicarla',
  ],
  expires_at: new Date(Date.parse(T_PROPUESTA) + 10 * 60_000).toISOString(), delivery: 'whatsapp', code: null,
  scope: 'host', target: HOST_VICTIMA, zone_name: ZONA, ttl_s: 1800, validado: true,
} satisfies UnderAttackProposal;
