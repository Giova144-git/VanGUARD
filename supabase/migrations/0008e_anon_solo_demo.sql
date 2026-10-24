-- 0008e_anon_solo_demo.sql · decisión 14 de 00.7 (propuesta en 0008, aprobada): una sesión anónima solo ve la org is_demo.
-- Cierra el advisor 0012 (políticas accesibles a usuarios anónimos) en las 11 *_sel y en vg_org_broadcast_sel, que es la
-- única activa de verdad: authenticated no tiene SELECT directo en public (decisión (a)), pero Realtime evalúa la política
-- de realtime.messages como authenticated. Por eso la lista de orgs de demo sale de una función security definer y no de
-- un `select ... from public.orgs` dentro de la política: sin grant fallaría con 42501 y en orgs_sel recursaría (42P17).
-- cron.* queda fuera: es del sistema y no se expone por la API (se documenta como ignorado con motivo).
create or replace function private.demo_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select id from public.orgs where is_demo $$;
revoke all on function private.demo_org_ids() from public, anon;
grant execute on function private.demo_org_ids() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['actions', 'connections', 'contacts', 'findings', 'incidents', 'metric_samples',
                           'notifications', 'org_members', 'perf_runs', 'scan_runs'] loop
    execute format($f$alter policy %I on public.%I using (org_id in (select private.user_org_ids())
      and (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
           or org_id in (select private.demo_org_ids())))$f$, t || '_sel', t);
  end loop;
end $$;

alter policy orgs_sel on public.orgs using (id in (select private.user_org_ids())
  and (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false or is_demo));

alter policy vg_org_broadcast_sel on realtime.messages
  using (split_part((select realtime.topic()), ':', 2)::uuid in (select private.user_org_ids())
    and (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
         or split_part((select realtime.topic()), ':', 2)::uuid in (select private.demo_org_ids())));

-- Hueco 2 de la auditoría del FRONT: broadcast_changes mandaba la fila ENTERA (notifications.recipient_masked, error,
-- provider_id…) a cualquier miembro del canal, también al anónimo de la demo, saltándose /api y su filtrado. El FRONT
-- solo usa table y operation para invalidar: ahora viaja solo eso más los ids (contrato RealtimeChange, sin cambios:
-- old_record ya es nullable). Mismo topic org:<id>, mismo evento (INSERT/UPDATE) y mensaje privado.
create or replace function private.broadcast_org_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object('table', tg_table_name, 'operation', tg_op,
                       'record', jsonb_build_object('id', new.id, 'org_id', new.org_id), 'old_record', null),
    tg_op, 'org:' || new.org_id::text, true);
  return null;
end $$;
revoke all on function private.broadcast_org_change() from public, anon, authenticated;
