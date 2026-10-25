// Textos de «Conecta tu IA por MCP» (S13 §13.8) y de «Resolver con mi IA». Puros: el token solo entra aquí dentro del
// panel de creación (se ve una vez); fuera de él, los fragmentos llevan TOKEN_EJEMPLO. El servidor se llama `vanguard`
// en todas las guías: de ese nombre sale el comando /mcp__vanguard__… de Claude Code.
export const TOKEN_EJEMPLO = 'vgk_TU_TOKEN';
export const NOMBRE_SERVIDOR = 'vanguard';

/** URL del MCP en el mismo origen que la app (officialvanguard.com, el *.workers.dev de respaldo o Vite en local). */
export const urlMcp = (origen: string) => `${origen.replace(/\/+$/, '')}/mcp`;
/** Origen de la app; sin `window` (render en servidor de las pruebas), el de producción. */
export const origenApp = () => (typeof window === 'undefined' ? 'https://officialvanguard.com' : window.location.origin);

export type ClienteMcp = 'claude_code' | 'claude_ai' | 'cursor' | 'vscode';
export type Guia = { id: ClienteMcp; nombre: string; pasos: string[]; fragmento: string };

export function guiasMcp(url: string, token: string = TOKEN_EJEMPLO): Guia[] {
  const json = (o: unknown) => JSON.stringify(o, null, 2);
  return [
    { id: 'claude_code', nombre: 'Claude Code', fragmento: `claude mcp add --transport http ${NOMBRE_SERVIDOR} ${url} --header "Authorization: Bearer ${token}" --scope user`,
      pasos: ['Pega el comando en tu terminal.', 'Comprueba con «claude mcp list» (o /mcp dentro de Claude Code) que vanguard sale conectado.',
        'Abre Claude Code en la raíz de tu repo y pídele: «Usa VanGUARD y dime mis 3 hallazgos más graves».'] },
    { id: 'claude_ai', nombre: 'claude.ai', fragmento: `Authorization: Bearer ${token}`,
      pasos: ['Customize → Connectors → «+ Add» → «Add custom connector».', `Nombre VanGUARD y URL ${url}. Continue.`,
        'Autenticación «No sign in»; en «Request headers» añade la cabecera de abajo. Add.', 'En un chat, activa el conector VanGUARD desde el menú de herramientas.'] },
    { id: 'cursor', nombre: 'Cursor', fragmento: json({ mcpServers: { [NOMBRE_SERVIDOR]: { url, headers: { Authorization: `Bearer ${token}` } } } }),
      pasos: ['Crea ~/.cursor/mcp.json (global) o .cursor/mcp.json en tu repo con este contenido.',
        'Si el archivo va al repo, cambia el token por ${env:VANGUARD_MCP_TOKEN} y define esa variable en tu equipo.',
        'En la configuración de MCP de Cursor, comprueba que vanguard aparece activo.'] },
    { id: 'vscode', nombre: 'VS Code', fragmento: json({
        inputs: [{ type: 'promptString', id: 'vanguard-token', description: 'Token MCP de VanGUARD (vgk_…)', password: true }],
        servers: { [NOMBRE_SERVIDOR]: { type: 'http', url, headers: { Authorization: 'Bearer ${input:vanguard-token}' } } } }),
      pasos: ['Crea .vscode/mcp.json con este contenido.', 'Al arrancar el servidor, VS Code te pide el token una vez y lo guarda cifrado.',
        'Abre el chat en modo agente y activa las herramientas de vanguard.'] },
  ];
}

/** Comando de un botón: Claude Code convierte los prompts MCP en /mcp__<servidor>__<prompt> con argumentos posicionales. */
export const comandoClaudeCode = (prompt: 'resolver_hallazgo' | 'resolver_criticos', arg?: string) =>
  `/mcp__${NOMBRE_SERVIDOR}__${prompt}${arg ? ` ${arg}` : ''}`;

/** Lo mismo en lenguaje natural para clientes sin prompts MCP como comandos (Cursor, VS Code, claude.ai). */
export const pedidoResolver = (findingId: string) =>
  `Usa el MCP de VanGUARD: llama a get_fix_prompt con id "${findingId}" y aplica la corrección en este repositorio. `
  + 'Muéstrame el diff y espera mi confirmación antes de aplicarlo.';
export const pedidoResolverTodo = () =>
  'Usa el MCP de VanGUARD: llama a get_repo_status y a list_findings con severity "critical" (después "high"), y resuelve '
  + 'cada hallazgo con get_fix_prompt, uno por uno, mostrándome el diff y esperando mi confirmación antes de aplicar cada uno.';

// ── «Abrir en Claude Code» (enlaces profundos oficiales) ──────────────────────────────────────────────────────────
// claude-cli://open abre una terminal con Claude Code en el clon local del repo (`repo` = owner/name que ya vio Claude
// Code) y la orden escrita; vscode://anthropic.claude-code/open abre una pestaña de Claude Code en la ventana activa.
// Ninguno envía nada: Claude Code avisa «Prompt from an external link» y el usuario pulsa Enter
// (https://code.claude.com/docs/en/deep-links.md, …/vs-code.md#launch-a-vs-code-tab-from-other-tools).
// La orden solo lleva el comando y el id (UUID): la corrección la trae la IA del MCP.
const REPO_SLUG = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** owner/name válido para el parámetro `repo`, o null (sin espacios, barras de más, `..` ni controles). */
export const slugRepo = (s: unknown): string | null =>
  typeof s === 'string' && REPO_SLUG.test(s) && !s.split('/').some((p) => p === '.' || p === '..') ? s : null;

type ConexionRepo = { id: string; provider: string; kind: string; status: string; meta: Record<string, unknown> };
/** Repo de GitHub donde arreglar: el de la conexión del hallazgo y, si no es de GitHub, el primero activo de la org. */
export function repoParaArreglar(connectionId: string | null, conexiones: readonly ConexionRepo[] | undefined): string | null {
  const gh = (conexiones ?? []).filter((c) => c.provider === 'github' && c.kind === 'read');
  const propia = gh.find((c) => c.id === connectionId);
  return slugRepo((propia ?? gh.find((c) => c.status === 'active') ?? gh[0])?.meta?.repo_full_name);   // meta fuera de contrato: sin repo
}

/** Enlace que abre Claude Code en la terminal (en el clon de `repo` si lo conoce) con `orden` escrita. */
export function enlaceClaudeCode(orden: string, repo?: string | null): string {
  const r = slugRepo(repo);
  return `claude-cli://open?${r ? `repo=${r}&` : ''}q=${encodeURIComponent(orden)}`;
}
/** Enlace que abre una pestaña de Claude Code en VS Code con `orden` escrita. */
export const enlaceVsCode = (orden: string) => `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(orden)}`;
