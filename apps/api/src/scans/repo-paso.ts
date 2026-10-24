import { escanearSecretos, fromComposerLock, fromPackageLock, reglasEnv, type ArchivoTexto } from '@vanguard/core';
import { fingerprint } from '@vanguard/core/crypto';
import type { DepCompacta, FnPaso, MsgScan } from '../jobs.ts';
import { withSecret } from '../lib/credentials.ts';
import { db } from '../lib/db.ts';
import { activeKid, getKeys } from '../lib/keyring.ts';
import { ProviderError } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { conexionActiva, guardarHallazgos, type Borrador } from './comun.ts';
import { DETALLE_POR_MENSAJE, depsVulnerables, detallar, filaDep, type Dep } from './osv.ts';
import { arbolRepo, elegirArchivosRiesgo, leerContenidos } from './repo.ts';

// Paso repo (§09.4) en mensajes de la cola: `repo:archivos` (sin cursor) y `repo:osv` (cursor osv:1..3). El token y la
// huella completa mueren en la invocación de `archivos`; a la continuación solo viajan las deps compactas (≤ 2000).
const MAX_DEPS = 2000;
const RONDAS_OSV = 8;   // 8 rondas de 12 = 96 paquetes con detalle; el resto entra sin_detalle

const aCompacta = (d: { ecosystem: string; name: string; version: string; dev: boolean }): DepCompacta =>
  [d.ecosystem, d.name, d.version, d.dev ? 1 : 0];
const deCompacta = ([ecosystem, name, version, dev]: DepCompacta): Dep =>
  ({ ecosystem: ecosystem as Dep['ecosystem'], name, version, dev: dev === 1 });

function leerLockfiles(archivos: readonly ArchivoTexto[]) {
  const deps = new Map<string, { ecosystem: string; name: string; version: string; dev: boolean }>();
  const porRuta = new Map(archivos.map((a) => [a.path, a.content]));
  for (const a of archivos) {
    const base = a.path.split('/').pop() ?? '';
    try {
      const ds = base === 'package-lock.json' ? fromPackageLock(a.content, a.path)
        : base === 'composer.lock' ? fromComposerLock(a.content, a.path, porRuta.get(a.path.replace(/composer\.lock$/, 'composer.json')))
        : [];
      for (const d of ds) if (d.ecosystem === 'npm' || d.ecosystem === 'Packagist') deps.set(`${d.ecosystem}:${d.name}@${d.version}`, d);
    } catch { log('warn', 'repo.lockfile_ilegible', { archivo: base }); }
  }
  return [...deps.values()];
}

async function totalHallazgos(env: CloudflareBindings, m: MsgScan): Promise<number> {
  const { count } = await db(env).from('findings').select('id', { count: 'exact', head: true }).eq('org_id', m.org_id)
    .eq('module', 'codebase').eq('scan_run_id', m.scan_run_id);
  return count ?? 0;
}

export const pasoRepo: FnPaso = async (env, m) => {
  const conn = await conexionActiva(env, m, 'github');
  if (!conn) return { status: 'skipped', error_code: 'no_connection' };
  const repo = String(conn.meta.repo_full_name ?? '');
  const admin = db(env);

  // ── repo:osv (continuación): ronda N sobre las deps que viajan en el mensaje ──
  if (m.cursor?.startsWith('osv')) {
    const ronda = Number(m.cursor.split(':')[1] ?? '1') || 1;
    let deps = (m.deps ?? []).map(deCompacta);
    try {
      if (ronda === 1) deps = (await depsVulnerables(deps)).vulnerables.map((i) => deps[i]!).filter(Boolean);
    } catch (e) {
      // OSV caído tras sus reintentos: los secretos y .env ya quedaron escritos; el paso termina sin auto-verificar.
      log('warn', 'repo.osv_caido', { code: e instanceof ProviderError ? e.code : 'error' });
      return { status: 'done', findings: await totalHallazgos(env, m), error_code: 'osv_unavailable' };
    }
    const ahora = deps.slice(0, DETALLE_POR_MENSAJE);
    const resto = deps.slice(DETALLE_POR_MENSAJE);
    const filas: Borrador[] = await detallar(ahora);
    if (resto.length && ronda < RONDAS_OSV) {
      await guardarHallazgos(env, m, 'codebase', conn.id, filas, false);
      return { continuar: { cursor: `osv:${ronda + 1}`, deps: resto.map(aCompacta) } };
    }
    filas.push(...resto.map((d) => filaDep(d, [], true)));   // pasadas las 3 rondas: sin detalle
    await guardarHallazgos(env, m, 'codebase', conn.id, filas, true);
    return { status: 'done', findings: await totalHallazgos(env, m) };
  }

  // ── repo:archivos: árbol por sha, archivos de riesgo, secretos, .env y lockfiles ──
  const ctx = { orgId: m.org_id, connectionId: conn.id, provider: 'github' as const, kind: 'read' as const };
  const leido = await withSecret(env, admin, ctx, async (token) => {
    const { sha, arbol, truncado } = await arbolRepo(token, repo);
    const rutas = elegirArchivosRiesgo(arbol);
    return { sha, arbol, truncado, archivos: await leerContenidos(token, repo, sha, rutas) };
  });
  const keys = await getKeys(env, admin, await activeKid(admin));
  const secretos = await escanearSecretos(leido.archivos, { huella: (v) => fingerprint(keys, m.org_id, v) });
  const env_ = reglasEnv(leido.arbol.map((e) => e.path), leido.archivos);
  await guardarHallazgos(env, m, 'codebase', conn.id, [...secretos.hallazgos, ...env_], false);

  const detalle = { modo: 'riesgo', archivos_leidos: leido.archivos.length, archivos_total: leido.arbol.length,
    arbol_truncado: leido.truncado, sha: leido.sha };
  const { data: prev } = await admin.from('scan_runs').select('coverage').eq('id', m.scan_run_id).eq('org_id', m.org_id).maybeSingle();
  const cov = (prev?.coverage as Record<string, unknown> | null) ?? {};
  await admin.from('scan_runs').update({ coverage: { ...cov, detail: { ...((cov.detail as object) ?? {}), codebase: detalle } } })
    .eq('id', m.scan_run_id).eq('org_id', m.org_id);

  const deps = leerLockfiles(leido.archivos).slice(0, MAX_DEPS);
  if (deps.length) return { continuar: { cursor: 'osv:1', deps: deps.map(aCompacta) } };
  await guardarHallazgos(env, m, 'codebase', conn.id, [], !leido.truncado);   // cierre sin deps: auto-verifica lo no visto
  return { status: 'done', findings: await totalHallazgos(env, m) };
};
