-- 0011_vigilante.sql · vigilante del cron por minuto (engine/housekeeping.ts): cierra las corridas que se quedaron en
-- curso porque su mensaje de vg-jobs se perdió (un dev-node --watch que se reinició con la cola en memoria, un mensaje
-- que nunca llegó a la DLQ). En UNA sentencia, acotada a p_limit filas por tabla (las más viejas primero):
--   wiki_runs queued/running con updated_at (último avance o última espera, lo pone vg_wiki_avanzar) de hace más de
--     p_wiki_seconds (600) → failed con su texto y finished_at. No toca cost_usd ni state: no cobra nada más. En steps, el
--     primer paso abierto queda failed con error_code 'interrumpida' y los demás abiertos skipped (como vistaFallo).
--   scan_runs queued/running sin avance desde hace p_scan_seconds (900). scan_runs no tiene updated_at y no se le añade
--     (vg_claim_step y vg_mark_step no lo escribirían): el avance es coalesce(started_at, created_at) (started_at lo fija
--     el primer vg_claim_step y no cambia) o, si es más nuevo, un hallazgo escrito por esa auditoría (findings.last_seen_at
--     con findings_scan_idx), que cuenta como avance de una auditoría larga. Sus pasos abiertos quedan failed con
--     'interrumpida' y step null, como el cierre forzado de jobs.ts (finalizar con forzar).
-- Compare-and-set en la misma sentencia: el filtro de tiempo va en el select for update y otra vez en el update. Un paso
-- que avanza a la vez gana: si ya hizo commit, el for update relee la fila (updated_at nuevo) y la deja fuera; si aún la
-- tiene bloqueada, skip locked la salta y se mira en el minuto siguiente. Lo que escriba después un paso viejo sobre una
-- fila cerrada no cambia nada: vg_wiki_avanzar, vg_claim_step, vg_mark_step y finalizar solo tocan corridas en curso.
-- Los umbrales tienen un suelo de 300 s para que una llamada errónea no cierre corridas vivas.
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
  cs as (
    select s.id from public.scan_runs s
     where s.status in ('queued', 'running')
       and coalesce(s.started_at, s.created_at) < now() - make_interval(secs => greatest(p_scan_seconds, 300))
       and not exists (select 1 from public.findings f
                        where f.scan_run_id = s.id
                          and f.last_seen_at >= now() - make_interval(secs => greatest(p_scan_seconds, 300)))
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
  select 'scan_runs'::text, us.id, us.org_id from us $$;

revoke all on function public.vg_vigilar_corridas(int, int, int) from public, anon, authenticated;
grant execute on function public.vg_vigilar_corridas(int, int, int) to service_role;
