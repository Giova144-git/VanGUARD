import { Hono } from 'hono';
import { Finding, FindingPatch, FindingStatus, Id, Module, Severity } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';

// E13 · GET findings, E13b · GET findings/:id y E14 · PATCH findings/:id (S15 15.4). El texto de fix_prompt lo da E15.
export const findings = new Hono<AppEnv>();

export const COLUMNAS_FINDING = 'id, module, rule_id, severity, confirmed, origin, title, resource, evidence, fix_prompt, fix_model, '
  + 'status, status_reason, suspected_injection, scan_run_id, connection_id, first_seen_at, last_seen_at, verified_at';

// Fila → Finding: sin el texto del prompt y sin la huella completa de la evidencia (solo fingerprint_short).
export function aFinding(fila: unknown): Finding {
  const f = fila as Record<string, unknown>;
  const ev = { ...((f.evidence ?? {}) as Record<string, unknown>) };
  delete ev.fingerprint;
  const t = (x: unknown) => (typeof x === 'string' ? iso(x) : null);
  return Finding.parse({ ...f, evidence: ev, has_fix_prompt: typeof f.fix_prompt === 'string' && f.fix_prompt.length > 0,
    first_seen_at: iso(String(f.first_seen_at)), last_seen_at: iso(String(f.last_seen_at)), verified_at: t(f.verified_at) });
}

const idDe = (raw: string | undefined) => {
  const r = Id.safeParse(raw);
  if (!r.success) throw new ApiError('not_found', 'Hallazgo no encontrado');
  return r.data;
};

findings.get('/orgs/:org/findings', async (c) => {
  const q = c.req.query();
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
  const filtro = <T>(s: { safeParse: (x: unknown) => { success: boolean; data?: T } }, v: string | undefined, campo: string) => {
    if (v === undefined || v === '') return undefined;
    const r = s.safeParse(v);
    if (!r.success) throw new ApiError('invalid_body', 'Filtro no válido', { field_errors: { [campo]: ['Valor no válido'] } });
    return r.data as T;
  };
  const [module, severity, status] = [filtro(Module, q.module, 'module'), filtro(Severity, q.severity, 'severity'),
    filtro(FindingStatus, q.status, 'status')];
  let consulta = db(c.env).from('findings').select(COLUMNAS_FINDING).eq('org_id', c.get('orgId'));
  if (module) consulta = consulta.eq('module', module);
  if (severity) consulta = consulta.eq('severity', severity);
  if (status) consulta = consulta.eq('status', status);
  const { data, error } = await consulta.order('severity_rank', { ascending: false }).order('confirmed', { ascending: false })
    .order('last_seen_at', { ascending: false }).limit(limit);
  if (error) {
    log('error', 'findings.lista_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos leer los hallazgos');
  }
  return c.json((data ?? []).map((f) => aFinding(f)));
});

findings.get('/orgs/:org/findings/:id', async (c) => {
  const { data, error } = await db(c.env).from('findings').select(COLUMNAS_FINDING)
    .eq('id', idDe(c.req.param('id'))).eq('org_id', c.get('orgId')).maybeSingle();
  if (error) throw new ApiError('internal', 'No pudimos leer el hallazgo');
  if (!data) throw new ApiError('not_found', 'Hallazgo no encontrado');
  return c.json(aFinding(data));
});

findings.patch('/orgs/:org/findings/:id', requireAdmin, async (c) => {
  const id = idDe(c.req.param('id'));
  const b = await cuerpo(c, FindingPatch);
  const { data, error } = await db(c.env).from('findings')
    .update({ status: b.status, status_reason: b.reason ?? null, ...(b.status === 'open' ? { verified_at: null } : {}) })
    .eq('id', id).eq('org_id', c.get('orgId')).select(COLUMNAS_FINDING).maybeSingle();
  if (error) throw new ApiError('internal', 'No pudimos actualizar el hallazgo');
  if (!data) throw new ApiError('not_found', 'Hallazgo no encontrado');
  log('info', 'finding.status', { rid: c.get('rid'), user: c.get('userId'), status: b.status, con_motivo: !!b.reason });
  return c.json(aFinding(data));
});
