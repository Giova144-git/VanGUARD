// Funciones puras de la wiki (sin React ni red), para poder probarlas solas.
import type { WikiDoc } from '@vanguard/contracts';
import { codigoMd, escaparMd } from '@/lib/md-escape';

// Tope aceptado: la estimación × 1,5 redondeada a centavos, máximo 5 USD (WikiRunCreate.max_usd).
export const topeUsd = (est: number) => Math.min(5, Math.max(0.01, Math.ceil(est * 1.5 * 100) / 100));

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
