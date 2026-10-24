// Detección determinista del stack (S09 09.5): reglas sobre el árbol y los manifiestos, sin red ni IA. Claude no lo
// adivina: IA-2 nombra este `stack` en su resumen e IA-1 lo recibe (package_manager = primer valor de `gestores`).
// Se guarda en scan_runs.coverage.detail.codebase.stack.

export type EntradaInventario = { path: string; size?: number };
export type Lenguaje = { nombre: string; archivos: number; bytes: number };
export type Stack = { lenguajes: Lenguaje[]; frameworks: string[]; servicios: string[]; plataformas: string[]; ci: string[]; gestores: string[] };

const FUERA = /(^|\/)(node_modules|vendor|dist|build|\.git)\//;
const LENGUAJE: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  php: 'PHP', py: 'Python', go: 'Go', rs: 'Rust', dart: 'Dart', rb: 'Ruby', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
};
// Dependencia de package.json → valor, en el orden en que salen.
const FRAMEWORKS_NPM = ['react', 'next', 'vite', 'hono', 'express', 'vue', 'svelte'];
const SERVICIOS_NPM: ReadonlyArray<readonly [string, string]> = [
  ['@supabase/supabase-js', 'supabase'], ['stripe', 'stripe'], ['@anthropic-ai/sdk', 'anthropic'], ['openai', 'openai'],
];
const ORDEN_FRAMEWORKS = [...FRAMEWORKS_NPM, 'laravel', 'symfony', 'django', 'flask', 'fastapi', 'flutter', 'rails'];
const ORDEN_PLATAFORMAS = ['cloudflare_workers', 'supabase', 'vercel', 'netlify', 'firebase', 'docker'];
// Lockfile (o manifiesto con versiones fijas de 09.6) → gestor, en el orden de 09.5.
const GESTORES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['npm', ['package-lock.json']], ['pnpm', ['pnpm-lock.yaml']], ['yarn', ['yarn.lock']], ['composer', ['composer.lock']],
  ['pip', ['requirements.txt', 'Pipfile.lock', 'poetry.lock']], ['go', ['go.sum', 'go.mod']], ['pub', ['pubspec.lock']], ['cargo', ['Cargo.lock']],
];
const PY = /(^|[\s"'])(django|flask|fastapi)(?=[\s"'<>=~!\[,;]|$)/gim;

const nombre = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const ordenar = (vistos: Set<string>, orden: readonly string[]) => orden.filter((x) => vistos.has(x));
function json(txt: string): Record<string, unknown> | null {
  try { const j: unknown = JSON.parse(txt); return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null; }
  catch { return null; }
}
const claves = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o) : []);

/** `inventario` = todas las rutas del árbol con su tamaño; `archivos` = los leídos (solo se miran los manifiestos). */
export function detectarStack(inventario: readonly EntradaInventario[], archivos: readonly { path: string; content: string }[] = []): Stack {
  const tam = new Map<string, number>();
  for (const e of inventario) if (!FUERA.test(e.path)) tam.set(e.path, e.size ?? 0);
  for (const a of archivos) if (!FUERA.test(a.path) && !tam.has(a.path)) tam.set(a.path, a.content.length);
  const rutas = [...tam.keys()];

  // Lenguajes por bytes: top 5.
  const porLenguaje = new Map<string, Lenguaje>();
  for (const [p, bytes] of tam) {
    const n = nombre(p), punto = n.lastIndexOf('.');
    const len = punto > 0 ? LENGUAJE[n.slice(punto + 1).toLowerCase()] : undefined;
    if (!len) continue;
    const l = porLenguaje.get(len) ?? { nombre: len, archivos: 0, bytes: 0 };
    l.archivos++; l.bytes += bytes; porLenguaje.set(len, l);
  }
  const lenguajes = [...porLenguaje.values()]
    .sort((a, b) => b.bytes - a.bytes || b.archivos - a.archivos || (a.nombre < b.nombre ? -1 : 1)).slice(0, 5);

  // Frameworks y servicios desde los manifiestos leídos.
  const fw = new Set<string>(), sv = new Set<string>();
  for (const a of archivos) {
    if (FUERA.test(a.path)) continue;
    const n = nombre(a.path);
    if (n === 'package.json') {
      const j = json(a.content);
      const deps = new Set([...claves(j?.dependencies), ...claves(j?.devDependencies)]);
      for (const f of FRAMEWORKS_NPM) if (deps.has(f)) fw.add(f);
      for (const [d, s] of SERVICIOS_NPM) if (deps.has(d)) sv.add(s);
    } else if (n === 'composer.json') {
      const j = json(a.content);
      const deps = [...claves(j?.require), ...claves(j?.['require-dev'])];
      if (deps.includes('laravel/framework')) fw.add('laravel');
      if (deps.some((d) => d.startsWith('symfony/'))) fw.add('symfony');
    } else if (n === 'requirements.txt' || n === 'pyproject.toml') {
      for (const m of a.content.replace(/#.*$/gm, '').matchAll(PY)) if (m[2]) fw.add(m[2].toLowerCase());   // sin comentarios
    } else if (n === 'pubspec.yaml') {
      if (/^\s*flutter\s*:|sdk:\s*flutter\b/m.test(a.content)) fw.add('flutter');
    } else if (n === 'Gemfile') {
      if (/^\s*gem\s+["']rails["']/m.test(a.content)) fw.add('rails');
    }
  }

  // Plataformas, CI y gestores solo por rutas.
  const pl = new Set<string>(), ci = new Set<string>(), nombres = new Set<string>();
  for (const p of rutas) {
    const n = nombre(p);
    nombres.add(n);
    if (/^wrangler\.(toml|json|jsonc)$/.test(n)) pl.add('cloudflare_workers');
    if (/(^|\/)supabase\/config\.toml$/.test(p) || /(^|\/)supabase\/migrations\//.test(p)) pl.add('supabase');
    if (n === 'vercel.json' || /(^|\/)\.vercel\//.test(p)) pl.add('vercel');
    if (n === 'netlify.toml') pl.add('netlify');
    if (n === 'firebase.json') pl.add('firebase');
    if (/^Dockerfile(\.[\w.-]+)?$/.test(n)) pl.add('docker');
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) ci.add('github_actions');
  }
  const gestores = GESTORES.filter(([, ls]) => ls.some((l) => nombres.has(l))).map(([g]) => g);

  return { lenguajes, frameworks: ordenar(fw, ORDEN_FRAMEWORKS), servicios: SERVICIOS_NPM.map(([, s]) => s).filter((s) => sv.has(s)),
    plataformas: ordenar(pl, ORDEN_PLATAFORMAS), ci: [...ci], gestores };
}
