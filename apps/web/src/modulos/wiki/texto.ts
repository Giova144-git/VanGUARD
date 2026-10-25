// Funciones puras de la wiki (sin React ni red), para poder probarlas solas.
import { RepoFullName, type WikiDoc, type WikiEstimate, type WikiRun } from '@vanguard/contracts';
import { codigoMd, escaparMd } from '@/lib/md-escape';
import { extraerRepoYRama } from '@/lib/pre-guardas';

// Tope aceptado: la estimación × 1,5 redondeada a centavos, máximo 5 USD (WikiRunCreate.max_usd).
export const topeUsd = (est: number) => Math.min(5, Math.max(0.01, Math.ceil(est * 1.5 * 100) / 100));

// Cada push cambia el commit y la caché de E40 incluye además la huella de los hallazgos, así que casi nunca hay caché:
// la wiki terminada más reciente del mismo repo (de otro commit, o del mismo antes de otra auditoría) se ofrece junto a
// «Generar» para no pagar otra vez por un cambio pequeño.
// También es «la última wiki lista» de un repo, la que la página abre sola (varias-codebases §6.3). El nombre se compara
// en minúsculas: GitHub no distingue mayúsculas y la conexión puede traerlo escrito de otra forma que la corrida.
export function wikiAnterior(runs: readonly WikiRun[], e: Pick<WikiEstimate, 'repo_full_name'>): WikiRun | null {
  const t = (r: WikiRun) => Date.parse(r.finished_at ?? r.created_at) || 0;
  return runs.filter((r) => r.status === 'succeeded' && mismoRepo(r.repo_full_name, e.repo_full_name)).sort((a, b) => t(b) - t(a))[0] ?? null;
}
// api() en producción deja pasar una corrida fuera de contrato: un repo que no es texto no casa con ninguno (sin lanzar,
// que tumbaría la página de la wiki del jurado).
export const mismoRepo = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

// Historial (E43): campo vacío → todas las wikis de la org; un owner/repo que pasa RepoFullName → las de ese repo; un
// texto a medio escribir o una URL que no es de GitHub → no se consulta (E43 respondería 422) y basta la ayuda de formato.
export function consultaHistorial(texto: string): { repo: string | null; consultar: boolean } {
  if (!texto.trim()) return { repo: null, consultar: true };
  const repo = extraerRepoYRama(texto)?.repo ?? null;
  return repo && RepoFullName.safeParse(repo).success ? { repo, consultar: true } : { repo: null, consultar: false };
}

// «Copiar como Markdown»: el documento entero, con el mapa en su valla mermaid y una sección por área. overview_md y
// resumen_md son Markdown a propósito (ya saneado por el motor); títulos, áreas, rama y rutas vienen del repo o del
// modelo y se escapan como texto plano (las rutas, como código en línea).
export function comoMarkdown(d: WikiDoc): string {
  const partes = [d.overview_md.trim()];
  if (d.mermaid) partes.push('```mermaid\n' + d.mermaid.replace(/```/g, '') + '\n```');
  for (const p of d.paginas) partes.push(
    `## ${escaparMd(p.titulo)}\n\n_Área: ${escaparMd(p.area)}_\n\n${p.resumen_md.trim()}\n\nArchivos: ${p.archivos.map(codigoMd).join(', ')}`);
  partes.push(`---\n${codigoMd(`${d.repo_full_name}@${d.branch}`)} · ${codigoMd(d.commit_sha.slice(0, 7))} · generado ${escaparMd(d.generated_at)} con ${escaparMd(d.models.fast)} y ${escaparMd(d.models.smart)}`);
  return partes.join('\n\n');
}
