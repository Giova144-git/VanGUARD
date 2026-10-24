-- supabase/tests/revision.sql · 0013: «nuevo» frente a open/ignored/verified, otro valor en la misma línea, mismo secreto
-- en otro sitio, p_write=false, CAS, alert_state con alert_prefs, PR (revisión anterior del mismo PR, fork) y 0013c (el
-- push que fusiona un PR ya avisado no repite el aviso; un squash sí avisa), checks de notifications y privilegios.
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0013 (o pegado detrás de la migración en la misma
-- llamada, para probarla antes de aplicarla). Siempre termina en ERROR a propósito: el mensaje lleva el resultado y la
-- excepción deshace todo (no queda ninguna fila de prueba).
-- Resultado esperado:
--   1 nuevo:2/pending/critical A=open B=ignored C=open(reapareció) D=open,conn_null | 2 otro valor:1/open(otro valor) |
--   3 mismo secreto:0/none/- insertado=0 | 4 pr:1/pending escrito=0 clave=ok cas=false otra_org=false |
--   5 sync:0/none | 6 merge:1/none/ya_avisado_pr escrito=1 | 7 squash:1/pending | 8 fork:1/none/fork |
--   9 umbral: def_medium=none/bajo_umbral solo_voz=pending wa_off_high=none/bajo_umbral dos_off=none/bajo_umbral
--   wa_low=pending parcial=pending parcial_off=none/- |
--   10 notif: sin_revision=23514 dos_origenes=23514 ok=1 repetida=23505 |
--   11 privilegios anon/auth: 0 de 6 tablas, rpc false/false, clave false/false
create or replace function pg_temp.sha(t text) returns text language sql immutable as $$
  select left(encode(sha256(convert_to(t, 'UTF8')), 'hex'), 40)
$$;
create or replace function pg_temp.fila(p_rule text, p_sev text, p_res text, p_fp text) returns jsonb language sql as $$
  select jsonb_build_object('rule_id', p_rule, 'severity', p_sev, 'title', 'Prueba ' || p_rule, 'resource', p_res,
    'confirmed', true, 'origin', 'rule',
    'evidence', case when p_fp is null then '{}'::jsonb else jsonb_build_object('fingerprint_short', p_fp) end,
    'dedupe_key', encode(sha256(convert_to('rev|' || p_rule || '|' || p_res, 'UTF8')), 'hex'))
$$;
create or replace function pg_temp.rev(p_org uuid, p_cfg uuid, p_event text, p_head text, p_pr int, p_commits text[])
returns uuid language sql as $$
  insert into public.code_reviews (org_id, config_id, event, branch, pr_number, base_sha, head_sha, push_commits, status,
                                   started_at)
  values (p_org, p_cfg, p_event, 'main', p_pr, repeat('0', 39) || '1', p_head, p_commits, 'running', now()) returning id
$$;
create or replace function pg_temp.hallazgo(p_org uuid, x jsonb, p_status text) returns void language sql as $$
  insert into public.findings (org_id, module, rule_id, severity, title, resource, evidence, dedupe_key, status)
  values (p_org, 'codebase', x->>'rule_id', x->>'severity', x->>'title', x->>'resource', x->'evidence', x->>'dedupe_key',
          p_status)
$$;

do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'idor-a');
  v_otra uuid := (select id from public.orgs where slug = 'idor-b');
  v_conn uuid := gen_random_uuid();
  v_cfg uuid := gen_random_uuid();
  fa jsonb := pg_temp.fila('CB_SECRET_STRIPE_LIVE', 'critical', 'src/a.ts:1', 'aaaaaaaa');
  fb jsonb := pg_temp.fila('CB_SECRET_GITHUB_PAT', 'critical', 'src/b.ts:2', 'bbbbbbbb');
  fc jsonb := pg_temp.fila('CB_SECRET_OPENAI', 'critical', 'src/c.ts:3', 'cccccccc');
  fd jsonb := pg_temp.fila('CB_ENV_COMMITTED', 'critical', '.env', null);
  fg jsonb := pg_temp.fila('CB_SECRET_AWS', 'critical', 'src/g.ts:1', '99999999');
  fh jsonb := pg_temp.fila('CB_SECRET_AWS', 'critical', 'src/h.ts:1', '77777777');
  r uuid; r4 uuid; r4b uuid;
  j jsonb;
  s text := '';
  st text;
  n int;
begin
  insert into public.connections (id, org_id, provider, kind, label, meta)
    values (v_conn, v_org, 'github', 'read', 'repo de prueba', '{"repo_full_name":"acme/rev","default_branch":"main"}');
  insert into public.code_review_configs (id, org_id, connection_id, branch, secret_sealed, secret_kid)
    values (v_cfg, v_org, v_conn, 'main', '{"v":1,"kid":"v1","iv":"x","ct":"x","ivk":"x","wdek":"x"}', 'v1');
  delete from public.alert_prefs where org_id = v_org;

  -- 1) open (mismo valor) no es nuevo; ignored tampoco; verified reaparece; el .env sin fila es nuevo
  perform pg_temp.hallazgo(v_org, fa, 'open');
  perform pg_temp.hallazgo(v_org, fb, 'ignored');
  perform pg_temp.hallazgo(v_org, fc, 'verified');
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('r1'), null, '{}');
  j := public.vg_review_findings(v_org, r, jsonb_build_array(fa, fb, fc, fd), true, '{}');
  s := s || '1 nuevo:' || (j->>'nuevos') || '/' || (j->>'alert_state') || '/' || coalesce(j->>'max_severity', '-')
         || ' A=' || (select status from public.findings where org_id = v_org and dedupe_key = fa->>'dedupe_key')
         || ' B=' || (select status from public.findings where org_id = v_org and dedupe_key = fb->>'dedupe_key')
         || ' C=' || (select status || case when status_reason like 'reapareció%' then '(reapareció)' else '' end
                        from public.findings where org_id = v_org and dedupe_key = fc->>'dedupe_key')
         || ' D=' || (select status || case when connection_id is null then ',conn_null' else '' end
                        from public.findings where org_id = v_org and dedupe_key = fd->>'dedupe_key') || ' | ';

  -- 2) mismo sitio con OTRA huella: nuevo y reabre aunque esté ignored
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('r2'), null, '{}');
  j := public.vg_review_findings(v_org, r, jsonb_build_array(jsonb_set(fb, '{evidence,fingerprint_short}', '"b2b2b2b2"')),
                                 true, '{}');
  s := s || '2 otro valor:' || (j->>'nuevos') || '/'
         || (select status || case when status_reason like 'otro valor%' then '(otro valor)' else '' end
               from public.findings where org_id = v_org and dedupe_key = fb->>'dedupe_key') || ' | ';

  -- 3) el mismo secreto (regla + huella de A) en otro sitio: no es nuevo ni se inserta
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('r3'), null, '{}');
  j := public.vg_review_findings(v_org, r,
         jsonb_build_array(pg_temp.fila('CB_SECRET_STRIPE_LIVE', 'critical', 'src/otro.ts:9', 'aaaaaaaa')), true, '{}');
  s := s || '3 mismo secreto:' || (j->>'nuevos') || '/' || (j->>'alert_state') || '/' || coalesce(j->>'max_severity', '-')
         || ' insertado=' || (select count(*) from public.findings where org_id = v_org
                                and dedupe_key = (pg_temp.fila('CB_SECRET_STRIPE_LIVE', 'critical', 'src/otro.ts:9', null)->>'dedupe_key'))
         || ' | ';

  -- 4) PR (p_write = false): no escribe; reported_keys 'dedupe_key:huella'; el CAS no cierra dos veces ni en otra org
  r4 := pg_temp.rev(v_org, v_cfg, 'pull_request', pg_temp.sha('r4'), 7, '{}');
  j := public.vg_review_findings(v_otra, r4, jsonb_build_array(fg), false, '{}');
  st := (j->>'applied');
  j := public.vg_review_findings(v_org, r4, jsonb_build_array(fg), false, '{}');
  s := s || '4 pr:' || (j->>'nuevos') || '/' || (j->>'alert_state')
         || ' escrito=' || (select count(*) from public.findings where org_id = v_org and dedupe_key = fg->>'dedupe_key')
         || ' clave=' || (select case when reported_keys = array[(fg->>'dedupe_key') || ':99999999'] then 'ok' else 'MAL' end
                            from public.code_reviews where id = r4)
         || ' cas=' || (public.vg_review_findings(v_org, r4, jsonb_build_array(fg), false, '{}')->>'applied')
         || ' otra_org=' || st || ' | ';
  update public.code_reviews set alert_state = 'sent', notified_at = now() where id = r4;

  -- 5) synchronize del mismo PR con lo mismo: no es nuevo
  r := pg_temp.rev(v_org, v_cfg, 'pull_request', pg_temp.sha('r5'), 7, '{}');
  j := public.vg_review_findings(v_org, r, jsonb_build_array(fg), false, '{}');
  s := s || '5 sync:' || (j->>'nuevos') || '/' || (j->>'alert_state') || ' | ';

  -- 6) 0013c: el push que fusiona ESE PR (su head en push_commits) escribe el hallazgo pero no repite el aviso
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('r6'), null, array[pg_temp.sha('x'), pg_temp.sha('r4')]);
  j := public.vg_review_findings(v_org, r, jsonb_build_array(fg), true, '{}');
  s := s || '6 merge:' || (j->>'nuevos') || '/' || (j->>'alert_state') || '/'
         || coalesce((select alert_reason from public.code_reviews where id = r), '-')
         || ' escrito=' || (select count(*) from public.findings where org_id = v_org and dedupe_key = fg->>'dedupe_key')
         || ' | ';

  -- 7) squash: el head del PR avisado no está en el push → vuelve a avisar
  r4b := pg_temp.rev(v_org, v_cfg, 'pull_request', pg_temp.sha('r4b'), 8, '{}');
  perform public.vg_review_findings(v_org, r4b, jsonb_build_array(fh), false, '{}');
  update public.code_reviews set alert_state = 'sent', notified_at = now() where id = r4b;
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('r7'), null, array[pg_temp.sha('squash')]);
  j := public.vg_review_findings(v_org, r, jsonb_build_array(fh), true, '{}');
  s := s || '7 squash:' || (j->>'nuevos') || '/' || (j->>'alert_state') || ' | ';

  -- 8) PR de un fork: se revisa en la app, sin aviso
  r := pg_temp.rev(v_org, v_cfg, 'pull_request', pg_temp.sha('r8'), 9, '{}');
  j := public.vg_review_findings(v_org, r, jsonb_build_array(pg_temp.fila('CB_SECRET_AWS', 'critical', 'src/i.ts:1', '66666666')),
                                 false, '{"sin_aviso":"fork"}');
  s := s || '8 fork:' || (j->>'nuevos') || '/' || (j->>'alert_state') || '/'
         || coalesce((select alert_reason from public.code_reviews where id = r), '-') || ' | ';

  -- 9) alert_state con alert_prefs (p_write = false para no tocar findings)
  s := s || '9 umbral:';
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('u1'), null, '{}');
  j := public.vg_review_findings(v_org, r, jsonb_build_array(pg_temp.fila('CB_SECRET_GENERIC', 'medium', 'src/u1.ts:1', null)), false, '{}');
  s := s || ' def_medium=' || (j->>'alert_state') || '/' || coalesce((select alert_reason from public.code_reviews where id = r), '-');
  insert into public.alert_prefs (org_id, review_whatsapp_min, review_voice_min) values (v_org, 'off', 'critical');
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('u2'), null, '{}');
  j := public.vg_review_findings(v_org, r, jsonb_build_array(pg_temp.fila('CB_SECRET_AWS', 'critical', 'src/u2.ts:1', '12121212')), false, '{}');
  s := s || ' solo_voz=' || (j->>'alert_state');
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('u3'), null, '{}');
  j := public.vg_review_findings(v_org, r, jsonb_build_array(pg_temp.fila('CB_SECRET_POSTGRES_URL', 'high', 'src/u3.ts:1', '13131313')), false, '{}');
  s := s || ' wa_off_high=' || (j->>'alert_state') || '/' || coalesce((select alert_reason from public.code_reviews where id = r), '-');
  update public.alert_prefs set review_voice_min = 'off' where org_id = v_org;
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('u4'), null, '{}');
  j := public.vg_review_findings(v_org, r, jsonb_build_array(pg_temp.fila('CB_SECRET_AWS', 'critical', 'src/u4.ts:1', '14141414')), false, '{}');
  s := s || ' dos_off=' || (j->>'alert_state') || '/' || coalesce((select alert_reason from public.code_reviews where id = r), '-');
  update public.alert_prefs set review_whatsapp_min = 'low', review_voice_min = 'critical' where org_id = v_org;
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('u5'), null, '{}');
  j := public.vg_review_findings(v_org, r, jsonb_build_array(pg_temp.fila('CB_SECRET_GENERIC', 'low', 'src/u5.ts:1', null)), false, '{}');
  s := s || ' wa_low=' || (j->>'alert_state');
  delete from public.alert_prefs where org_id = v_org;
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('u6'), null, '{}');
  j := public.vg_review_findings(v_org, r, '[]', false, '{"partial":true,"error_code":"diff_grande"}');
  s := s || ' parcial=' || (j->>'alert_state');
  insert into public.alert_prefs (org_id, review_whatsapp_min, review_voice_min) values (v_org, 'off', 'off');
  r := pg_temp.rev(v_org, v_cfg, 'push', pg_temp.sha('u7'), null, '{}');
  j := public.vg_review_findings(v_org, r, '[]', false, '{"partial":true}');
  s := s || ' parcial_off=' || (j->>'alert_state') || '/' || coalesce((select alert_reason from public.code_reviews where id = r), '-')
         || ' | ';

  -- 10) checks de notifications
  s := s || '10 notif:';
  begin
    insert into public.notifications (org_id, channel, recipient_masked, template)
      values (v_org, 'whatsapp', '+58•••4567', 'code_review_v1');
    s := s || ' sin_revision=ENTRO';
  exception when check_violation then s := s || ' sin_revision=23514';
  end;
  begin
    insert into public.notifications (org_id, incident_id, code_review_id, channel, recipient_masked, template)
      values (v_org, (select id from public.incidents limit 1), r4, 'whatsapp', '+58•••4567', 'code_review_v1');
    s := s || ' dos_origenes=ENTRO';
  exception when check_violation then s := s || ' dos_origenes=23514';
            when not_null_violation then s := s || ' dos_origenes=sin_incidente';
  end;
  insert into public.notifications (org_id, code_review_id, channel, recipient_masked, template)
    values (v_org, r4, 'whatsapp', '+58•••4567', 'code_review_v1');
  s := s || ' ok=' || (select count(*) from public.notifications where code_review_id = r4);
  begin
    insert into public.notifications (org_id, code_review_id, channel, recipient_masked, template)
      values (v_org, r4, 'whatsapp', '+58•••4567', 'code_review_v1');
    s := s || ' repetida=ENTRO';
  exception when unique_violation then s := s || ' repetida=23505';
  end;
  s := s || ' | ';

  -- 11) privilegios: anon y authenticated no leen las tres tablas ni ejecutan la RPC
  select count(*) into n from (values ('anon'), ('authenticated')) ro(rol),
         (values ('public.alert_prefs'), ('public.code_review_configs'), ('public.code_reviews')) t(tabla)
   where has_table_privilege(ro.rol, t.tabla, 'select');
  s := s || '11 privilegios anon/auth: ' || n || ' de 6 tablas, rpc '
         || has_function_privilege('anon', 'public.vg_review_findings(uuid, uuid, jsonb, boolean, jsonb)', 'execute') || '/'
         || has_function_privilege('authenticated', 'public.vg_review_findings(uuid, uuid, jsonb, boolean, jsonb)', 'execute')
         || ', clave ' || has_function_privilege('anon', 'private.clave_revision(jsonb)', 'execute') || '/'
         || has_function_privilege('authenticated', 'private.clave_revision(jsonb)', 'execute');
  raise exception 'RESULTADO %', s;
end $$;
