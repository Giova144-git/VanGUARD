import { Hono } from 'hono';
import { Id } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

// E51 y E52 (docs/plan_maestro_trabajo/asignaciones/evolucion-entre-revisiones.md §4.1). Lectura para cualquier miembro
// (también el anónimo de la demo): títulos y recursos ya son visibles en Hallazgos. p_org sale de orgMember, nunca de la
// URL ni del cuerpo, y las RPC filtran por org_id (una auditoría ajena da found:false → el mismo 404). Una RPC cada una
// y el JSON sale como lo arma la base (las horas ya vienen con Z de private.vg_iso): su forma la prueban
// supabase/tests/evolucion.sql y evolucion.test.ts. Re-validarlo con zod costaría ~8 ms de CPU la primera vez con 60
// puntos y 50 revisiones (§8). Subpeticiones: las del middleware de siempre + 1.
export const evolucion = new Hono<AppEnv>();

// Solo dígitos: «1e1», «7.0» o « 7» no son un entero de la URL.
const entero = (v: string | undefined, campo: string, min: number, max: number, def: number) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!/^\d{1,4}$/.test(v) || n < min || n > max) {
    throw new ApiError('invalid_body', 'Filtro no válido', { field_errors: { [campo]: [`Entre ${min} y ${max}`] } });
  }
  return n;
};

// E51 · GET /api/orgs/:org/scans/:id/delta · user → AuditDelta. available:false trae su motivo (en_curso o sin_foto).
evolucion.get('/orgs/:org/scans/:id/delta', async (c) => {
  const id = Id.safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError('not_found', 'Auditoría no encontrada');
  const { data, error } = await db(c.env).rpc('vg_audit_delta', { p_org: c.get('orgId'), p_scan: id.data, p_limit: 50 });
  if (error) {
    log('error', 'evolucion.delta_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer los cambios de esta auditoría');
  }
  const r = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const { found, ...cuerpo } = r;
  if (found !== true) throw new ApiError('not_found', 'Auditoría no encontrada');
  return c.json(cuerpo);
});

// E52 · GET /api/orgs/:org/evolution?days=30&limit=30 · user → Evolution. days 1–90 y limit 1–60 (la base los
// vuelve a acotar); fuera de rango o no entero → 422 con field_errors, como el filtro de E13.
evolucion.get('/orgs/:org/evolution', async (c) => {
  const q = c.req.query();
  const days = entero(q.days, 'days', 1, 90, 30);
  const limit = entero(q.limit, 'limit', 1, 60, 30);
  const { data, error } = await db(c.env).rpc('vg_evolution', { p_org: c.get('orgId'), p_days: days, p_limit: limit });
  const r = (data && typeof data === 'object' && !Array.isArray(data) ? data : null) as { points?: unknown } | null;
  if (error || !r || !Array.isArray(r.points)) {
    log('error', 'evolucion.lectura_error', { rid: c.get('rid'), code: error ? (error.code ?? null) : 'forma' });
    throw new ApiError('internal', 'No pudimos leer la evolución');
  }
  return c.json(r);
});
