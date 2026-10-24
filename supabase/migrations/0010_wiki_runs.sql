-- 0010_wiki_runs.sql · DeepWiki «Wiki del repo» (E40–E44 y los pasos 'wiki' de vg-jobs; packages/deepwiki/LEEME.md,
-- «Integración en el BACK»). Una fila por corrida. Llave de la caché: (org_id, repo_full_name, commit_sha, huella), con
-- huella = huellaHallazgos(hallazgos de la auditoría) y null si ese repo no se auditó. Una corrida servida desde la caché
-- es otra fila cached = true, ya succeeded, con el doc copiado y costo 0.
create table if not exists public.wiki_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid references public.connections(id) on delete set null,   -- PAT de GitHub para repos privados (solo el id)
  requested_by uuid references auth.users(id) on delete set null,
  repo_full_name text not null check (repo_full_name ~ '^[A-Za-z0-9-]{1,39}/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$'),   -- RepoFullName
  branch text,
  commit_sha text check (commit_sha ~ '^[0-9a-f]{40}$'),
  huella text check (huella ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  progress smallint not null default 0 check (progress between 0 and 100),
  steps jsonb not null default '[]' check (jsonb_typeof(steps) = 'array'),   -- WikiRunStep[]: arbol, triage, area, sintesis, fin
  est_usd numeric check (est_usd >= 0),
  max_usd numeric not null default 1 check (max_usd > 0 and max_usd <= 5),   -- tope que aceptó el usuario (WikiRunCreate)
  cost_usd numeric not null default 0 check (cost_usd >= 0),
  models jsonb not null default '{}',
  cached boolean not null default false,
  error text check (char_length(error) <= 300),
  state jsonb,                            -- EstadoWiki del motor: rutas, resúmenes y consumo, nunca el código leído
  doc jsonb,                              -- WikiDoc sin run_id (lo pone E44 con el id de la fila)
  -- Sin columna de «síntesis en curso»: la marca vive en state.sintesis_iniciada (LEEME, punto 5) y va con el CAS.
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz,
  -- Último avance (lo pone vg_wiki_avanzar): una corrida en curso que lleva 4 h sin avanzar es de un Worker perdido y E41
  -- la cierra antes de crear otra igual (wiki/corridas.ts, SIN_AVANCE_MS).
  updated_at timestamptz not null default now(),
  check (not cached or status = 'succeeded'),
  check (not private.looks_like_secret(error)));
create index if not exists wiki_runs_org_repo_created_idx on public.wiki_runs (org_id, repo_full_name, created_at desc);   -- E43
create index if not exists wiki_runs_cache_idx on public.wiki_runs (org_id, repo_full_name, commit_sha, huella)
  where status = 'succeeded';                                                                                               -- E40 y E41
-- Una sola corrida en curso por llave: dos E41 iguales a la vez (doble clic, dos pestañas, un reintento del front) no
-- pagan dos veces la misma wiki; el segundo insert falla con 23505 y E41 devuelve la que ganó. commit_sha null no choca
-- (E41 siempre lo pone).
create unique index if not exists wiki_runs_en_curso_uidx on public.wiki_runs (org_id, repo_full_name, commit_sha, coalesce(huella, ''))
  where status in ('queued', 'running');

-- Solo el Worker (service_role) la lee y la escribe; RLS sin políticas (decisión (a): los datos van por /api).
alter table public.wiki_runs enable row level security;
revoke all on public.wiki_runs from anon, authenticated;
grant select, insert, update, delete on public.wiki_runs to service_role;

-- Avance de un paso 'wiki' de la cola (LEEME, punto 4): compare-and-set sobre state.n, así dos entregas del mismo mensaje
-- no se pisan. Solo toca una corrida en curso de ESA org. p_state null deja el estado como está. p_patch admite status,
-- progress (nunca baja), steps, cost_usd, commit_sha, branch, error, doc, est_usd y models; una clave ausente no cambia
-- la columna. huella solo se admite al cerrar (status succeeded o failed): la de los hallazgos que de verdad recibió la
-- síntesis, para que el doc quede bajo su llave (en curso chocaría con wiki_runs_en_curso_uidx). started_at se fija al
-- pasar a running, finished_at al cerrar y updated_at en cada avance. true = actualizó la fila.
create or replace function public.vg_wiki_avanzar(p_run uuid, p_org uuid, p_n int, p_state jsonb, p_patch jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v jsonb := coalesce(p_patch, '{}'::jsonb);
  v_status text;
  n int;
begin
  if jsonb_typeof(v) <> 'object' then return false; end if;
  v_status := v->>'status';
  update public.wiki_runs w
     set state       = coalesce(nullif(p_state, 'null'::jsonb), w.state),
         status      = coalesce(v_status, w.status),
         progress    = least(100, greatest(w.progress, coalesce((v->>'progress')::smallint, w.progress))),
         steps       = case when jsonb_typeof(v->'steps') = 'array' then v->'steps' else w.steps end,
         cost_usd    = coalesce((v->>'cost_usd')::numeric, w.cost_usd),
         commit_sha  = case when v ? 'commit_sha' then v->>'commit_sha' else w.commit_sha end,
         branch      = case when v ? 'branch' then v->>'branch' else w.branch end,
         error       = case when v ? 'error' then left(v->>'error', 300) else w.error end,
         doc         = case when v ? 'doc' then nullif(v->'doc', 'null'::jsonb) else w.doc end,
         est_usd     = case when v ? 'est_usd' then (v->>'est_usd')::numeric else w.est_usd end,
         models      = case when jsonb_typeof(v->'models') = 'object' then v->'models' else w.models end,
         huella      = case when v ? 'huella' and v_status in ('succeeded', 'failed') then v->>'huella' else w.huella end,
         updated_at  = now(),
         started_at  = case when v_status = 'running' then coalesce(w.started_at, now()) else w.started_at end,
         finished_at = case when v_status in ('succeeded', 'failed') then coalesce(w.finished_at, now()) else w.finished_at end
   where w.id = p_run and w.org_id = p_org
     and coalesce((w.state->>'n')::int, 0) = p_n
     and w.status in ('queued', 'running');
  get diagnostics n = row_count;
  return n = 1;
end $$;

revoke all on function public.vg_wiki_avanzar(uuid, uuid, int, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.vg_wiki_avanzar(uuid, uuid, int, jsonb, jsonb) to service_role;

-- Rutas de IA de la wiki (deepwiki Tarea): ai_usage las registra vía llamarIA (ia/claude.ts) con sus topes.
alter table public.ai_usage drop constraint if exists ai_usage_route_check;
alter table public.ai_usage add constraint ai_usage_route_check
  check (route in ('fix_prompt','audit_summary','alert_text','triage','wiki_triage','wiki_area','wiki_sintesis'));
