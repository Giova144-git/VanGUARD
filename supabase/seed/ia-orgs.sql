-- supabase/seed/ia-orgs.sql · literal de PLAN_MAESTRO §05.11 (BACK; después de 0008). vg-dev recibe el gasto de IA del
-- desarrollo local y la prueba de humo; vg-eval, el de la evaluación de §11.14. Sin miembros: nadie las ve por RLS.
-- ai_daily_cap_usd = 15: vg_ai_reserve aplica least(ai_daily_cap_usd, topes.org_usd_day). Con el 1,5 por defecto, el modo
-- desarrollo de la §11.8 (org_usd_day = 15) no tendría efecto en estas orgs; en modo jurado el tope vuelve a 1,5 por el least.
insert into public.orgs (name, slug, ai_daily_cap_usd) values
  ('Desarrollo IA', 'vg-dev', 15), ('Evaluación IA', 'vg-eval', 15)
on conflict (slug) do update set ai_daily_cap_usd = excluded.ai_daily_cap_usd;
