import { Hono, type Context } from 'hono';
import { Id, UnderAttackPropose } from '@vanguard/contracts';
import { COLUMNAS_INCIDENTE_BLOQUEO, leerIncidenteBloqueo, type IncidenteBloqueo } from '../actions/approvals.ts';
import {
  ERROR_SIN_PERMISO_CONFIG, leerOfertaBajoAtaque, proponerBajoAtaque, type MotivoPropuestaBajoAtaque,
} from '../actions/under-attack.ts';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';
import { requireProdHostOSandbox } from '../mw/prod-host.ts';
import { ofertaBajoAtaqueSandbox, proponerBajoAtaqueSandbox } from '../actions/sandbox.ts';
import { limitar, MENSAJE_ENTREGA } from './actions.ts';

// E55 · GET incidents/:id/under-attack (oferta; miembro, también viewer y anónimo de demo; solo lee la base) y E56 ·
// POST incidents/:id/under-attack/propose (admin, solo officialvanguard.com, RL_COSTLY u:<user_id>) · P0
// (asignaciones/modo-bajo-ataque.md §5). Confirmar y deshacer son E21 y E22 (rutas/actions.ts, despacho por tipo). El
// host sale de incidents.details.host (el nombre de la conexión de ingesta), nunca del cuerpo. Anti-IDOR: el incidente se
// lee por id Y org_id (otra org → 404). Esta ruta registrada en rutas/index.ts es el interruptor del corte de §13.1: sin
// ella E55 da 404 y la tarjeta del FRONT no se pinta.
export const bajoAtaque = new Hono<AppEnv>();

async function leerIncidente(c: Context<AppEnv>): Promise<IncidenteBloqueo> {
  const id = Id.safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError('not_found', 'Incidente no encontrado');
  const { data, error } = await db(c.env).from('incidents').select(COLUMNAS_INCIDENTE_BLOQUEO)
    .eq('id', id.data).eq('org_id', c.get('orgId')).maybeSingle();
  if (error) {
    log('error', 'bajo_ataque.incidente_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer el incidente');
  }
  const incidente = leerIncidenteBloqueo(data);
  if (!incidente) throw new ApiError('not_found', 'Incidente no encontrado');
  return incidente;
}

// E55: 4 subpeticiones (incidente; luego conexiones, acciones del host y conteo de CF_IP_FLOOD en paralelo), 0 a Cloudflare.
bajoAtaque.get('/orgs/:org/incidents/:id/under-attack', async (c) => {
  const incidente = await leerIncidente(c);
  // Sandbox de «Ver demo» (0026): sin conexión de acciones; la oferta y la propuesta van en seco (actions/sandbox.ts).
  if (c.get('sandbox')) return c.json(await ofertaBajoAtaqueSandbox(c.env, { orgId: c.get('orgId'), incidente, rid: c.get('rid') }));
  return c.json(await leerOfertaBajoAtaque(c.env, { orgId: c.get('orgId'), incidente, rid: c.get('rid') }));
});

// Rechazos de E56 (tabla de §5): código de error y mensaje; host, zona, cupo y código de Cloudflare se interpolan aquí.
type Rechazo = { motivo: MotivoPropuestaBajoAtaque; host: string | null; zona: string | null; cupo?: number; codigo?: number | null };
const MENSAJE_RECHAZO: Record<MotivoPropuestaBajoAtaque, [ApiError['code'], (r: Rechazo) => string]> = {
  no_aplica: ['invalid_body', () => 'El modo bajo ataque es solo para inundaciones de tráfico'],
  una_ip: ['invalid_body', () => 'Viene de una sola IP: bloquéala con «Bloquear IP»'],
  sin_host: ['invalid_body', () => 'No sabemos qué host atacan: ponle a tu conexión de ingesta el nombre del host '
    + '(por ejemplo, demo.officialvanguard.com)'],
  host_protegido: ['invalid_body', () => 'Ese host es VanGUARD: ponerlo bajo ataque cortaría tu panel y tus avisos'],
  fuera_de_zona: ['invalid_body', (r) => `Ese host no es de tu zona ${r.zona ?? ''}`.trim()],
  zona_del_producto: ['invalid_body', () => 'En esta zona solo se puede por host'],
  alcance_no_disponible: ['invalid_body', () => 'Por ahora solo por host'],
  sin_cupo: ['invalid_body', (r) => `Tu plan admite ${r.cupo ?? '?'} reglas de configuración y ya las usas`],
  rechazada_por_cloudflare: ['invalid_body', (r) => `Cloudflare no aceptó la regla (código ${r.codigo ?? 'desconocido'})`],
  resolved: ['conflict', () => 'El incidente ya se cerró'],
  no_action_connection: ['conflict', () => 'Activa el Modo blindaje con un token de acciones'],
  sin_permiso: ['conflict', () => ERROR_SIN_PERMISO_CONFIG],
  token_invalido: ['conflict', () => 'El token de acciones ya no es válido. Vuelve a conectarlo.'],
  sin_credencial: ['conflict', () => 'No pudimos abrir el token de acciones. Vuelve a conectarlo.'],
  already_active: ['conflict', (r) => `El modo bajo ataque ya está activo en ${r.host ?? 'ese host'}`],
  in_progress: ['conflict', () => 'Se está activando ahora mismo'],
  escrita: ['internal', () => 'No pudimos validar la regla con Cloudflare'],
};

// E56: ≈ 14–15 subpeticiones (incidente 1 + 5 en paralelo + sobre 2 + GET del entrypoint 1 + dry_run 1 + claves 2 +
// aprobación 1 + Kapso 1; +1 si el dry_run se colara y hubiera que borrar la regla).
bajoAtaque.post('/orgs/:org/incidents/:id/under-attack/propose', requireAdmin, requireProdHostOSandbox, async (c) => {
  const limitado = await limitar(c, `u:${c.get('userId')}`);
  if (limitado) return limitado;
  const body = await cuerpo(c, UnderAttackPropose);
  const incidente = await leerIncidente(c);
  const rid = c.get('rid');
  if (c.get('sandbox')) {
    const s = await proponerBajoAtaqueSandbox(c.env, { orgId: c.get('orgId'), incidente, scope: body.scope,
      requestedBy: c.get('userId'), rid });
    if (s.ok) return c.json(s.respuesta);
    const host = typeof incidente.details.host === 'string' ? incidente.details.host : null;
    const [code, texto] = MENSAJE_RECHAZO[s.motivo];
    throw new ApiError(code, texto({ motivo: s.motivo, host, zona: host }), { reason: s.motivo,
      ...(s.action_id ? { action_id: s.action_id } : {}) });
  }
  const r = await proponerBajoAtaque(c.env, { orgId: c.get('orgId'), incidente, scope: body.scope, connectionId: body.connection_id,
    requestedBy: c.get('userId'), rid });
  if (!r.ok) {
    if (r.motivo === 'sin_entrega') {
      log('warn', 'bajo_ataque.propuesta_sin_entrega', { rid, incidente: incidente.code, motivo: r.detalle });
      throw new ApiError('provider_unavailable', MENSAJE_ENTREGA[r.detalle], { reason: r.detalle });
    }
    const [code, texto] = MENSAJE_RECHAZO[r.motivo];
    log('info', 'bajo_ataque.propuesta_rechazada', { rid, incidente: incidente.code, motivo: r.motivo });
    throw new ApiError(code, texto(r), code === 'internal' ? undefined : { reason: r.motivo,
      ...(r.action_id ? { action_id: r.action_id } : {}), ...(r.copiar ? { copiar: r.copiar } : {}) });
  }
  log('info', 'accion.propuesta_bajo_ataque', { rid, user: c.get('userId'), incidente: incidente.code,
    delivery: r.respuesta.delivery, validado: r.respuesta.validado, recipient_masked: r.recipient_masked });
  return c.json(r.respuesta);
});
