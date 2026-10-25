-- supabase/tests/vigilante-terminadas.sql · 0022: vg_vigilar_corridas cierra como finalizar una auditoría con todos sus
-- pasos terminados cuyo cierre se perdió (caso del scan 1fc34a1e… del 25-oct), y sigue cerrando como «se interrumpió» las
-- que tienen pasos abiertos. Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0022. Siempre termina en
-- ERROR a propósito: el mensaje lleva el resultado y la excepción deshace todo (no queda ninguna corrida de prueba).
-- Antes de 0022, la primera línea sale «terminada 16 min:failed/…» (el cuelgue reproducido).
-- Resultado esperado:
--   terminada 16 min:succeeded/100/null/null/supabase=done,cloudflare=skipped,repo=done,resumen_ia=done/scan_runs_cerradas |
--   terminada 4 min:succeeded | terminada 2 min:running | fuentes fallidas:failed/Todos los pasos de la auditoría fallaron |
--   abierta 16 min:failed/interrumpida | abierta 10 min:running | sin pasos 16 min:failed | segunda pasada:0 |
--   rpc anon/authenticated:false/false
do $$
declare
  v_org uuid := (select id from public.orgs order by created_at limit 1);
  v_t16 uuid; v_t4 uuid; v_t2 uuid; v_ff uuid; v_a16 uuid; v_a10 uuid; v_v16 uuid;
  v_hecho jsonb := '[{"name":"supabase","status":"done","findings":8},{"name":"cloudflare","status":"skipped","error_code":"no_connection"},{"name":"repo","status":"done","findings":11},{"name":"resumen_ia","status":"done"}]';
  s public.scan_runs;
  r text := '';
  n int;
begin
  insert into public.scan_runs (org_id, kind, status, progress, steps, created_at, started_at)
    values (v_org, 'full_audit', 'running', 95, v_hecho, now() - interval '16 minutes', now() - interval '16 minutes')
    returning id into v_t16;
  insert into public.scan_runs (org_id, kind, status, progress, steps, created_at, started_at)
    values (v_org, 'full_audit', 'running', 95, v_hecho, now() - interval '4 minutes', now() - interval '4 minutes')
    returning id into v_t4;
  insert into public.scan_runs (org_id, kind, status, progress, steps, created_at, started_at)
    values (v_org, 'full_audit', 'running', 95, v_hecho, now() - interval '2 minutes', now() - interval '2 minutes')
    returning id into v_t2;
  insert into public.scan_runs (org_id, kind, status, steps, created_at)
    values (v_org, 'repo', 'running', '[{"name":"repo","status":"failed","error_code":"unavailable"},{"name":"resumen_ia","status":"skipped"}]',
            now() - interval '5 minutes') returning id into v_ff;
  insert into public.scan_runs (org_id, kind, status, steps, created_at)
    values (v_org, 'repo', 'running', '[{"name":"repo","status":"done"},{"name":"resumen_ia","status":"running"}]',
            now() - interval '16 minutes') returning id into v_a16;
  insert into public.scan_runs (org_id, kind, status, steps, created_at)
    values (v_org, 'repo', 'running', '[{"name":"repo","status":"done"},{"name":"resumen_ia","status":"pending"}]',
            now() - interval '10 minutes') returning id into v_a10;
  insert into public.scan_runs (org_id, kind, status, steps, created_at)
    values (v_org, 'repo', 'running', '[]', now() - interval '16 minutes') returning id into v_v16;

  create temp table vig on commit drop as
    select v.tabla, v.id from public.vg_vigilar_corridas() v where v.id in (v_t16, v_t4, v_t2, v_ff, v_a16, v_a10, v_v16);
  select * into s from public.scan_runs where id = v_t16;
  r := r || 'terminada 16 min:' || s.status || '/' || s.progress || '/' || coalesce(s.step, 'null') || '/'
         || coalesce(s.error, 'null') || '/'
         || (select string_agg(e->>'name' || '=' || (e->>'status'), ',' order by o)
               from jsonb_array_elements(s.steps) with ordinality t(e, o)) || '/'
         || coalesce((select tabla from vig where id = v_t16), 'ninguna') || ' | ';
  r := r || 'terminada 4 min:' || (select status from public.scan_runs where id = v_t4) || ' | ';
  r := r || 'terminada 2 min:' || (select status from public.scan_runs where id = v_t2) || ' | ';
  select * into s from public.scan_runs where id = v_ff;
  r := r || 'fuentes fallidas:' || s.status || '/' || coalesce(s.error, 'null') || ' | ';
  select * into s from public.scan_runs where id = v_a16;
  r := r || 'abierta 16 min:' || s.status || '/' || coalesce(s.steps->1->>'error_code', 'null') || ' | ';
  r := r || 'abierta 10 min:' || (select status from public.scan_runs where id = v_a10) || ' | ';
  r := r || 'sin pasos 16 min:' || (select status from public.scan_runs where id = v_v16) || ' | ';
  select count(*) into n from public.vg_vigilar_corridas() v where v.id in (v_t16, v_t4, v_t2, v_ff, v_a16, v_a10, v_v16);
  r := r || 'segunda pasada:' || n || ' | rpc anon/authenticated:'
         || has_function_privilege('anon', 'public.vg_vigilar_corridas(int, int, int)', 'execute') || '/'
         || has_function_privilege('authenticated', 'public.vg_vigilar_corridas(int, int, int)', 'execute');
  raise exception 'RESULTADO %', r;
end $$;
