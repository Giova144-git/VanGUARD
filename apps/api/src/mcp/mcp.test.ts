import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpTokenCreated, McpTokenPublic } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { app } = await import('../app.ts');
const { hashToken, nuevoToken, TOKEN_RE } = await import('../lib/mcp-token.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const OTRA = '0f6c0000-0000-4000-8000-000000000002';
const F = 'c3d40000-0000-4000-8000-000000000001';
const TOK_ID = 'd0000000-0000-4000-8000-000000000001';
const TOKEN = 'vgk_' + 'A'.repeat(43);
const TODOS = ['findings:read', 'incidents:read', 'metrics:read', 'export:read'];

let fila: Record<string, unknown> | null;
let token: Record<string, unknown> | null;
let rol: string;
let tabla: (op: Op) => Resp | undefined;
let doble: ReturnType<typeof dbDoble>;
let hashBueno: string;

const hallazgo = (o: Record<string, unknown> = {}) => ({ id: F, module: 'codebase', rule_id: 'CB_ENV_COMMITTED', severity: 'critical',
  confirmed: true, origin: 'rule', title: '.env subido al repositorio', resource: '.env', status: 'open', status_reason: null,
  evidence: { path: '.env', line: 3, fingerprint: 'f'.repeat(64), muestra: 'SUPABASE_SECRET_KEY=sb_secret_' + 'x'.repeat(30) },
  fix_prompt: null, fix_model: null, suspected_injection: false, first_seen_at: '2026-10-24T10:00:00+00:00',
  last_seen_at: '2026-10-24T11:00:00+00:00', verified_at: null, ...o });

beforeEach(async () => {
  hashBueno = await hashToken(TOKEN);
  fila = hallazgo();
  rol = 'owner';
  token = { id: TOK_ID, org_id: ORG, scopes: TODOS, expires_at: '2099-01-01T00:00:00Z', last_used_at: new Date().toISOString() };
  tabla = () => undefined;
  doble = dbDoble({
    tabla: (op) => {
      if (op.table === 'org_members') return { data: { role: rol } };
      if (op.table === 'mcp_tokens' && op.action === 'select' && eqDe(op, 'token_hash') !== undefined)
        return { data: eqDe(op, 'token_hash') === hashBueno ? token : null };
      if (op.table === 'findings' && op.action === 'select' && eqDe(op, 'id') === F)
        return { data: eqDe(op, 'org_id') === fila?.org_id || eqDe(op, 'org_id') === ORG ? fila : null };
      return tabla(op);
    },
    claims: (t) => (t === 'ok' ? { sub: ANA, email: 'ana@acme.dev', is_anonymous: false } : null),
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const rpc = (body: unknown, auth = `Bearer ${TOKEN}`, method = 'POST') => app.request('https://officialvanguard.com/mcp', {
  method, headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }, envDoble().env);
const llamar = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
  expect(r.status).toBe(200);
  return (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
};

describe('token vgk_', () => {
  it('nuevoToken: prefijo + 43 car. base64url, distinto cada vez', () => {
    const a = nuevoToken(), b = nuevoToken();
    expect(a).toMatch(TOKEN_RE);
    expect(a).not.toBe(b);
  });
});

describe('/mcp · autenticación', () => {
  it('sin cabecera → 401 con WWW-Authenticate y sin tocar la base', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, '');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('invalid_token');
    expect(doble.ops).toHaveLength(0);
  });

  it('token desconocido, revocado (no casa revoked_at null) o vencido → 401', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, `Bearer vgk_${'B'.repeat(43)}`)).status).toBe(401);
    token = { ...token, expires_at: '2020-01-01T00:00:00Z' };
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    const q = doble.ops.find((o) => o.table === 'mcp_tokens');
    expect(q?.filters).toContainEqual(['revoked_at', 'is', null]);
  });

  it('límite de RL_API con clave mcp:<token_id> → 429', async () => {
    const claves: string[] = [];
    const env = envDoble({ RL_API: { limit: async ({ key }: { key: string }) => { claves.push(key); return { success: false }; } } } as never).env;
    const r = await app.request('https://officialvanguard.com/mcp', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }, env);
    expect(r.status).toBe(429);
    expect(claves).toEqual([`mcp:${TOK_ID}`]);
  });

  it('GET → 405 (sin stream SSE)', async () => {
    const r = await rpc(null, `Bearer ${TOKEN}`, 'GET');
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
  });
});

describe('/mcp · protocolo', () => {
  it('initialize negocia la versión y anuncia tools y prompts', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } } });
    const b = await r.json() as { result: Record<string, unknown> };
    expect(b.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'vanguard' },
      capabilities: { tools: {}, prompts: {} } });
  });

  it('una notificación sola → 202 sin cuerpo', async () => {
    const r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
  });

  it('tools/list: herramientas de solo lectura con inputSchema y los defaults como opcionales', async () => {
    const b = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json() as
      { result: { tools: { name: string; inputSchema: { required?: string[] }; annotations: { readOnlyHint: boolean } }[] } };
    const nombres = b.result.tools.map((x) => x.name);
    expect(nombres).toEqual(expect.arrayContaining(['get_overview', 'get_repo_status', 'list_findings', 'get_finding', 'get_fix_prompt']));
    expect(b.result.tools.every((x) => x.annotations.readOnlyHint)).toBe(true);
    const fix = b.result.tools.find((x) => x.name === 'get_fix_prompt')!;
    expect(fix.inputSchema.required).toEqual(['id']);
  });

  it('método desconocido → -32601; JSON roto → -32700', async () => {
    const a = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).json() as { error: { code: number } };
    expect(a.error.code).toBe(-32601);
    const r = await app.request('https://officialvanguard.com/mcp', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
      body: '{no' }, envDoble().env);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
});

describe('/mcp · herramientas', () => {
  it('get_fix_prompt sin prompt guardado → plantilla de la regla, redactada y sin llamar al modelo', async () => {
    const b = await llamar('get_fix_prompt', { id: F, flavor: 'claude_code' });
    expect(b.result.isError).toBeUndefined();
    const out = JSON.parse(b.result.content[0]!.text);
    expect(out.vanguard.tool).toBe('get_fix_prompt');
    expect(out.untrusted_data.fix).toMatchObject({ source: 'template', model: null });
    expect(out.untrusted_data.fix.text).toContain('<evidencia_no_confiable');
    expect(out.untrusted_data.finding.location).toEqual({ path: '.env', line: 3 });
    expect(b.result.content[0]!.text).not.toContain('sb_secret_xxxx');
    const q = doble.ops.find((o) => o.table === 'findings')!;
    expect(eqDe(q, 'org_id')).toBe(ORG);
  });

  it('get_fix_prompt con prompt guardado → source ai con su modelo', async () => {
    fila = hallazgo({ fix_prompt: '> EVIDENCIA NO CONFIABLE\n**Corrección** guardada', fix_model: 'claude-sonnet-5-5' });
    const out = JSON.parse((await llamar('get_fix_prompt', { id: F })).result.content[0]!.text);
    expect(out.untrusted_data.fix).toMatchObject({ source: 'ai', model: 'claude-sonnet-5-5' });
    expect(out.untrusted_data.fix.text).toContain('Corrección** guardada');
  });

  it('anti-IDOR: el tenant sale del token; un hallazgo de otra org → «No encontrado»', async () => {
    token = { ...token, org_id: OTRA };
    const b = await llamar('get_finding', { id: F });
    expect(b.result.isError).toBe(true);
    expect(b.result.content[0]!.text).toContain('No encontrado');
    expect(eqDe(doble.ops.find((o) => o.table === 'findings')!, 'org_id')).toBe(OTRA);
  });

  it('get_finding quita la huella completa de la evidencia y no trae el texto del prompt', async () => {
    const out = JSON.parse((await llamar('get_finding', { id: F })).result.content[0]!.text);
    expect(out.untrusted_data.evidence.fingerprint).toBeUndefined();
    expect(out.untrusted_data.fix_prompt).toBeUndefined();
    expect(out.untrusted_data.has_fix_prompt).toBe(false);
  });

  it('sin el alcance → isError; argumentos no válidos → isError', async () => {
    token = { ...token, scopes: ['incidents:read'] };
    expect((await llamar('get_fix_prompt', { id: F })).result.isError).toBe(true);
    token = { ...token, scopes: TODOS };
    const b = await llamar('get_fix_prompt', { id: 'no-es-uuid' });
    expect(b.result.isError).toBe(true);
    expect(b.result.content[0]!.text).toContain('id');
  });

  it('list_findings pagina con next_offset', async () => {
    tabla = (op) => (op.table === 'findings' ? { data: [hallazgo(), hallazgo({ id: 'c3d40000-0000-4000-8000-000000000002' }),
      hallazgo({ id: 'c3d40000-0000-4000-8000-000000000003' })] } : undefined);
    const out = JSON.parse((await llamar('list_findings', { limit: 2 })).result.content[0]!.text);
    expect(out.untrusted_data.items).toHaveLength(2);
    expect(out.untrusted_data.next_offset).toBe(2);
  });
});

describe('/mcp · prompts', () => {
  it('resolver_hallazgo trae la corrección dentro del mensaje', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'resolver_hallazgo', arguments: { id: F } } });
    const b = await r.json() as { result: { messages: { role: string; content: { text: string } }[] } };
    expect(b.result.messages[0]!.role).toBe('user');
    const t = b.result.messages[0]!.content.text;
    expect(t).toContain('CB_ENV_COMMITTED');
    expect(t).toContain('Archivo: .env:3');
    expect(t).toContain('<evidencia_no_confiable');
    expect(t).not.toContain('sb_secret_xxxx');
  });

  it('resolver_hallazgo sin id → -32602; resolver_criticos no lee la base', async () => {
    const a = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'resolver_hallazgo' } })).json() as { error: { code: number } };
    expect(a.error.code).toBe(-32602);
    const antes = doble.ops.filter((o) => o.table === 'findings').length;
    const b = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'resolver_criticos', arguments: { modulo: 'codebase' } } })).json() as
      { result: { messages: { content: { text: string } }[] } };
    expect(b.result.messages[0]!.content.text).toContain('module "codebase"');
    expect(doble.ops.filter((o) => o.table === 'findings').length).toBe(antes);
  });
});

describe('E29 · mcp-tokens', () => {
  const api = (method: string, ruta = '', body?: unknown) => app.request(`https://officialvanguard.com/api/orgs/${ORG}/mcp-tokens${ruta}`, {
    method, headers: { authorization: 'Bearer ok', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, envDoble().env);

  it('POST: el token sale una vez; en la base solo su hash, last4 y los cuatro alcances', async () => {
    tabla = (op) => (op.table === 'mcp_tokens' && op.action === 'insert'
      ? { data: { id: TOK_ID, name: 'Claude Code de Ana', scopes: TODOS, last4: (op.payload as { last4: string }).last4,
        expires_at: '2026-11-23T00:00:00+00:00' } } : op.table === 'mcp_tokens' ? { data: [] } : undefined);
    const r = await api('POST', '', { name: 'Claude Code de Ana', expires_in_days: 30 });
    expect(r.status).toBe(201);
    const b = McpTokenCreated.parse(await r.json());
    expect(b.token).toMatch(TOKEN_RE);
    const ins = doble.ops.find((o) => o.action === 'insert')!.payload as Record<string, unknown>;
    expect(ins.token_hash).toBe(await hashToken(b.token));
    expect(JSON.stringify(ins)).not.toContain(b.token);
    expect(ins).toMatchObject({ org_id: ORG, created_by: ANA, scopes: TODOS, last4: b.token.slice(-4) });
  });

  it('POST con 10 vivos → 409; viewer → 403', async () => {
    tabla = (op) => (op.table === 'mcp_tokens' ? { data: Array.from({ length: 10 }, () => ({ id: TOK_ID, expires_at: null })) } : undefined);
    expect((await api('POST', '', { name: 'Otro' })).status).toBe(409);
    rol = 'viewer';
    expect((await api('POST', '', { name: 'Otro' })).status).toBe(403);
    expect((await api('GET')).status).toBe(403);
  });

  it('GET nunca pide token_hash; DELETE pone revoked_at en la org de la sesión', async () => {
    tabla = (op) => (op.table === 'mcp_tokens' && op.action === 'select' ? { data: [{ id: TOK_ID, name: 'x1', scopes: TODOS, last4: 'AAAA',
      created_at: '2026-10-24T10:00:00+00:00', last_used_at: null, expires_at: null, revoked_at: null }] }
      : op.table === 'mcp_tokens' && op.action === 'update' ? { data: { id: TOK_ID } } : undefined);
    const g = await api('GET');
    expect(McpTokenPublic.array().parse(await g.json())).toHaveLength(1);
    expect(doble.ops.find((o) => o.table === 'mcp_tokens')!.columns).not.toContain('token_hash');
    const d = await api('DELETE', `/${TOK_ID}`);
    expect(d.status).toBe(204);
    const u = doble.ops.find((o) => o.action === 'update')!;
    expect(eqDe(u, 'org_id')).toBe(ORG);
    expect(u.payload).toHaveProperty('revoked_at');
  });
});
