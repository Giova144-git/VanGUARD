import { Hono } from 'hono';
import { RepoFullName, WikiRun } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { ApiError } from '../lib/errors.ts';

// E42–E44 provisionales hasta la integración de DeepWiki (wiki_runs y los pasos 'wiki' de vg-jobs): el historial sale
// vacío y una generación concreta da 404 con el mismo texto para un id ajeno, inexistente o malformado. Así la
// pantalla de la Wiki muestra «sin generaciones» en vez de un error. E40/E41 (estimar y generar) llegan con el motor.
export const wiki = new Hono<AppEnv>();

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
