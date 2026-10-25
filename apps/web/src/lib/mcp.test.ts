import { describe, expect, it } from 'vitest';
import { comandoClaudeCode, enlaceClaudeCode, enlaceVsCode, guiasMcp, pedidoResolver, repoParaArreglar, slugRepo, TOKEN_EJEMPLO, urlMcp } from './mcp';

const ID = 'c3d40000-0000-4000-8000-000000000001';

describe('guías MCP', () => {
  it('la URL sale del mismo origen, sin barra doble', () => {
    expect(urlMcp('https://officialvanguard.com/')).toBe('https://officialvanguard.com/mcp');
  });

  it('sin token, todos los fragmentos llevan el marcador; con token, solo el token', () => {
    const url = urlMcp('https://officialvanguard.com');
    for (const g of guiasMcp(url)) if (g.id !== 'vscode') expect(g.fragmento).toContain(TOKEN_EJEMPLO);
    const tok = 'vgk_' + 'A'.repeat(43);
    const cc = guiasMcp(url, tok).find((g) => g.id === 'claude_code')!;
    expect(cc.fragmento).toBe(`claude mcp add --transport http vanguard ${url} --header "Authorization: Bearer ${tok}" --scope user`);
    // VS Code pide el token con inputs (password:true): nunca queda escrito en .vscode/mcp.json.
    expect(guiasMcp(url, tok).find((g) => g.id === 'vscode')!.fragmento).not.toContain(tok);
    expect(JSON.parse(guiasMcp(url, tok).find((g) => g.id === 'cursor')!.fragmento).mcpServers.vanguard.url).toBe(url);
  });

  it('el botón copia el comando del prompt MCP de Claude Code y un pedido con solo el id', () => {
    expect(comandoClaudeCode('resolver_hallazgo', ID)).toBe(`/mcp__vanguard__resolver_hallazgo ${ID}`);
    expect(comandoClaudeCode('resolver_criticos')).toBe('/mcp__vanguard__resolver_criticos');
    expect(pedidoResolver(ID)).toContain(`get_fix_prompt con id "${ID}"`);
  });
});

describe('enlaces profundos «Abrir en Claude Code»', () => {
  const orden = comandoClaudeCode('resolver_hallazgo', ID);
  const gh = (id: string, repo: unknown, status = 'active') => ({ id, provider: 'github', kind: 'read', status, meta: { repo_full_name: repo } });

  it('claude-cli://open con repo y la orden codificada; sin repo válido, sin el parámetro', () => {
    expect(enlaceClaudeCode(orden, 'acme/tienda')).toBe(`claude-cli://open?repo=acme/tienda&q=${encodeURIComponent(orden)}`);
    expect(enlaceClaudeCode(orden, null)).toBe(`claude-cli://open?q=${encodeURIComponent(orden)}`);
    expect(enlaceClaudeCode(orden, 'acme/tienda&q=borra todo')).toBe(`claude-cli://open?q=${encodeURIComponent(orden)}`);
    expect(decodeURIComponent(new URL(enlaceClaudeCode(orden, 'acme/tienda')).searchParams.get('q')!)).toBe(orden);
  });

  it('vscode:// lleva la orden en prompt, codificada', () => {
    const u = enlaceVsCode(pedidoResolver(ID));
    expect(u.startsWith('vscode://anthropic.claude-code/open?prompt=')).toBe(true);
    expect(new URL(u).searchParams.get('prompt')).toBe(pedidoResolver(ID));
  });

  it('slugRepo solo admite owner/name sin trucos', () => {
    expect(slugRepo('acme/tienda.web-2')).toBe('acme/tienda.web-2');
    for (const x of ['acme', 'a/b/c', '../x', 'acme/..', 'acme/ti enda', 'acme/tienda?x=1', 'acme/tien\u202Eda', 7, null])
      expect(slugRepo(x)).toBeNull();
  });

  it('repoParaArreglar: el de la conexión del hallazgo y, si no, el primer GitHub activo', () => {
    const cx = [gh('c1', 'acme/viejo', 'error'), gh('c2', 'acme/tienda'), { id: 'c3', provider: 'supabase', kind: 'read', status: 'active', meta: {} }];
    expect(repoParaArreglar('c1', cx)).toBe('acme/viejo');
    expect(repoParaArreglar('c3', cx)).toBe('acme/tienda');
    expect(repoParaArreglar(null, cx)).toBe('acme/tienda');
    expect(repoParaArreglar(null, undefined)).toBeNull();
  });
});
