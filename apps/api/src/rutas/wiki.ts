import { Hono } from 'hono';
import { RepoFullName, WikiEstimate, WikiEstimateRequest, WikiRun } from '@vanguard/contracts';
import { estimar, pasoArbol, type Estimacion } from '@vanguard/deepwiki';
import type { AppEnv } from '../env.ts';
import { cuerpo } from '../lib/body.ts';
import { db } from '../lib/db.ts';
import { ApiError, fail } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { requireAdmin } from '../mw/admin.ts';
import { conTokenGithub, depsWiki, falloGithub, salidaGithub, TOPE_SUBPETICIONES } from '../wiki/deps.ts';

// E40 con el motor de DeepWiki (packages/deepwiki). E42–E44 siguen provisionales hasta wiki_runs y los pasos 'wiki' de
// vg-jobs: el historial sale vacío y una generación concreta da 404 con el mismo texto para un id ajeno, inexistente o
// malformado. Así la pantalla de la Wiki muestra «sin generaciones» en vez de un error. E41 llega con wiki_runs.
export const wiki = new Hono<AppEnv>();

// Subpeticiones de E40 fuera de GitHub: auth (getClaims, ≤ 1) + org_members + connections + connection_secrets +
// vg_crypto_material (en caché 10 min) = ≤ 5. pasoArbol hace ≤ 25 (33 si GitHub redirige): ≤ 38 de 40. salidaGithub
// corta en 35 por si acaso. CPU: el árbol se acota a 450 KB (~2,7 ms medido); la estimación no usa red ni modelo.
export const SUBPETICIONES_RUTA_E40 = 5;

// E40 · POST /api/orgs/:org/wiki/estimate · admin — solo lee GitHub (pasoArbol + estimar); no llama a Claude.
wiki.post('/orgs/:org/wiki/estimate', requireAdmin, async (c) => {
  const body = await cuerpo(c, WikiEstimateRequest);
  // RL_COSTLY (§06.9): 10 por minuto y usuario.
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
    // El PAT solo existe dentro de esta función: va a deps.githubToken y de ahí a la cabecera de GitHub, nada más.
    estimacion = await conTokenGithub(c.env, db(c.env), c.get('orgId'), body.connection_id, async (githubToken) => {
      const deps = depsWiki({ fetch: salida.fetch, githubToken });
      return estimar(await pasoArbol(body, deps), deps);
    });
  } catch (e) {
    const fallo = falloGithub(e, conToken);
    if (!fallo) throw e;
    log('warn', 'wiki.estimar_github', { rid, codigo: fallo.codigo, status: fallo.status, subpeticiones: salida.usadas(),
      bloqueadas: salida.bloqueadas() });
    if (fallo.retryAfterS !== null) c.header('Retry-After', String(fallo.retryAfterS));
    throw fallo.error;
  }

  log('info', 'wiki.estimada', { rid, files_total: estimacion.files_total, candidatos: estimacion.files_candidatos,
    truncado: estimacion.truncado, subpeticiones: salida.usadas(), con_conexion: conToken });
  // TODO(wiki_runs, pieza de E41): buscar una wiki terminada con la llave (org_id, repo_full_name, commit_sha, huella)
  // del LEEME de deepwiki (punto 2) y devolver su id aquí. Hasta que exista la tabla, nunca hay caché.
  return c.json(WikiEstimate.parse({ ...estimacion, cached_run_id: null }));
});

wiki.get('/orgs/:org/wiki/runs', (c) => {
  const repo = c.req.query('repo');
  if (repo !== undefined && !RepoFullName.safeParse(repo).success) {
    throw new ApiError('invalid_body', 'Revisa el repositorio', { field_errors: { repo: ['Formato owner/repo'] } });
  }
  return c.json(WikiRun.array().parse([]));
});

const noEncontrada = () => { throw new ApiError('not_found', 'Generación no encontrada'); };
wiki.get('/orgs/:org/wiki/runs/:id', noEncontrada);
wiki.get('/orgs/:org/wiki/runs/:id/doc', noEncontrada);
