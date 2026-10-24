-- 0009_vg_resolve_idle.sql · housekeeping del cron por minuto (§12.3, §15.7): cierra en UNA sentencia los incidentes
-- con reglas CF_ sin peticiones de su IP (details.ip) en edge_hits desde hace p_idle_seconds (15 min) y sin evaluación
-- que los tocara en ese tiempo (last_event_at, filtro previo barato). Acotada a p_limit candidatos (los más viejos
-- primero); el not exists usa edge_hits_org_ip_ts_idx. Una details.ip ilegible no rompe la sentencia
-- (pg_input_is_valid, PG ≥ 16): ese incidente se cierra por last_event_at. Las SB_ siguen su propia regla (monitor).
-- skip locked: no espera a un vg_upsert_incident en curso; ese incidente se mira en el minuto siguiente.
create or replace function public.vg_resolve_idle_incidents(p_idle_seconds int default 900, p_limit int default 200)
returns table (id uuid, org_id uuid)
language sql security definer set search_path = '' as $$
  with c as (
    select i.id from public.incidents i
     where i.status <> 'resolved'
       and i.last_event_at < now() - make_interval(secs => greatest(p_idle_seconds, 60))
       and exists (select 1 from unnest(i.rule_ids) r where starts_with(r, 'CF_'))
       and not exists (
         select 1 from public.edge_hits h
          where h.org_id = i.org_id
            and h.ip = (case when pg_input_is_valid(i.details->>'ip', 'inet') then (i.details->>'ip')::inet end)
            and h.ts > now() - make_interval(secs => greatest(p_idle_seconds, 60)))
     order by i.last_event_at
     limit least(greatest(p_limit, 1), 500)
     for update skip locked)
  update public.incidents u set status = 'resolved', resolved_at = now()
    from c
   where u.id = c.id and u.status <> 'resolved'
  returning u.id, u.org_id $$;

revoke all on function public.vg_resolve_idle_incidents(int, int) from public, anon, authenticated;
grant execute on function public.vg_resolve_idle_incidents(int, int) to service_role;
