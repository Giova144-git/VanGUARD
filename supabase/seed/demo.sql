-- supabase/seed/demo.sql · literal de PLAN_MAESTRO §05.11 (BACK; en accshmgmfrqrxubpuxcl, una vez, después de 0008; sin
-- teléfonos, correos ni tokens; el id de la org es el ORG_DEMO de packages/contracts/src/fixtures/ids.ts).
-- Estado: la org se aplicó el sáb 24-oct tras 0008b. Las dos filas de perf_runs NO se han aplicado: llevan marcadores __X__
-- que se sustituyen por la medición real (plan B de las 19:00, §10.11).

-- daily_audit = false: una re-auditoría a las 06:00 del domingo cambiaría el estado de la demo y gastaría IA (§15.12).
insert into public.orgs (id, name, slug, is_demo, daily_audit, ai_daily_cap_usd)
values ('00000000-0000-4000-a000-00000000de00', 'Tienda Demo', 'demo', true, false, 10)
on conflict (id) do nothing;
-- Rendimiento P0: medición REAL tomada a mano el sábado en https://pagespeed.web.dev sobre https://demo.officialvanguard.com/
-- (móvil y escritorio). Sustituir cada __X__ por el valor del informe antes de ejecutar (puntajes de 0 a 1, como los da PSI);
-- un dato que falte se omite, no se inventa. PLAN B: la siembra real es scripts/perf-medir.ts + demo/seed-perf.sql de la §10.11
-- (16:30, 17:15 y 18:00, cuando la víctima ya está en línea); esta fila manual solo se pega a las 19:00 si aquello falló.
-- version_label: 'v1-sana' (la versión que esté desplegada al medir).
insert into public.perf_runs (org_id, url, strategy, lighthouse_version, scores, metrics, created_at, trigger, is_representative, version_label) values
 ('00000000-0000-4000-a000-00000000de00', 'https://demo.officialvanguard.com/', 'mobile', '__LH__',
  '{"performance":__P__,"accessibility":__A__,"best-practices":__BP__,"seo":__SEO__}',
  '{"lcp_ms":__LCP__,"tbt_ms":__TBT__,"cls":__CLS__,"fcp_ms":__FCP__,"si_ms":__SI__,"ttfb_ms":__TTFB__}', '__ISO__', 'seed', true, 'v1-sana'),
 ('00000000-0000-4000-a000-00000000de00', 'https://demo.officialvanguard.com/', 'desktop', '__LH__',
  '{"performance":__P__,"accessibility":__A__,"best-practices":__BP__,"seo":__SEO__}',
  '{"lcp_ms":__LCP__,"tbt_ms":__TBT__,"cls":__CLS__,"fcp_ms":__FCP__,"si_ms":__SI__,"ttfb_ms":__TTFB__}', '__ISO__', 'seed', true, 'v1-sana');

-- A mano y sin versionar (lleva correos reales), cuando Giovanni y Gabriel se registren con correo:
-- insert into public.org_members (org_id, user_id, role) select '00000000-0000-4000-a000-00000000de00', id,
--   case when email = '<correo de Giovanni>' then 'owner' else 'admin' end from auth.users
--   where email in ('<correo de Giovanni>', '<correo de Gabriel>') on conflict (org_id, user_id) do update set role = excluded.role;
