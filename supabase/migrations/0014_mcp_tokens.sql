-- 0014_mcp_tokens.sql · tokens vgk_ del servidor MCP propio (S13 §13.7, DDL de §05.13 más last4 y expires_at de §13).
-- Se guarda solo sha256 hex del token completo: con 256 bits aleatorios no hace falta sal (R16 §10). Decisión (a) del
-- ORQUESTADOR: el navegador no lee tablas, así que RLS sin políticas y solo service_role (el Worker) la toca; la UI
-- usa E29/E29b. El tope de 10 vivos por org lo aplica la API.
create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  last4 text check (last4 ~ '^[A-Za-z0-9_-]{4}$'),
  scopes text[] not null default '{findings:read}'
    check (scopes <@ array['findings:read','incidents:read','metrics:read','export:read']::text[]),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  check (expires_at is null or expires_at > created_at));
create index if not exists mcp_tokens_org_live_idx on public.mcp_tokens (org_id) where revoked_at is null;

alter table public.mcp_tokens enable row level security;     -- y NINGUNA política
revoke all on public.mcp_tokens from public, anon, authenticated;
grant select, insert, update, delete on public.mcp_tokens to service_role;
