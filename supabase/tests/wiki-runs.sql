-- supabase/tests/wiki-runs.sql · 0010: checks de wiki_runs, una sola corrida en curso por llave, compare-and-set de
-- vg_wiki_avanzar (state.n, org, estado en curso, progress que nunca baja, started_at/finished_at/updated_at, huella solo
-- al cerrar), rutas wiki_* de ai_usage y permisos (solo service_role).
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0010. Siempre termina en ERROR a propósito: el
-- mensaje lleva el resultado y la excepción deshace todo (no queda ninguna corrida ni fila de ai_usage de prueba).
-- Resultado esperado:
--   checks repo/commit/huella/status/progress/max_usd/cached/error:8/8 | en curso única:true | sin huella única:true |
--   avanza n=0:true | started_at:true | updated_at:true | huella en curso:igual | repetido n=0:false | otra org:false |
--   progress no baja:10 | state null conserva n:1 | cierra:true | finished_at:true | doc:true | huella al cerrar:nueva |
--   tras cerrar otra en curso:true | cerrada:false | patch no objeto:false | ai_usage wiki_sintesis:true |
--   ai_usage otra:false | rls:true/0 políticas | anon:false | authenticated:false | service_role:true |
--   rpc anon/authenticated/service_role:false/false/true | definer:true | índice caché:true | índice en curso:true
do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'idor-a');
  v_otra uuid := (select id from public.orgs where slug = 'idor-b');
  v_sha text := repeat('ab12', 10);
  v_huella text := repeat('cd', 32);
  v_huella2 text := repeat('ef', 32);
  v_id uuid;
  v_ok int := 0;
  w public.wiki_runs;
  r text := '';
begin
  if v_org is null or v_otra is null then raise exception 'RESULTADO faltan las orgs idor-a / idor-b'; end if;

  -- Checks: cada inserción inválida debe fallar con check_violation (23514).
  begin insert into public.wiki_runs (org_id, repo_full_name) values (v_org, 'acme/..');
  exception when check_violation then v_ok := v_ok + 1; end;
  begin insert into public.wiki_runs (org_id, repo_full_name, commit_sha) values (v_org, 'acme/tienda', 'ABC123');
  exception when check_violation then v_ok := v_ok + 1; end;
  begin insert into public.wiki_runs (org_id, repo_full_name, huella) values (v_org, 'acme/tienda', 'sin-auditoria');
  exception when check_violation then v_ok := v_ok + 1; end;
  begin insert into public.wiki_runs (org_id, repo_full_name, status) values (v_org, 'acme/tienda', 'done');
  exception when check_violation then v_ok := v_ok + 1; end;
  begin insert into public.wiki_runs (org_id, repo_full_name, progress) values (v_org, 'acme/tienda', 101);
  exception when check_violation then v_ok := v_ok + 1; end;
  begin insert into public.wiki_runs (org_id, repo_full_name, max_usd) values (v_org, 'acme/tienda', 5.01);
  exception when check_violation then v_ok := v_ok + 1; end;
  begin insert into public.wiki_runs (org_id, repo_full_name, cached) values (v_org, 'acme/tienda', true);   -- cached nace succeeded
  exception when check_violation then v_ok := v_ok + 1; end;
  begin insert into public.wiki_runs (org_id, repo_full_name, error) values (v_org, 'acme/tienda', repeat('x', 301));
  exception when check_violation then v_ok := v_ok + 1; end;
  r := r || 'checks repo/commit/huella/status/progress/max_usd/cached/error:' || v_ok || '/8 | ';

  -- Una corrida en cola como la crea E41.
  insert into public.wiki_runs (org_id, repo_full_name, branch, commit_sha, huella, steps, max_usd)
    values (v_org, 'acme/tienda', 'main', v_sha, v_huella,
            '[{"name":"arbol","status":"pending"},{"name":"triage","status":"pending"}]', 0.2)
    returning id into v_id;

  -- Una sola en curso por llave (org, repo, commit, huella; null cuenta como una huella más): la segunda E41 simultánea
  -- choca con 23505.
  begin
    insert into public.wiki_runs (org_id, repo_full_name, commit_sha, huella) values (v_org, 'acme/tienda', v_sha, v_huella);
    r := r || 'en curso única:false | ';
  exception when unique_violation then r := r || 'en curso única:true | ';
  end;
  insert into public.wiki_runs (org_id, repo_full_name, commit_sha) values (v_org, 'acme/otro', v_sha);
  begin
    insert into public.wiki_runs (org_id, repo_full_name, commit_sha, status) values (v_org, 'acme/otro', v_sha, 'running');
    r := r || 'sin huella única:false | ';
  exception when unique_violation then r := r || 'sin huella única:true | ';
  end;

  -- Paso arbol: n 0 → 1, pasa a running. Una huella en un patch que no cierra se ignora. now() es fijo en la
  -- transacción: se envejece updated_at antes para ver que el avance lo mueve.
  update public.wiki_runs set updated_at = now() - interval '5 hours' where id = v_id;
  r := r || 'avanza n=0:' || public.vg_wiki_avanzar(v_id, v_org, 0, '{"version":1,"n":1}',
    format('{"status":"running","progress":10,"steps":[{"name":"arbol","status":"done"},{"name":"triage","status":"pending"}],"est_usd":0.04,"huella":"%s"}', v_huella2)::jsonb);
  select * into w from public.wiki_runs where id = v_id;
  r := r || ' | started_at:' || (w.started_at is not null and w.finished_at is null)
         || ' | updated_at:' || (w.updated_at = now())
         || ' | huella en curso:' || case when w.huella = v_huella then 'igual' else 'cambió' end || ' | ';
  -- La misma entrega repetida (n viejo) y otra org: no tocan nada.
  r := r || 'repetido n=0:' || public.vg_wiki_avanzar(v_id, v_org, 0, '{"version":1,"n":1}', '{"progress":90}') || ' | ';
  r := r || 'otra org:' || public.vg_wiki_avanzar(v_id, v_otra, 1, '{"version":1,"n":2}', '{"progress":90}') || ' | ';
  -- progress nunca baja; p_state null deja el estado (y su n) como estaba.
  perform public.vg_wiki_avanzar(v_id, v_org, 1, null, '{"progress":5,"cost_usd":0.001}');
  select * into w from public.wiki_runs where id = v_id;
  r := r || 'progress no baja:' || w.progress || ' | state null conserva n:' || (w.state->>'n') || ' | ';
  -- Síntesis: cierra con el documento y el costo final.
  r := r || 'cierra:' || public.vg_wiki_avanzar(v_id, v_org, 1, '{"version":1,"n":2}',
    format('{"status":"succeeded","progress":100,"cost_usd":0.034,"doc":{"overview_md":"# Qué es"},"models":{"fast":"claude-haiku-5-5","smart":"claude-sonnet-5-5"},"huella":"%s"}', v_huella2)::jsonb);
  select * into w from public.wiki_runs where id = v_id;
  r := r || ' | finished_at:' || (w.finished_at is not null and w.status = 'succeeded')
         || ' | doc:' || (w.doc->>'overview_md' = '# Qué es' and w.cost_usd = 0.034 and w.est_usd = 0.04)
         || ' | huella al cerrar:' || case when w.huella = v_huella2 then 'nueva' else 'vieja' end || ' | ';
  -- Cerrada, ya no ocupa el hueco de la llave: otra corrida igual puede empezar (regenerar con force).
  begin
    insert into public.wiki_runs (org_id, repo_full_name, commit_sha, huella) values (v_org, 'acme/tienda', v_sha, v_huella2);
    r := r || 'tras cerrar otra en curso:true | ';
  exception when unique_violation then r := r || 'tras cerrar otra en curso:false | ';
  end;
  -- Una corrida cerrada ya no cambia; un patch que no es objeto tampoco hace nada.
  r := r || 'cerrada:' || public.vg_wiki_avanzar(v_id, v_org, 2, '{"version":1,"n":3}', '{"status":"failed"}') || ' | ';
  insert into public.wiki_runs (org_id, repo_full_name) values (v_org, 'acme/tienda') returning id into v_id;
  r := r || 'patch no objeto:' || public.vg_wiki_avanzar(v_id, v_org, 0, null, '[1]') || ' | ';

  -- ai_usage admite las rutas de la wiki (y sigue rechazando las que no existen).
  insert into public.ai_usage (org_id, route, model, cost_usd, stop_reason) values (v_org, 'wiki_sintesis', 'claude-sonnet-5-5', 0, 'end_turn');
  r := r || 'ai_usage wiki_sintesis:true | ';
  begin
    insert into public.ai_usage (org_id, route, model, cost_usd, stop_reason) values (v_org, 'wiki_otra', 'claude-sonnet-5-5', 0, 'end_turn');
    r := r || 'ai_usage otra:true | ';
  exception when check_violation then r := r || 'ai_usage otra:false | ';
  end;

  -- Permisos: RLS sin políticas, nada para anon ni authenticated, DML para service_role; la RPC solo para service_role.
  r := r || 'rls:' || (select c.relrowsecurity from pg_class c where c.oid = 'public.wiki_runs'::regclass)
         || '/' || (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'wiki_runs') || ' políticas | ';
  r := r || 'anon:' || (has_table_privilege('anon', 'public.wiki_runs', 'select') or has_table_privilege('anon', 'public.wiki_runs', 'insert'))
         || ' | authenticated:' || (has_table_privilege('authenticated', 'public.wiki_runs', 'select')
                                    or has_table_privilege('authenticated', 'public.wiki_runs', 'update'))
         || ' | service_role:' || (has_table_privilege('service_role', 'public.wiki_runs', 'select')
                                   and has_table_privilege('service_role', 'public.wiki_runs', 'insert')
                                   and has_table_privilege('service_role', 'public.wiki_runs', 'update')
                                   and has_table_privilege('service_role', 'public.wiki_runs', 'delete')) || ' | ';
  r := r || 'rpc anon/authenticated/service_role:'
         || has_function_privilege('anon', 'public.vg_wiki_avanzar(uuid, uuid, int, jsonb, jsonb)', 'execute') || '/'
         || has_function_privilege('authenticated', 'public.vg_wiki_avanzar(uuid, uuid, int, jsonb, jsonb)', 'execute') || '/'
         || has_function_privilege('service_role', 'public.vg_wiki_avanzar(uuid, uuid, int, jsonb, jsonb)', 'execute') || ' | ';
  r := r || 'definer:' || (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p
                           where p.oid = 'public.vg_wiki_avanzar(uuid, uuid, int, jsonb, jsonb)'::regprocedure)
         || ' | índice caché:' || (exists (select 1 from pg_indexes i where i.schemaname = 'public' and i.indexname = 'wiki_runs_cache_idx'
                                           and i.indexdef like '%WHERE (status = ''succeeded''::text)%'))
         || ' | índice en curso:' || (exists (select 1 from pg_indexes i where i.schemaname = 'public'
                                              and i.indexname = 'wiki_runs_en_curso_uidx' and i.indexdef like 'CREATE UNIQUE INDEX%'
                                              and i.indexdef ilike '%coalesce(huella%' and i.indexdef like '%queued%running%'));
  raise exception 'RESULTADO %', r;
end $$;
