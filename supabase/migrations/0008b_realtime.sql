-- 0008b_realtime.sql · Realtime en P0 (A7.5): §15.6 y §05.13. Broadcast privado por org desde triggers sobre
-- scan_runs, findings, incidents y notifications, más la política de realtime.messages. Ajustes de §05.13: la función
-- lleva search_path = '' y la política compara el topic como uuid. Nunca se emiten edge_hits, metric_samples,
-- connections, connection_secrets, approvals, ai_usage ni contacts.
create or replace function private.broadcast_org_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.broadcast_changes('org:' || coalesce(new.org_id, old.org_id)::text, tg_op, tg_op,
    tg_table_name, tg_table_schema, new, old);
  return null;
end $$;
revoke all on function private.broadcast_org_change() from public, anon, authenticated;

drop trigger if exists vg_broadcast on public.scan_runs;
create trigger vg_broadcast after insert or update on public.scan_runs
  for each row execute function private.broadcast_org_change();
drop trigger if exists vg_broadcast on public.findings;
create trigger vg_broadcast after insert or update on public.findings
  for each row execute function private.broadcast_org_change();
drop trigger if exists vg_broadcast on public.incidents;
create trigger vg_broadcast after insert or update on public.incidents
  for each row execute function private.broadcast_org_change();
drop trigger if exists vg_broadcast on public.notifications;
create trigger vg_broadcast after insert or update on public.notifications
  for each row execute function private.broadcast_org_change();

-- Un miembro autenticado solo recibe los mensajes del canal org:<su org>.
drop policy if exists vg_org_broadcast_sel on realtime.messages;
create policy vg_org_broadcast_sel on realtime.messages for select to authenticated
  using (split_part((select realtime.topic()), ':', 2)::uuid in (select private.user_org_ids()));
