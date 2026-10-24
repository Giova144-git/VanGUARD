-- supabase/tests/anon-demo.sql · 0008e: una sesión anónima solo recibe el canal Realtime de la org is_demo.
-- Se corre con execute_sql del MCP o el editor SQL, DESPUÉS de aplicar 0008e. Siempre termina en ERROR a propósito: el
-- mensaje lleva el resultado y la excepción deshace todo (ni la membresía de prueba ni los mensajes quedan).
-- Fuerza el caso que no debería darse nunca: un anónimo que además es miembro de idor-a. Necesita idor-a sembrada
-- (seed/dev-idor.sql) y al menos un anónimo en la demo (humo-auth.mjs deja uno).
-- Resultado esperado (sáb 24-oct, ensayado antes de aplicar):
--   anon demo:1 | anon idor-a:0 | real idor-a:1 | real demo:0
do $do$
declare
  v_demo uuid := (select id from public.orgs where is_demo);
  v_a uuid := (select id from public.orgs where slug = 'idor-a');
  v_anon uuid := (select m.user_id from public.org_members m join auth.users u on u.id = m.user_id
                   where m.org_id = v_demo and u.is_anonymous limit 1);
  v_real uuid := (select user_id from public.org_members where org_id = v_a limit 1);
  r text := '';
  n int;
begin
  insert into public.org_members (org_id, user_id, role) values (v_a, v_anon, 'viewer');
  insert into realtime.messages (topic, extension, event, payload, private) values
    ('org:' || v_demo, 'broadcast', 'prueba', '{}'::jsonb, true),
    ('org:' || v_a, 'broadcast', 'prueba', '{}'::jsonb, true);

  set local role authenticated;
  -- Anónimo en org:demo → ve.
  perform set_config('request.jwt.claims', json_build_object('sub', v_anon, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  perform set_config('realtime.topic', 'org:' || v_demo, true);
  select count(*) into n from realtime.messages where topic = 'org:' || v_demo and event = 'prueba'; r := r || 'anon demo:' || n || ' | ';
  -- Anónimo en org:idor-a, aun siendo miembro → no ve.
  perform set_config('realtime.topic', 'org:' || v_a, true);
  select count(*) into n from realtime.messages where topic = 'org:' || v_a and event = 'prueba'; r := r || 'anon idor-a:' || n || ' | ';
  -- Usuario real de idor-a → ve.
  perform set_config('request.jwt.claims', json_build_object('sub', v_real, 'role', 'authenticated', 'is_anonymous', false)::text, true);
  select count(*) into n from realtime.messages where topic = 'org:' || v_a and event = 'prueba'; r := r || 'real idor-a:' || n || ' | ';
  -- Usuario real en org:demo, sin ser miembro → no ve.
  perform set_config('realtime.topic', 'org:' || v_demo, true);
  select count(*) into n from realtime.messages where topic = 'org:' || v_demo and event = 'prueba'; r := r || 'real demo:' || n;
  raise exception 'RESULTADO %', r;
end $do$;
