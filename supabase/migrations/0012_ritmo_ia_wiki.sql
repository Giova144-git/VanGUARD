-- 0012_ritmo_ia_wiki.sql · vg_ai_reserve con un tope de ritmo propio para las rutas wiki_* (decisión del ORQUESTADOR).
-- Una wiki hace ~12 llamadas seguidas (triage + una por área + síntesis) y el tope de 10 reservas por 60 s y org la
-- frenaba (codigo ia_ritmo en la corrida bf89ec57, 60 s perdidos) y además le quitaba el turno a «Generar prompt» (E15)
-- y al resumen de una auditoría. Ahora el minuto se cuenta por clase de ruta: wiki_* hasta 20 por 60 s y org; el resto
-- sigue en 10. El tope diario de la org y el global en USD siguen sumando TODAS las rutas. Mismo cuerpo que 0007 salvo
-- el conteo y el límite del ritmo.
create or replace function public.vg_ai_reserve(p_org uuid, p_route text, p_model text, p_worst_usd numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_day timestamptz := date_trunc('day', now() at time zone 'America/Caracas') at time zone 'America/Caracas';
  v_wiki boolean := left(coalesce(p_route, ''), 5) = 'wiki_';
  v_ritmo int := 10;                                                    -- reservas por 60 s y org; wiki_*: 20
  v_topes jsonb; v_on boolean; v_global numeric; v_org numeric; v_min int; v_demo boolean; v_cap numeric; v_lim numeric; v_id uuid;
begin
  if v_wiki then v_ritmo := 20; end if;
  if p_worst_usd is null or p_worst_usd <= 0 or p_worst_usd > 1 then          -- una sola llamada nunca pasa de 1 USD (§11.8)
    return jsonb_build_object('ok', false, 'code', 'budget', 'scope', 'request'); end if;
  perform pg_advisory_xact_lock(hashtext('vg_ai_budget'));
  select value into v_topes from public.app_config where key = 'topes';
  select (value #>> '{}')::boolean into v_on from public.app_config where key = 'ia_habilitada';
  if not coalesce(v_on, false) then return jsonb_build_object('ok', false, 'code', 'disabled'); end if;
  select is_demo, ai_daily_cap_usd into v_demo, v_cap from public.orgs where id = p_org;
  if not found then return jsonb_build_object('ok', false, 'code', 'budget', 'scope', 'org'); end if;
  select coalesce(sum(cost_usd), 0) into v_global from public.ai_usage where created_at >= v_day;
  -- Gasto del día de la org: todas las rutas. Ritmo del último minuto: solo las de la misma clase (wiki_* o el resto).
  select coalesce(sum(cost_usd), 0),
         count(*) filter (where created_at > now() - interval '60 seconds' and (left(route, 5) = 'wiki_') = v_wiki)
    into v_org, v_min from public.ai_usage where created_at >= v_day and org_id = p_org;
  v_lim := case when v_demo then coalesce((v_topes->>'demo_usd_day')::numeric, 0)          -- sin tope configurado → 0 (sin IA), nunca «sin límite»
                else least(coalesce(v_cap, 1.5), coalesce((v_topes->>'org_usd_day')::numeric, 0)) end;
  if v_global + p_worst_usd > coalesce((v_topes->>'global_usd_day')::numeric, 0)
     then return jsonb_build_object('ok', false, 'code', 'budget', 'scope', 'global'); end if;
  if v_org + p_worst_usd > v_lim then return jsonb_build_object('ok', false, 'code', 'budget', 'scope', 'org'); end if;
  if v_min >= v_ritmo then return jsonb_build_object('ok', false, 'code', 'budget', 'scope', 'rate'); end if;
  insert into public.ai_usage (org_id, route, model, cost_usd, stop_reason)
  values (p_org, p_route, p_model, p_worst_usd, 'reserved') returning id into v_id;
  return jsonb_build_object('ok', true, 'usage_id', v_id,
    'global_pct', round(100 * (v_global + p_worst_usd) / (v_topes->>'global_usd_day')::numeric, 1));
end $$;
revoke all on function public.vg_ai_reserve(uuid, text, text, numeric) from public, anon, authenticated;
grant execute on function public.vg_ai_reserve(uuid, text, text, numeric) to service_role;
