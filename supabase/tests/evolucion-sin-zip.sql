-- supabase/tests/evolucion-sin-zip.sql · 0024: un ZIP no entra en la evolución. Se corre con execute_sql DESPUÉS de
-- aplicar 0024 (o pegado detrás de la migración en la misma llamada). Siempre termina en ERROR a propósito: el mensaje
-- lleva el resultado y la excepción deshace todo. Esperado:
--   RESULTADO zip foto:false/zip | versiones:1 sin zip | anterior no es zip:true
do $$
declare
  o uuid := (select id from public.orgs where slug = 'idor-a');
  z uuid; vieja uuid; a uuid; j jsonb; r text := ''; n int;
begin
  insert into public.scan_runs (org_id, kind, status, steps, score, finished_at)
    values (o, 'zip', 'succeeded', '[{"name":"zip","status":"done"}]', 100, now() - interval '2 hours') returning id into z;
  j := public.vg_snapshot_audit(o, z);
  r := r || 'zip foto:' || (j->>'applied') || '/' || coalesce(j->>'reason', '-');
  -- Una foto de ZIP de antes de 0024 (la de producción): no puede ser la anterior de la siguiente auditoría.
  insert into public.scan_runs (org_id, kind, status, steps, score, finished_at)
    values (o, 'zip', 'succeeded', '[{"name":"zip","status":"done"}]', 100, now() - interval '1 hour') returning id into vieja;
  insert into public.audit_snapshots (scan_run_id, org_id, kind, taken_at, modules_seen, is_first, counts)
    values (vieja, o, 'zip', now() - interval '1 hour', array['codebase'], true,
            '{"open":{},"new":{},"kept":{},"fixed":{},"ignored":{}}');
  insert into public.scan_runs (org_id, kind, status, steps, score, finished_at)
    values (o, 'full_audit', 'succeeded', '[{"name":"supabase","status":"done"}]', 49, now()) returning id into a;
  perform public.vg_snapshot_audit(o, a);
  select count(*) into n from private.vg_versiones(o, now() - interval '1 day') v where v.kind = 'zip';
  r := r || ' | versiones:' || (select count(*) from private.vg_versiones(o, now() - interval '1 day') v
                                 where v.scan_id in (z, vieja, a)) || case when n = 0 then ' sin zip' else ' CON ZIP' end;
  r := r || ' | anterior no es zip:' || (select coalesce(x.prev_scan_run_id is distinct from vieja, true)::text
                                          from public.audit_snapshots x where x.scan_run_id = a);
  raise exception 'RESULTADO %', r;
end $$;
