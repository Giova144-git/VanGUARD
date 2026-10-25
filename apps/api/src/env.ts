import type { Role } from '@vanguard/contracts';

// Lo que los middlewares de S15 15.3 dejan en el contexto de Hono.
export type Ctx = {
  rid: string;
  userId: string;
  email: string | null;
  isAnon: boolean;
  orgId: string;
  role: Role;
  mcp: McpCtx;            // solo en /mcp (mw/mcp-auth.ts): el tenant sale del token, nunca de un argumento
};

export const MCP_SCOPES = ['findings:read', 'incidents:read', 'metrics:read', 'export:read'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export type McpCtx = { tokenId: string; orgId: string; scopes: string[] };

export type AppEnv = { Bindings: CloudflareBindings; Variables: Ctx };
