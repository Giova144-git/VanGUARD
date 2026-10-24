import { SEV_RANK, escanearSecretos, esLockfile, fromComposerLock, fromPackageLock, reglasEnv, type ArchivoTexto } from '@vanguard/core';
import { fingerprint } from '@vanguard/core/crypto';
import { REINTENTOS, type DepCompacta, type FnPaso, type MsgScan } from '../jobs.ts';
import { withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { activeKid, getKeys } from '../lib/keyring.ts';
import { ProviderError } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { TOPE_SUBPETICIONES, conexionActiva, guardarHallazgos, type Borrador } from './comun.ts';
import { DETALLE_POR_MENSAJE, depsVulnerables, detallar, esTransitorio, filaDep, type Dep } from './osv.ts';
import { arbolRepo, elegirArchivosRiesgo, leerContenidos, lockfilesDe, rutasEnv } from './repo.ts';

// Paso repo (§09.4) en mensajes de la cola: `repo:archivos` (sin cursor) y `repo:osv` (cursor osv:…). El token y la
// huella completa mueren en la invocación de `archivos`; a la continuación solo viajan las deps compactas (≤ 2000).
const MAX_DEPS = 2000;
const RONDAS_OSV = 8;   // 8 rondas de 12 = 96 paquetes con detalle; el resto entra sin_detalle
export const TOPE_HALLAZGOS = 200;   // §09.11: filas por escaneo, las más graves primero; el resto en hallazgos_omitidos

const aCompacta = (d: { ecosystem: string; name: string; version: string; dev: boolean }): DepCompacta =>
  [d.ecosystem, d.name, d.version, d.dev ? 1 : 0];
const deCompacta = ([ecosystem, name, version, dev]: DepCompacta): Dep =>
  ({ ecosystem: ecosystem as Dep['ecosystem'], name, version, dev: dev === 1 });

// Lo que viaja de un mensaje al siguiente: osv:<ronda>:<marcas>:<filas escritas>:<filas omitidas>. Marcas: p = lectura
// parcial (árbol truncado, archivo sin leer o cortado, lockfile ilegible, deps de más, filas omitidas): el cierre no
// auto-verifica; t = el cable trampa descartó filas (error_code 'tripwire'); o = OSV no vio todo (miradas.osv false).
// 'osv:2' a secas (mensajes en vuelo de antes) se lee como ronda 2 sin marcas.
export type EstadoOsv = { ronda: number; parcial: boolean; tripwire: boolean; osvIncompleto: boolean; escritas: number; omitidas: number };
export const aCursor = (e: EstadoOsv) =>
  `osv:${e.ronda}:${e.parcial ? 'p' : ''}${e.tripwire ? 't' : ''}${e.osvIncompleto ? 'o' : ''}:${e.escritas}:${e.omitidas}`;
export function deCursor(c: string): EstadoOsv {
  const [, r = '1', marcas = '', esc = '0', om = '0'] = c.split(':');
  const tripwire = marcas.includes('t');
  const osvIncompleto = marcas.includes('o');
  return { ronda: Number(r) || 1, parcial: marcas.includes('p') || tripwire || osvIncompleto, tripwire, osvIncompleto,
    escritas: Number(esc) || 0, omitidas: Number(om) || 0 };
}

// Las más graves primero (sort estable: dentro de cada severidad conserva el orden de llegada) hasta `cupo`.
export function recortar<T extends { severity: string }>(xs: T[], cupo: number): { dentro: T[]; fuera: T[] } {
  const c = Math.max(0, cupo);
  if (xs.length <= c) return { dentro: xs, fuera: [] };
  const rango = (s: string) => SEV_RANK[s as keyof typeof SEV_RANK] ?? 0;
  const orden = [...xs].sort((a, b) => rango(b.severity) - rango(a.severity));
  return { dentro: orden.slice(0, c), fuera: orden.slice(c) };
}

// error_code del paso: uno solo, el más importante. El detalle completo queda en coverage.detail.codebase.
const codigo = (e: { tripwire: boolean; osvCaido?: boolean; omitidas: number; parcial: boolean }) => {
  const c = e.tripwire ? 'tripwire' : e.osvCaido ? 'osv_unavailable' : e.omitidas > 0 ? 'hallazgos_truncados' : e.parcial ? 'parcial' : null;
  return c ? { error_code: c } : {};
};

// Solo los lockfiles leídos enteros; `ilegibles` cuenta los que no se pudieron interpretar. Uno vacío está leído y no
// tiene deps (JSON.parse('') lo daría por ilegible y dejaría parcial cada auditoría de ese repo).
function leerLockfiles(archivos: readonly ArchivoTexto[]) {
  const deps = new Map<string, { ecosystem: string; name: string; version: string; dev: boolean }>();
  const porRuta = new Map(archivos.map((a) => [a.path, a.content]));
  let ilegibles = 0;
  for (const a of archivos) {
    const base = a.path.split('/').pop() ?? '';
    if ((base !== 'package-lock.json' && base !== 'composer.lock') || !a.content.trim()) continue;
    try {
      const ds = base === 'package-lock.json' ? fromPackageLock(a.content, a.path)
        : fromComposerLock(a.content, a.path, porRuta.get(a.path.replace(/composer\.lock$/, 'composer.json')));
      for (const d of ds) if (d.ecosystem === 'npm' || d.ecosystem === 'Packagist') deps.set(`${d.ecosystem}:${d.name}@${d.version}`, d);
    } catch { ilegibles++; log('warn', 'repo.lockfile_ilegible', { archivo: base }); }
  }
  return { deps: [...deps.values()], ilegibles };
}

async function totalHallazgos(env: CloudflareBindings, m: MsgScan): Promise<number> {
  const { count } = await db(env).from('findings').select('id', { count: 'exact', head: true }).eq('org_id', m.org_id)
    .eq('module', 'codebase').eq('scan_run_id', m.scan_run_id);
  return count ?? 0;
}

// coverage.detail.codebase (§09.5) se fusiona: no se pisa el resto de coverage ni el detalle de otros módulos. Si la
// base falla al leer o escribir, el mensaje se reintenta (sin miradas, E6 no sabría qué se miró).
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

// Presupuesto de subpeticiones (§A7, TOPE_SUBPETICIONES): lo que guardarHallazgos puede gastar es el tope menos lo ya
// gastado y lo que falta hasta el ack, contado en el peor caso. Antes del paso, guarded hace leerScan y vg_claim_step;
// conexionActiva lee params y la conexión; el token y las llaves en frío y con la llave rotada son connection_secrets,
// app_config y 2 × vg_crypto_material. Después: leer y escribir coverage, totalHallazgos y, en guarded, el send del
// paso siguiente y vg_mark_step (o solo el send de la continuación). El send también se cuenta, por margen. GitHub
// (árbol con sus saltos y 1 por ruta) lo cuenta arbolRepo; las rutas que no caben con el cierre y el lote no se leen.
const SUB = { guarded: 2, conexion: 2, llaves: 4, cobertura: 2, total: 1, encolar: 1, marcar: 1, lote: 1 };
const presupuesto = (gastadas: number, faltan: number) => TOPE_SUBPETICIONES - gastadas - faltan;
const SUB_CIERRE = SUB.cobertura + SUB.total + SUB.encolar + SUB.marcar;
const ANTES_DE_GITHUB = SUB.guarded + SUB.conexion + SUB.llaves;

export const pasoRepo: FnPaso = async (env, m, intento = 1) => {
  const conn = await conexionActiva(env, m, 'github');
  if (!conn) return { status: 'skipped', error_code: 'no_connection' };
  const repo = String(conn.meta.repo_full_name ?? '');
  const admin = db(env);

  // ── repo:osv (continuación): ronda N sobre las deps que viajan en el mensaje ──
  if (m.cursor?.startsWith('osv')) {
    const est = deCursor(m.cursor);
    // ¿Guarded reintentará este mensaje si lanza un transitorio? Por m.attempts y no por una marca propia: la entrega
    // anterior pudo caer por otra cosa (claim, encolar, CPU) y entonces esta ya es la última.
    const quedaReintento = intento <= REINTENTOS.repo;
    let deps = (m.deps ?? []).map(deCompacta);
    let gastadas = SUB.guarded + SUB.conexion;
    try {
      if (est.ronda === 1) {
        const v = await depsVulnerables(deps);
        gastadas += v.subpeticiones;
        deps = v.vulnerables.map((i) => deps[i]!).filter(Boolean);
      }
    } catch (e) {
      // OSV caído tras el reintento del querybatch: primero un reintento de cola (10 s después); con ese gastado, el paso
      // no falla (los secretos y .env ya quedaron escritos), deja miradas.osv false y no auto-verifica (§09.4, §09.11).
      if (esTransitorio(e) && quedaReintento) throw e;
      log('warn', 'repo.osv_caido', { code: e instanceof ProviderError ? e.code : 'error' });
      return { status: 'done', findings: await totalHallazgos(env, m), ...codigo({ ...est, osvCaido: true }) };
    }
    const ahora = deps.slice(0, DETALLE_POR_MENSAJE);
    const resto = deps.slice(DETALLE_POR_MENSAJE);
    const d = await detallar(ahora);
    gastadas += ahora.length;
    // Un /query caído: el mensaje entero vuelve a la cola una vez (§09.4); con el reintento gastado entran sin detalle.
    // Cualquier paquete sin detalle por un error (un 400 incluido) deja OSV incompleto: miradas.osv false y sin auto-verificar.
    if (d.fallidos > 0 && quedaReintento) throw new ProviderError('unavailable');
    const osvIncompleto = est.osvIncompleto || d.errores > 0;
    const cupo = TOPE_HALLAZGOS - est.escritas;
    if (resto.length && est.ronda < RONDAS_OSV) {
      const { dentro, fuera } = recortar<Borrador>(d.filas, cupo);
      const g = await guardarHallazgos(env, m, 'codebase', conn.id, dentro, false, undefined, presupuesto(gastadas, SUB.encolar));
      const sigue = osvIncompleto || fuera.length > 0 || g.descartadas > 0;
      return { continuar: { cursor: aCursor({ ronda: est.ronda + 1, parcial: est.parcial || sigue, tripwire: est.tripwire || g.descartadas > 0,
        osvIncompleto: sigue, escritas: est.escritas + g.n, omitidas: est.omitidas + fuera.length }), deps: resto.map(aCompacta) } };
    }
    const filas: Borrador[] = [...d.filas, ...resto.map((x) => filaDep(x, [], true))];   // pasadas las rondas: sin detalle
    const { dentro, fuera } = recortar(filas, cupo);
    const osvVioTodo = !osvIncompleto && fuera.length === 0;
    const parcial = est.parcial || !osvVioTodo;
    // cierre: auto-verifica si vio todo
    const g = await guardarHallazgos(env, m, 'codebase', conn.id, dentro, !parcial, undefined, presupuesto(gastadas, SUB_CIERRE));
    const tripwire = est.tripwire || g.descartadas > 0;
    const omitidas = est.omitidas + fuera.length;
    const cov = await leerCobertura(env, m);
    const cb = detalleDe(cov);
    // osv: los lockfiles se leyeron todos (miradas.lockfiles), no sobraron deps y OSV respondió por todas sus filas.
    const osv = cb.miradas?.lockfiles === true && cb.deps_truncadas !== true && osvVioTodo && g.descartadas === 0;
    await escribirDetalle(env, m, cov, { ...cb, hallazgos_omitidos: omitidas, miradas: { ...(cb.miradas ?? {}), osv } });
    return { status: 'done', findings: await totalHallazgos(env, m), ...codigo({ tripwire, omitidas, parcial: parcial || tripwire }) };
  }

  // ── repo:archivos: árbol por sha, archivos de riesgo, secretos, .env y lockfiles ──
  const ctx = { orgId: m.org_id, connectionId: conn.id, provider: 'github' as const, kind: 'read' as const };
  const leido = await withSecret(env, admin, ctx, async (token) => {
    const a = await arbolRepo(token, repo);
    // Las de menos riesgo van al final: si no caben todas, las que sobran cuentan como no leídas (lectura parcial).
    const elegidas = elegirArchivosRiesgo(a.arbol);
    const cupo = Math.max(0, presupuesto(ANTES_DE_GITHUB + a.subpeticiones, SUB_CIERRE + SUB.lote));
    const rutas = elegidas.slice(0, cupo);
    const leidos = await leerContenidos(token, a.repo, a.sha, rutas);   // 429/5xx/red: lanza y se reintenta
    return { sha: a.sha, arbol: a.arbol, truncado: a.truncado, vacio: a.vacio, archivos: leidos.archivos,
      incompletos: [...leidos.incompletos, ...elegidas.slice(cupo)], sinCupo: elegidas.length - rutas.length,
      subpeticiones: a.subpeticiones + rutas.length };   // 1 por ruta (con el nombre canónico, sin saltos)
  });
  const sinLeer = new Set(leido.incompletos);
  const enteros = leido.archivos.filter((a) => !sinLeer.has(a.path));
  const keys = await getKeys(env, admin, await activeKid(admin));
  const secretos = await escanearSecretos(leido.archivos, { huella: (v) => fingerprint(keys, m.org_id, v) });

  // .env y .gitignore: sin el .gitignore leído entero (o con el árbol truncado y sin verlo) no se sabe si cubre .env.
  const rutas = rutasEnv(leido.arbol);
  const gitignoreEnArbol = rutas.includes('.gitignore');
  const gitignoreLeido = enteros.some((a) => a.path === '.gitignore');
  const gitignoreSabido = gitignoreLeido || (!gitignoreEnArbol && !leido.truncado);
  // Repo vacío: no hay nada que commitear ni que ignorar todavía (sin CB_GITIGNORE_NO_ENV); se miró todo.
  const env_ = leido.vacio ? [] : reglasEnv(rutas, enteros).filter((b) => gitignoreSabido || b.rule_id !== 'CB_GITIGNORE_NO_ENV');

  // Lockfiles: todos los legibles del árbol leídos enteros e interpretados; pnpm/yarn aún no se leen (miradas.lockfiles
  // false), pero tampoco pudieron dejar un CB_DEP_VULN que auto-verificar, así que no vuelven parcial el cierre.
  const locks = lockfilesDe(leido.arbol);
  const lk = leerLockfiles(enteros.filter((a) => locks.legibles.includes(a.path)));
  const lockSinLeer = locks.legibles.some((p) => !enteros.some((a) => a.path === p));
  const lockParcial = leido.truncado || lockSinLeer || lk.ilegibles > 0;
  const depsDeMas = lk.deps.length > MAX_DEPS;
  const deps = lk.deps.slice(0, MAX_DEPS);

  // Parcial también si el .gitignore está en el árbol pero no se eligió (> 1 MB): su CB_GITIGNORE_NO_ENV anterior no se
  // puede auto-verificar sin haberlo mirado (la marca p del cursor lo lleva hasta el cierre de OSV).
  const { dentro, fuera } = recortar<Borrador>([...secretos.hallazgos, ...env_], TOPE_HALLAZGOS);
  const parcial = leido.truncado || leido.incompletos.length > 0 || !gitignoreSabido || lockParcial || depsDeMas || fuera.length > 0;
  const cierre = deps.length === 0;
  const gastadas = ANTES_DE_GITHUB + leido.subpeticiones;
  const g = await guardarHallazgos(env, m, 'codebase', conn.id, dentro, cierre && !parcial, undefined,   // sin deps es el cierre
    presupuesto(gastadas, cierre ? SUB_CIERRE : SUB.cobertura + SUB.encolar));
  const tripwire = g.descartadas > 0;

  const omitidoSi = (f: (r: string) => boolean) => fuera.some((b) => f(b.rule_id));
  const miradas = {
    secretos: !leido.truncado && !leido.incompletos.some((p) => !esLockfile(p)) && !tripwire && !omitidoSi((r) => r.startsWith('CB_SECRET_')),
    env: gitignoreSabido && !leido.truncado && !tripwire && !omitidoSi((r) => r === 'CB_ENV_COMMITTED' || r === 'CB_GITIGNORE_NO_ENV'),
    lockfiles: !lockParcial && locks.otros.length === 0,
    osv: cierre && !lockParcial && locks.otros.length === 0,   // sin deps no hay nada que consultar; si no, lo fija el cierre
  };
  const detalle: DetalleCodebase = { modo: 'riesgo', archivos_leidos: leido.archivos.length, archivos_total: leido.arbol.length,
    archivos_incompletos: leido.incompletos.length, archivos_sin_cupo: leido.sinCupo, arbol_truncado: leido.truncado,
    ...(leido.vacio ? { repo_vacio: true } : {}), sha: leido.sha,
    lockfiles_ilegibles: lk.ilegibles, deps_truncadas: depsDeMas, hallazgos_omitidos: fuera.length, miradas };
  await escribirDetalle(env, m, await leerCobertura(env, m), detalle);

  if (!cierre) {
    return { continuar: { cursor: aCursor({ ronda: 1, parcial: parcial || tripwire, tripwire, osvIncompleto: false, escritas: g.n,
      omitidas: fuera.length }), deps: deps.map(aCompacta) } };
  }
  return { status: 'done', findings: await totalHallazgos(env, m), ...codigo({ tripwire, omitidas: fuera.length, parcial }) };
};
