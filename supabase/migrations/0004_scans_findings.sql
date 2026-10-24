-- 0004_scans_findings.sql · literal de PLAN_MAESTRO §05.4 + vg_upsert_findings y vg_claim_step de §15.12 (bloque «0004»).
create table if not exists public.scan_runs (
  id uuid primary key default gen_random_uuid(),          -- viaja en cada mensaje de la cola de pasos (A7.2); id de vg-scan solo en la alternativa Workflow
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null check (kind in ('full_audit','supabase','cloudflare','repo','zip','lighthouse')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  progress smallint not null default 0 check (progress between 0 and 100),
  step text check (char_length(step) <= 40), params jsonb not null default '{}',
  steps jsonb not null default '[]' check (jsonb_typeof(steps) = 'array'),   -- ScanRun.steps de §15.5: [{name,status,findings?,error_code?}]
  summary jsonb,                                          -- salida de IA-2 audit_summary
  score smallint check (score between 0 and 100),
  coverage jsonb,                                         -- {"seen":3,"total":4,"missing":["performance"]}
  error text check (char_length(error) <= 200),
  requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz,
  check (not private.looks_like_secret(params::text || ' ' || coalesce(summary::text, '') || ' ' || coalesce(error, ''))));
create index if not exists scan_runs_org_created_idx on public.scan_runs (org_id, created_at desc);   -- tope 3 auditorías/día

create table if not exists public.findings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  scan_run_id uuid references public.scan_runs(id) on delete set null,
  connection_id uuid references public.connections(id) on delete set null,   -- revocar no borra el historial
  module text not null check (module in ('supabase','cloudflare','codebase','performance')),
  rule_id text not null check (rule_id ~ '^(SB|CF|CB|PF)_[A-Z0-9_]+$'),
  severity text not null check (severity in ('critical','high','medium','low','info')),
  severity_rank smallint generated always as (case severity when 'critical' then 5 when 'high' then 4
                 when 'medium' then 3 when 'low' then 2 else 1 end) stored,     -- para .order() en PostgREST
  confirmed boolean not null default false,
  origin text not null default 'rule' check (origin in ('rule','ai','provider')),
  title text not null check (char_length(title) <= 200), resource text not null check (char_length(resource) <= 300),
  evidence jsonb not null default '{}' check (octet_length(evidence::text) <= 16384),   -- SIEMPRE redactada
  fix_prompt text check (char_length(fix_prompt) <= 20000), fix_model text,
  status text not null default 'open' check (status in ('open','fixed','verified','ignored')),
  status_reason text check (char_length(status_reason) <= 300),
  suspected_injection boolean not null default false,
  dedupe_key text not null check (dedupe_key ~ '^[0-9a-f]{64}$'),
  first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  verified_at timestamptz,
  unique (org_id, dedupe_key),
  check (not private.looks_like_secret(evidence::text || ' ' || title || ' ' || resource || ' ' || coalesce(fix_prompt, ''))));
create index if not exists findings_org_open_idx on public.findings (org_id, status, severity_rank desc);
create index if not exists findings_scan_idx on public.findings (scan_run_id);
alter table public.scan_runs enable row level security;
alter table public.findings enable row level security;

-- §15.12 «0004»: hallazgos con reapertura y auto-verificación. p_complete = true solo si corrieron TODAS las reglas del paso.
-- p_conn = conexión auditada (null en ZIP): la auto-verificación solo toca hallazgos de esa misma conexión.
-- El paso zip llama siempre con p_complete = false (un ZIP suelto no prueba que algo se arregló, y los hallazgos
-- de una conexión borrada también tienen connection_id null).
create or replace function public.vg_upsert_findings(p_org uuid, p_scan uuid, p_module text, p_conn uuid, p_rows jsonb,
  p_complete boolean, p_rule text default null) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into public.findings as f (org_id, scan_run_id, connection_id, module, rule_id, severity, confirmed, origin,
                                    title, resource, evidence, dedupe_key, suspected_injection)
  select distinct on (r->>'dedupe_key')        -- dos filas con la misma clave en un lote darían 21000 en ON CONFLICT
         p_org, p_scan, p_conn, p_module, r->>'rule_id', r->>'severity', coalesce((r->>'confirmed')::boolean, false),
         coalesce(r->>'origin', 'rule'), r->>'title', r->>'resource', coalesce(r->'evidence', '{}'::jsonb), r->>'dedupe_key',
         coalesce((r->>'suspected_injection')::boolean, false)
    from jsonb_array_elements(p_rows) r
   order by r->>'dedupe_key'
  on conflict (org_id, dedupe_key) do update set
    scan_run_id = excluded.scan_run_id, severity = excluded.severity, confirmed = excluded.confirmed, title = excluded.title,
    evidence = excluded.evidence, last_seen_at = now(),
    fix_prompt = case when f.evidence is distinct from excluded.evidence then null else f.fix_prompt end,   -- §11.4: la caché vale mientras la evidencia no cambie
    fix_model  = case when f.evidence is distinct from excluded.evidence then null else f.fix_model end,
    status        = case when f.status in ('fixed', 'verified') then 'open' else f.status end,        -- 'ignored' se respeta
    status_reason = case when f.status in ('fixed', 'verified') then 'reapareció' else f.status_reason end,
    verified_at   = case when f.status in ('fixed', 'verified') then null else f.verified_at end;
  get diagnostics n = row_count;
  if p_complete then
    update public.findings g set status = 'verified', verified_at = now(), status_reason = 'no reapareció en la auditoría'
     where g.org_id = p_org and g.module = p_module and g.status in ('open', 'fixed')
       and g.connection_id is not distinct from p_conn
       and g.scan_run_id is distinct from p_scan and (p_rule is null or g.rule_id = p_rule);
  end if;
  return n;
end $$;

-- §15.12 «0004» (A7.2): reclama un paso de la cola vg-jobs (15.8 regla 2).
-- true = esta invocación ejecuta el paso. p_paso es el nombre en steps[] (psi-<strategy> → 'psi').
-- El UPDATE bloquea la fila: de dos entregas simultáneas del mismo mensaje, solo una ve 'pending'.
create or replace function public.vg_claim_step(p_scan uuid, p_paso text, p_retomar boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.scan_runs s
     set status = 'running', step = p_paso, started_at = coalesce(s.started_at, now()),
         steps = (select jsonb_agg(case when e->>'name' = p_paso then e || '{"status":"running"}'::jsonb else e end order by o)
                    from jsonb_array_elements(s.steps) with ordinality as t(e, o))
   where s.id = p_scan and s.status in ('queued', 'running')
     and exists (select 1 from jsonb_array_elements(s.steps) x
                  where x->>'name' = p_paso and (x->>'status' = 'pending' or (p_retomar and x->>'status' = 'running')));
  get diagnostics n = row_count;
  return n = 1;
end $$;

revoke all on function public.vg_upsert_findings(uuid, uuid, text, uuid, jsonb, boolean, text),
  public.vg_claim_step(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.vg_upsert_findings(uuid, uuid, text, uuid, jsonb, boolean, text),
  public.vg_claim_step(uuid, text, boolean) to service_role;
