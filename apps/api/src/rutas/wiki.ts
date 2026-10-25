import { Hono, type Context } from 'hono';
import { Id, RepoFullName, WikiEstimate, WikiEstimateRequest, WikiRun, WikiRunAccepted, WikiRunCreate } from '@vanguard/contracts';
import { estimar, leerMeta, pasoArbol, type Estimacion, type MetaRepo } from '@vanguard/deepwiki';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError, fail } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';
import { requireColaPropia } from '../mw/prod-host.ts';
import {
  avisarSinTabla, aWikiRun, cacheDeEstimacion, COLUMNAS_RUN, crearCorrida, faltaTabla, LIMITE_HISTORIAL, leerDoc,
  marcarNoEncolada, MAX_USD_POR_DEFECTO,
  mensajeInicio, SUBPETICIONES_CACHE,
} from '../wiki/corridas.ts';
import { conTokenGithub, depsWiki, falloGithub, salidaGithub, TOPE_SUBPETICIONES, type SalidaGithub } from '../wiki/deps.ts';

// «Wiki del repo» con el motor de DeepWiki (packages/deepwiki/LEEME.md, «Integración en el BACK»): E40 estima, E41 crea
// la corrida (o la sirve de la caché) y encola el paso arbol en vg-jobs, E42–E44 leen wiki_runs (0010). La caché es por
// (org_id, repo_full_name, commit_sha, huella) y la lógica de filas vive en wiki/corridas.ts.
export const wiki = new Hono<AppEnv>();

// Subpeticiones de E40 fuera de GitHub: auth (getClaims, ≤ 1) + org_members + connections + connection_secrets +
// vg_crypto_material (en caché 10 min) = ≤ 5. pasoArbol hace ≤ 25 (33 si GitHub redirige): ≤ 38 de 40. salidaGithub
// corta en 35 por si acaso. La caché (≤ 5, SUBPETICIONES_CACHE) se mira después solo si aún cabe. CPU: el árbol se
// acota a 450 KB (~2,7 ms medido); la estimación no usa red ni modelo.
export const SUBPETICIONES_RUTA_E40 = 5;
// Subpeticiones de E41 fuera de GitHub: auth (≤ 1) + org_members + conexión (≤ 3, como E40) + crearCorrida (≤ 9) + send
// a vg-jobs + marcar la fila si el send falla = ≤ 16 (la relectura tras un 23505 nunca va con send ni marca: ≤ 15 ahí).
// leerMeta hace ≤ 3: ≤ 19 de 40.
export const SUBPETICIONES_RUTA_E41 = 16;

const NO_ENCONTRADA = 'Generación no encontrada';

// ErrorGithub → ApiError con su código (wiki/deps.ts); cualquier otro error sigue hasta mw/error.ts.
function errorGithub(c: Context<AppEnv>, e: unknown, conToken: boolean, salida: SalidaGithub, evento: string): never {
  const fallo = falloGithub(e, conToken);
  if (!fallo) throw e;
  log('warn', evento, { rid: c.get('rid'), codigo: fallo.codigo, status: fallo.status, subpeticiones: salida.usadas(),
    bloqueadas: salida.bloqueadas() });
  if (fallo.retryAfterS !== null) c.header('Retry-After', String(fallo.retryAfterS));
  throw fallo.error;
}

// :id malformado → el mismo 404 que uno ajeno o inexistente, sin consultar la base.
function idDe(c: Context<AppEnv>): string {
  const id = Id.safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError('not_found', NO_ENCONTRADA);
  return id.data.toLowerCase();
}

// E40 · POST /api/orgs/:org/wiki/estimate · admin — solo lee GitHub (pasoArbol + estimar); no llama a Claude.
wiki.post('/orgs/:org/wiki/estimate', requireAdmin, async (c) => {
  const body = await cuerpo(c, WikiEstimateRequest);
  // RL_COSTLY (§06.9): 10 por minuto y usuario, compartido con E41.
  const { success } = await c.env.RL_COSTLY.limit({ key: `u:${c.get('userId')}` });
  if (!success) {
    c.header('Retry-After', '60');
    return fail(c, 'rate_limited', 'Demasiadas estimaciones seguidas. Espera un minuto.');
  }

  const rid = c.get('rid');
  const conToken = body.connection_id !== undefined;
  const salida = salidaGithub(TOPE_SUBPETICIONES - SUBPETICIONES_RUTA_E40);
  let estimacion: Estimacion;
  try {
    // El PAT solo existe dentro de esta función: va a deps.githubToken y de ahí a la cabecera de GitHub, nada más. La
    // conexión tiene que ser la del repo pedido (B8 de varias-codebases.md). Con conexión, repo_full_name es el de la
    // conexión y no el canónico (repo renombrado): es el que el FRONT manda a E41 y la llave de la caché, como en E41.
    estimacion = await conTokenGithub(c.env, db(c.env), c.get('orgId'), body.connection_id, body.repo_full_name,
      async (githubToken, repoConexion) => {
        const deps = depsWiki({ fetch: salida.fetch, githubToken });
        const e = estimar(await pasoArbol(body, deps), deps);
        return repoConexion === null ? e : { ...e, repo_full_name: repoConexion };
      });
  } catch (e) {
    errorGithub(c, e, conToken, salida, 'wiki.estimar_github');
  }

  // cached_run_id (LEEME, punto 1): una wiki terminada con la misma llave. Si no cabe en el presupuesto o la base falla,
  // null: E41 vuelve a mirar la caché antes de pagar, así que nunca se paga dos veces.
  let cached_run_id: string | null = null;
  if (salida.usadas() + SUBPETICIONES_RUTA_E40 + SUBPETICIONES_CACHE <= TOPE_SUBPETICIONES) {
    try {
      cached_run_id = await cacheDeEstimacion(db(c.env), { orgId: c.get('orgId'), repo: estimacion.repo_full_name,
        commitSha: estimacion.commit_sha });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.details?.reason !== 'sin_tabla') log('warn', 'wiki.estimar_sin_cache', { rid, motivo: 'base' });   // sin tabla: ya avisó una vez
    }
  } else {
    log('warn', 'wiki.estimar_sin_cache', { rid, motivo: 'subpeticiones', subpeticiones: salida.usadas() });
  }

  log('info', 'wiki.estimada', { rid, files_total: estimacion.files_total, candidatos: estimacion.files_candidatos,
    truncado: estimacion.truncado, subpeticiones: salida.usadas(), con_conexion: conToken, cache: cached_run_id !== null });
  return c.json(WikiEstimate.parse({ ...estimacion, cached_run_id }));
});

// E41 · POST /api/orgs/:org/wiki/runs · admin y productor de vg-jobs (requireColaPropia, §15.7/15.8: en producción solo
// desde el host real). Resuelve el commit con leerMeta (≤ 3 subpeticiones, sin modelo): con la llave completa decide
// aquí mismo si sirve la caché, sin encolar nada. El árbol lo lee el paso arbol de la cola: pasoArbol aquí serían ≤ 25
// subpeticiones más que no hacen falta para decidir. La fila guarda commit_sha y branch para que el paso arbol
// documente ese mismo commit. Con conexión, repo_full_name de la fila es el meta.repo_full_name de la conexión, el que
// se comprobó: los pasos arbol y area lo vuelven a comprobar (B8) y con un repo renombrado el canónico de leerMeta ya no
// casaría (la conexión conserva el nombre de antes); además así casan hallazgosDelRepo y el ?repo= de E43, que el FRONT
// pide con el nombre de la conexión. Sin conexión, el canónico, como siempre. Dos E41 iguales a la vez no pagan dos
// veces: el índice único de corridas en curso de 0010 deja una sola fila y un solo mensaje (crearCorrida).
wiki.post('/orgs/:org/wiki/runs', requireAdmin, requireColaPropia, async (c) => {
  const body = await cuerpo(c, WikiRunCreate);
  const { success } = await c.env.RL_COSTLY.limit({ key: `u:${c.get('userId')}` });
  if (!success) {
    c.header('Retry-After', '60');
    return fail(c, 'rate_limited', 'Demasiadas wikis seguidas. Espera un minuto.');
  }

  const rid = c.get('rid');
  const orgId = c.get('orgId');
  const admin = db(c.env);
  const connectionId = body.connection_id?.toLowerCase();   // como se guarda: va a la fila y la lee el paso arbol
  const conToken = connectionId !== undefined;
  const salida = salidaGithub(TOPE_SUBPETICIONES - SUBPETICIONES_RUTA_E41);
  let leido: { meta: MetaRepo; repo: string };
  try {
    leido = await conTokenGithub(c.env, admin, orgId, connectionId, body.repo_full_name,
      async (githubToken, repoConexion) => {
        const meta = await leerMeta(body, depsWiki({ fetch: salida.fetch, githubToken }));
        return { meta, repo: repoConexion ?? meta.full_name };
      });
  } catch (e) {
    errorGithub(c, e, conToken, salida, 'wiki.correr_github');
  }

  const { meta, repo } = leido;
  const force = body.force === true;
  const creada = await crearCorrida(admin, { orgId, repo, commitSha: meta.commit_sha, branch: meta.branch,
    userId: c.get('userId'), connectionId, maxUsd: body.max_usd ?? MAX_USD_POR_DEFECTO, force });
  if (creada.tipo === 'nueva') {
    try {
      // JobMsg kind 'wiki' (jobs.ts); lo consume wiki/pasos.ts.
      await c.env.JOBS_Q.send(mensajeInicio(orgId, creada.id));
    } catch {
      await marcarNoEncolada(admin, orgId, creada.id);
      throw new ApiError('provider_unavailable', 'No pudimos arrancar la wiki. Vuelve a intentarlo.');
    }
  }
  log('info', 'wiki.corrida', { rid, tipo: creada.tipo, force, con_conexion: conToken, subpeticiones: salida.usadas() });
  const cached = creada.tipo === 'cache';
  return c.json(WikiRunAccepted.parse({ wiki_run_id: creada.id, cached }), cached ? 200 : 202);
});

// E43 · GET /api/orgs/:org/wiki/runs?repo= — historial (viewer y anónimo leen): las más nuevas primero.
wiki.get('/orgs/:org/wiki/runs', async (c) => {
  const repo = c.req.query('repo');
  if (repo !== undefined && !RepoFullName.safeParse(repo).success) {
    throw new ApiError('invalid_body', 'Revisa el repositorio', { field_errors: { repo: ['Formato owner/repo'] } });
  }
  let q = db(c.env).from('wiki_runs').select(COLUMNAS_RUN).eq('org_id', c.get('orgId'));
  if (repo !== undefined) q = q.eq('repo_full_name', repo);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(LIMITE_HISTORIAL);
  if (error && faltaTabla(error.code)) {
    avisarSinTabla();
    return c.json([]);
  }
  if (error) {
    log('error', 'wiki.historial_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos leer el historial de la wiki');
  }
  return c.json(WikiRun.array().parse(((data ?? []) as Record<string, unknown>[]).map(aWikiRun)));
});

// E42 · GET /api/orgs/:org/wiki/runs/:id — progreso de una corrida. Ajena, inexistente o malformada: el mismo 404.
wiki.get('/orgs/:org/wiki/runs/:id', async (c) => {
  const id = idDe(c);
  const { data, error } = await db(c.env).from('wiki_runs').select(COLUMNAS_RUN).eq('id', id).eq('org_id', c.get('orgId'))
    .maybeSingle();
  if (error && faltaTabla(error.code)) {
    avisarSinTabla();
    throw new ApiError('not_found', NO_ENCONTRADA);
  }
  if (error) {
    log('error', 'wiki.leer_error', { rid: c.get('rid'), code: error.code });
    throw new ApiError('internal', 'No pudimos leer la wiki');
  }
  if (!data) throw new ApiError('not_found', NO_ENCONTRADA);
  return c.json(aWikiRun(data as Record<string, unknown>));
});

// E44 · GET /api/orgs/:org/wiki/runs/:id/doc — el documento terminado (run_id = :id). Una corrida en cola, en curso o
// fallida existe pero no tiene documento: 409 con details.status, para no confundirla con un 404.
wiki.get('/orgs/:org/wiki/runs/:id/doc', async (c) => {
  const id = idDe(c);
  const r = await leerDoc(db(c.env), c.get('orgId'), id).catch((e: unknown) => {
    if (e instanceof ApiError && e.details?.reason === 'sin_tabla') return null;   // sin la tabla: el 404 uniforme
    throw e;
  });
  if (!r) throw new ApiError('not_found', NO_ENCONTRADA);
  if (r.status !== 'succeeded') {
    throw new ApiError('conflict', r.status === 'failed' ? 'Esta generación falló y no tiene documento.'
      : 'La wiki todavía se está generando.', { status: r.status });
  }
  if (!r.doc) {
    log('error', 'wiki.doc_invalido', { rid: c.get('rid') });
    throw new ApiError('internal', 'No pudimos leer el documento de la wiki');
  }
  return c.json(r.doc);
});
