-- supabase/tests/vigilante.sql · 0011: vg_vigilar_corridas cierra las corridas de wiki sin avance > 10 min y las auditorías
-- sin avance > 15 min, sin cobrar nada más, y deja las vivas.
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0011. Siempre termina en ERROR a propósito: el
-- mensaje lleva el resultado y la excepción deshace todo (no queda ninguna corrida de prueba).
-- Resultado esperado:
--   cerradas:2 | wiki vieja:failed/0.02/true/arbol=done,triage=done,area=failed(interrumpida),sintesis=skipped,fin=skipped |
--   wiki 9 min:running | scan 16 min:failed/null/interrumpida | scan 10 min:running | segunda pasada:0 |
--   rpc anon/authenticated:false/false
do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'idor-a');
  v_vieja uuid; v_viva uuid; v_scan uuid; v_scan_viva uuid;
  w public.wiki_runs; s public.scan_runs;
  r text := '';
  n int;
begin
  insert into public.wiki_runs (org_id, repo_full_name, commit_sha, status, progress, cost_usd, steps, updated_at)
    values (v_org, 'acme/vigia1', repeat('a1', 20), 'running', 78, 0.02,
            '[{"name":"arbol","status":"done"},{"name":"triage","status":"done"},{"name":"area","status":"running"},{"name":"sintesis","status":"pending"},{"name":"fin","status":"pending"}]',
            now() - interval '11 minutes') returning id into v_vieja;
  insert into public.wiki_runs (org_id, repo_full_name, commit_sha, status, updated_at)
    values (v_org, 'acme/vigia2', repeat('b2', 20), 'running', now() - interval '9 minutes') returning id into v_viva;
  insert into public.scan_runs (org_id, kind, status, steps, created_at)
    values (v_org, 'repo', 'running', '[{"name":"repo","status":"running"},{"name":"puntaje","status":"pending"}]', now() - interval '16 minutes')
    returning id into v_scan;
  insert into public.scan_runs (org_id, kind, status, created_at) values (v_org, 'repo', 'running', now() - interval '10 minutes') returning id into v_scan_viva;
  select count(*) into n from public.vg_vigilar_corridas() v where v.id in (v_vieja, v_viva, v_scan, v_scan_viva);
  r := r || 'cerradas:' || n || ' | ';
  select * into w from public.wiki_runs where id = v_vieja;
  r := r || 'wiki vieja:' || w.status || '/' || w.cost_usd || '/' || (w.finished_at is not null)
         || '/' || (select string_agg(e->>'name' || '=' || (e->>'status') || coalesce('(' || (e->>'error_code') || ')', ''), ',' order by o)
                    from jsonb_array_elements(w.steps) with ordinality t(e, o)) || ' | ';
  r := r || 'wiki 9 min:' || (select status from public.wiki_runs where id = v_viva) || ' | ';
  select * into s from public.scan_runs where id = v_scan;
  r := r || 'scan 16 min:' || s.status || '/' || coalesce(s.step, 'null') || '/' || (s.steps->0->>'error_code') || ' | ';
  r := r || 'scan 10 min:' || (select status from public.scan_runs where id = v_scan_viva) || ' | ';
  select count(*) into n from public.vg_vigilar_corridas() v where v.id in (v_vieja, v_viva, v_scan, v_scan_viva);
  r := r || 'segunda pasada:' || n || ' | rpc anon/authenticated:'
         || has_function_privilege('anon', 'public.vg_vigilar_corridas(int, int, int)', 'execute') || '/'
         || has_function_privilege('authenticated', 'public.vg_vigilar_corridas(int, int, int)', 'execute');
  raise exception 'RESULTADO %', r;
end $$;
