-- supabase/tests/ia-ritmo-wiki.sql · 0012: el ritmo de vg_ai_reserve se cuenta por clase de ruta (wiki_* hasta 20 por 60 s
-- y org; el resto hasta 10) y el gasto diario de la org sigue sumando todas las rutas.
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0012. Siempre termina en ERROR a propósito: el
-- mensaje lleva el resultado y la excepción deshace todo (no queda ninguna fila de prueba en ai_usage).
-- Resultado esperado:
--   12 de una wiki seguidas:12 ok | 10 fix_prompt además:10 ok | 11.º fix_prompt:rate | 21.ª wiki:rate |
--   wiki tras 10 fix_prompt sigue:true | el diario suma todo:org | rpc anon/authenticated:false/false
do $$
declare
  v_demo uuid := '00000000-0000-4000-a000-00000000de00';
  v_eval uuid := (select id from public.orgs where slug = 'vg-eval');
  n int := 0;
  r text := '';
  s jsonb;
begin
  -- Una wiki entera (triage + 10 áreas + síntesis) ya no choca con el ritmo.
  for i in 1..12 loop
    if (public.vg_ai_reserve(v_demo, case when i = 1 then 'wiki_triage' when i = 12 then 'wiki_sintesis' else 'wiki_area' end,
        'claude-haiku-5-5', 0.01)->>'ok')::boolean then n := n + 1; end if;
  end loop;
  r := r || '12 de una wiki seguidas:' || n || ' ok | ';
  -- Las otras rutas tienen su propio minuto: 10 más caben aunque la wiki haya hecho 12.
  n := 0;
  for i in 1..10 loop
    if (public.vg_ai_reserve(v_demo, 'fix_prompt', 'claude-sonnet-5-5', 0.01)->>'ok')::boolean then n := n + 1; end if;
  end loop;
  r := r || '10 fix_prompt además:' || n || ' ok | ';
  r := r || '11.º fix_prompt:' || (public.vg_ai_reserve(v_demo, 'fix_prompt', 'claude-sonnet-5-5', 0.01)->>'scope') || ' | ';
  -- La wiki llega a 20 por minuto y la 21.ª espera.
  for i in 13..20 loop perform public.vg_ai_reserve(v_demo, 'wiki_area', 'claude-haiku-5-5', 0.01); end loop;
  r := r || '21.ª wiki:' || (public.vg_ai_reserve(v_demo, 'wiki_area', 'claude-haiku-5-5', 0.01)->>'scope') || ' | ';
  -- En otra org: 10 fix_prompt no le quitan el turno a la wiki.
  for i in 1..10 loop perform public.vg_ai_reserve(v_eval, 'fix_prompt', 'claude-sonnet-5-5', 0.01); end loop;
  r := r || 'wiki tras 10 fix_prompt sigue:' || (public.vg_ai_reserve(v_eval, 'wiki_triage', 'claude-haiku-5-5', 0.01)->>'ok') || ' | ';
  -- El tope diario de la org (vg-eval: 1,5 USD) suma wiki y resto: con 1,45 USD de fix_prompt, una wiki de 0,1 no cabe.
  insert into public.ai_usage (org_id, route, model, cost_usd, stop_reason, created_at)
    values (v_eval, 'fix_prompt', 'claude-sonnet-5-5', 1.45, 'end_turn', now() - interval '2 hours');
  r := r || 'el diario suma todo:' || (public.vg_ai_reserve(v_eval, 'wiki_sintesis', 'claude-sonnet-5-5', 0.1)->>'scope') || ' | ';
  r := r || 'rpc anon/authenticated:' || has_function_privilege('anon', 'public.vg_ai_reserve(uuid, text, text, numeric)', 'execute')
         || '/' || has_function_privilege('authenticated', 'public.vg_ai_reserve(uuid, text, text, numeric)', 'execute');
  raise exception 'RESULTADO %', r;
end $$;
