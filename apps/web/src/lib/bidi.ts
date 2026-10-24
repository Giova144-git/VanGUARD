// Controles de dirección (Trojan Source, CVE-2021-42574) en texto técnico que llega del servidor: rutas, recursos, user
// agents, IPs y nombres de archivo. «src/lib/‮sj.nimda» se leería «src/lib/admin.js»; aquí se ve «src/lib/⟨U+202E⟩sj.nimda».
// Las letras árabes o hebreas no se tocan: solo los controles invisibles. Pintar el resultado dentro de <bdi> para que
// tampoco reordene el texto vecino.
const CONTROLES = /[؜‎‏‪-‮⁦-⁩]/g;

export const sinBidi = (s: string) =>
  s.replace(CONTROLES, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`);
