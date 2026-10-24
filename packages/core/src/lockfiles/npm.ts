// Lockfile de npm → dependencias para OSV (S09 09.6 literal). P0: package-lock.json v2/v3 (`packages`) y v1 (`dependencies`).
// Ecosistema y Dep viven aquí mientras no exista lockfiles/types.ts del plan; composer.ts los importa.

// Cadenas de ecosistema de OSV, con mayúsculas exactas (https://ossf.github.io/osv-schema/).
export type Ecosistema = 'npm' | 'Packagist' | 'PyPI' | 'Go' | 'Pub' | 'crates.io';
export type Dep = { ecosystem: Ecosistema; name: string; version: string; dev: boolean; direct: boolean; manifest: string };

export function fromPackageLock(txt: string, manifest: string): Dep[] {
  const j = JSON.parse(txt);
  if (j.packages) {
    const root = j.packages[''] ?? {};
    const direct = new Set([...Object.keys(root.dependencies ?? {}), ...Object.keys(root.devDependencies ?? {})]);
    return Object.entries<any>(j.packages).filter(([k, v]) => k.includes('node_modules/') && v?.version && !v.link)
      .map(([k, v]) => { const clave = k.slice(k.lastIndexOf('node_modules/') + 13), name = v.name ?? clave;   // alias npm:
        return { ecosystem: 'npm' as const, name, version: v.version, dev: !!v.dev, direct: direct.has(clave), manifest }; });
  }
  const out: Dep[] = [];                                             // lockfileVersion 1
  const walk = (deps: Record<string, any> = {}, top: boolean) => { for (const [name, v] of Object.entries(deps)) {
    if (v?.version && !String(v.version).startsWith('file:')) out.push({ ecosystem: 'npm', name, version: v.version, dev: !!v.dev, direct: top, manifest });
    walk(v?.dependencies, false); } };
  walk(j.dependencies, true);
  return out;
}
