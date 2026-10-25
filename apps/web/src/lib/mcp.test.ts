import { describe, expect, it } from 'vitest';
import { comandoClaudeCode, guiasMcp, pedidoResolver, TOKEN_EJEMPLO, urlMcp } from './mcp';

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
