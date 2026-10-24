-- Copia literal de PLAN_MAESTRO.md §07.9 (ORQUESTADOR). Lo pega Gabriel en el SQL Editor de vanguard-demo,
-- en SU cuenta de Supabase (paso 9 de docs/PASOS_MANUALES_GIOVANNI.md). Sin claves ni datos reales.
-- demo/seed-victima.sql · SOLO para vanguard-demo · fallas SIMULADAS · datos FALSOS
-- 0) Guarda [propuesta]: aborta si esto es la base de VanGUARD (ahí viven nuestras RPC vg_*, §6 de las decisiones)
do $$ begin
  if exists (select 1 from pg_catalog.pg_proc where proname like 'vg\_%') then
    raise exception 'Esta es la base de VanGUARD (accshmgmfrqrxubpuxcl), no vanguard-demo: no se siembra';
  end if;
end $$;
-- 1) SB_RLS_DISABLED (critical): tabla legible por anon sin RLS
create table public.pedidos (
  id bigint generated always as identity primary key,
  cliente text not null, producto text not null, monto numeric(10,2) not null,
  created_at timestamptz not null default now());
comment on table public.pedidos is 'VanGUARD demo: falla SIMULADA (RLS desactivada)';
alter table public.pedidos disable row level security;          -- por si el proyecto activa RLS por defecto
grant select on public.pedidos to anon;
insert into public.pedidos (cliente, producto, monto)
select 'Cliente Falso ' || g, 'Producto ' || (g % 7), (g % 90) + 10 from generate_series(1, 500) g;

-- 2) SB_POLICY_ALLOW_ALL (high): política pase-todo para anon
create table public.perfiles (
  id uuid primary key default gen_random_uuid(), user_id uuid, alias text, created_at timestamptz default now());
comment on table public.perfiles is 'VanGUARD demo: falla SIMULADA (politica using true)';
alter table public.perfiles enable row level security;
create policy "pase_todo" on public.perfiles for select to anon, authenticated using (true);
grant select on public.perfiles to anon, authenticated;
insert into public.perfiles (alias) select 'alias_falso_' || g from generate_series(1, 50) g;

-- 3) SB_RPC_ANON_NO_LIMIT (critical por nombre "otp"): función pública sin freno; NO envía nada
create table public.codigos_solicitados (
  id bigint generated always as identity primary key, destino text, created_at timestamptz default now());
alter table public.codigos_solicitados enable row level security;  -- sin políticas: nadie la lee por la API
create or replace function public.enviar_otp(p_destino text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  insert into public.codigos_solicitados (destino) values (left(p_destino, 100));  -- simulada: no manda correo ni SMS
end $$;
comment on function public.enviar_otp(text) is 'VanGUARD demo: falla SIMULADA (RPC sin freno)';
grant execute on function public.enviar_otp(text) to anon;

-- 4) P1 · SB_TABLE_BLOAT (high): ~30 MB con 60 % de filas muertas
create table public.eventos (
  id bigint generated always as identity primary key, tipo text, payload text, created_at timestamptz default now())
  with (autovacuum_enabled = false);
comment on table public.eventos is 'VanGUARD demo: falla SIMULADA (tabla hinchada)';
alter table public.eventos enable row level security;
insert into public.eventos (tipo, payload) select 'evento_falso', repeat('x', 100) from generate_series(1, 200000);
delete from public.eventos where id % 10 < 6;
