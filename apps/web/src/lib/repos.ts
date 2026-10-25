// Varias codebases por org (asignaciones/varias-codebases.md §6): un repo = una conexión GitHub de LECTURA. La conexión
// de estados del bloqueo de merge (kind 'action') no es un repo. Funciones puras salvo useRepoDeConexion.
import { useMemo } from 'react';
import { RepoFullName, type ConnectionPublic } from '@vanguard/contracts';
import { useConexiones } from './consultas';

// meta.repo_full_name lo escribe el sondeo de E8; fuera de contrato (no es texto, o la conexión llega sin meta: api() en
// producción deja pasar el cuerpo) cuenta como «sin nombre». Resumen, auditoría y el detalle del hallazgo no leían meta
// antes de varias codebases: aquí no pueden caerse por él.
export const nombreRepo = (c: Pick<ConnectionPublic, 'meta'>): string =>
  typeof c.meta?.repo_full_name === 'string' ? c.meta.repo_full_name : '';
const clave = (c: ConnectionPublic) => nombreRepo(c).toLowerCase() || c.id;   // sin nombre: cada una es su propio repo

export const lecturasGithub = (cx: readonly ConnectionPublic[] | undefined): ConnectionPublic[] =>
  (cx ?? []).filter((c) => c.provider === 'github' && c.kind === 'read');

// Un repo por nombre en minúsculas, en el orden de E7 (created_at): de cada grupo, la activa; si ninguna, la más
// antigua. Así las parejas viejas de «Reconectar» (una revocada y otra activa del mismo repo) salen una vez.
export function reposGithub(cx: readonly ConnectionPublic[] | undefined): ConnectionPublic[] {
  const grupos = new Map<string, ConnectionPublic>();
  for (const c of lecturasGithub(cx)) {
    const previa = grupos.get(clave(c));
    if (!previa || (previa.status !== 'active' && c.status === 'active')) grupos.set(clave(c), c);   // set conserva el puesto
  }
  return [...grupos.values()];
}

// La conexión ACTIVA de ese repo, buscada por nombre en minúsculas entre todas (no la primera conexión de la lista):
// su connection_id es el que va en estimar, generar y reintentar la wiki. null si ninguna está activa.
export function activaDeRepo(cx: readonly ConnectionPublic[] | undefined, repo: string): ConnectionPublic | null {
  const k = repo.toLowerCase();
  return lecturasGithub(cx).find((c) => c.status === 'active' && nombreRepo(c).toLowerCase() === k) ?? null;
}

// Solo un owner/repo válido va a E43 (?repo=): con otro texto respondería 422.
export const repoConsultable = (repo: string) => RepoFullName.safeParse(repo).success;

// Repo de un hallazgo o de un elemento de «Ahora» por su connection_id (§6.4). null si la org tiene menos de 2 repos
// (el chip sobra) o si la conexión ya no existe. Las parejas viejas de «Reconectar» dan el mismo nombre.
export function useRepoDeConexion(org: string): (id: string | null | undefined) => string | null {
  const q = useConexiones(org);
  return useMemo(() => {
    if (reposGithub(q.data).length < 2) return () => null;
    const porId = new Map(lecturasGithub(q.data).map((c) => [c.id, nombreRepo(c)]));
    return (id: string | null | undefined) => (id ? porId.get(id) || null : null);
  }, [q.data]);
}
