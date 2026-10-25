-- 0022_vigilante_cierra_terminadas.sql · el vigilante de 0011 cierra BIEN una auditoría que ya terminó todos sus pasos
-- pero cuyo cierre (finalizar de jobs.ts) se perdió. Pasó el 25-oct (scan 1fc34a1e…): un dev-node --watch se reinició con
-- la cola en memoria justo después de que resumen_ia escribiera su steps[i]; la auditoría tenía resumen, foto y hallazgos,
-- pero el vigilante la dejó failed «se interrumpió» a los 15 min.
-- Ahora, en la misma sentencia y con el mismo compare-and-set (for update skip locked y el filtro repetido en el update):
--   terminada = steps no vacío y ningún paso pending ni running, en curso desde hace más de 180 s (el cierre normal llega
--     en milisegundos y sus reintentos y la DLQ en menos de un minuto) → lo mismo que finalizar:
--     succeeded, progress 100, step null y finished_at; failed «Todos los pasos de la auditoría fallaron» si fallaron todos
--     los pasos de fuente (todos menos resumen_ia). No toca steps, summary, score ni coverage. Sale como 'scan_runs_cerradas'
--     (housekeeping.ts solo cuenta como interrumpidas las 'scan_runs').
--   sin terminar → como en 0011 (failed «se interrumpió» a los p_scan_seconds sin avance).
-- Un finalizar que llegue tarde no cambia nada: solo actualiza corridas queued/running. Misma firma y permisos que 0011:
-- la llamada del Worker no cambia. Prueba: supabase/tests/vigilante-terminadas.sql.

-- Como todosFallaron de finalizar (jobs.ts): hay pasos de fuente (todos menos resumen_ia) y todos quedaron failed.
create or replace function private.vg_fuentes_fallaron(p_steps jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select count(*) > 0 and bool_and(t.e->>'status' = 'failed')
    from jsonb_array_elements(case when jsonb_typeof(p_steps) = 'array' then p_steps else '[]'::jsonb end) t(e)
   where t.e->>'name' <> 'resumen_ia'
$$;

create or replace function public.vg_vigilar_corridas(p_wiki_seconds int default 600, p_scan_seconds int default 900,
  p_limit int default 50)
returns table (tabla text, id uuid, org_id uuid)
language sql security definer set search_path = '' as $$
  with cw as (
    select w.id from public.wiki_runs w
     where w.status in ('queued', 'running')
       and w.updated_at < now() - make_interval(secs => greatest(p_wiki_seconds, 300))
     order by w.updated_at
     limit least(greatest(p_limit, 1), 200)
     for update skip locked),
  uw as (
    update public.wiki_runs u
       set status = 'failed', error = 'La corrida se interrumpió; vuelve a generarla',
           finished_at = coalesce(u.finished_at, now()), updated_at = now(),
           steps = coalesce((
             select jsonb_agg(case when x.abierto and x.o = x.primero
                                     then jsonb_build_object('name', x.e->'name', 'status', 'failed', 'error_code', 'interrumpida')
                                   when x.abierto then jsonb_build_object('name', x.e->'name', 'status', 'skipped')
                                   else x.e end order by x.o)
               from (select t.e, t.o, t.e->>'status' in ('pending', 'running') as abierto,
                            min(t.o) filter (where t.e->>'status' in ('pending', 'running')) over () as primero
                       from jsonb_array_elements(u.steps) with ordinality as t(e, o)) x), '[]'::jsonb)
      from cw
     where u.id = cw.id and u.status in ('queued', 'running')
       and u.updated_at < now() - make_interval(secs => greatest(p_wiki_seconds, 300))
    returning u.id, u.org_id),
  -- Auditorías con todos sus pasos terminados: su cierre se perdió.
  ct as (
    select s.id from public.scan_runs s
     where s.status in ('queued', 'running')
       and jsonb_typeof(s.steps) = 'array' and jsonb_array_length(s.steps) > 0
       and not exists (select 1 from jsonb_array_elements(s.steps) t(e) where t.e->>'status' in ('pending', 'running'))
       and coalesce(s.started_at, s.created_at) < now() - interval '180 seconds'
     order by s.created_at
     limit least(greatest(p_limit, 1), 200)
     for update skip locked),
  ut as (
    update public.scan_runs u
       set status = case when private.vg_fuentes_fallaron(u.steps) then 'failed' else 'succeeded' end,
           error = case when private.vg_fuentes_fallaron(u.steps) then 'Todos los pasos de la auditoría fallaron'
                        else u.error end,
           progress = 100, step = null, finished_at = coalesce(u.finished_at, now())
      from ct
     where u.id = ct.id and u.status in ('queued', 'running')
       and not exists (select 1 from jsonb_array_elements(u.steps) t(e) where t.e->>'status' in ('pending', 'running'))
       and coalesce(u.started_at, u.created_at) < now() - interval '180 seconds'
    returning u.id, u.org_id),
  cs as (
    select s.id from public.scan_runs s
     where s.status in ('queued', 'running')
       and coalesce(s.started_at, s.created_at) < now() - make_interval(secs => greatest(p_scan_seconds, 300))
       and not exists (select 1 from public.findings f
                        where f.scan_run_id = s.id
                          and f.last_seen_at >= now() - make_interval(secs => greatest(p_scan_seconds, 300)))
       and not (jsonb_typeof(s.steps) = 'array' and jsonb_array_length(s.steps) > 0
                and not exists (select 1 from jsonb_array_elements(s.steps) t(e) where t.e->>'status' in ('pending', 'running')))
     order by s.created_at
     limit least(greatest(p_limit, 1), 200)
     for update skip locked),
  us as (
    update public.scan_runs u
       set status = 'failed', error = 'La auditoría se interrumpió; vuelve a lanzarla', step = null,
           finished_at = coalesce(u.finished_at, now()),
           steps = coalesce((
             select jsonb_agg(case when t.e->>'status' in ('pending', 'running')
                                     then jsonb_build_object('name', t.e->'name', 'status', 'failed', 'error_code', 'interrumpida')
                                   else t.e end order by t.o)
               from jsonb_array_elements(u.steps) with ordinality as t(e, o)), '[]'::jsonb)
      from cs
     where u.id = cs.id and u.status in ('queued', 'running')
       and coalesce(u.started_at, u.created_at) < now() - make_interval(secs => greatest(p_scan_seconds, 300))
    returning u.id, u.org_id)
  select 'wiki_runs'::text, uw.id, uw.org_id from uw
  union all
  select 'scan_runs_cerradas'::text, ut.id, ut.org_id from ut
  union all
  select 'scan_runs'::text, us.id, us.org_id from us $$;

revoke all on function private.vg_fuentes_fallaron(jsonb) from public, anon, authenticated;
revoke all on function public.vg_vigilar_corridas(int, int, int) from public, anon, authenticated;
grant execute on function public.vg_vigilar_corridas(int, int, int) to service_role;
