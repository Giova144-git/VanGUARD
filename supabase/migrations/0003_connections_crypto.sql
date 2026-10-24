-- 0003_connections_crypto.sql · literal de PLAN_MAESTRO §05.4.
create table if not exists public.connections (
  id uuid primary key,                    -- lo genera el Worker (crypto.randomUUID()): entra en el AAD antes de insertar
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null check (provider in ('supabase','cloudflare','github','ingest')),
  kind text not null default 'read' check (kind in ('read','action')),
  label text not null check (char_length(label) between 1 and 80),
  status text not null default 'active' check (status in ('active','error','revoked','expired')),
  meta jsonb not null default '{}',       -- supabase {project_ref} · cloudflare {zone_id, zone_name, account_id, plan}
                                          -- github {repo_full_name, default_branch} · ingest {hostname}
  last4 text check (char_length(last4) <= 4),
  scopes text[] not null default '{}',
  capabilities jsonb not null default '{}',   -- sondeo, solo booleanos con claves cortas: {"health":true,"sql_read_only":true,"analytics":false} (§15.5)
  expires_at timestamptz, last_checked_at timestamptz,
  last_error text check (char_length(last_error) <= 200),   -- ProviderErrorCode: unauthorized|forbidden|not_found|rate_limited|unavailable|timeout|invalid
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id),                                    -- destino de la FK compuesta de connection_secrets
  check (kind = 'read' or provider = 'cloudflare'),       -- solo Cloudflare tiene token de acciones (§10.2)
  check (provider <> 'supabase'   or meta ? 'project_ref'),
  check (provider <> 'cloudflare' or meta ? 'zone_id'),
  check (provider <> 'github'     or meta ? 'repo_full_name'),
  check (not private.looks_like_secret(meta::text) and not private.looks_like_secret(last_error)));
create index if not exists connections_org_idx on public.connections (org_id);
alter table public.connections enable row level security;   -- política en 0008

create table if not exists public.connection_secrets (
  connection_id uuid primary key,
  org_id uuid not null,
  sealed jsonb not null,                  -- Box {v, kid, iv, ct, ivk, wdek} (05.7)
  kid text not null check (kid ~ '^v[0-9]{1,3}$'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  foreign key (connection_id, org_id) references public.connections (id, org_id) on delete cascade,
  unique (org_id, fingerprint),
  check (sealed ?& array['v','kid','iv','ct','ivk','wdek'] and sealed->>'kid' = kid));
alter table public.connection_secrets enable row level security;     -- y NINGUNA política
revoke all on public.connection_secrets from anon, authenticated;

-- Material de Vault: se genera dentro de la base; el valor no aparece en ningún texto de sentencia ni en el repo.
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'kek_v1') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'), 'kek_v1', 'VanGUARD KEK v1 (mitad Vault)');
  end if;
  if not exists (select 1 from vault.secrets where name = 'fp_pepper_v1') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'), 'fp_pepper_v1', 'VanGUARD pimienta de huellas v1');
  end if;
end $$;

create or replace function public.vg_crypto_material(p_version int)
returns table (kek_b64 text, fp_pepper_b64 text)
language sql stable security definer set search_path = '' as $$
  select (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'kek_v' || p_version),
         (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'fp_pepper_v1') $$;

-- Alta atómica: fila pública + secreto sellado en una transacción (el Worker ya selló con el id definitivo).
create or replace function public.vg_create_connection(p_conn jsonb, p_secret jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.connections (id, org_id, provider, kind, label, meta, last4, scopes, capabilities,
                                  expires_at, last_checked_at, created_by)
  values ((p_conn->>'id')::uuid, (p_conn->>'org_id')::uuid, p_conn->>'provider', coalesce(p_conn->>'kind', 'read'),
          p_conn->>'label', coalesce(p_conn->'meta', '{}'), p_conn->>'last4',
          array(select jsonb_array_elements_text(coalesce(p_conn->'scopes', '[]'))),
          coalesce(p_conn->'capabilities', '{}'), (p_conn->>'expires_at')::timestamptz, now(),
          (p_conn->>'created_by')::uuid);
  insert into public.connection_secrets (connection_id, org_id, sealed, kid, fingerprint)
  values ((p_conn->>'id')::uuid, (p_conn->>'org_id')::uuid, p_secret->'sealed', p_secret->>'kid', p_secret->>'fingerprint');
end $$;

-- P1 «Rotar token sin perder historial»: mismo connection_id, así los hallazgos siguen colgando de él.
create or replace function public.vg_rotate_secret(p_org uuid, p_conn uuid, p_secret jsonb, p_last4 text,
  p_scopes text[], p_capabilities jsonb, p_expires_at timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.connection_secrets set sealed = p_secret->'sealed', kid = p_secret->>'kid',
         fingerprint = p_secret->>'fingerprint', rotated_at = now()
   where connection_id = p_conn and org_id = p_org;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  update public.connections set last4 = p_last4, scopes = p_scopes, capabilities = p_capabilities,
         expires_at = p_expires_at, status = 'active', last_error = null, last_checked_at = now()
   where id = p_conn and org_id = p_org;
end $$;

revoke all on function public.vg_crypto_material(int), public.vg_create_connection(jsonb, jsonb),
  public.vg_rotate_secret(uuid, uuid, jsonb, text, text[], jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.vg_crypto_material(int), public.vg_create_connection(jsonb, jsonb),
  public.vg_rotate_secret(uuid, uuid, jsonb, text, text[], jsonb, timestamptz) to service_role;
