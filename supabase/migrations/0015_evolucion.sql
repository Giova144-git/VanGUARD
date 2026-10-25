-- 0015_evolucion.sql · Evolución entre revisiones (docs/plan_maestro_trabajo/asignaciones/evolucion-entre-revisiones.md
-- §3). Dos fotos del estado de los hallazgos: una al cerrar cada auditoría (paso puntaje, todos los módulos) y otra de
-- Codebase al cerrar cada revisión de push (paso diff). Frente a la foto anterior de la org: qué es nuevo, qué se
-- mantiene, qué se corrigió, qué se ignoró y qué ya no existe. Una foto no se rehace: si el paso se repite, se devuelve
-- la que hay. audit_snapshots es solo del servidor (RLS sin políticas y sin grants a anon/authenticated, como 0008h y
-- 0013) y sin trigger de Realtime. No toca findings, scan_runs ni vg_upsert_findings; a code_reviews le suma tres
-- columnas nulas (snap_at, snap_open_ids, delta) que solo escribe vg_review_snapshot. «Corregido» sale de comparar ids,
-- no de scan_run_id. Va ANTES del Worker que pide code_reviews.delta en E45 (sin la columna, PostgREST rechaza la
-- consulta entera). Prueba: supabase/tests/evolucion.sql (pegada detrás, «RESULTADO OK …»).

-- 1) Una foto por auditoría. Se borra con su scan_runs (retención de 90 días de 0008). prev_scan_run_id queda null si la
-- anterior se borra: el delta ya está guardado (ids y conteos).
create table if not exists public.audit_snapshots (
  scan_run_id uuid primary key references public.scan_runs(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null check (kind in ('full_audit','supabase','cloudflare','repo','zip')),
  taken_at timestamptz not null default now(),
  modules_seen text[] not null
    check (cardinality(modules_seen) between 1 and 4
           and modules_seen <@ array['supabase','cloudflare','codebase','performance']::text[]),
  open_ids uuid[] not null default '{}' check (cardinality(open_ids) <= 20000),
  prev_scan_run_id uuid references public.scan_runs(id) on delete set null,
  is_first boolean not null,
  new_ids uuid[] not null default '{}',
  fixed_ids uuid[] not null default '{}',
  ignored_ids uuid[] not null default '{}',
  moved int not null default 0 check (moved >= 0),
  gone int not null default 0 check (gone >= 0),
  counts jsonb not null check (counts ?& array['open','new','kept','fixed','ignored']),
  fixed_checked int not null default 0 check (fixed_checked >= 0));
create index if not exists audit_snapshots_org_taken_idx on public.audit_snapshots (org_id, taken_at desc);

-- 2) Foto de Codebase de cada revisión de push. snap_open_ids = hallazgos de Codebase abiertos de TODA la org al cerrar
-- el diff (los de push van con connection_id null: con varios repos no se pueden separar por repo). delta = lo que leen
-- E45 y E52 (CodeReviewDelta del contrato). El anterior se busca entre las revisiones de la org
-- (code_reviews_org_created_idx): sin índice nuevo.
alter table public.code_reviews add column if not exists snap_at timestamptz;
alter table public.code_reviews add column if not exists snap_open_ids uuid[] check (cardinality(snap_open_ids) <= 20000);
alter table public.code_reviews add column if not exists delta jsonb check (jsonb_typeof(delta) = 'object');

-- 3) Piezas sin security definer: solo las llaman las RPC de abajo, que ya corren como dueño.
-- Hora con Z, como iso() del Worker (S15 15.3): el JSON sale tal cual hacia el FRONT.
create or replace function private.vg_iso(t timestamptz) returns text
language sql stable strict set search_path = '' as $$
  select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- Reglas de claves: que ya no estén en el código no prueba que se rotaron. No cuentan como «comprobado» ni en el tiempo
-- hasta comprobar.
create or replace function private.vg_es_clave(p_rule text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(starts_with(p_rule, 'CB_SECRET_') or p_rule = 'CB_ENV_COMMITTED', false)
$$;

-- Módulos cuyo paso quedó done (repo y zip → codebase).
create or replace function private.vg_modulos_vistos(p_steps jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct case x->>'name' when 'repo' then 'codebase' when 'zip' then 'codebase'
                                                   else x->>'name' end), '{}')
    from jsonb_array_elements(case when jsonb_typeof(p_steps) = 'array' then p_steps else '[]'::jsonb end) x
   where x->>'status' = 'done' and x->>'name' in ('supabase', 'cloudflare', 'repo', 'zip')
$$;

-- Conteo por módulo × severidad de unos ids (las 4 × 5 claves, aunque valgan 0). Severidad de ahora. Las filas borradas
-- no cuentan (por eso gone va aparte y nunca dentro de estos ids).
create or replace function private.vg_matriz(p_org uuid, p_ids uuid[]) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_object_agg(t.module, t.c) from (
    select m.module, jsonb_build_object(
             'critical', count(f.id) filter (where f.severity = 'critical'),
             'high',     count(f.id) filter (where f.severity = 'high'),
             'medium',   count(f.id) filter (where f.severity = 'medium'),
             'low',      count(f.id) filter (where f.severity = 'low'),
             'info',     count(f.id) filter (where f.severity = 'info')) as c
      from (values ('supabase'), ('cloudflare'), ('codebase'), ('performance')) as m(module)
      left join public.findings f on f.org_id = p_org and f.module = m.module and f.id = any(p_ids)
     group by m.module) t
$$;

-- Lista de E51: total y los p_lim primeros en el orden de E13, con el estado de AHORA. Sin evidencia.
create or replace function private.vg_lista_delta(p_org uuid, p_ids uuid[], p_lim int) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('total', coalesce(cardinality(p_ids), 0), 'items', coalesce((
    select jsonb_agg(jsonb_build_object('finding_id', f.id, 'module', f.module, 'rule_id', f.rule_id,
             'severity', f.severity, 'title', f.title, 'resource', f.resource, 'status', f.status)
             order by f.severity_rank desc, f.confirmed desc, f.last_seen_at desc, f.id)
      from (select g.id, g.module, g.rule_id, g.severity, g.title, g.resource, g.status, g.severity_rank, g.confirmed,
                   g.last_seen_at
              from public.findings g where g.org_id = p_org and g.id = any(p_ids)
             order by g.severity_rank desc, g.confirmed desc, g.last_seen_at desc, g.id limit p_lim) f), '[]'::jsonb))
$$;

-- La resta de conjuntos (§2.1), la misma para auditorías y pushes. p_prev = abiertos de la foto anterior; p_open =
-- abiertos ahora. Los que salieron se parten por su estado de ahora: fixed o verified → corregidos; ignored →
-- ignorados; fila borrada → gone (ni corregido ni ignorado). moved: la misma clave (regla + huella) salió de un sitio
-- (fixed o verified) y entró en otro, porque cambió de línea: se emparejan 1 a 1 y cuentan como «se mantiene», nunca
-- como nuevo ni como corregido. checked: corregidos verified que no son claves.
create or replace function private.vg_restar(p_org uuid, p_prev uuid[], p_open uuid[], out o_new uuid[],
  out o_fixed uuid[], out o_ignored uuid[], out o_moved int, out o_gone int, out o_checked int)
language sql stable set search_path = '' as $$
  with salen as (
    select g.id, f.status, f.rule_id, f.evidence->>'fingerprint_short' as fp
      from unnest(array(select unnest(p_prev) except select unnest(p_open))) as g(id)
      left join public.findings f on f.id = g.id and f.org_id = p_org),
  entran as (
    select g.id, f.rule_id, f.evidence->>'fingerprint_short' as fp
      from unnest(array(select unnest(p_open) except select unnest(p_prev))) as g(id)
      left join public.findings f on f.id = g.id and f.org_id = p_org),
  s as (select x.id, x.rule_id, x.fp, row_number() over (partition by x.rule_id, x.fp order by x.id) as n
          from salen x where x.fp is not null and x.status in ('fixed', 'verified')),
  e as (select x.id, x.rule_id, x.fp, row_number() over (partition by x.rule_id, x.fp order by x.id) as n
          from entran x where x.fp is not null),
  pares as (select s.id as sale, e.id as entra from s join e on e.rule_id = s.rule_id and e.fp = s.fp and e.n = s.n)
  select coalesce((select array_agg(x.id order by x.id) from entran x
                    where not exists (select 1 from pares p where p.entra = x.id)), '{}'),
         coalesce((select array_agg(x.id order by x.id) from salen x where x.status in ('fixed', 'verified')
                    and not exists (select 1 from pares p where p.sale = x.id)), '{}'),
         coalesce((select array_agg(x.id order by x.id) from salen x where x.status = 'ignored'), '{}'),
         (select count(*)::int from pares),
         (select count(*)::int from salen x where x.status is null),
         (select count(*)::int from salen x where x.status = 'verified' and not private.vg_es_clave(x.rule_id)
             and not exists (select 1 from pares p where p.sale = x.id))
$$;

-- 4) La foto de una auditoría (paso puntaje). Candado por org: dos auditorías que cierran a la vez no se comparan con
-- una foto a medias. taken_at = clock_timestamp() DESPUÉS del candado: siempre posterior a la foto anterior.
create or replace function public.vg_snapshot_audit(p_org uuid, p_scan uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
  v_steps jsonb;
  v_seen text[];
  v_at timestamptz;
  v_open uuid[];
  v_prev uuid;
  v_prev_open uuid[];
  v_new uuid[] := '{}';
  v_kept uuid[] := '{}';
  v_fixed uuid[] := '{}';
  v_ign uuid[] := '{}';
  v_moved int := 0;
  v_gone int := 0;
  v_checked int := 0;
  a public.audit_snapshots%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('vg_snap|' || p_org::text));
  select s.kind, s.steps into v_kind, v_steps from public.scan_runs s where s.id = p_scan and s.org_id = p_org;
  if v_kind is null or v_kind = 'lighthouse' then
    return jsonb_build_object('applied', false, 'reason', 'scan');
  end if;
  -- Una foto no se rehace: un reintento de puntaje o finalizar devuelven la que hay. Ninguna foto cambia después de que
  -- otra la tomó como anterior.
  select * into a from public.audit_snapshots x where x.scan_run_id = p_scan;
  if a.scan_run_id is not null then
    return jsonb_build_object('applied', true, 'repeated', true, 'first', a.is_first, 'open', cardinality(a.open_ids),
      'new', cardinality(a.new_ids),
      'kept', case when a.is_first then 0 else cardinality(a.open_ids) - cardinality(a.new_ids) end,
      'fixed', cardinality(a.fixed_ids), 'ignored', cardinality(a.ignored_ids), 'moved', a.moved, 'gone', a.gone);
  end if;
  v_seen := private.vg_modulos_vistos(v_steps);
  if cardinality(v_seen) = 0 then
    return jsonb_build_object('applied', false, 'reason', 'sin_modulos');   -- nunca una versión sin mirar nada
  end if;
  v_at := clock_timestamp();
  select coalesce(array_agg(f.id order by f.id), '{}') into v_open
    from public.findings f where f.org_id = p_org and f.status = 'open';
  select x.scan_run_id, x.open_ids into v_prev, v_prev_open from public.audit_snapshots x
   where x.org_id = p_org order by x.taken_at desc, x.scan_run_id desc limit 1;
  if v_prev is not null then
    select r.o_new, r.o_fixed, r.o_ignored, r.o_moved, r.o_gone, r.o_checked
      into v_new, v_fixed, v_ign, v_moved, v_gone, v_checked
      from private.vg_restar(p_org, v_prev_open, v_open) r;
    v_kept := array(select unnest(v_open) except select unnest(v_new));   -- incluye las claves que cambiaron de línea
  end if;
  insert into public.audit_snapshots (scan_run_id, org_id, kind, taken_at, modules_seen, open_ids, prev_scan_run_id,
                                      is_first, new_ids, fixed_ids, ignored_ids, moved, gone, counts, fixed_checked)
  values (p_scan, p_org, v_kind, v_at, v_seen, v_open, v_prev, v_prev is null, v_new, v_fixed, v_ign, v_moved, v_gone,
          jsonb_build_object('open', private.vg_matriz(p_org, v_open), 'new', private.vg_matriz(p_org, v_new),
                             'kept', private.vg_matriz(p_org, v_kept), 'fixed', private.vg_matriz(p_org, v_fixed),
                             'ignored', private.vg_matriz(p_org, v_ign)),
          v_checked)
  on conflict (scan_run_id) do nothing;
  return jsonb_build_object('applied', true, 'first', v_prev is null, 'open', cardinality(v_open),
    'new', cardinality(v_new), 'kept', cardinality(v_kept), 'fixed', cardinality(v_fixed),
    'ignored', cardinality(v_ign), 'moved', v_moved, 'gone', v_gone);
end $$;

-- 5) La foto de Codebase de una revisión de push (paso diff, después de vg_review_findings). Anterior = la foto de push
-- más reciente de la ORG (no de la config: con varios repos, el mismo arreglo saldría en la fila de cada uno). kept =
-- abiertos de Codebase menos los nuevos de este push (new_findings guarda hasta 50). Entre dos pushes, «corregido» solo
-- puede ser algo marcado a mano o comprobado por una auditoría: el diff no ve lo que se quita. No se rehace.
create or replace function public.vg_review_snapshot(p_org uuid, p_review uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.code_reviews%rowtype;
  p public.code_reviews%rowtype;
  v_at timestamptz;
  v_open uuid[];
  v_nuevos uuid[];
  v_fixed uuid[] := '{}';
  v_ign uuid[] := '{}';
  v_moved int := 0;
  v_gone int := 0;
  v_checked int := 0;
  v_delta jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('vg_snap_rev|' || p_org::text));
  select * into r from public.code_reviews c where c.id = p_review and c.org_id = p_org;
  if r.id is null or r.event <> 'push' or r.status <> 'done' then
    return jsonb_build_object('applied', false, 'reason', 'revision');
  end if;
  if r.delta is not null then
    return jsonb_build_object('applied', true, 'repeated', true) || r.delta;
  end if;
  v_at := clock_timestamp();
  select coalesce(array_agg(f.id order by f.id), '{}') into v_open
    from public.findings f where f.org_id = p_org and f.module = 'codebase' and f.status = 'open';
  v_nuevos := array(select (e->>'finding_id')::uuid from jsonb_array_elements(r.new_findings) e
                     where e->>'finding_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    intersect select unnest(v_open));
  select * into p from public.code_reviews c
   where c.org_id = p_org and c.event = 'push' and c.snap_at is not null and c.id <> p_review
   order by c.snap_at desc, c.id desc limit 1;
  if p.id is not null then
    select x.o_fixed, x.o_ignored, x.o_moved, x.o_gone, x.o_checked into v_fixed, v_ign, v_moved, v_gone, v_checked
      from private.vg_restar(p_org, p.snap_open_ids, v_open) x;
  end if;
  v_delta := jsonb_build_object('first', p.id is null, 'previous_review_id', p.id,
    'previous_at', private.vg_iso(p.snap_at), 'open', cardinality(v_open),
    'kept', cardinality(v_open) - cardinality(v_nuevos), 'fixed', cardinality(v_fixed), 'fixed_checked', v_checked,
    'ignored', cardinality(v_ign));
  update public.code_reviews c set snap_at = v_at, snap_open_ids = v_open, delta = v_delta
   where c.id = r.id and c.org_id = p_org and c.delta is null;
  return jsonb_build_object('applied', true, 'moved', v_moved, 'gone', v_gone) || v_delta;
end $$;

-- 6) Lecturas. E51: found:false = la auditoría no es de la org (404 uniforme). Sin foto: en_curso si sigue queued o
-- running; si no, sin_foto. El puntaje y el de la anterior salen de scan_runs. En la primera foto no hay «se mantiene».
create or replace function public.vg_audit_delta(p_org uuid, p_scan uuid, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_status text;
  v_score smallint;
  a public.audit_snapshots%rowtype;
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 50);
begin
  select s.status, s.score into v_status, v_score from public.scan_runs s where s.id = p_scan and s.org_id = p_org;
  if v_status is null then return jsonb_build_object('found', false); end if;
  select * into a from public.audit_snapshots x where x.scan_run_id = p_scan and x.org_id = p_org;
  if a.scan_run_id is null then
    return jsonb_build_object('found', true, 'available', false, 'scan_run_id', p_scan,
      'reason', case when v_status in ('queued', 'running') then 'en_curso' else 'sin_foto' end);
  end if;
  return jsonb_build_object('found', true, 'available', true, 'scan_run_id', p_scan,
    'taken_at', private.vg_iso(a.taken_at), 'first', a.is_first, 'score', v_score,
    'modules_seen', to_jsonb(a.modules_seen),
    'previous', (select jsonb_build_object('scan_run_id', s.id, 'kind', s.kind,
                                           'finished_at', private.vg_iso(s.finished_at), 'score', s.score)
                   from public.scan_runs s where s.id = a.prev_scan_run_id and s.org_id = p_org),
    'counts', a.counts, 'fixed_checked', a.fixed_checked, 'moved', a.moved, 'gone', a.gone,
    'new', private.vg_lista_delta(p_org, a.new_ids, v_lim),
    'kept', private.vg_lista_delta(p_org, case when a.is_first then '{}'::uuid[]
                                    else array(select unnest(a.open_ids) except select unnest(a.new_ids)) end, v_lim),
    'fixed', private.vg_lista_delta(p_org, a.fixed_ids, v_lim),
    'ignored', private.vg_lista_delta(p_org, a.ignored_ids, v_lim));
end $$;

-- Versiones de la org desde p_desde: toda foto (sea cual sea el status de su auditoría: el vigilante puede cerrar como
-- failed una que ya tenía foto, y sigue siendo la anterior de la siguiente) y las auditorías terminadas con puntaje y sin
-- foto (anteriores a 0015). t = cuándo se tomó la foto (sin foto, cuándo terminó): el orden de la cadena.
create or replace function private.vg_versiones(p_org uuid, p_desde timestamptz)
returns table (scan_id uuid, kind text, score smallint, steps jsonb, snap boolean, t timestamptz, modules_seen text[],
               is_first boolean, counts jsonb, ignored int, gone int, fixed_checked int)
language sql stable set search_path = '' as $$
  select r.id, r.kind, r.score, r.steps, a.scan_run_id is not null, coalesce(a.taken_at, r.finished_at), a.modules_seen,
         a.is_first, a.counts, cardinality(a.ignored_ids), a.gone, a.fixed_checked
    from public.scan_runs r
    left join public.audit_snapshots a on a.scan_run_id = r.id and a.org_id = p_org
   where r.org_id = p_org and r.kind <> 'lighthouse'
     and r.created_at >= p_desde - interval '1 day'    -- una auditoría dura minutos (el vigilante corta a los 15)
     and (a.scan_run_id is not null or (r.status = 'succeeded' and r.score is not null and r.finished_at is not null))
     and coalesce(a.taken_at, r.finished_at) >= p_desde
$$;

-- Suma por módulo × severidad de una clave de counts ('new' o 'fixed') en las fotos del periodo con is_first false.
create or replace function private.vg_suma(p_org uuid, p_desde timestamptz, p_clave text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_object_agg(m.module, (
           select jsonb_object_agg(v.sev, (
                    select coalesce(sum((a.counts->p_clave->m.module->>v.sev)::int), 0)
                      from public.audit_snapshots a
                     where a.org_id = p_org and a.taken_at >= p_desde and not a.is_first))
             from unnest(array['critical', 'high', 'medium', 'low', 'info']) as v(sev)))
    from unnest(array['supabase', 'cloudflare', 'codebase', 'performance']) as m(module)
$$;

-- E52: versiones del periodo (las p_limit más recientes, de la más vieja a la más nueva), totales de TODO el periodo,
-- revisiones de código (push y PR) con la foto de cada push, incidentes por día de Caracas y tiempo hasta comprobar.
create or replace function public.vg_evolution(p_org uuid, p_days int default 30, p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dias int := least(greatest(coalesce(p_days, 30), 1), 90);
  v_tope int := least(greatest(coalesce(p_limit, 30), 1), 60);
  v_desde timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90));
  v_puntos jsonb;
  v_n int;
  v_totales jsonb;
  v_revs jsonb;
  v_inc jsonb;
  v_mttr jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'scan_run_id', p.scan_id, 'kind', p.kind, 'at', private.vg_iso(p.t), 'score', p.score,
           'modules_seen', to_jsonb(coalesce(p.modules_seen, private.vg_modulos_vistos(p.steps))),
           'snapshot', p.snap, 'first', coalesce(p.is_first, false),
           'open', p.counts->'open', 'new', p.counts->'new', 'fixed', p.counts->'fixed',
           'ignored', coalesce(p.ignored, 0), 'gone', coalesce(p.gone, 0), 'fixed_checked', coalesce(p.fixed_checked, 0))
         order by p.t, p.scan_id), '[]'::jsonb)
    into v_puntos
    from (select * from private.vg_versiones(p_org, v_desde) v order by v.t desc, v.scan_id desc limit v_tope) p;

  select count(*), jsonb_build_object(
           'versions', count(*), 'snapshots', count(*) filter (where v.snap),
           'score_first', (array_agg(v.score order by v.t, v.scan_id))[1],
           'new', private.vg_suma(p_org, v_desde, 'new'), 'fixed', private.vg_suma(p_org, v_desde, 'fixed'),
           'fixed_checked', coalesce(sum(v.fixed_checked) filter (where v.snap and not v.is_first), 0),
           'ignored', coalesce(sum(v.ignored) filter (where v.snap and not v.is_first), 0),
           'gone', coalesce(sum(v.gone) filter (where v.snap and not v.is_first), 0))
    into v_n, v_totales
    from private.vg_versiones(p_org, v_desde) v;

  select coalesce(jsonb_agg(jsonb_build_object('review_id', r.id, 'event', r.event, 'pr_number', r.pr_number,
           'at', private.vg_iso(r.created_at), 'head_sha7', left(r.head_sha, 7), 'new', r.counts, 'partial', r.partial,
           'delta', r.delta) order by r.created_at, r.id), '[]'::jsonb)
    into v_revs
    from (select c.id, c.event, c.pr_number, c.created_at, c.head_sha, c.counts, c.partial, c.delta
            from public.code_reviews c
           where c.org_id = p_org and c.event in ('push', 'pull_request') and c.status = 'done'
             and c.created_at >= v_desde
           order by c.created_at desc, c.id desc limit 50) r;

  select coalesce(jsonb_agg(jsonb_build_object('day', d.dia, 'counts', d.c) order by d.dia), '[]'::jsonb)
    into v_inc
    from (select to_char(i.started_at at time zone 'America/Caracas', 'YYYY-MM-DD') as dia,
                 jsonb_build_object('critical', count(*) filter (where i.severity = 'critical'),
                                    'high', count(*) filter (where i.severity = 'high'),
                                    'medium', count(*) filter (where i.severity = 'medium'),
                                    'low', count(*) filter (where i.severity = 'low'),
                                    'info', count(*) filter (where i.severity = 'info')) as c
            from public.incidents i
           where i.org_id = p_org and i.started_at >= v_desde
           group by 1) d;

  select jsonb_build_object('verified', count(*),
           'hours_avg', case when count(*) = 0 then null else round((greatest(avg(
             extract(epoch from f.verified_at - f.first_seen_at)::float8), 0) / 3600)::numeric, 1) end,
           'hours_median', case when count(*) = 0 then null else round((greatest(percentile_cont(0.5) within group
             (order by extract(epoch from f.verified_at - f.first_seen_at)::float8), 0) / 3600)::numeric, 1) end)
    into v_mttr
    from public.findings f
   where f.org_id = p_org and f.status = 'verified' and f.verified_at >= v_desde and not private.vg_es_clave(f.rule_id);

  return jsonb_build_object('days', v_dias, 'points', v_puntos, 'truncated', v_n > v_tope, 'totals', v_totales,
    'reviews', v_revs, 'incidents', v_inc, 'mttr', v_mttr);
end $$;

-- 7) Solo el Worker (service_role). Decisión (a): los datos van por /api; anon y authenticated no leen nada.
alter table public.audit_snapshots enable row level security;
revoke all on public.audit_snapshots from anon, authenticated;
grant select, insert, update, delete on public.audit_snapshots to service_role;
revoke all on function private.vg_iso(timestamptz), private.vg_es_clave(text), private.vg_modulos_vistos(jsonb),
  private.vg_matriz(uuid, uuid[]), private.vg_lista_delta(uuid, uuid[], int), private.vg_restar(uuid, uuid[], uuid[]),
  private.vg_versiones(uuid, timestamptz), private.vg_suma(uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.vg_snapshot_audit(uuid, uuid), public.vg_review_snapshot(uuid, uuid),
  public.vg_audit_delta(uuid, uuid, int), public.vg_evolution(uuid, int, int) from public, anon, authenticated;
grant execute on function public.vg_snapshot_audit(uuid, uuid), public.vg_review_snapshot(uuid, uuid),
  public.vg_audit_delta(uuid, uuid, int), public.vg_evolution(uuid, int, int) to service_role;
