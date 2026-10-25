import { Hono, type Context } from 'hono';
import { AuditSummary, Coverage, Id, ScanAccepted, ScanCreate, ScanRun, ZipResult, type ScanKind } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { pasosDe, primerPaso } from '../jobs.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError, fail } from '../lib/errors.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';
import { requireColaPropia } from '../mw/prod-host.ts';
import { hostsPropios, UrlNoMedible, urlMedibleOrg } from '../scans/psi.ts';
import { sanearNombreZip } from '../scans/zip-paso.ts';

// E11 · POST /api/orgs/:org/scans, E12 · GET /api/orgs/:org/scans/:id y E23 · POST …/scans/:id/zip-result (S15 15.4, 15.8;
// F-18: el ZIP se analiza en el navegador y E23 recibe solo deps y hallazgos enmascarados, §09.3).
export const scans = new Hono<AppEnv>();

const COLUMNAS = 'id, kind, status, progress, step, steps, score, coverage, summary, error, created_at, started_at, finished_at';
const EN_CURSO_MS = 15 * 60_000;
const PERF_EN_CURSO = 'Ya hay una medición de rendimiento en curso: espera a que termine';
// Un zip espera su resultado (E23) 15 min desde created_at: lo mismo que tarda el vigilante (0011, 900 s sin avance
// desde coalesce(started_at, created_at)) en cerrarlo. E23 fija started_at y así el vigilante vuelve a contar desde ahí.
const ESPERA_ZIP_MS = 15 * 60_000;
const PROVEEDOR: Partial<Record<ScanKind, string>> = { supabase: 'supabase', cloudflare: 'cloudflare', repo: 'github' };

export const banda = (s: number | null) => (s === null ? null : s <= 49 ? 'red' : s <= 79 ? 'amber' : 'green');

// Fila de scan_runs → ScanRun. coverage.detail y otros campos internos los quita zod; summary inválido → null.
export function aScanRun(f: Record<string, unknown>): ScanRun {
  const cov = Coverage.safeParse(f.coverage);
  const sum = AuditSummary.safeParse(f.summary);
  const score = typeof f.score === 'number' ? f.score : null;
  const t = (x: unknown) => (typeof x === 'string' ? iso(x) : null);
  return ScanRun.parse({ ...f, steps: Array.isArray(f.steps) ? f.steps : [], score, band: banda(score),
    coverage: cov.success ? cov.data : null, summary: sum.success ? sum.data : null,
    created_at: iso(String(f.created_at)), started_at: t(f.started_at), finished_at: t(f.finished_at) });
}

// Inicio del día en Caracas (UTC−4, sin horario de verano): el tope de auditorías es por día de America/Caracas.
export function inicioDiaCaracas(ahora = new Date()): string {
  const c = new Date(ahora.getTime() - 4 * 3_600_000);
  return new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate(), 4)).toISOString();
}

// Topes diarios por org (día de Caracas): full_audit = app_config.topes.org_audits_day (3) y lighthouse = org_perf_day (10,
// §10.4: cada medición es una llamada a PSI); la org de demo, 20 de cada uno [propuesta].
const TOPE_DIA: Partial<Record<ScanKind, { clave: string; defecto: number; texto: (n: number) => string }>> = {
  full_audit: { clave: 'org_audits_day', defecto: 3, texto: (n) => `Ya hiciste ${n} auditorías completas hoy. Vuelve mañana.` },
  lighthouse: { clave: 'org_perf_day', defecto: 10,
    texto: (n) => `Ya hiciste ${n} mediciones de rendimiento hoy, el máximo diario. Vuelve mañana.` },
};

// RL_COSTLY (§06.9): 10 por minuto y usuario en E11; cada auditoría encola trabajo y puede gastar IA.
async function topeCostoso(c: Context<AppEnv>) {
  const { success } = await c.env.RL_COSTLY.limit({ key: `u:${c.get('userId')}` });
  if (success) return null;
  c.header('Retry-After', '60');
  return fail(c, 'rate_limited', 'Demasiadas auditorías seguidas. Espera un minuto.');
}

scans.post('/orgs/:org/scans', requireAdmin, requireColaPropia, async (c) => {
  const tope = await topeCostoso(c);
  if (tope) return tope;
  const body = await cuerpo(c, ScanCreate);
  const admin = db(c.env);
  const orgId = c.get('orgId');
  // lighthouse («Medir ahora», §10.4): la URL se valida antes de tocar la base (scans/psi.ts; el paso la repite). Nunca IPs,
  // hosts internos ni los de VanGUARD (salvo la víctima de la demo desde la org de demo); se guarda como https://host/ruta,
  // la forma que exigen perf_runs.url y el histórico.
  let urlPerf: string | null = null;
  if (body.kind === 'lighthouse') {
    try {
      urlPerf = await urlMedibleOrg(admin, orgId, body.url, hostsPropios(c.env));
    } catch (e) {
      if (!(e instanceof UrlNoMedible)) throw e;
      throw new ApiError('invalid_body', e.message, { reason: e.motivo, field_errors: { url: [e.message] } });
    }
  }

  // 409 si ya hay una del mismo kind en curso creada hace < 15 min (en zip se libera la que espera resultado). La lectura no
  // tiene candado: en lighthouse lo hace atómico el índice único parcial de 0019 (23505 en el insert, más abajo).
  const { data: enCurso } = await admin.from('scan_runs').select('id, step, requested_by').eq('org_id', orgId).eq('kind', body.kind)
    .in('status', ['queued', 'running']).gt('created_at', new Date(Date.now() - EN_CURSO_MS).toISOString()).limit(1).maybeSingle();
  if (enCurso) {
    if (body.kind === 'zip' && enCurso.step === 'waiting_result' && enCurso.requested_by === c.get('userId')) {
      await admin.from('scan_runs').update({ status: 'failed', error: 'ZIP_RESULT_MISSING', finished_at: new Date().toISOString() })
        .eq('id', enCurso.id).eq('org_id', orgId);
    } else {
      const texto = body.kind === 'lighthouse' ? PERF_EN_CURSO : 'Ya hay una auditoría de este tipo en curso';
      throw new ApiError('conflict', texto, { scan_run_id: enCurso.id });
    }
  }

  // Algo que auditar: full_audit necesita al menos una conexión de lectura activa; un kind de una fuente, la suya. zip y
  // lighthouse no usan conexión (el ZIP llega del navegador y PSI mide una URL pública).
  if (body.kind !== 'zip' && body.kind !== 'lighthouse') {
    const provs = body.kind === 'full_audit' ? ['supabase', 'cloudflare', 'github'] : [PROVEEDOR[body.kind] ?? ''];
    let q = admin.from('connections').select('id', { count: 'exact', head: true }).eq('org_id', orgId)
      .eq('kind', 'read').eq('status', 'active').in('provider', provs);
    if ('connection_id' in body && body.connection_id) q = q.eq('id', body.connection_id);
    const { count } = await q;
    if (!count) throw new ApiError('conflict', 'No hay ninguna conexión que auditar. Conecta un servicio primero.');
  }

  // Tope diario de full_audit y de mediciones de Rendimiento (TOPE_DIA), contando los scan_runs de ese kind de hoy.
  const cupo = TOPE_DIA[body.kind];
  if (cupo) {
    const [{ data: cfg }, { data: org }, { count: hoy }] = await Promise.all([
      admin.from('app_config').select('value').eq('key', 'topes').maybeSingle(),
      admin.from('orgs').select('is_demo').eq('id', orgId).maybeSingle(),
      admin.from('scan_runs').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('kind', body.kind)
        .gte('created_at', inicioDiaCaracas()),
    ]);
    const tope = org?.is_demo ? 20 : Number((cfg?.value as Record<string, unknown> | undefined)?.[cupo.clave] ?? cupo.defecto);
    if ((hoy ?? 0) >= tope) throw new ApiError('budget_exceeded', cupo.texto(tope));
  }

  const kind = body.kind as ScanKind;
  const steps = pasosDe(kind).map((name) => ({ name, status: 'pending' }));
  const params: Record<string, unknown> = {};
  if ('connection_id' in body && body.connection_id) params.connection_id = body.connection_id;
  // zip: el nombre saneado (es el prefijo zip:<archivo>/ de sus hallazgos); queda queued en waiting_result sin encolar nada.
  if (body.kind === 'zip') Object.assign(params, { filename: sanearNombreZip(body.filename), size_bytes: body.size_bytes });
  // lighthouse: p.perf de §10.2, que lee el paso psi. Un solo paso con la estrategia pedida (ScanCreate admite una).
  if (body.kind === 'lighthouse') {
    params.perf = { url: urlPerf, strategy: body.strategy, ...(body.version_label ? { version_label: body.version_label } : {}),
      trigger: 'manual' };
  }
  const { data: fila, error } = await admin.from('scan_runs').insert({ org_id: orgId, kind, status: 'queued', steps, params,
    requested_by: c.get('userId'), ...(body.kind === 'zip' ? { step: 'waiting_result' } : {}) }).select('id').single();
  if (error?.code === '23514') {
    // private.looks_like_secret de scan_runs (0004): algo de params (la ruta de la URL) parece un secreto en claro.
    log('warn', 'TRIPWIRE', { rid: c.get('rid'), donde: 'scan_params' });
    throw new ApiError('invalid_body', 'La petición trae algo que parece un secreto sin enmascarar', { reason: 'looks_like_secret' });
  }
  // scan_runs_lighthouse_en_curso (0019): otra petición simultánea ya insertó su medición y la lectura de arriba no la vio.
  // Con una sola en curso por org, una ráfaga tampoco rebasa el cupo diario (la siguiente cuenta la anterior).
  if (error?.code === '23505' && body.kind === 'lighthouse') throw new ApiError('conflict', PERF_EN_CURSO);
  if (error || !fila) {
    log('error', 'scans.crear_error', { rid: c.get('rid'), code: error?.code ?? null });
    throw new ApiError('internal', 'No pudimos crear la auditoría');
  }
  if (body.kind !== 'zip') {
    try {
      await c.env.JOBS_Q.send({ v: 1, kind: 'scan', scan_run_id: fila.id, org_id: orgId, paso: primerPaso(kind) });
    } catch {
      await admin.from('scan_runs').update({ status: 'failed', error: 'No se pudo encolar', finished_at: new Date().toISOString() })
        .eq('id', fila.id).eq('org_id', orgId);
      throw new ApiError('provider_unavailable', 'No pudimos arrancar la auditoría. Vuelve a intentarlo.');
    }
  }
  log('info', 'scan.creado', { rid: c.get('rid'), kind, ...(body.kind === 'lighthouse' ? { strategy: body.strategy } : {}) });
  return c.json(ScanAccepted.parse({ scan_run_id: fila.id }), 202);
});

// E23 · POST /api/orgs/:org/scans/:id/zip-result · admin (§09.3 paso 5): el ZipResult del navegador. Lo mínimo para caber
// en 10 ms de CPU: busca el scan de ESTA org (404 uniforme), exige zip en waiting_result del mismo usuario y dentro de los
// 15 min (409), valida con zod (422; el cuerpo > 1 MB lo corta antes el bodyLimit de app.ts con 413), guarda el resultado
// en params.zip y encola el paso zip. Un solo uso y atómico: el update va condicionado a step = 'waiting_result' y lo
// deja en null, así que de dos E23 a la vez Postgres deja ganar a uno y el otro no actualiza ninguna fila (409).
const YA_NO_ESPERA = 'Esta auditoría ya no espera el resultado del ZIP: vuelve a elegirlo';
scans.post('/orgs/:org/scans/:id/zip-result', requireAdmin, requireColaPropia, async (c) => {
  const id = Id.safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError('not_found', 'Esa auditoría no existe');
  const admin = db(c.env);
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const { data: scan, error } = await admin.from('scan_runs').select('id, kind, status, step, params, requested_by, created_at')
    .eq('id', id.data).eq('org_id', orgId).maybeSingle();
  if (error) throw new ApiError('internal', 'No pudimos leer la auditoría');
  if (!scan) throw new ApiError('not_found', 'Esa auditoría no existe');
  if (scan.kind !== 'zip') throw new ApiError('conflict', 'Esta auditoría no es de un ZIP', { reason: 'not_zip' });
  if (scan.status !== 'queued' || scan.step !== 'waiting_result' || scan.requested_by !== userId) {
    throw new ApiError('conflict', YA_NO_ESPERA, { reason: 'not_waiting' });
  }
  const limite = new Date(Date.now() - ESPERA_ZIP_MS).toISOString();
  if (Date.parse(String(scan.created_at)) <= Date.parse(limite)) {
    // Se cierra ya (el vigilante lo haría en su minuto) para que el FRONT vea un estado final, no una espera eterna.
    await admin.from('scan_runs').update({ status: 'failed', error: 'ZIP_RESULT_MISSING', finished_at: new Date().toISOString() })
      .eq('id', id.data).eq('org_id', orgId).eq('status', 'queued').eq('step', 'waiting_result');
    throw new ApiError('conflict', 'Pasaron más de 15 minutos desde que elegiste el ZIP: vuelve a elegirlo', { reason: 'expired' });
  }
  const resultado = await cuerpo(c, ZipResult);
  const previos = (scan.params ?? {}) as { filename?: unknown; size_bytes?: unknown };
  const params = { filename: sanearNombreZip(typeof previos.filename === 'string' ? previos.filename : ''),
    size_bytes: previos.size_bytes ?? null, zip: resultado };
  const { data: gana, error: eu } = await admin.from('scan_runs')
    .update({ params, step: null, started_at: new Date().toISOString() })
    .eq('id', id.data).eq('org_id', orgId).eq('kind', 'zip').eq('status', 'queued').eq('step', 'waiting_result')
    .eq('requested_by', userId).gt('created_at', limite).select('id');
  if (eu?.code === '23514') {
    // private.looks_like_secret de scan_runs (0004): algo del resultado parece un secreto en claro; no se guarda nada.
    log('warn', 'TRIPWIRE', { rid: c.get('rid'), donde: 'zip_result' });
    throw new ApiError('invalid_body', 'El resultado trae algo que parece un secreto sin enmascarar', { reason: 'looks_like_secret' });
  }
  if (eu) {
    log('error', 'scans.zip_guardar_error', { rid: c.get('rid'), code: eu.code ?? null });
    throw new ApiError('internal', 'No pudimos guardar el resultado del ZIP');
  }
  if (!Array.isArray(gana) || gana.length === 0) throw new ApiError('conflict', YA_NO_ESPERA, { reason: 'not_waiting' });
  try {
    await c.env.JOBS_Q.send({ v: 1, kind: 'scan', scan_run_id: id.data, org_id: orgId, paso: primerPaso('zip') });
  } catch {
    await admin.from('scan_runs').update({ status: 'failed', error: 'No se pudo encolar', finished_at: new Date().toISOString() })
      .eq('id', id.data).eq('org_id', orgId);
    throw new ApiError('provider_unavailable', 'No pudimos arrancar el análisis. Vuelve a elegir el ZIP.');
  }
  log('info', 'scan.zip_recibido', { rid: c.get('rid'), deps: resultado.deps.length, hallazgos: resultado.findings.length });
  return c.json(ScanAccepted.parse({ scan_run_id: id.data }), 202);
});

scans.get('/orgs/:org/scans/:id', async (c) => {
  const id = Id.safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError('not_found', 'Auditoría no encontrada');
  const { data, error } = await db(c.env).from('scan_runs').select(COLUMNAS).eq('id', id.data).eq('org_id', c.get('orgId')).maybeSingle();
  if (error) throw new ApiError('internal', 'No pudimos leer la auditoría');
  if (!data) throw new ApiError('not_found', 'Auditoría no encontrada');
  return c.json(aScanRun(data as Record<string, unknown>));
});
