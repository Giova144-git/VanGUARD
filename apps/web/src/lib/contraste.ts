// Contraste WCAG con canales linealizados (S14 §14.6, R08 §2.5).
export function luminancia(hex: string): number {
  const h = hex.replace('#', '');
  const canal = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(0) + 0.7152 * canal(2) + 0.0722 * canal(4);
}

export function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

// Lee los hex de un bloque `selector { … }` de globals.css (solo los tokens planos, no los color-mix).
export function tokensDe(css: string, selector: string): Record<string, string> {
  const ini = css.indexOf(`${selector} {`);
  if (ini < 0) return {};
  const bloque = css.slice(ini, css.indexOf('}', ini));
  const out: Record<string, string> = {};
  for (const m of bloque.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) if (m[1] && m[2]) out[m[1]] = m[2];
  return out;
}
