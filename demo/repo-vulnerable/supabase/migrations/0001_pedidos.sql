-- Falla SIMULADA para la demo: tabla pública sin RLS (espejo de SB_RLS_DISABLED; aquí la ve CB_SQL_NO_RLS, P2).
create table public.pedidos (
  id bigint generated always as identity primary key,
  cliente text not null,
  producto text not null,
  monto numeric(10, 2) not null,
  created_at timestamptz not null default now()
);

-- Sin RLS y legible por anon: cualquiera lee todos los pedidos.
alter table public.pedidos disable row level security;
grant select on public.pedidos to anon;
