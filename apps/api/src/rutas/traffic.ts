import { Hono } from 'hono';
import { Traffic } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';

// E18 · GET /api/orgs/:org/traffic?seconds=300 · user · P0 (S15 15.4). Cubetas de 10 s y top_ips (≤ 10) de edge_hits con
// la RPC vg_traffic (0006). La IP va completa, como en el contrato: el panel la cruza con resource = 'ip:'+ip y la copia.
export const traffic = new Hono<AppEnv>();

const MAX_TOP = 10;
type Rpc = { buckets?: { t: string; n: number; n4xx: number; n5xx: number }[];
  top_ips?: { ip: string; n: number; ua_top: string | null }[] };

traffic.get('/orgs/:org/traffic', async (c) => {
  const raw = c.req.query('seconds');
  const seconds = raw === undefined || raw === '' ? 300 : /^\d{2,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(seconds >= 60 && seconds <= 3600)) {
    throw new ApiError('invalid_body', 'Ventana no válida', { field_errors: { seconds: ['Entre 60 y 3600 segundos'] } });
  }
  const { data, error } = await db(c.env).rpc('vg_traffic', { p_org: c.get('orgId'), p_seconds: seconds });
  if (error) {
    log('error', 'traffic.error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer el tráfico');
  }
  const r = (data ?? {}) as Rpc;
  return c.json(Traffic.parse({
    // date_bin da timestamptz → «…+00:00» en el jsonb; el contrato quiere «…Z».
    buckets: (r.buckets ?? []).map((b) => ({ t: iso(b.t), n: Number(b.n), n4xx: Number(b.n4xx), n5xx: Number(b.n5xx) })),
    // mode() del UA puede ser '' (columna not null default ''): sin UA es null en el contrato.
    top_ips: (r.top_ips ?? []).slice(0, MAX_TOP).map((t) => ({ ip: String(t.ip), n: Number(t.n), ua_top: t.ua_top || null })),
  }));
});
