-- supabase/tests/historial-hallazgos.sql · 0025: las fechas de cada cambio de estado de un hallazgo (corregido a mano,
-- verificado, ignorado, reabierto a mano y reaparecido con vg_upsert_findings), el relleno desde las fotos de
-- audit_snapshots y los privilegios (anon y authenticated no leen findings, tampoco las columnas nuevas).
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0025 (o pegado detrás de la migración en la misma
-- llamada). Siempre termina en ERROR a propósito: el mensaje lleva el resultado y la excepción deshace todo.
-- Dentro de una transacción now() no avanza: las fechas se comparan con «no es null» y con el estado anterior.
-- Resultado esperado:
--   1 nuevo: cambio=true fechas=0 | 2 fixed: fixed=true cambio=true | 3 verified: fixed_se_queda=true |
--   4 reaparece: open reopened=true n=1 verified=null fixed_se_queda=true | 5 reabrir a mano: fixed=null n=1 |
--   6 ignorar: ignored=true reabrir=null | 7 mismo estado: sin_cambio=true |
--   8 relleno: fixed=foto2 ignored=foto2 reaparece=foto3 n=1 cambio=foto3 sin_fotos=null |
--   9 privilegios anon/auth: 0 de 10, trigger=true indice=true
create or replace function pg_temp.hallazgo(p_org uuid, p_regla text, p_estado text default 'open') returns uuid
language sql as $$
  insert into public.findings (org_id, module, rule_id, severity, title, resource, dedupe_key, status, first_seen_at)
  values (p_org, 'supabase', p_regla, 'high', 'Prueba ' || p_regla, 'public.' || lower(p_regla),
          encode(sha256(convert_to('historial|' || p_org || '|' || p_regla, 'UTF8')), 'hex'), p_estado,
          now() - interval '5 days')
  returning id
$$;

do $$
declare
  v_org uuid;
  v_scan1 uuid; v_scan2 uuid; v_scan3 uuid;
  f1 uuid; f2 uuid; f3 uuid; f4 uuid; f5 uuid;
  r public.findings%rowtype;
  s text := '';
  n int;
  t1 timestamptz := now() - interval '3 days';
  t2 timestamptz := now() - interval '2 days';
  t3 timestamptz := now() - interval '1 day';
begin
  insert into public.orgs (name, slug) values ('Prueba historial', 'prueba-historial-' || substr(md5(random()::text), 1, 8))
    returning id into v_org;
  f1 := pg_temp.hallazgo(v_org, 'SB_HIST_UNO');

  -- 1) recién creado: changed = ahora, sin fechas de cambio
  select * into r from public.findings where id = f1;
  s := s || '1 nuevo: cambio=' || (r.status_changed_at is not null)
         || ' fechas=' || num_nonnulls(r.fixed_at, r.ignored_at, r.reopened_at, r.verified_at);

  -- 2) «Marcar corregido» (E14)
  update public.findings set status_changed_at = now() - interval '1 hour' where id = f1;
  update public.findings set status = 'fixed', status_reason = null where id = f1;
  select * into r from public.findings where id = f1;
  s := s || ' | 2 fixed: fixed=' || (r.fixed_at is not null) || ' cambio=' || (r.status_changed_at = now());

  -- 3) una auditoría la verifica: fixed_at se queda
  update public.findings set status = 'verified', verified_at = now(), status_reason = 'no reapareció en la auditoría' where id = f1;
  select * into r from public.findings where id = f1;
  s := s || ' | 3 verified: fixed_se_queda=' || (r.fixed_at is not null);

  -- 4) reaparece en la siguiente auditoría (vg_upsert_findings con la misma clave)
  perform public.vg_upsert_findings(v_org, null, 'supabase', null, jsonb_build_array(jsonb_build_object(
    'rule_id', 'SB_HIST_UNO', 'severity', 'high', 'title', 'Prueba SB_HIST_UNO', 'resource', 'public.sb_hist_uno',
    'dedupe_key', encode(sha256(convert_to('historial|' || v_org || '|SB_HIST_UNO', 'UTF8')), 'hex'))), false);
  select * into r from public.findings where id = f1;
  s := s || ' | 4 reaparece: ' || r.status || ' reopened=' || (r.reopened_at is not null) || ' n=' || r.reopen_count
         || ' verified=' || coalesce(r.verified_at::text, 'null') || ' fixed_se_queda=' || (r.fixed_at is not null);

  -- 5) «Reabrir» a mano un corregido: deshace la marca y no cuenta como reaparición
  f2 := pg_temp.hallazgo(v_org, 'SB_HIST_DOS');
  update public.findings set status = 'fixed' where id = f2;
  update public.findings set status = 'open', status_reason = null where id = f2;
  update public.findings set status = 'fixed' where id = f1;
  update public.findings set status = 'open', status_reason = null where id = f1;
  select * into r from public.findings where id = f1;
  s := s || ' | 5 reabrir a mano: fixed=' || coalesce(r.fixed_at::text, 'null') || ' n=' || r.reopen_count;

  -- 6) ignorar y reabrir
  update public.findings set status = 'ignored', status_reason = 'tabla interna' where id = f2;
  select * into r from public.findings where id = f2;
  s := s || ' | 6 ignorar: ignored=' || (r.ignored_at is not null);
  update public.findings set status = 'open', status_reason = null where id = f2;
  select * into r from public.findings where id = f2;
  s := s || ' reabrir=' || coalesce(r.ignored_at::text, 'null');

  -- 7) un UPDATE que no cambia el estado no toca las fechas
  update public.findings set status_changed_at = now() - interval '1 hour' where id = f2;
  update public.findings set status = 'open', title = 'Prueba otra vez' where id = f2;
  select * into r from public.findings where id = f2;
  s := s || ' | 7 mismo estado: sin_cambio=' || (r.status_changed_at < now());

  -- 8) relleno desde las fotos: f3 salió en la foto 2 (fixed), f4 se ignoró en la foto 2, f5 salió en la 1 y volvió
  -- nueva en la 3. Una falla sin fotos se queda sin fechas.
  f3 := pg_temp.hallazgo(v_org, 'SB_HIST_TRES', 'fixed');
  f4 := pg_temp.hallazgo(v_org, 'SB_HIST_CUATRO', 'ignored');
  f5 := pg_temp.hallazgo(v_org, 'SB_HIST_CINCO');
  update public.findings set fixed_at = null, ignored_at = null, reopened_at = null, reopen_count = 0
   where id in (f3, f4, f5);
  insert into public.scan_runs (org_id, kind, status) values (v_org, 'full_audit', 'succeeded') returning id into v_scan1;
  insert into public.scan_runs (org_id, kind, status) values (v_org, 'full_audit', 'succeeded') returning id into v_scan2;
  insert into public.scan_runs (org_id, kind, status) values (v_org, 'full_audit', 'succeeded') returning id into v_scan3;
  insert into public.audit_snapshots (scan_run_id, org_id, kind, taken_at, modules_seen, open_ids, is_first, fixed_ids,
                                      ignored_ids, new_ids, counts)
  values (v_scan1, v_org, 'full_audit', t1, array['supabase'], array[f3, f4], false, array[f5], '{}', '{}',
          '{"open":{},"new":{},"kept":{},"fixed":{},"ignored":{}}'),
         (v_scan2, v_org, 'full_audit', t2, array['supabase'], '{}', false, array[f3], array[f4], '{}',
          '{"open":{},"new":{},"kept":{},"fixed":{},"ignored":{}}'),
         (v_scan3, v_org, 'full_audit', t3, array['supabase'], array[f5], false, '{}', '{}', array[f5],
          '{"open":{},"new":{},"kept":{},"fixed":{},"ignored":{}}');
  n := private.vg_rellenar_historial(v_org);
  s := s || ' | 8 relleno: fixed=' || case (select fixed_at from public.findings where id = f3) when t2 then 'foto2' else 'MAL' end
         || ' ignored=' || case (select ignored_at from public.findings where id = f4) when t2 then 'foto2' else 'MAL' end
         || ' reaparece=' || case (select reopened_at from public.findings where id = f5) when t3 then 'foto3' else 'MAL' end
         || ' n=' || (select reopen_count from public.findings where id = f5)
         || ' cambio=' || case (select status_changed_at from public.findings where id = f5) when t3 then 'foto3' else 'MAL' end
         || ' sin_fotos=' || coalesce((select fixed_at::text from public.findings where id = f2), 'null');

  -- 9) privilegios: ni anon ni authenticated leen ni escriben las columnas nuevas (select, insert, update, references)
  select count(*) into n
    from (values ('anon'), ('authenticated')) ro(rol),
         (values ('fixed_at'), ('ignored_at'), ('reopened_at'), ('reopen_count'), ('status_changed_at')) c(col)
   where has_column_privilege(ro.rol, 'public.findings', c.col, 'select')
      or has_column_privilege(ro.rol, 'public.findings', c.col, 'update');
  s := s || ' | 9 privilegios anon/auth: ' || n || ' de 10, trigger='
         || exists (select 1 from pg_trigger where tgname = 'vg_findings_historial' and tgrelid = 'public.findings'::regclass)
         || ' indice=' || exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'findings_org_cambio_idx');
  raise exception 'RESULTADO %', s;
end $$;
