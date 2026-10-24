import { redact } from './redact.mjs';
// Lectura de repos publicos de GitHub via API REST (sin dependencias).
const API = 'https://api.github.com';

const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|\.next|vendor|__pycache__|coverage)\//;
const SKIP_FILE = /((^|\/)\.env[^/]*|\.(pem|key|p12|pfx)|id_rsa[^/]*|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|woff2?|ttf|mp[34]|lock|map|min\.js))$/i;
const MAX_FILE_BYTES = 60_000;

export function parseRepoUrl(input) {
  const m = input.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error('URL invalida. Usa https://github.com/<dueno>/<repo> o <dueno>/<repo>');
  return { owner: m[1], repo: m[2] };
}

async function gh(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'deepwiki-claude' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GitHub ${res.status} en ${path}${res.status === 403 ? ' (posible limite de peticiones; define GITHUB_TOKEN)' : ''}`);
  return res.json();
}

export async function fetchRepo({ owner, repo }, { maxFiles = 150, select } = {}) {
  const meta = await gh(`/repos/${owner}/${repo}`);
  const tree = await gh(`/repos/${owner}/${repo}/git/trees/${meta.default_branch}?recursive=1`);
  if (!tree.tree?.length) throw new Error('Repositorio vacio o sin archivos legibles');
  if (tree.truncated) console.warn('Aviso: el arbol del repo es muy grande y GitHub lo trunco; el documento sera parcial.');
  const candidates = tree.tree.filter(
    (e) => e.type === 'blob' && !SKIP_DIR.test(e.path) && !SKIP_FILE.test(e.path) && e.size <= MAX_FILE_BYTES,
  );
  // Prioriza README/docs/manifiestos y archivos poco profundos.
  const score = (p) => (/readme|package\.json|pyproject|go\.mod|cargo\.toml/i.test(p) ? 0 : 1) * 100 + p.split('/').length;
  let ranked = candidates.sort((a, b) => score(a.path) - score(b.path));
  if (select) {
    // Triage con modelo barato: solo rutas, nunca contenido.
    const keep = new Set(await select(ranked.slice(0, 400).map((e) => e.path)));
    ranked = ranked.filter((e) => keep.has(e.path));
  }
  const files = ranked.slice(0, maxFiles);

  const out = [];
  for (const f of files) {
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(meta.default_branch)}/${encodeURI(f.path)}`, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) out.push({ path: f.path, content: redact(await res.text()) });
  }
  return {
    meta: { name: meta.full_name, description: meta.description, language: meta.language, stars: meta.stargazers_count, branch: meta.default_branch },
    allPaths: tree.tree.filter((e) => e.type === 'blob').map((e) => e.path),
    files: out,
  };
}
