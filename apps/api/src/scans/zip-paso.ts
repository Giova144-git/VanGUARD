import { ZipDep, ZipResult, type Severity, type ZipFinding } from '@vanguard/contracts';
import { REGLAS_SECRETO, RUTA_PRUEBAS, unaLinea } from '@vanguard/core';
import { z } from 'zod';
import { REINTENTOS, type DepCompacta, type FnPaso, type MsgScan, type ResultadoPaso } from '../jobs.ts';
import { db } from '../lib/db.ts';
import { ProviderError } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { TOPE_SUBPETICIONES, guardarHallazgos, type Borrador } from './comun.ts';
import { DETALLE_POR_MENSAJE, depsVulnerables, detallar, esTransitorio, filaDep, type Dep } from './osv.ts';
import { TOPE_HALLAZGOS, aCursor, deCursor, recortar } from './repo-paso.ts';

// Paso zip (F-18, §09.3 paso 6): lo que el navegador analizó y E23 guardó en scan_runs.params.zip, tratado como entrada
// no confiable. Mensaje sin cursor: los hallazgos del navegador; `zip:osv` (cursor osv:…): OSV por rondas como repo:osv,
// con el mismo cursor y las mismas piezas de osv.ts y repo-paso.ts. Siempre p_conn null y p_complete false (0004, §09.3):
// con p_conn null la auto-verificación tocaría los hallazgos de otros ZIP y los de conexiones borradas, y un ZIP suelto
// no prueba que algo se arregló. Volver a subir el mismo archivo actualiza sus filas (mismo resource, misma dedupe_key).

const RONDAS_OSV = 8;          // = repo-paso.ts: 8 rondas de 12 = 96 paquetes con detalle; el resto entra sin_detalle
const MAX_DEPS = 2000;         // ZipResult.deps
const MAX_RESOURCE = 300;      // findings.resource (0004)
const BYTES_MENSAJE = 96_000;  // deps que viajan a la ronda siguiente: un mensaje de Queues admite 128 KB

// Nombre del ZIP para params.filename y el prefijo zip:<archivo>/ (E11): sin barras, sin '..', sin caracteres de control
// ni de formato (bidi, ancho cero) y ≤ 100. ScanCreate ya exige ^[\w .()-]{1,120}\.zip$: esto es la segunda capa.
const INVISIBLES = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
export function sanearNombreZip(nombre: string): string {
  const conExt = /\.zip$/i.test(nombre);
  const ext = conExt ? nombre.slice(-4) : '.zip';
  const base = (conExt ? nombre.slice(0, -4) : nombre).replace(INVISIBLES, '').replace(/[\\/]+/g, '_')
    .replace(/\.{2,}/g, '.').replace(/^[\s.]+/, '').slice(0, 100 - ext.length).replace(/[\s.]+$/, '');
  return (base || 'archivo') + ext;
}

const quitarPrefijo = (prefijo: string, s: string) => (s.startsWith(prefijo) ? s.slice(prefijo.length) : s);
const recortarIzq = (s: string, max: number) => (s.length > max ? '…' + s.slice(s.length - max + 1) : s);
// resource = zip:<archivo>/<ruta>[:línea] (§09.11). El navegador manda la ruta sin prefijo; si ya lo trae, no se duplica.
// El prefijo nunca se recorta (así un ZIP no pisa los hallazgos del repo): si no cabe, la ruta se recorta por la izquierda.
export function recursoZip(filename: string, ruta: string): string {
  const prefijo = `zip:${filename}/`;
  return prefijo + recortarIzq(quitarPrefijo(prefijo, ruta), MAX_RESOURCE - prefijo.length);
}

// Severidad por rule_id (§09.3: el cliente no la decide), con las dos excepciones que core calcula con lo que aquí no
// llega: low si el secreto solo está en rutas de prueba y critical si la URL de Postgres es de un host de Supabase. Con un
// navegador honrado da lo mismo que mandó.
const SEV_SECRETO: ReadonlyMap<string, Severity> = new Map(REGLAS_SECRETO.map((r) => [r.rule_id, r.severity]));
export function severidadZip(f: Pick<ZipFinding, 'rule_id' | 'severity'>, path: string): Severity {
  if (f.rule_id === 'CB_ENV_COMMITTED') return 'critical';
  if (f.rule_id === 'CB_GITIGNORE_NO_ENV') return 'medium';
  if (f.severity === 'low' && RUTA_PRUEBAS.test(path)) return 'low';
  if (f.rule_id === 'CB_SECRET_POSTGRES_URL' && f.severity === 'critical') return 'critical';
  return SEV_SECRETO.get(f.rule_id) ?? 'medium';
}

// ZipFinding → borrador de guardarHallazgos (redact() y el cable trampa van allí, como en repo). La evidencia es la
// enmascarada que llegó (path, line, preview ≤ 12) más fuente:'zip'; nunca un valor completo.
export function borradorZip(filename: string, f: ZipFinding): Borrador {
  const prefijo = `zip:${filename}/`;
  const { line, preview } = f.evidence;
  const path = quitarPrefijo(prefijo, f.evidence.path);
  const ruta = path ? (line ? `${path}:${line}` : path) : f.resource;
  return { rule_id: f.rule_id, severity: severidadZip(f, path), confirmed: true, origin: 'rule',
    title: unaLinea(f.title, 200) || 'Hallazgo del ZIP', resource: recursoZip(filename, ruta),
    evidence: { fuente: 'zip', path, ...(line ? { line } : {}), ...(preview ? { preview } : {}) } };
}

const aCompacta = (d: Dep): DepCompacta => [d.ecosystem, d.name, d.version, d.dev ? 1 : 0];
const deCompacta = ([ecosystem, name, version, dev]: DepCompacta): Dep => ({ ecosystem, name, version, dev: dev === 1 });
// Las deps de la ronda siguiente viajan en el mensaje. Si no caben (nombres absurdos de un cliente hostil), las que sobran
// cuentan como omitidas y OSV queda incompleto, en vez de un send que fallaría en cada reintento.
const UTF8 = new TextEncoder();
function caben(deps: Dep[]): { viajan: DepCompacta[]; sobran: number } {
  const viajan: DepCompacta[] = [];
  let bytes = 2;
  for (const d of deps) {
    const c = aCompacta(d);
    bytes += UTF8.encode(JSON.stringify(c)).length + 1;
    if (bytes > BYTES_MENSAJE) break;
    viajan.push(c);
  }
  return { viajan, sobran: deps.length - viajan.length };
}

// Presupuesto de subpeticiones (§A7, TOPE_SUBPETICIONES), en el peor caso como repo-paso.ts: guarded (leerScan y
// vg_claim_step) y la lectura de params antes; OSV lo cuentan depsVulnerables y 1 por detalle; después, leer y escribir
// coverage, contar los hallazgos y, en guarded, el send del paso siguiente (o de la continuación) y vg_mark_step.
const SUB = { guarded: 2, params: 1, cobertura: 2, total: 1, encolar: 1, marcar: 1 };
const SUB_CIERRE = SUB.cobertura + SUB.total + SUB.encolar + SUB.marcar;
const presupuesto = (gastadas: number, faltan: number) => TOPE_SUBPETICIONES - gastadas - faltan;

// error_code del paso: uno solo, el más importante (= repo-paso.ts). El detalle queda en coverage.detail.codebase.
const codigo = (e: { tripwire: boolean; osvCaido?: boolean; omitidas: number; parcial: boolean }) => {
  const c = e.tripwire ? 'tripwire' : e.osvCaido ? 'osv_unavailable' : e.omitidas > 0 ? 'hallazgos_truncados' : e.parcial ? 'parcial' : null;
  return c ? { error_code: c } : {};
};

// Solo las claves de params que hacen falta (selección jsonb de PostgREST): el resultado del ZIP puede ocupar 1 MB y
// leerlo entero en cada ronda gastaría CPU. `que`: el resultado entero, solo sus deps o solo el nombre.
async function leerParams(env: CloudflareBindings, m: MsgScan, que: 'zip' | 'deps' | 'nombre') {
  const cols = { zip: 'filename:params->>filename, zip:params->zip', deps: 'filename:params->>filename, deps:params->zip->deps',
    nombre: 'filename:params->>filename' }[que];
  const { data, error } = await db(env).from('scan_runs').select(cols).eq('id', m.scan_run_id).eq('org_id', m.org_id).maybeSingle();
  if (error) throw new ProviderError('unavailable');
  const fila = (data ?? {}) as unknown as { filename?: unknown; zip?: unknown; deps?: unknown };
  return { filename: typeof fila.filename === 'string' ? sanearNombreZip(fila.filename) : null, zip: fila.zip, deps: fila.deps };
}

async function totalHallazgos(env: CloudflareBindings, m: MsgScan): Promise<number> {
  const { count } = await db(env).from('findings').select('id', { count: 'exact', head: true }).eq('org_id', m.org_id)
    .eq('module', 'codebase').eq('scan_run_id', m.scan_run_id);
  return count ?? 0;
}

// coverage.detail.codebase (§09.5) se fusiona como en repo-paso.ts: no se pisa el resto de coverage ni otros módulos.
type Cobertura = Record<string, unknown>;
type DetalleCodebase = Record<string, unknown> & { miradas?: Record<string, boolean> };
async function leerCobertura(env: CloudflareBindings, m: MsgScan): Promise<Cobertura> {
  const { data, error } = await db(env).from('scan_runs').select('coverage').eq('id', m.scan_run_id).eq('org_id', m.org_id).maybeSingle();
  if (error) throw new ProviderError('unavailable');
  return (data?.coverage as Cobertura | null) ?? {};
}
const detalleDe = (cov: Cobertura): DetalleCodebase =>
  ((cov.detail as Record<string, unknown> | undefined)?.codebase as DetalleCodebase | undefined) ?? {};
async function escribirDetalle(env: CloudflareBindings, m: MsgScan, cov: Cobertura, codebase: DetalleCodebase) {
  const { error } = await db(env).from('scan_runs')
    .update({ coverage: { ...cov, detail: { ...((cov.detail as object | undefined) ?? {}), codebase } } })
    .eq('id', m.scan_run_id).eq('org_id', m.org_id);
  if (error) throw new ProviderError('unavailable');
}

// ── zip (sin cursor): hallazgos del navegador ──
// miradas (lo que de verdad se miró, §09.5): secretos y .env si el navegador vio archivos, el cable trampa no descartó
// nada y no hubo que recortar a 200; lockfiles si llegaron deps sin tocar el tope de 2000 (sin deps no se sabe si no
// había lockfile o no se pudo leer); osv lo fija el cierre de OSV.
async function hallazgosDelNavegador(env: CloudflareBindings, m: MsgScan): Promise<ResultadoPaso> {
  const p = await leerParams(env, m, 'zip');
  const r = ZipResult.safeParse(p.zip);
  if (!r.success || !p.filename) {
    log('warn', 'zip.sin_resultado', { valido: r.success });
    return { status: 'failed', error_code: 'ZIP_RESULT_MISSING' };
  }
  const zip = r.data;
  const filename = p.filename;
  const conDeps = zip.deps.length > 0;
  const g = await guardarHallazgos(env, m, 'codebase', null, zip.findings.map((f) => borradorZip(filename, f)), false, undefined,
    presupuesto(SUB.guarded + SUB.params, conDeps ? SUB.cobertura + SUB.encolar : SUB_CIERRE));
  const tripwire = g.descartadas > 0;
  const recortados = zip.findings.length >= TOPE_HALLAZGOS;   // el navegador manda los 200 más graves: pudo dejar fuera
  const depsTruncadas = zip.deps.length >= MAX_DEPS;
  const vio = zip.files_seen > 0;
  const miradas = { secretos: vio && !tripwire && !recortados, env: vio && !tripwire && !recortados,
    lockfiles: conDeps && !depsTruncadas, osv: false };
  await escribirDetalle(env, m, await leerCobertura(env, m), { fuente: 'zip', modo: 'zip', archivo: filename,
    archivos_vistos: zip.files_seen, analizador: zip.analyzer ?? null, deps: zip.deps.length, deps_truncadas: depsTruncadas,
    hallazgos_recibidos: zip.findings.length, hallazgos_descartados: g.descartadas, hallazgos_omitidos: 0, miradas });
  const parcial = !vio || recortados || depsTruncadas;
  if (conDeps) {
    return { continuar: { cursor: aCursor({ ronda: 1, parcial: parcial || tripwire, tripwire, osvIncompleto: false,
      escritas: g.n, omitidas: 0 }) } };
  }
  return { status: 'done', findings: await totalHallazgos(env, m), ...codigo({ tripwire, omitidas: 0, parcial }) };
}

// ── zip:osv (cursor osv:…): ronda N; la 1 lee las deps de params y pregunta a OSV cuáles tienen avisos ──
async function rondaOsv(env: CloudflareBindings, m: MsgScan, intento: number): Promise<ResultadoPaso> {
  const est = deCursor(m.cursor ?? 'osv:1');
  // Por m.attempts, como repo:osv: la entrega anterior pudo caer por otra cosa y entonces esta ya es la última.
  const quedaReintento = intento <= REINTENTOS.zip;
  const p = await leerParams(env, m, est.ronda === 1 ? 'deps' : 'nombre');
  const filename = p.filename ?? 'archivo.zip';
  const conPrefijo = (b: Borrador): Borrador => ({ ...b, resource: recursoZip(filename, b.resource),
    evidence: { ...(b.evidence ?? {}), fuente: 'zip' } });
  let gastadas = SUB.guarded + SUB.params;
  let deps: Dep[];
  if (est.ronda === 1) {
    const leidas = z.array(ZipDep).max(MAX_DEPS).safeParse(p.deps);
    if (!leidas.success) {
      log('warn', 'zip.deps_invalidas', {});
      return { status: 'done', findings: await totalHallazgos(env, m), ...codigo({ ...est, parcial: true }) };
    }
    const todas = leidas.data.map((d) => ({ ecosystem: d.ecosystem, name: d.name, version: d.version, dev: d.dev === true }));
    try {
      const v = await depsVulnerables(todas);
      gastadas += v.subpeticiones;
      deps = v.vulnerables.map((i) => todas[i]!).filter(Boolean);
    } catch (e) {
      // OSV caído tras el reintento del querybatch: un reintento de cola y, gastado, el paso termina done sin OSV
      // (los hallazgos del navegador ya están escritos; miradas.osv sigue false).
      if (esTransitorio(e) && quedaReintento) throw e;
      log('warn', 'zip.osv_caido', { code: e instanceof ProviderError ? e.code : 'error' });
      return { status: 'done', findings: await totalHallazgos(env, m), ...codigo({ ...est, osvCaido: true }) };
    }
  } else {
    deps = (m.deps ?? []).map(deCompacta);
  }
  const ahora = deps.slice(0, DETALLE_POR_MENSAJE);
  const resto = deps.slice(DETALLE_POR_MENSAJE);
  const d = await detallar(ahora);
  gastadas += ahora.length;
  // Un /query caído: el mensaje entero vuelve a la cola una vez; con el reintento gastado entran sin detalle.
  if (d.fallidos > 0 && quedaReintento) throw new ProviderError('unavailable');
  const osvIncompleto = est.osvIncompleto || d.errores > 0;
  const cupo = TOPE_HALLAZGOS - est.escritas;
  if (resto.length && est.ronda < RONDAS_OSV) {
    const { dentro, fuera } = recortar<Borrador>(d.filas.map(conPrefijo), cupo);
    const g = await guardarHallazgos(env, m, 'codebase', null, dentro, false, undefined, presupuesto(gastadas, SUB.encolar));
    const { viajan, sobran } = caben(resto);
    const sigue = osvIncompleto || fuera.length > 0 || g.descartadas > 0 || sobran > 0;
    return { continuar: { cursor: aCursor({ ronda: est.ronda + 1, parcial: est.parcial || sigue, tripwire: est.tripwire || g.descartadas > 0,
      osvIncompleto: sigue, escritas: est.escritas + g.n, omitidas: est.omitidas + fuera.length + sobran }), deps: viajan } };
  }
  // cierre: pasadas las rondas, lo que queda entra sin detalle
  const filas = [...d.filas, ...resto.map((x) => filaDep(x, [], true))].map(conPrefijo);
  const { dentro, fuera } = recortar(filas, cupo);
  const osvVioTodo = !osvIncompleto && fuera.length === 0;
  const g = await guardarHallazgos(env, m, 'codebase', null, dentro, false, undefined, presupuesto(gastadas, SUB_CIERRE));
  const tripwire = est.tripwire || g.descartadas > 0;
  const omitidas = est.omitidas + fuera.length;
  const cov = await leerCobertura(env, m);
  const cb = detalleDe(cov);
  // osv: llegaron deps sin tocar el tope (miradas.lockfiles), OSV respondió por todas y no se descartó ni omitió nada.
  const osv = cb.miradas?.lockfiles === true && cb.deps_truncadas !== true && osvVioTodo && g.descartadas === 0;
  await escribirDetalle(env, m, cov, { ...cb, hallazgos_omitidos: omitidas, miradas: { ...(cb.miradas ?? {}), osv } });
  return { status: 'done', findings: await totalHallazgos(env, m), ...codigo({ tripwire, omitidas, parcial: est.parcial || !osvVioTodo }) };
}

export const pasoZip: FnPaso = async (env, m, intento = 1) =>
  (m.cursor?.startsWith('osv') ? rondaOsv(env, m, intento) : hallazgosDelNavegador(env, m));
