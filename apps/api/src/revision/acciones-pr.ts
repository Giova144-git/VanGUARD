import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProviderErrorCode } from '@vanguard/contracts';
import { withSecret } from '../lib/credentials.ts';
import { ApiError } from '../lib/errors.ts';
import { pedir, ProviderError } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { PARECE_SECRETO } from '../scans/comun.ts';
import { codigoGithub, ghHeaders, leerAcotado } from '../scans/repo.ts';

// Escrituras en el GitHub del cliente con el token de ACCIONES (conexión GitHub kind 'action', una por org; 0016):
// estado de commit (revision/estado.ts), y con el anexo bloqueo-merge-cierre-pr.md comentar, cerrar y reabrir un PR y
// crear un issue. El repo sale siempre de connections.meta de esa conexión (validado), nunca de un payload ni de un
// mensaje; el token solo vive dentro de withSecret. Las respuestas de GitHub no se registran ni se interpolan: solo el
// código HTTP decide. reabrirPr y crearIssue son las ACCIONES que luego dispararán los botones del WhatsApp («Reabrir
// el PR», «Crear issue»; asignaciones/avisos-whatsapp-botones.md): devuelven un motivo corto que el panel (E54) o el
// botón traducen, y no saben nada de WhatsApp. El botón y su confirmación («Sí, reabrir») los conecta otro trabajo.

const GH = 'https://api.github.com';
const PLAZO_MS = 10_000;
// dueño/nombre de GitHub sin . ni .. (copia de scans/repo.ts, allí sin exportar).
export const NOMBRE_REPO = /^[A-Za-z0-9_-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
export const TRANSITORIO_GH: ReadonlySet<string> = new Set(['unavailable', 'timeout', 'rate_limited']);
const MAX_PR = 2_147_483_647;
const cp = String.fromCharCode;   // controles bidi armados en tiempo de ejecución: ninguno crudo en el repo
const BIDI = new RegExp(`[${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}]`);

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {});

/** Resultado de una escritura: ok con el status (y el JSON si se pidió leerlo, acotado), o el código sin texto de GitHub.
 *  status null = no hubo respuesta (red, plazo o salida bloqueada). expira = cabecera de caducidad del token, en ISO. */
export type Escrito = { ok: true; status: number; expira: string | null; json: unknown }
  | { ok: false; status: number | null; code: ProviderErrorCode };

/** POST o PATCH a la API de GitHub con el token de acciones. Nunca lanza: la red y el plazo vuelven como código (pedir
 *  sigue hasta 3 saltos al mismo host: cada uno es otra subpetición). `leer` = bytes del cuerpo que se leen (0: se cancela
 *  sin leer). Un 403 con cabeceras de límite sale rate_limited (codigoGithub), como en el resto del BACK. */
export async function escribirGh(token: string, method: 'POST' | 'PATCH', ruta: string, cuerpo: unknown, leer = 0):
  Promise<Escrito> {
  let r: Response;
  try {
    r = await pedir(`${GH}${ruta}`, { method, headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo) }, PLAZO_MS);
  } catch (e) {
    return { ok: false, status: null, code: e instanceof ProviderError ? e.code : 'unavailable' };
  }
  if (r.status < 200 || r.status >= 300) {
    await r.body?.cancel();
    return { ok: false, status: r.status, code: codigoGithub(r) };
  }
  const exp = r.headers.get('github-authentication-token-expiration');
  const expira = exp && !Number.isNaN(Date.parse(exp)) ? new Date(exp).toISOString() : null;
  let json: unknown = null;
  if (leer > 0) {
    try {
      const { texto, cortado } = await leerAcotado(r, leer);
      json = cortado ? null : JSON.parse(texto);
    } catch { json = null; }
  } else await r.body?.cancel();
  return { ok: true, status: r.status, expira, json };
}

const prValido = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_PR;

/** Comentario en el PR (POST /issues/{n}/comments: los PR son issues). Texto fijo de core (textoCierrePr). */
export const comentarPr = (token: string, repo: string, n: number, texto: string) =>
  escribirGh(token, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: texto });
/** Cierra o reabre el PR (PATCH /pulls/{n} con state). Pide «Pull requests: Read and write». */
export const cambiarEstadoPr = (token: string, repo: string, n: number, state: 'open' | 'closed') =>
  escribirGh(token, 'PATCH', `/repos/${repo}/pulls/${n}`, { state });

// ── La conexión de acciones y su repo ──────────────────────────────────────────────────────────────────────────────
export type Accion = { id: string; repo: string; meta: Obj; caps: Obj };
const idRepo = (m: Obj): string | null => {
  const x = m.repo_id;
  return (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) || (typeof x === 'string' && /^\d{1,20}$/.test(x))
    ? String(x) : null;
};
/** Mismo repo: repo_id si las dos lo tienen; si no, el nombre sin mayúsculas (varias-codebases.md §2.6, punto 5). */
export function mismoRepoGh(a: Obj, b: Obj): boolean {
  const ia = idRepo(a), ib = idRepo(b);
  if (ia && ib) return ia === ib;
  const na = typeof a.repo_full_name === 'string' ? a.repo_full_name.toLowerCase() : null;
  return !!na && na === (typeof b.repo_full_name === 'string' ? b.repo_full_name.toLowerCase() : null);
}

/** La conexión GitHub de acciones ACTIVA de la org (1 subpetición: también trae las de lectura). Con lecturaId (la
 *  conexión de la config de la revisión), exige que las dos sean del mismo repo: nunca se escribe en un repo lo que se
 *  revisó en otro. Lanza ProviderError('unavailable') si la base falla. */
export async function conexionAccion(admin: SupabaseClient, orgId: string, lecturaId: string | null):
  Promise<{ ok: true; accion: Accion } | { ok: false; motivo: 'sin_token' | 'otro_repo' | 'repo_invalido' }> {
  const { data, error } = await admin.from('connections').select('id, kind, status, meta, capabilities')
    .eq('org_id', orgId).eq('provider', 'github').in('kind', ['read', 'action']).limit(20);
  if (error) throw new ProviderError('unavailable');
  const filas = (Array.isArray(data) ? data : []) as Obj[];
  const a = filas.find((f) => f.kind === 'action' && f.status === 'active');
  if (!a) return { ok: false, motivo: 'sin_token' };
  const meta = obj(a.meta);
  const repo = typeof meta.repo_full_name === 'string' ? meta.repo_full_name : '';
  if (!NOMBRE_REPO.test(repo)) return { ok: false, motivo: 'repo_invalido' };
  if (lecturaId !== null) {
    const l = filas.find((f) => f.kind === 'read' && f.id === lecturaId);
    if (!l || !mismoRepoGh(meta, obj(l.meta))) return { ok: false, motivo: 'otro_repo' };
  }
  return { ok: true, accion: { id: String(a.id), repo, meta, caps: obj(a.capabilities) } };
}

const ctxAccion = (orgId: string, id: string) =>
  ({ orgId, connectionId: id, provider: 'github' as const, kind: 'action' as const });
const leerAccion = async (admin: SupabaseClient, orgId: string, lecturaId: string | null) => {
  try {
    return await conexionAccion(admin, orgId, lecturaId);
  } catch {
    throw new ApiError('internal', 'No pudimos leer la conexión');
  }
};
/** 401/403/404 → su código; 422 y otros 4xx → 'rechazado'; red, plazo, 429, 403 con límite y 5xx → 'red'. */
export const motivoGh = (code: ProviderErrorCode): string => (TRANSITORIO_GH.has(code) ? 'red'
  : code === 'unauthorized' || code === 'forbidden' || code === 'not_found' ? code : 'rechazado');

export type ResultadoAccion = { ok: true; numero: number | null; url?: string } | { ok: false; motivo: string };

async function leerRevisionYConfig(admin: SupabaseClient, orgId: string, reviewId: string) {
  const { data: rev, error } = await admin.from('code_reviews').select('id, config_id, event, pr_number, gate_pr_action')
    .eq('id', reviewId).eq('org_id', orgId).maybeSingle();
  if (error) throw new ApiError('internal', 'No pudimos leer la revisión');
  if (!rev) return null;
  const { data: cfg, error: ec } = await admin.from('code_review_configs').select('id, connection_id')
    .eq('id', String(obj(rev).config_id)).eq('org_id', orgId).maybeSingle();
  if (ec) throw new ApiError('internal', 'No pudimos leer la revisión');
  return { rev: obj(rev), lecturaId: cfg ? String(obj(cfg).connection_id) : null };
}

/** Token de acciones de una conexión activa: withSecret lanza la MISMA ApiError si falta el secreto y si la base falla
 *  (08006, plazo), y con la conexión activa casi siempre es lo segundo. 'sin_credencial' = «no pudimos leerlo, vuelve a
 *  intentarlo»; nunca «falta el token» (eso es sin_token, sin conexión activa). */
async function conToken(env: CloudflareBindings, admin: SupabaseClient, orgId: string, id: string,
  fn: (token: string) => Promise<Escrito>): Promise<Escrito | 'sin_credencial'> {
  try {
    return await withSecret(env, admin, ctxAccion(orgId, id), fn);
  } catch (e) {
    if (e instanceof ApiError) return 'sin_credencial';
    throw e;
  }
}

// Las dos acciones escriben en el GitHub del cliente: como el paso 'estado' (§2.4, paso 4), ni un despliegue de prueba ni
// local lo hacen (dev y prod comparten la base). Fuera de producción responden dry_run sin leer ni escribir nada; quien
// llame (E54, el botón del WhatsApp) exige además el host de producción.

/** «Reabrir el PR» (anexo, punto 6): solo un PR que cerró VanGUARD (gate_pr_action 'closed'). PATCH state open con el
 *  token de acciones; el ✗ y el comentario se quedan. Deja gate_pr_action 'reopened' (CAS desde closed o
 *  reopened_by_human: el webhook del reabierto puede llegar antes que esta escritura). Lo usan E54 (op reopen_pr) y, más
 *  adelante, el botón del WhatsApp tras su «Sí, reabrir». Subpeticiones: revisión 1 + config 1 + conexiones 1 + secreto
 *  1 + llaves ≤ 2 + PATCH ≤ 4 + escritura 1 ≤ 11. */
export async function reabrirPr(env: CloudflareBindings, admin: SupabaseClient, orgId: string, reviewId: string,
  o: { rid?: string; via?: 'panel' | 'whatsapp' } = {}): Promise<ResultadoAccion> {
  if (env.VG_ENV !== 'production') return { ok: false, motivo: 'dry_run' };
  const leida = await leerRevisionYConfig(admin, orgId, reviewId);
  if (!leida) return { ok: false, motivo: 'no_encontrada' };
  const { rev, lecturaId } = leida;
  const n = rev.pr_number;
  if (rev.event !== 'pull_request' || !prValido(n)) return { ok: false, motivo: 'no_es_pr' };
  if (rev.gate_pr_action === 'reopened' || rev.gate_pr_action === 'reopened_by_human') {
    return { ok: false, motivo: 'ya_abierto' };
  }
  if (rev.gate_pr_action !== 'closed') return { ok: false, motivo: 'no_cerrado' };
  const c = await leerAccion(admin, orgId, lecturaId);
  if (!c.ok) return { ok: false, motivo: c.motivo };
  if (c.accion.caps.pull_requests !== true) return { ok: false, motivo: 'sin_permiso_pr' };
  const { repo } = c.accion;
  const r = await conToken(env, admin, orgId, c.accion.id, (t) => cambiarEstadoPr(t, repo, n, 'open'));
  if (r === 'sin_credencial') return { ok: false, motivo: r };
  if (!r.ok) {
    const motivo = motivoGh(r.code);
    log('warn', 'gate.pr_reabrir_error', { rid: o.rid, review: reviewId, motivo, status: r.status, via: o.via ?? 'panel' });
    return { ok: false, motivo };
  }
  const { error } = await admin.from('code_reviews').update({ gate_pr_action: 'reopened', gate_pr_error: null })
    .eq('id', reviewId).eq('org_id', orgId).in('gate_pr_action', ['closed', 'reopened_by_human']);
  if (error) log('warn', 'gate.pr_reabierto_sin_marca', { rid: o.rid, review: reviewId, code: error.code ?? null });
  log('info', 'gate.pr_reabierto', { rid: o.rid, review: reviewId, pr: n, via: o.via ?? 'panel' });
  return { ok: true, numero: n };
}

/** «Crear issue» (anexo de botones): título y cuerpo los arma quien llama con texto FIJO (regla, archivo y línea sin el
 *  valor, pasos de la plantilla de corrección); aquí solo se comprueba que no traen nada con forma de secreto ni
 *  controles bidi (el repo puede ser público) y se crea con la etiqueta `vanguard`. Exige el permiso «Issues: Read and
 *  write» (capabilities.issues, lo comprueba E53) y que la revisión sea del repo del token. Devuelve número y URL. */
export async function crearIssue(env: CloudflareBindings, admin: SupabaseClient, orgId: string, reviewId: string,
  t: { titulo: string; cuerpo: string }, o: { rid?: string; via?: 'panel' | 'whatsapp' } = {}): Promise<ResultadoAccion> {
  if (env.VG_ENV !== 'production') return { ok: false, motivo: 'dry_run' };
  const titulo = t.titulo.trim(), cuerpo = t.cuerpo.trim();
  if (!titulo || titulo.length > 200 || cuerpo.length > 10_000 || PARECE_SECRETO.test(`${titulo}\n${cuerpo}`)
    || BIDI.test(`${titulo}${cuerpo}`)) {
    return { ok: false, motivo: 'texto_rechazado' };
  }
  const leida = await leerRevisionYConfig(admin, orgId, reviewId);
  if (!leida) return { ok: false, motivo: 'no_encontrada' };
  const c = await leerAccion(admin, orgId, leida.lecturaId);
  if (!c.ok) return { ok: false, motivo: c.motivo };
  if (c.accion.caps.issues !== true) return { ok: false, motivo: 'sin_permiso_issues' };
  const { repo } = c.accion;
  const issue = { title: titulo, body: cuerpo, labels: ['vanguard'] };
  const r = await conToken(env, admin, orgId, c.accion.id,
    (tok) => escribirGh(tok, 'POST', `/repos/${repo}/issues`, issue, 64_000));
  if (r === 'sin_credencial') return { ok: false, motivo: r };
  if (!r.ok) {
    const motivo = motivoGh(r.code);
    log('warn', 'gate.issue_error', { rid: o.rid, review: reviewId, motivo, status: r.status, via: o.via ?? 'panel' });
    return { ok: false, motivo };
  }
  // Creado (201) aunque el cuerpo no se pueda leer: numero null, nunca «no se pudo» sobre un issue que ya existe.
  const j = obj(r.json);
  const base = `https://github.com/${repo.toLowerCase()}/issues/`;
  const url = typeof j.html_url === 'string' && j.html_url.toLowerCase().startsWith(base) ? j.html_url : undefined;
  const numero = prValido(j.number) ? j.number : null;
  log('info', 'gate.issue_creado', { rid: o.rid, review: reviewId, issue: numero, via: o.via ?? 'panel' });
  return { ok: true, numero, ...(url ? { url } : {}) };
}
