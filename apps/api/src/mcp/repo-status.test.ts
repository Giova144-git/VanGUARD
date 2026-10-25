import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbDoble, type Op } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// get_repo_status con el token de acciones del bloqueo de merge (0016: GitHub kind 'action', una por org): no es otro
// repo conectado y no sale en `repos`. Archivo aparte de mcp.test.ts (otra rama lo está cambiando a la vez).
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { app } = await import('../app.ts');
const { hashToken } = await import('../lib/mcp-token.ts');

const ORG = '0f6c0000-0000-4000-8000-000000000001';
const TOKEN = 'vgk_' + 'A'.repeat(43);
type Fila = Record<string, unknown>;

const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) =>
  o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : true);
const conexiones: Fila[] = [
  { org_id: ORG, provider: 'github', kind: 'read', label: 'GitHub · acme/tienda', status: 'active', last_checked_at: null,
    meta: { repo_full_name: 'acme/tienda', default_branch: 'main' } },
  { org_id: ORG, provider: 'github', kind: 'action', label: 'GitHub · estados · acme/tienda', status: 'active',
    last_checked_at: null, meta: { repo_full_name: 'acme/tienda', branch: 'main', purpose: 'commit_statuses' } },
];

beforeEach(async () => {
  const hash = await hashToken(TOKEN);
  const token = { id: 'd0000000-0000-4000-8000-000000000001', org_id: ORG, scopes: ['findings:read'],
    expires_at: '2099-01-01T00:00:00Z', last_used_at: new Date().toISOString() };
  estado.client = dbDoble({
    tabla: (op) => {
      if (op.table === 'mcp_tokens' && op.action === 'select') {
        return { data: op.filters.some(([c, , v]) => c === 'token_hash' && v === hash) ? token : null };
      }
      if (op.table === 'connections' && op.action === 'select') return { data: conexiones.filter((c) => cumple(c, op)) };
      return undefined;
    },
  }).client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('MCP get_repo_status', () => {
  it('lista solo las conexiones GitHub de lectura: el token de estados no sale como un 2.º repo', async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'get_repo_status', arguments: {} } });
    const r = await app.request('https://officialvanguard.com/mcp', { method: 'POST', headers, body }, envDoble().env);
    expect(r.status).toBe(200);
    const b = await r.json() as { result: { content: { text: string }[]; isError?: boolean } };
    expect(b.result.isError).toBeUndefined();
    const out = JSON.parse(b.result.content[0]!.text) as { untrusted_data: { repos: Fila[] } };
    expect(out.untrusted_data.repos).toEqual([{ label: 'GitHub · acme/tienda', status: 'active', last_checked_at: null,
      repo_full_name: 'acme/tienda', default_branch: 'main' }]);
  });
});
