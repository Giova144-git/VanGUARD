-- 0002_tenancy.sql · literal de PLAN_MAESTRO §05.4.
create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  is_demo boolean not null default false,
  daily_audit boolean not null default false,
  ai_daily_cap_usd numeric(8,2) not null default 1.5 check (ai_daily_cap_usd between 0 and 100),
  created_at timestamptz not null default now());
create unique index if not exists orgs_one_demo on public.orgs (is_demo) where is_demo;   -- una sola org de demo

create table if not exists public.org_members (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id));
create index if not exists org_members_user_idx on public.org_members (user_id);
alter table public.orgs enable row level security;  alter table public.org_members enable row level security;  -- políticas en 0008

create or replace function private.user_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select org_id from public.org_members where user_id = (select auth.uid()) $$;
create or replace function private.user_admin_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select org_id from public.org_members where user_id = (select auth.uid()) and role in ('owner','admin') $$;
revoke all on function private.user_org_ids(), private.user_admin_org_ids() from public, anon;
grant execute on function private.user_org_ids(), private.user_admin_org_ids() to authenticated;

-- «Ver demo»: cualquier sesión (también la anónima) entra como viewer a la única org is_demo.
create or replace function public.join_demo_org() returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  select id into v_org from public.orgs where is_demo;
  if v_org is null then raise exception 'demo_org_missing' using errcode = 'P0002'; end if;
  insert into public.org_members (org_id, user_id, role) values (v_org, v_uid, 'viewer')
  on conflict (org_id, user_id) do nothing;              -- un owner de la demo no baja a viewer
  return v_org;
end $$;
revoke all on function public.join_demo_org() from public, anon;
grant execute on function public.join_demo_org() to authenticated;

-- POST /api/orgs: org + membresía owner en una transacción. El API rechaza sesiones anónimas (claim is_anonymous)
-- y usuarios owner de 3 orgs o más [propuesta]. slug = slugify(name) recortado a 35 car. (vacío → 'org') + '-' + 4 car.
-- [a-z0-9] al azar (cabe en el check de 3–40 car.); reintenta hasta 3 veces si da 23505.
create or replace function public.vg_create_org(p_name text, p_slug text, p_owner uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.orgs (name, slug) values (p_name, p_slug) returning id into v_id;
  insert into public.org_members (org_id, user_id, role) values (v_id, p_owner, 'owner');
  return v_id;
end $$;
revoke all on function public.vg_create_org(text, text, uuid) from public, anon, authenticated;
grant execute on function public.vg_create_org(text, text, uuid) to service_role;
