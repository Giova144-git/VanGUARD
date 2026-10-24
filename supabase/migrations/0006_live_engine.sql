-- 0006_live_engine.sql · literal de PLAN_MAESTRO §05.4 + vg_try_eval/vg_edge_window del Anexo A6 (canónicas §6)
-- + vg_ip_first_seen/vg_traffic de §15.12 (bloque «0006»).
create table if not exists public.edge_hits (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  ts timestamptz not null, ip inet not null,
  method text not null check (char_length(method) <= 10),
  path text not null check (char_length(path) <= 300 and position('?' in path) = 0),   -- nunca la query
  status smallint not null check (status between 100 and 599),
  ua text not null default '' check (char_length(ua) <= 200),
  latency_ms int not null check (latency_ms >= 0), auth boolean not null default false);
create index if not exists edge_hits_org_ts_idx on public.edge_hits (org_id, ts desc);
create index if not exists edge_hits_org_ip_ts_idx on public.edge_hits (org_id, ip, ts desc);   -- vg_upsert_incident, vg_ip_first_seen

create table if not exists public.edge_eval_state (
  org_id uuid primary key references public.orgs(id) on delete cascade, last_eval_at timestamptz not null);

create table if not exists public.metric_samples (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  metric text not null check (metric ~ '^[a-z0-9_.]{2,60}$'), ts timestamptz not null,   -- sb_cpu_pct, cf_req_5m (§15.7)
  value double precision not null, labels jsonb not null default '{}');
create index if not exists metric_samples_conn_idx on public.metric_samples (connection_id, metric, ts desc);
alter table public.edge_hits enable row level security;  alter table public.edge_eval_state enable row level security;
alter table public.metric_samples enable row level security;

-- Anexo A6: vg_try_eval evita evaluar si ya se evaluó hace < 5 s (devuelve null, no false, cuando no toca: el TS lo
-- trata como false) y vg_edge_window agrega por IP en 60 s.
create or replace function public.vg_try_eval(p_org uuid) returns boolean
language sql security definer set search_path = '' as $$
  insert into public.edge_eval_state as s (org_id, last_eval_at) values (p_org, now())
  on conflict (org_id) do update set last_eval_at = now()
    where s.last_eval_at < now() - interval '5 seconds'
  returning true $$;

create or replace function public.vg_edge_window(p_org uuid, p_seconds int default 60)
returns table (ip inet, n bigint, paths_4xx bigint, probe_hits bigint, admin_ok bigint, n5xx bigint,
               p95_ms double precision, ua_top text, total bigint)
language sql stable security definer set search_path = '' as $$
  select h.ip, count(*),
         count(distinct h.path) filter (where h.status in (403,404)),
         count(*) filter (where h.path ~ '^/(\.env|\.git/config|wp-login\.php|phpmyadmin|server-status)'),
         count(*) filter (where h.status between 200 and 399 and not h.auth
                            and h.path ~ '^/(admin|api/admin|wp-admin)(/|$)'),
         count(*) filter (where h.status >= 500),
         percentile_cont(0.95) within group (order by h.latency_ms),
         mode() within group (order by h.ua),
         sum(count(*)) over ()
  from public.edge_hits h
  where h.org_id = p_org and h.ts > now() - make_interval(secs => p_seconds)
  group by h.ip order by 2 desc limit 20 $$;

revoke all on function public.vg_try_eval(uuid), public.vg_edge_window(uuid, int) from public, anon, authenticated;
grant execute on function public.vg_try_eval(uuid), public.vg_edge_window(uuid, int) to service_role;

-- §15.12 «0006»: inicio del cronómetro (timeline.attack_start) y tráfico por cubetas de 10 s (E18)
create or replace function public.vg_ip_first_seen(p_org uuid, p_ip inet, p_seconds int default 120) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select min(h.ts) from public.edge_hits h where h.org_id = p_org and h.ip = p_ip and h.ts > now() - make_interval(secs => p_seconds) $$;

create or replace function public.vg_traffic(p_org uuid, p_seconds int default 300) returns jsonb
language sql stable security definer set search_path = '' as $$
  with w as (select h.ts, h.ip, h.status, h.ua from public.edge_hits h
              where h.org_id = p_org and h.ts > now() - make_interval(secs => least(greatest(p_seconds, 60), 3600))),
  b as (select date_bin('10 seconds', w.ts, timestamptz '2000-01-01') as t, count(*) as n,
               count(*) filter (where w.status between 400 and 499) as n4xx, count(*) filter (where w.status >= 500) as n5xx
          from w group by 1),
  t as (select jsonb_build_object('ip', host(w.ip), 'n', count(*), 'ua_top', mode() within group (order by w.ua)) as o, count(*) as c
          from w group by w.ip order by c desc limit 10)
  select jsonb_build_object('buckets', coalesce((select jsonb_agg(to_jsonb(b) order by b.t) from b), '[]'::jsonb),
                            'top_ips', coalesce((select jsonb_agg(t.o order by t.c desc) from t), '[]'::jsonb)) $$;

revoke all on function public.vg_ip_first_seen(uuid, inet, int), public.vg_traffic(uuid, int) from public, anon, authenticated;
grant execute on function public.vg_ip_first_seen(uuid, inet, int), public.vg_traffic(uuid, int) to service_role;
