-- supabase/tests/sandbox.sql · 0026: sandbox de «Ver demo» por visitante y volátil. Copia de la demo (qué se copia y qué
-- no, ids v4 remapeados, acciones en seco, tope de IA), una viva por usuario, latido, RLS (el anónimo ve SU sandbox y
-- nada más), sin conexiones de acciones, topes por IP y global, «replay» de auditoría, salir (idempotente, borra al
-- anónimo), cierre en dos pasos (cerrando + latido), purga por minuto (10 min sin latido o cierra_en vencido; borra
-- a sus dueños anónimos, nunca a una cuenta real ni a un anónimo sin sandbox), notifications 'skipped' con preview y la limpieza de viewers reales de la demo.
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0026 (o pegado detrás de la migración). Siempre
-- termina en ERROR a propósito: el mensaje lleva el resultado y la excepción deshace todo (orgs, usuarios, datos de la
-- demo de prueba y los grants temporales con los que se prueban las políticas). Si la base no tiene org de demo, crea una.
-- Resultado esperado (dom 25-oct, Postgres 16 desechable con las 26 migraciones):
--   1 copia: owner=1 v4=true hallazgos=2 conexiones=3 acciones_conn=0 secretos=0 contactos=0 sim=1 fk=true fotos=true
--   simulado=true provider_id=true codigo_nuevo=true ia=0.20 misma=true | 2 latido: suyo=true ajeno=false |
--   3 rls: anon_org=1 anon_otra=0 anon_hallazgos=2 canal_suyo=1 otro_hallazgos=0 canal_ajeno=0 real_demo=0 |
--   4 acciones: 23514 | 5 replay: ok=true foto=true | 6 cupos: ip=sandbox_cupo_ip global=sandbox_cupo_global |
--   7 salir: borrada=true usuario=true otra_vez=f,f |
--   8 cerrando: suyo=true ajeno=false otra_vez=true latido_anula=true | purga: orgs=2 anon_borrado=true real_vive=true
--   cerrada_borrada=true margen_10min=true recargada=true cerrando_20s=true anon_sin_sandbox_vive=true viva_sigue=true |
--   9 avisos: skipped=ok secreto=23514 | 10 viewers: real=0 equipo=1 anon=1
do $$
declare
  v_demo uuid := (select id from public.orgs where is_demo);
  u_a uuid := gen_random_uuid(); u_b uuid := gen_random_uuid(); u_c uuid := gen_random_uuid();
  u_real uuid := gen_random_uuid(); u_equipo uuid := gen_random_uuid();
  c_sb uuid := gen_random_uuid(); c_cf uuid := gen_random_uuid(); c_act uuid := gen_random_uuid(); c_in uuid := gen_random_uuid();
  v_scan uuid; f1 uuid; f2 uuid; v_inc uuid;
  s_a uuid; s_b uuid; s_r uuid; s_x uuid; v_rep uuid;
  v_ip text := encode(sha256(convert_to('ip-prueba-sandbox', 'UTF8')), 'hex');
  r text := ''; e text; n int; b boolean; j jsonb; v_ids uuid[]; v_duenos uuid[];
begin
  if v_demo is null then
    insert into public.orgs (name, slug, is_demo) values ('Tienda Demo', 'demo-prueba-sbx', true) returning id into v_demo;
  end if;
  insert into auth.users (id, email, is_anonymous) values
    (u_a, null, true), (u_b, null, true), (u_c, null, true),
    (u_real, 'sbx-real-' || u_real || '@vanguard.test', false), (u_equipo, 'sbx-eq-' || u_equipo || '@vanguard.test', false);

  -- Datos de la demo: lectura supabase y cloudflare, acciones de cloudflare, ingesta; una auditoría con dos hallazgos y
  -- su foto; un incidente con su aviso y su bloqueo; tráfico, métricas, un contacto y un secreto que NO deben copiarse.
  insert into public.connections (id, org_id, provider, kind, label, meta) values
    (c_sb, v_demo, 'supabase', 'read', 'Supabase demo', '{"project_ref":"abcdefghijklmnopqrst"}'),
    (c_cf, v_demo, 'cloudflare', 'read', 'Cloudflare demo', '{"zone_id":"0123456789abcdef0123456789abcdef","zone_name":"demo.test"}'),
    (c_act, v_demo, 'cloudflare', 'action', 'Blindaje demo', '{"zone_id":"0123456789abcdef0123456789abcdef","zone_name":"demo.test"}'),
    (c_in, v_demo, 'ingest', 'read', 'tienda.demo.test', '{"hostname":"tienda.demo.test"}');
  insert into public.connection_secrets (connection_id, org_id, sealed, kid, fingerprint) values
    (c_sb, v_demo, '{"v":1,"kid":"v1","iv":"a","ct":"b","ivk":"c","wdek":"d"}', 'v1', repeat('a', 64));
  insert into public.contacts (org_id, name, phone_e164) values (v_demo, 'Equipo', '+584141234567');
  insert into public.scan_runs (org_id, kind, status, progress, steps, score, finished_at)
  values (v_demo, 'full_audit', 'succeeded', 100,
          '[{"name":"supabase","status":"done"},{"name":"cloudflare","status":"done"},{"name":"repo","status":"skipped"},{"name":"resumen_ia","status":"done"}]',
          62, now()) returning id into v_scan;
  insert into public.findings (org_id, scan_run_id, connection_id, module, rule_id, severity, title, resource, dedupe_key)
  values (v_demo, v_scan, c_sb, 'supabase', 'SB_PRUEBA_UNO', 'high', 'Uno', 'tabla.uno', repeat('1', 64)) returning id into f1;
  insert into public.findings (org_id, scan_run_id, connection_id, module, rule_id, severity, title, resource, dedupe_key)
  values (v_demo, v_scan, c_cf, 'cloudflare', 'CF_PRUEBA_DOS', 'medium', 'Dos', 'zona.dos', repeat('2', 64)) returning id into f2;
  perform public.vg_snapshot_audit(v_demo, v_scan);
  insert into public.incidents (org_id, connection_id, rule_ids, severity, title, resource, dedupe_key)
  values (v_demo, c_in, '{CF_IP_FLOOD}', 'critical', 'Ataque', 'ip:203.0.113.7', repeat('3', 64)) returning id into v_inc;
  insert into public.notifications (org_id, incident_id, channel, recipient_masked, template, status, provider_id)
  values (v_demo, v_inc, 'whatsapp', '+58•••••4567', 'edge_critical_v1', 'sent', 'wamid.prueba');
  insert into public.actions (org_id, incident_id, kind, target, status, provider_ref, previous, expires_at)
  values (v_demo, v_inc, 'block_ip', '203.0.113.7', 'executed', 'abc123',
          jsonb_build_object('connection_id', c_act, 'zone_id', '0123456789abcdef0123456789abcdef'), now() + interval '1 hour');
  insert into public.edge_hits (org_id, connection_id, ts, ip, method, path, status, latency_ms)
  values (v_demo, c_in, now(), '203.0.113.7', 'GET', '/', 200, 10);
  insert into public.metric_samples (org_id, connection_id, metric, ts, value) values
    (v_demo, c_sb, 'sb_cpu_pct', now(), 12), (v_demo, c_act, 'cf_req_5m', now(), 3);

  -- 1) Copia
  s_a := private.vg_clone_demo(u_a, null);
  r := r || '1 copia: owner=' || (select count(*) from public.org_members where org_id = s_a and user_id = u_a and role = 'owner');
  r := r || ' v4=' || (s_a::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                       and not exists (select 1 from public.findings where org_id = s_a
                         and id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'));
  r := r || ' hallazgos=' || (select count(*) from public.findings where org_id = s_a);
  r := r || ' conexiones=' || (select count(*) from public.connections where org_id = s_a and meta->>'demostracion' = 'true'
                                 and coalesce(meta->>'simulador', '') <> 'true');
  r := r || ' acciones_conn=' || (select count(*) from public.connections where org_id = s_a and kind = 'action');
  r := r || ' secretos=' || (select count(*) from public.connection_secrets where org_id = s_a);
  r := r || ' contactos=' || (select count(*) from public.contacts where org_id = s_a);
  r := r || ' sim=' || (select count(*) from public.connections where org_id = s_a and provider = 'ingest' and meta->>'simulador' = 'true');
  r := r || ' fk=' || (not exists (select 1 from public.findings f where f.org_id = s_a
                         and (not exists (select 1 from public.scan_runs s where s.id = f.scan_run_id and s.org_id = s_a)
                              or not exists (select 1 from public.connections k where k.id = f.connection_id and k.org_id = s_a))));
  r := r || ' fotos=' || (exists (select 1 from public.audit_snapshots a where a.org_id = s_a and cardinality(a.open_ids) = 2)
                           and not exists (select 1 from public.audit_snapshots a, unnest(a.open_ids) x
                                            where a.org_id = s_a
                                              and not exists (select 1 from public.findings f where f.id = x and f.org_id = s_a)));
  r := r || ' simulado=' || (select bool_and(provider_ref like 'simulado:%' and previous->>'simulado' = 'true')
                               from public.actions where org_id = s_a);
  r := r || ' provider_id=' || (select bool_and(provider_id is null) from public.notifications where org_id = s_a);
  r := r || ' codigo_nuevo=' || (not exists (select 1 from public.incidents i join public.incidents d
                                    on d.org_id = v_demo and d.code = i.code where i.org_id = s_a));
  r := r || ' ia=' || (select ai_daily_cap_usd from public.orgs where id = s_a);
  r := r || ' misma=' || (private.vg_clone_demo(u_a, null) = s_a) || ' | ';
  if (select count(*) from public.metric_samples where org_id = s_a) <> 1 or (select count(*) from public.edge_hits where org_id = s_a) <> 0 then
    raise exception 'métricas o tráfico mal copiados';
  end if;

  -- 2) Latido
  s_b := private.vg_clone_demo(u_b, null);
  r := r || '2 latido: suyo=' || coalesce(public.vg_sandbox_latido(s_a, u_a), false)
         || ' ajeno=' || coalesce(public.vg_sandbox_latido(s_a, u_b), false) || ' | ';

  -- 3) RLS (grant temporal: authenticated no lee public directamente, decisión (a); se deshace con la excepción)
  insert into realtime.messages (topic, extension, event, payload, private)
  values ('org:' || s_a, 'broadcast', 'prueba-sbx', '{}'::jsonb, true);
  grant select on public.orgs, public.findings to authenticated;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', u_a, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  select count(*) into n from public.orgs where id = s_a;      r := r || '3 rls: anon_org=' || n;
  select count(*) into n from public.orgs where id = s_b;      r := r || ' anon_otra=' || n;
  select count(*) into n from public.findings where org_id = s_a; r := r || ' anon_hallazgos=' || n;
  perform set_config('realtime.topic', 'org:' || s_a, true);
  select count(*) into n from realtime.messages where topic = 'org:' || s_a and event = 'prueba-sbx'; r := r || ' canal_suyo=' || n;
  perform set_config('request.jwt.claims', json_build_object('sub', u_b, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  select count(*) into n from public.findings where org_id = s_a; r := r || ' otro_hallazgos=' || n;
  perform set_config('realtime.topic', 'org:' || s_a, true);
  select count(*) into n from realtime.messages where topic = 'org:' || s_a and event = 'prueba-sbx'; r := r || ' canal_ajeno=' || n;
  perform set_config('request.jwt.claims', json_build_object('sub', u_real, 'role', 'authenticated', 'is_anonymous', false)::text, true);
  select count(*) into n from public.orgs where id = v_demo;   r := r || ' real_demo=' || n || ' | ';
  reset role;

  -- 4) Sin conexiones de acciones en una sandbox
  begin
    insert into public.connections (id, org_id, provider, kind, label, meta)
    values (gen_random_uuid(), s_a, 'cloudflare', 'action', 'x', '{"zone_id":"0123456789abcdef0123456789abcdef"}');
    e := 'ok';
  exception when others then e := sqlstate;
  end;
  r := r || '4 acciones: ' || e || ' | ';

  -- 5) Replay
  v_rep := public.vg_sandbox_replay(s_a, u_a);
  r := r || '5 replay: ok=' || (exists (select 1 from public.scan_runs where id = v_rep and org_id = s_a and status = 'succeeded'
                                        and params->>'replay' = 'true'))
         || ' foto=' || (exists (select 1 from public.audit_snapshots where scan_run_id = v_rep)) || ' | ';

  -- 6) Cupos: 10 por IP y hora; 200 vivas en total
  for i in 1..10 loop
    insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id into s_x;
    perform private.vg_clone_demo(s_x, v_ip);
  end loop;
  insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id into s_x;
  begin perform private.vg_clone_demo(s_x, v_ip); e := 'ok'; exception when others then e := sqlerrm; end;
  r := r || '6 cupos: ip=' || e;
  insert into public.orgs (name, slug, sandbox_of, last_seen_at)
  select 'Relleno', 'sbx-relleno-' || g || '-' || substr(md5(random()::text), 1, 6), v_demo, now() from generate_series(1, 200) g;
  begin perform private.vg_clone_demo(s_x, null); e := 'ok'; exception when others then e := sqlerrm; end;
  r := r || ' global=' || e || ' | ';
  delete from public.orgs where name = 'Relleno' and sandbox_of = v_demo;

  -- 7) Salir (idempotente; borra al anónimo sin orgs)
  j := public.vg_sandbox_salir(s_b, u_b);
  r := r || '7 salir: borrada=' || (j->>'borrada') || ' usuario=' || (j->>'usuario_borrado');
  j := public.vg_sandbox_salir(s_b, u_b);
  r := r || ' otra_vez=' || left(j->>'borrada', 1) || ',' || left(j->>'usuario_borrado', 1) || ' | ';

  -- 8) Purga (margen de 10 min y cierre en dos pasos). A: anónimo sin latido hace 11 min → se borra con su usuario.
  -- Cuenta real: cerró la pestaña (E4d) y no volvió → se borra la sandbox, no el usuario. De las 10 del cupo por IP:
  -- p1 sin latido hace 5 min (dentro del margen), p2 cerró y recargó (cerrando + latido), p3 cerró hace 5 s (aún en sus
  -- 20 s): las tres siguen. C es anónimo sin sandbox (acaba de entrar) → no se toca.
  s_r := private.vg_clone_demo(u_real, null);
  update public.orgs set last_seen_at = now() - interval '11 minutes' where id = s_a;
  r := r || '8 cerrando: suyo=' || coalesce(public.vg_sandbox_cerrando(s_r, u_real), false)
         || ' ajeno=' || coalesce(public.vg_sandbox_cerrando(s_r, u_a), false)
         || ' otra_vez=' || coalesce(public.vg_sandbox_cerrando(s_r, u_real), false);
  update public.orgs set cierra_en = now() - interval '1 second' where id = s_r;       -- pasaron los 20 s sin latido
  select array_agg(o.id order by o.id), array_agg(m.user_id order by o.id) into v_ids, v_duenos
    from public.orgs o join public.org_members m on m.org_id = o.id and m.role = 'owner'
   where o.sandbox_of = v_demo and o.id not in (s_a, s_r);
  update public.orgs set last_seen_at = now() - interval '5 minutes' where id = v_ids[1];
  perform public.vg_sandbox_cerrando(v_ids[2], v_duenos[2]);
  update public.orgs set cierra_en = now() - interval '1 second' where id = v_ids[2];
  b := public.vg_sandbox_latido(v_ids[2], v_duenos[2]);                                -- la recarga late: anula el cierre
  r := r || ' latido_anula=' || ((select cierra_en from public.orgs where id = v_ids[2]) is null);
  perform public.vg_sandbox_cerrando(v_ids[3], v_duenos[3]);
  j := private.vg_purgar_sandboxes();
  r := r || ' | purga: orgs=' || (j->>'orgs')
         || ' anon_borrado=' || (not exists (select 1 from auth.users where id = u_a))
         || ' real_vive=' || (exists (select 1 from auth.users where id = u_real))
         || ' cerrada_borrada=' || (not exists (select 1 from public.orgs where id = s_r))
         || ' margen_10min=' || (exists (select 1 from public.orgs where id = v_ids[1]))
         || ' recargada=' || (exists (select 1 from public.orgs where id = v_ids[2]))
         || ' cerrando_20s=' || (exists (select 1 from public.orgs where id = v_ids[3]))
         || ' anon_sin_sandbox_vive=' || (exists (select 1 from auth.users where id = u_c))
         || ' viva_sigue=' || ((select count(*) from public.orgs where sandbox_of = v_demo) = 10) || ' | ';

  -- 9) Aviso no enviado por ser sandbox, con el texto que habría llegado
  s_x := private.vg_clone_demo(u_c, null);
  select id into v_inc from public.incidents where org_id = s_x limit 1;
  begin
    insert into public.notifications (org_id, incident_id, channel, recipient_masked, template, status, error, preview)
    values (s_x, v_inc, 'whatsapp', '+58•••••9999', 'edge_high_v1', 'skipped', 'sandbox', 'VanGUARD: ataque en tu tienda');
    e := 'ok';
  exception when others then e := sqlstate;
  end;
  r := r || '9 avisos: skipped=' || e;
  begin
    insert into public.notifications (org_id, incident_id, channel, recipient_masked, template, status, error, preview)
    values (s_x, v_inc, 'whatsapp', '+58•••••8888', 'edge_high_v1', 'skipped', 'sandbox', 'clave sb_secret_abcdefghijklmnopqrstuv');
    e := 'ok';
  exception when others then e := sqlstate;
  end;
  r := r || ' secreto=' || e || ' | ';

  -- 10) Limpieza del bug de E4 (la misma sentencia de 0026): viewer real fuera; equipo y anónimo se quedan
  insert into public.org_members (org_id, user_id, role) values (v_demo, u_real, 'viewer'), (v_demo, u_equipo, 'admin'),
    (v_demo, u_c, 'viewer');
  delete from public.org_members m using public.orgs o, auth.users u
   where o.id = m.org_id and u.id = m.user_id and o.is_demo and m.role = 'viewer' and u.is_anonymous is not true;
  r := r || '10 viewers: real=' || (select count(*) from public.org_members where org_id = v_demo and user_id = u_real)
         || ' equipo=' || (select count(*) from public.org_members where org_id = v_demo and user_id = u_equipo)
         || ' anon=' || (select count(*) from public.org_members where org_id = v_demo and user_id = u_c);
  raise exception 'RESULTADO %', r;
end $$;
