-- 0007_ai_config_perf.sql · literal de PLAN_MAESTRO §05.4; al final, los bloques literales de §10.5 (columnas de
-- perf_runs y vista perf_points) y de §11.8 (vg_ai_status y vg_ai_settle).
create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete set null,       -- el libro de gasto sobrevive a la org
  route text not null check (route in ('fix_prompt','audit_summary','alert_text','triage')),   -- triage: P2 reservado (§11.1)
  model text not null check (model ~ '^claude-[a-z0-9.-]{2,60}$'),  -- el pedido al reservar (§11.8); admite cualquier claude-*
                                                                    -- por si se guarda el servido por fallbacks:"default" (§8)
  input_tokens int not null default 0, cache_read int not null default 0, cache_write int not null default 0,
  output_tokens int not null default 0, cost_usd numeric(12,6) not null check (cost_usd >= 0),
  stop_reason text,          -- 'reserved' en curso; luego end_turn, max_tokens, refusal, error_4xx (costo 0), error_transient
  refusal_category text, request_id text, created_at timestamptz not null default now());
create index if not exists ai_usage_created_idx on public.ai_usage (created_at);
create index if not exists ai_usage_org_idx on public.ai_usage (org_id, created_at);

create table if not exists public.app_config (
  key text primary key check (key ~ '^[a-z_]{2,40}$'), value jsonb not null, updated_at timestamptz not null default now());
insert into public.app_config (key, value) values
  ('ia_habilitada', 'true'),
  ('topes', '{"global_usd_day":40,"demo_usd_day":10,"org_usd_day":1.5,"org_audits_day":3}'),
  ('kek_active', '"v1"')                                            -- añadido para la rotación de 05.8
on conflict (key) do nothing;

create table if not exists public.perf_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  url text not null check (url ~ '^https://[a-z0-9.-]+(/[^?#[:space:]]*)?$'),
  strategy text not null check (strategy in ('mobile','desktop')),
  source text not null default 'psi' check (source = 'psi'), lighthouse_version text,
  scores jsonb not null default '{}',     -- {"performance":0.62,"accessibility":0.91,"best-practices":0.96,"seo":0.9} (ids de PSI)
  metrics jsonb not null default '{}',    -- {"lcp_ms":..,"tbt_ms":..,"cls":..,"fcp_ms":..,"si_ms":..,"ttfb_ms":..}
  created_at timestamptz not null default now());   -- = lighthouseResult.fetchTime
create index if not exists perf_runs_org_url_idx on public.perf_runs (org_id, url, strategy, created_at desc);
alter table public.ai_usage enable row level security;  alter table public.app_config enable row level security;
alter table public.perf_runs enable row level security;

-- Reserva del peor caso ANTES de llamar a Claude (§8 y §11). Serializa con un candado de transacción para que dos
-- llamadas simultáneas no se salten el tope. vg_ai_settle (§11.8) liquida después la misma fila con el uso y costo reales;
-- una fila que se queda en 'reserved' (proceso caído) cuenta por su peor caso: conservador, sin cron.
-- Nunca lanza: devuelve {ok:false, code:'disabled'|'budget', scope} (contrato de §15.10) o {ok:true, usage_id, global_pct}.
-- scope 'request' (peor caso > 1 USD) y 'rate' (≥ 10 reservas en 60 s por org) repiten DENTRO del candado las comprobaciones
-- que llamarIA hace antes (§11.8): así una ráfaga en paralelo tampoco se cuela.
create or replace function public.vg_ai_reserve(p_org uuid, p_route text, p_model text, p_worst_usd numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_day timestamptz := date_trunc('day', now() at time zone 'America/Caracas') at time zone 'America/Caracas';
  v_topes jsonb; v_on boolean; v_global numeric; v_org numeric; v_min int; v_demo boolean; v_cap numeric; v_lim numeric; v_id uuid;
begin
  if p_worst_usd is null or p_worst_usd <= 0 or p_worst_usd > 1 then          -- una sola llamada nunca pasa de 1 USD (§11.8)
    return jsonb_build_object('ok', false, 'code', 'budget', 'scope', 'request'); end if;
  perform pg_advisory_xact_lock(hashtext('vg_ai_budget'));
  select value into v_topes from public.app_config where key = 'topes';
  select (value #>> '{}')::boolean into v_on from public.app_config where key = 'ia_habilitada';
  if not coalesce(v_on, false) then return jsonb_build_object('ok', false, 'code', 'disabled'); end if;
  select is_demo, ai_daily_cap_usd into v_demo, v_cap from public.orgs where id = p_org;
  if not found then return jsonb_build_object('ok', false, 'code', 'budget', 'scope', 'org'); end if;
  select coalesce(sum(cost_usd), 0) into v_global from public.ai_usage where created_at >= v_day;
  select coalesce(sum(cost_usd), 0), count(*) filter (where created_at > now() - interval '60 seconds')
    into v_org, v_min from public.ai_usage where created_at >= v_day and org_id = p_org;
  v_lim := case when v_demo then coalesce((v_topes->>'demo_usd_day')::numeric, 0)          -- sin tope configurado → 0 (sin IA), nunca «sin límite»
                else least(coalesce(v_cap, 1.5), coalesce((v_topes->>'org_usd_day')::numeric, 0)) end;
  if v_global + p_worst_usd > coalesce((v_topes->>'global_usd_day')::numeric, 0)
     then return jsonb_build_object('ok', false, 'code', 'budget', 'scope', 'global'); end if;
  if v_org + p_worst_usd > v_lim then return jsonb_build_object('ok', false, 'code', 'budget', 'scope', 'org'); end if;
  if v_min >= 10 then return jsonb_build_object('ok', false, 'code', 'budget', 'scope', 'rate'); end if;   -- 10/min/org [propuesta §11.8]
  insert into public.ai_usage (org_id, route, model, cost_usd, stop_reason)
  values (p_org, p_route, p_model, p_worst_usd, 'reserved') returning id into v_id;
  return jsonb_build_object('ok', true, 'usage_id', v_id,
    'global_pct', round(100 * (v_global + p_worst_usd) / (v_topes->>'global_usd_day')::numeric, 1));
end $$;

revoke all on function public.vg_ai_reserve(uuid, text, text, numeric) from public, anon, authenticated;
grant execute on function public.vg_ai_reserve(uuid, text, text, numeric) to service_role;

-- §10.5 (final, BACK): columnas añadidas por §10 sobre el perf_runs de §5
alter table public.perf_runs
  add column if not exists scan_run_id uuid references public.scan_runs(id) on delete set null,  -- null en el sembrado
  add column if not exists run_group uuid not null default gen_random_uuid(),  -- repeticiones de una medición: uuidFrom(scan_run_id|strategy);
                                                                               -- el default cubre la siembra manual de §5 (cada fila, su propio grupo, n=1)
  add column if not exists rep smallint not null default 1 check (rep between 1 and 5),
  add column if not exists is_representative boolean not null default false, -- la más cercana a la mediana; solo ella lleva diagnosis
  add column if not exists trigger text not null default 'manual' check (trigger in ('manual','deploy','schedule','seed')),
  add column if not exists version_label text check (version_label ~ '^[A-Za-z0-9_.-]{1,40}$'),
  add column if not exists commit_sha text check (commit_sha ~ '^[0-9a-f]{7,40}$'),
  add column if not exists final_url text,
  add column if not exists runtime_error text,     -- p. ej. NO_FCP; no entra en medianas
  add column if not exists diagnosis jsonb,        -- PerfDiagnosis (§10.7), ≤ 8 KB, redactada
  add column if not exists field jsonb;            -- loadingExperience.metrics si existe
create index if not exists perf_runs_group_idx on public.perf_runs (run_group);

-- Un punto del gráfico = una medición (mediana de sus repeticiones válidas). 0008 revoca anon sobre todas las tablas y vistas de public.
create or replace view public.perf_points with (security_invoker = true) as
select run_group, org_id, url, strategy, min(created_at) as at,
       max(version_label) as version_label, max(commit_sha) as commit_sha, max(trigger) as trigger,
       max(lighthouse_version) as lighthouse_version, count(*)::int as n,
       round(100 * percentile_cont(0.5) within group (order by (scores->>'performance')::numeric))::int as perf_score,
       percentile_cont(0.5) within group (order by (metrics->>'lcp_ms')::numeric)  as lcp_ms,
       percentile_cont(0.5) within group (order by (metrics->>'tbt_ms')::numeric)  as tbt_ms,
       percentile_cont(0.5) within group (order by (metrics->>'cls')::numeric)     as cls,
       percentile_cont(0.5) within group (order by (metrics->>'fcp_ms')::numeric)  as fcp_ms,
       percentile_cont(0.5) within group (order by (metrics->>'si_ms')::numeric)   as si_ms,
       percentile_cont(0.5) within group (order by (metrics->>'ttfb_ms')::numeric) as ttfb_ms,
       percentile_cont(0.5) within group (order by (metrics->>'script_bytes')::numeric) as script_bytes
from public.perf_runs where runtime_error is null
group by run_group, org_id, url, strategy;

-- §11.8 (fragmento S11, al final del archivo)
create or replace function public.vg_ai_status(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_desde timestamptz := date_trunc('day', now() at time zone 'America/Caracas') at time zone 'America/Caracas';
  v_on boolean := coalesce((select (c.value #>> '{}')::boolean from public.app_config c where c.key = 'ia_habilitada'), false);
  v_topes jsonb := coalesce((select c.value from public.app_config c where c.key = 'topes'), '{}'::jsonb);
  v_cap_glob numeric := coalesce((v_topes->>'global_usd_day')::numeric, 0);
  v_cap_org numeric; v_hoy_org numeric; v_hoy_glob numeric; v_min int; v_pct numeric;
begin
  -- mismo tope por org que vg_ai_reserve (sección 5): demo → demo_usd_day; resto → least(ai_daily_cap_usd, org_usd_day)
  select case when o.is_demo then (v_topes->>'demo_usd_day')::numeric
              else least(coalesce(o.ai_daily_cap_usd, 1.5), (v_topes->>'org_usd_day')::numeric) end
    into v_cap_org from public.orgs o where o.id = p_org;
  select coalesce(sum(u.cost_usd), 0) into v_hoy_glob from public.ai_usage u where u.created_at >= v_desde;
  select coalesce(sum(u.cost_usd), 0), count(*) filter (where u.created_at > now() - interval '60 seconds')
    into v_hoy_org, v_min from public.ai_usage u where u.org_id = p_org and u.created_at >= v_desde;
  v_pct := greatest(case when coalesce(v_cap_org, 0) > 0 then v_hoy_org / v_cap_org else 1 end,
                    case when v_cap_glob > 0 then v_hoy_glob / v_cap_glob else 1 end);
  return jsonb_build_object('enabled', v_on, 'today_usd', round(v_hoy_org, 4), 'cap_usd', coalesce(v_cap_org, 0),
    'calls_1m', v_min,
    'level', case when not v_on or v_pct >= 1 then 'off' when v_pct >= 0.9 then 'minimal'
                  when v_pct >= 0.7 then 'reduced' else 'normal' end);
end $$;

-- Liquidación: el modelo ya quedó en la reserva (plan.model, por el check de la sección 5); null en tokens = 0.
create or replace function public.vg_ai_settle(p_id uuid, p_input int, p_cache_read int, p_cache_write int,
  p_output int, p_cost numeric, p_stop text, p_refusal text, p_request_id text) returns void
language sql security definer set search_path = '' as $$
  update public.ai_usage
     set input_tokens = coalesce(p_input, 0), cache_read = coalesce(p_cache_read, 0),
         cache_write = coalesce(p_cache_write, 0), output_tokens = coalesce(p_output, 0),
         cost_usd = coalesce(p_cost, cost_usd),                       -- null = conservar el peor caso reservado
         stop_reason = p_stop, refusal_category = p_refusal, request_id = p_request_id
   where id = p_id and stop_reason = 'reserved' $$;

revoke all on function public.vg_ai_status(uuid),
  public.vg_ai_settle(uuid, int, int, int, int, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public.vg_ai_status(uuid),
  public.vg_ai_settle(uuid, int, int, int, int, numeric, text, text, text) to service_role;
