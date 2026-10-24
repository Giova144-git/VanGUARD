import { Hono } from 'hono';
import { Finding, FindingPatch, FindingStatus, FixPromptRequest, FixPromptResponse, Id, Module, Severity } from '@vanguard/contracts';
import { armarPromptCorreccion, conSabor, plantillaCorreccion } from '@vanguard/core';
import { pedirFixPrompt } from '../ia/claude.ts';
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

// E15 · POST /api/orgs/:org/findings/:id/fix-prompt · user (genera: admin; viewer y anónimo: solo caché) · P0.
// Con fix_prompt guardado → cached:true sin llamar al modelo. Si la IA falla, va la plantilla de la regla: 429/503
// con details.fallback_prompt (presupuesto o IA apagada) o 200 con model:'template' y las banderas (filtro de salida).
findings.post('/orgs/:org/findings/:id/fix-prompt', async (c) => {
  const id = idDe(c.req.param('id'));
  let flavor: 'generic' | 'claude_code' | 'cursor' = 'generic';
  const texto = await c.req.text();
  if (texto.trim()) {
    let raw: unknown;
    try { raw = JSON.parse(texto); } catch { throw new ApiError('invalid_body', 'El cuerpo de la petición no es JSON válido'); }
    const b = FixPromptRequest.safeParse(raw);
    if (!b.success) throw new ApiError('invalid_body', 'Revisa los campos marcados', { field_errors: { flavor: ['Sabor no válido'] } });
    flavor = b.data.flavor;
  }
  const admin = db(c.env);
  const orgId = c.get('orgId');
  const { data: f, error } = await admin.from('findings')
    .select('id, module, rule_id, severity, confirmed, title, resource, evidence, fix_prompt, fix_model')
    .eq('id', id).eq('org_id', orgId).maybeSingle();
  if (error) throw new ApiError('internal', 'No pudimos leer el hallazgo');
  if (!f) throw new ApiError('not_found', 'Hallazgo no encontrado');
  const evidencia = (f.evidence ?? {}) as Record<string, unknown>;
  if (typeof f.fix_prompt === 'string' && f.fix_prompt) {
    return c.json(FixPromptResponse.parse({ prompt: conSabor(f.fix_prompt, flavor), model: f.fix_model ?? 'template', cached: true,
      injection_flags: [] }));
  }
  const rol = c.get('role');
  if (c.get('isAnon') || (rol !== 'owner' && rol !== 'admin')) {
    throw new ApiError('forbidden', 'Este prompt todavía no está generado. Pídeselo a un administrador de la organización.');
  }
  const base = { rule_id: f.rule_id, severity: f.severity, resource: f.resource, evidence: evidencia, title: f.title };
  const plantilla = () => armarPromptCorreccion(base, plantillaCorreccion(base));
  const r = await pedirFixPrompt(c.env, { org_id: orgId, hallazgo: { rule_id: f.rule_id, severity: f.severity,
    confirmed: f.confirmed, title: f.title, resource: f.resource, module: f.module, evidence: evidencia } });
  if (!r.ok) {
    if (r.code === 'budget') throw new ApiError('budget_exceeded', 'Llegaste al tope de IA de hoy. Te dejamos la corrección base.', { fallback_prompt: conSabor(plantilla(), flavor) });
    if (r.code === 'disabled') throw new ApiError('ai_disabled', 'La IA está en pausa. Te dejamos la corrección base.', { fallback_prompt: conSabor(plantilla(), flavor) });
    log('info', 'fix_prompt.plantilla', { rid: c.get('rid'), code: r.code, flags: r.injection_flags.length });
    return c.json(FixPromptResponse.parse({ prompt: conSabor(plantilla(), flavor), model: 'template', cached: false,
      injection_flags: r.injection_flags }));
  }
  const prompt = armarPromptCorreccion(base, r.data);
  const { error: eu } = await admin.from('findings').update({ fix_prompt: prompt, fix_model: r.model }).eq('id', id).eq('org_id', orgId);
  if (eu) {
    // 23514 = el cable trampa vio un secreto en la salida: no se guarda ni se devuelve; va la plantilla.
    log('warn', 'fix_prompt.no_guardado', { rid: c.get('rid'), code: eu.code });
    return c.json(FixPromptResponse.parse({ prompt: conSabor(plantilla(), flavor), model: 'template', cached: false,
      injection_flags: [...r.injection_flags, 'secreto'] }));
  }
  return c.json(FixPromptResponse.parse({ prompt: conSabor(prompt, flavor), model: r.model, cached: false, injection_flags: r.injection_flags }));
});
