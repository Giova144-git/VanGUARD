// Entropía de Shannon por carácter (S09 09.9 literal): filtra valores repetitivos en AWS, OpenAI, GitHub (≥ 3) y la genérica (≥ 3,5).
export const entropia = (s: string) => { const f = new Map<string, number>(); for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0; for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); } return h; };   // Shannon por carácter
