import type { Module } from '@vanguard/contracts';
import { redact } from '@vanguard/core';
import { dedupeKey } from '@vanguard/core/crypto';
import type { MsgScan } from '../jobs.ts';
import { db } from '../lib/db.ts';
import { ProviderError } from '../lib/http.ts';
import { log } from '../lib/log.ts';

// Piezas comunes de los pasos de la auditoría (S15 15.8).
// dedupe_input: lo que identifica el hallazgo dentro de la regla (por defecto el resource; en SQL 2 es recurso#política y
// en advisors el cache_key del lint, según packages/core/src/rules/supabase.ts).
export type Borrador = { rule_id: string; severity: string; confirmed?: boolean; origin?: 'rule' | 'ai' | 'provider';
  title: string; resource: string; evidence?: Record<string, unknown>; suspected_injection?: boolean; dedupe_input?: string };
export type Conexion = { id: string; meta: Record<string, unknown>; capabilities: Record<string, unknown> };

// Conexión de lectura activa del proveedor: la del params del scan_run si la pidieron; si no, en GitHub la MÁS ANTIGUA
// (el repo principal: conectar un 2.º repo no cambia el que mira la auditoría; varias-codebases.md B0) y en los demás
// proveedores la más reciente.
export async function conexionActiva(env: CloudflareBindings, m: MsgScan, provider: string): Promise<Conexion | null> {
  const admin = db(env);
  const { data: scan } = await admin.from('scan_runs').select('params').eq('id', m.scan_run_id).eq('org_id', m.org_id).maybeSingle();
  const pedida = (scan?.params as { connection_id?: string } | undefined)?.connection_id;
  let q = admin.from('connections').select('id, meta, capabilities').eq('org_id', m.org_id).eq('provider', provider)
    .eq('kind', 'read').eq('status', 'active');
  if (pedida) q = q.eq('id', pedida);
  const asc = provider === 'github';
  const { data, error } = await q.order('created_at', { ascending: asc }).order('id', { ascending: asc }).limit(1).maybeSingle();
  if (error) throw new ProviderError('unavailable');
  return (data as Conexion | null) ?? null;
}

// Clave de los hallazgos de código por repo (varias-codebases.md §2.2). Solo conexiones nacidas con
// meta.hallazgos_por_repo (E8 la pone si la org ya tenía otro repo): las de antes conservan su clave y sus hallazgos
// abiertos no se duplican. El resource visible no cambia; el repo solo entra en el hash de dedupe_key.
export function claveDeRepo(meta: Record<string, unknown>): (b: Borrador) => Borrador {
  const repo = meta.hallazgos_por_repo === true && typeof meta.repo_full_name === 'string'
    ? meta.repo_full_name.toLowerCase() : null;
  return repo ? (b) => ({ ...b, dedupe_input: `${repo}|${b.dedupe_input ?? b.resource}` }) : (b) => b;
}

// Toda la evidencia pasa por redact() antes de salir del paso; dedupe_key = sha256hex(org|regla|recurso) (§05). La usa
// también la revisión de código (revision/pasos.ts), que en vez de prefiltrar pasa sus filas por ocultarRutas.
export async function aFila(orgId: string, b: Borrador) {
  const limpio = redact({ title: b.title, resource: b.resource, evidence: b.evidence ?? {}, clave: b.dedupe_input ?? b.resource });
  return { rule_id: b.rule_id, severity: b.severity, confirmed: b.confirmed ?? false, origin: b.origin ?? 'rule',
    title: limpio.title.slice(0, 200), resource: limpio.resource.slice(0, 300), evidence: limpio.evidence,
    suspected_injection: b.suspected_injection ?? false, dedupe_key: await dedupeKey(orgId, b.rule_id, limpio.clave) };
}
export type Fila = Awaited<ReturnType<typeof aFila>>;

// Copia en JS de private.looks_like_secret (0001_base.sql), sin \b, igual que allí (redact() sí lo exige, así que
// «x_ghp_…» pasa redact() y la base lo rechaza). El cable trampa mira evidence::text, title y resource. Si cambia el
// SQL, cambia esto (el rescate de abajo cubre la deriva).
export const PARECE_SECRETO = /(sb_secret_[A-Za-z0-9_-]{16,}|sbp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|vg[iks]_[A-Za-z0-9_-]{20,}|cf(k|ut|at)_[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.)/;

// Regla 9 en memoria, antes del primer RPC (así el 23514 es de verdad excepcional y no gasta subpeticiones): la fila
// cuya evidencia casa va con evidence {redacted:true}; la que lo lleva en title o resource se descarta.
export function prefiltrar(filas: readonly Fila[]): { filas: Fila[]; descartadas: number } {
  const out: Fila[] = [];
  let descartadas = 0;
  for (const f of filas) {
    if (PARECE_SECRETO.test(`${f.title} ${f.resource}`)) { log('warn', 'TRIPWIRE', { rule_id: f.rule_id, descartada: true }); descartadas++; }
    else if (PARECE_SECRETO.test(JSON.stringify(f.evidence))) { log('warn', 'TRIPWIRE', { rule_id: f.rule_id }); out.push({ ...f, evidence: { redacted: true } }); }
    else out.push(f);
  }
  return { filas: out, descartadas };
}

// Tope propio de subpeticiones por invocación (§A7): Free da 50 y dejamos 10 de margen.
export const TOPE_SUBPETICIONES = 40;
// Lo que guardarHallazgos puede gastar si el llamador no lo dice: lote + 6 de rescate (≤ 3 filas fila por fila) + cierre.
const PRESUPUESTO_GUARDAR = 8;

// vg_upsert_findings con cable trampa (regla 9). Si se descarta alguna fila, el paso no auto-verifica (su instancia
// anterior quedaría 'verified' sin haberse arreglado) y el llamador debe propagar error_code 'tripwire'.
// presupuesto = subpeticiones que puede gastar en total (lote, rescate y auto-verificación): lo que le queda al paso
// hasta TOPE_SUBPETICIONES. El rescate fila por fila (hasta 2 por fila) solo va si cabe; si no, un único lote con
// evidence {redacted:true} (§05.14, hallazgo 24).
export async function guardarHallazgos(env: CloudflareBindings, m: MsgScan, module: Module, connId: string | null,
  borradores: Borrador[], completo: boolean, regla?: string, presupuesto = PRESUPUESTO_GUARDAR):
  Promise<{ n: number; descartadas: number; error_code?: 'tripwire' }> {
  const admin = db(env);
  const pre = prefiltrar(await Promise.all(borradores.map((b) => aFila(m.org_id, b))));
  const filas = pre.filas;
  let descartadas = pre.descartadas;
  const fin = (n: number) => ({ n, descartadas, ...(descartadas > 0 ? { error_code: 'tripwire' as const } : {}) });
  const rpc = (rows: unknown[], complete: boolean) => admin.rpc('vg_upsert_findings', { p_org: m.org_id, p_scan: m.scan_run_id,
    p_module: module, p_conn: connId, p_rows: rows, p_complete: complete, ...(regla ? { p_rule: regla } : {}) });
  const otroError = (e: { code?: string } | null) => { if (e && e.code !== '23514') throw new ProviderError('unavailable'); };

  const auto = completo && descartadas === 0;
  if (!filas.length && !auto) return fin(0);
  const { error } = await rpc(filas, auto);
  if (!error) return fin(filas.length);
  otroError(error);

  // La base rechazó el lote aunque el filtro en JS no vio nada (deriva entre la regex de aquí y la del SQL).
  log('warn', 'TRIPWIRE', { lote: filas.length });
  const resto = presupuesto - 1;   // ya se gastó el lote
  let fallidas = 0;
  if (filas.length * 2 + (auto ? 1 : 0) <= resto) {
    for (const f of filas) {
      const r1 = await rpc([f], false);
      if (!r1.error) continue;
      otroError(r1.error);
      log('warn', 'TRIPWIRE', { rule_id: f.rule_id });
      const r2 = await rpc([{ ...f, evidence: { redacted: true } }], false);
      otroError(r2.error);
      if (r2.error) fallidas++;
    }
    if (auto && fallidas === 0) otroError((await rpc([], true)).error ?? null);   // auto-verifica solo si se guardó todo
  } else if (resto >= 1) {
    // Una sola llamada: el RPC es atómico, así que con p_complete escribe todo y auto-verifica, o no hace nada.
    const r = await rpc(filas.map((f) => ({ ...f, evidence: { redacted: true } })), auto);
    otroError(r.error);
    if (r.error) fallidas = filas.length;   // el secreto está en title o resource de alguna: no caben más pruebas
  } else {
    fallidas = filas.length;   // sin presupuesto ni para el lote tapado: nada se guarda y el paso avisa con tripwire
  }
  if (fallidas) log('warn', 'TRIPWIRE', { descartadas: fallidas });
  descartadas += fallidas;
  return fin(filas.length - fallidas);
}
