-- supabase/tests/ia-topes.sql · topes de IA por org, globales y por ritmo (§11.8): vg_ai_status y vg_ai_reserve.
-- Hay UNA sola key de Claude (local = Worker, decisión de Giovanni): estos topes son la barrera antes del límite de la key.
-- Se corre con execute_sql del MCP o el editor SQL. Siempre termina en ERROR a propósito: el mensaje lleva el resultado y
-- la excepción deshace todo (no queda ninguna fila de prueba en ai_usage ni cambio en app_config).
-- Resultado esperado (sáb 24-oct, 11:12Z):
--   base:normal/cap=1.5 | 70%:reduced | 93%:minimal | reserva 0.2 con 1.40 gastado:org | reserva 0.05:true |
--   tras reservar 1.45:minimal | peor caso 1.5 > 1 USD:request | demo cap=10 | 11.ª reserva en 60 s:rate |
--   global lleno:global | ia_habilitada=false:disabled/off
do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'vg-eval');
  v_demo uuid := '00000000-0000-4000-a000-00000000de00';
  r text := '';
  s jsonb;
begin
  -- vg-eval: tope efectivo least(ai_daily_cap_usd = 15, topes.org_usd_day = 1.5) = 1.5 USD; sin gasto hoy → normal.
  s := public.vg_ai_status(v_org); r := r || 'base:' || (s->>'level') || '/cap=' || (s->>'cap_usd') || ' | ';
  insert into public.ai_usage (org_id, route, model, cost_usd, stop_reason) values (v_org, 'fix_prompt', 'claude-sonnet-5-5', 1.05, 'end_turn');
  s := public.vg_ai_status(v_org); r := r || '70%:' || (s->>'level') || ' | ';
  insert into public.ai_usage (org_id, route, model, cost_usd, stop_reason) values (v_org, 'fix_prompt', 'claude-sonnet-5-5', 0.35, 'end_turn');
  s := public.vg_ai_status(v_org); r := r || '93%:' || (s->>'level') || ' | ';
  r := r || 'reserva 0.2 con 1.40 gastado:' || (public.vg_ai_reserve(v_org, 'fix_prompt', 'claude-sonnet-5-5', 0.2)->>'scope') || ' | ';
  r := r || 'reserva 0.05:' || (public.vg_ai_reserve(v_org, 'fix_prompt', 'claude-sonnet-5-5', 0.05)->>'ok') || ' | ';
  s := public.vg_ai_status(v_org); r := r || 'tras reservar 1.45:' || (s->>'level') || ' | ';
  r := r || 'peor caso 1.5 > 1 USD:' || (public.vg_ai_reserve(v_org, 'fix_prompt', 'claude-sonnet-5-5', 1.5)->>'scope') || ' | ';
  -- Demo: tope demo_usd_day = 10.
  s := public.vg_ai_status(v_demo); r := r || 'demo cap=' || (s->>'cap_usd') || ' | ';
  -- Ritmo: con 10 reservas en 60 s, la siguiente de la misma org → rate.
  for i in 1..10 loop perform public.vg_ai_reserve(v_demo, 'fix_prompt', 'claude-sonnet-5-5', 0.01); end loop;
  r := r || '11.ª reserva en 60 s:' || (public.vg_ai_reserve(v_demo, 'fix_prompt', 'claude-sonnet-5-5', 0.01)->>'scope') || ' | ';
  -- Global: con ~40 USD gastados hoy entre todas las orgs → global.
  insert into public.ai_usage (org_id, route, model, cost_usd, stop_reason) values (null, 'audit_summary', 'claude-opus-5-5', 39.9, 'end_turn');
  r := r || 'global lleno:' || (public.vg_ai_reserve((select id from public.orgs where slug = 'vg-dev'), 'audit_summary', 'claude-opus-5-5', 0.3)->>'scope') || ' | ';
  -- Interruptor de la base: ia_habilitada = false → disabled y nivel off.
  update public.app_config set value = 'false' where key = 'ia_habilitada';
  r := r || 'ia_habilitada=false:' || (public.vg_ai_reserve(v_demo, 'fix_prompt', 'claude-sonnet-5-5', 0.01)->>'code') || '/' || (public.vg_ai_status(v_demo)->>'level');
  raise exception 'RESULTADO %', r;
end $$;
