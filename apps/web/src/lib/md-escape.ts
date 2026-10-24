// Escapes para el Markdown que ARMA el FRONT («Copiar como Markdown» de la wiki). Títulos, áreas, ramas y rutas vienen
// del repo del cliente o del modelo: tienen que quedar como texto plano aunque el motor ya los sanee.

// Texto en línea: barra invertida delante de toda la puntuación que CommonMark puede interpretar, y sin saltos de línea.
export const escaparMd = (t: string) =>
  t.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]()#+\-.!|<>~&"'=:]/g, (c) => `\\${c}`);

// Código en línea: una valla de comillas invertidas más larga que cualquier racha del texto, con espacios si el texto
// empieza o acaba en comilla invertida (CommonMark §6.1).
export function codigoMd(t: string): string {
  const limpio = t.replace(/[\r\n]+/g, ' ');
  const racha = Math.max(0, ...(limpio.match(/`+/g) ?? []).map((r) => r.length));
  const valla = '`'.repeat(racha + 1);
  const relleno = limpio.startsWith('`') || limpio.endsWith('`') || limpio.startsWith(' ') ? ' ' : '';
  return `${valla}${relleno}${limpio}${relleno}${valla}`;
}
