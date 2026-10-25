-- supabase/tests/botones.sql · 0018: columnas nuevas, approvals de una revisión (fix/rvs), un solo origen, acciones nuevas
-- y las de 0005, canje de un solo uso con vg_redeem_approval (devuelve code_review_id), silencio del repo,
-- whatsapp_action, borrado en cascada y privilegios. Necesita la org idor-a sembrada (como revision.sql).
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0018 (o pegado detrás de la migración en la misma
-- llamada, para probarla antes de aplicarla). Siempre termina en ERROR a propósito: el mensaje lleva el resultado y la
-- excepción deshace todo (no queda ninguna fila de prueba).
-- Resultado esperado:
--   1 columnas:code_review_id=uuid muted_until=timestamp with time zone whatsapp_action=text
--   whatsapp_action_at=timestamp with time zone | 2 revision: fix=ok rvs=ok |
--   3 checks: sin_revision=23514 dos_origenes=23514 accion_rara=23514
--   ack_incidente=ok block_ip=ok | 4 canje: fix=1/rev_ok/send_fix repetido=0 otro_tel=0 vencido=0 |
--   5 silencio: muted=true | 6 whatsapp_action: muted=ok rara=23514 sin_fecha=23514 | 7 cascada: 0 |
--   8 privilegios anon/auth: 0 de 6 tablas, rpc false/false
create or replace function pg_temp.h(t text) returns bytea language sql immutable as $$
  select sha256(convert_to(t, 'UTF8'))
$$;

do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'idor-a');
  v_conn uuid := gen_random_uuid();
  v_cfg uuid := gen_random_uuid();
  v_tel text := '58' || '4141234567';
  r uuid;
  v_inc uuid;
  f record;
  s text := '';
  n int;
begin
  if v_org is null then raise exception 'falta la org idor-a'; end if;
  insert into public.connections (id, org_id, provider, kind, label, meta)
    values (v_conn, v_org, 'github', 'read', 'repo de prueba', '{"repo_full_name":"acme/botones","default_branch":"main"}');
  insert into public.code_review_configs (id, org_id, connection_id, branch, secret_sealed, secret_kid)
    values (v_cfg, v_org, v_conn, 'main', '{"v":1,"kid":"v1","iv":"x","ct":"x","ivk":"x","wdek":"x"}', 'v1');
  insert into public.code_reviews (org_id, config_id, event, branch, base_sha, head_sha, status)
    values (v_org, v_cfg, 'push', 'main', repeat('0', 39) || '1', repeat('a', 40), 'done') returning id into r;
  insert into public.incidents (org_id, rule_ids, severity, title, resource, dedupe_key)
    values (v_org, array['CF_UA_TOOL'], 'high', 'Prueba de botones', 'ip:203.0.113.7', encode(pg_temp.h('botones'), 'hex'))
    returning id into v_inc;

  -- 1) columnas nuevas y su tipo
  s := s || '1 columnas:' || (
    select string_agg(column_name || '=' || data_type, ' ' order by column_name)
      from information_schema.columns
     where table_schema = 'public'
       and ((table_name = 'code_review_configs' and column_name = 'muted_until')
            or (table_name = 'code_reviews' and column_name in ('whatsapp_action', 'whatsapp_action_at'))
            or (table_name = 'approvals' and column_name = 'code_review_id'))) || ' | ';

  -- 2) los dos botones del aviso de revisión: una fila por botón con sha256(nonce), como escribe notify/revision.ts
  insert into public.approvals (org_id, code_review_id, action_kind, channel, recipient, nonce_hash, params)
    values (v_org, r, 'send_fix', 'whatsapp', v_tel, pg_temp.h('nonce-fix'), '{}');
  insert into public.approvals (org_id, code_review_id, action_kind, channel, recipient, nonce_hash, params)
    values (v_org, r, 'mute_repo', 'whatsapp', v_tel, pg_temp.h('nonce-rvs'), '{}');
  s := s || '2 revision: fix=' || (select case when count(*) = 1 then 'ok' else 'MAL' end from public.approvals
                                     where code_review_id = r and action_kind = 'send_fix')
         || ' rvs=' || (select case when count(*) = 1 then 'ok' else 'MAL' end from public.approvals
                          where code_review_id = r and action_kind = 'mute_repo') || ' | ';

  -- 3) checks: las de revisión llevan su revisión; nunca incidente y revisión a la vez; acción fuera de la lista; las
  -- de 0005 siguen entrando
  s := s || '3 checks:';
  begin
    insert into public.approvals (org_id, action_kind, channel, recipient, nonce_hash)
      values (v_org, 'send_fix', 'whatsapp', v_tel, pg_temp.h('sin-revision'));
    s := s || ' sin_revision=ENTRO';
  exception when check_violation then s := s || ' sin_revision=23514';
  end;
  begin
    insert into public.approvals (org_id, incident_id, code_review_id, action_kind, channel, recipient, nonce_hash)
      values (v_org, v_inc, r, 'ack', 'whatsapp', v_tel, pg_temp.h('dos-origenes'));
    s := s || ' dos_origenes=ENTRO';
  exception when check_violation then s := s || ' dos_origenes=23514';
  end;
  begin
    insert into public.approvals (org_id, code_review_id, action_kind, channel, recipient, nonce_hash)
      values (v_org, r, 'borrar_repo', 'whatsapp', v_tel, pg_temp.h('accion-rara'));
    s := s || ' accion_rara=ENTRO';
  exception when check_violation then s := s || ' accion_rara=23514';
  end;
  insert into public.approvals (org_id, incident_id, action_kind, channel, recipient, nonce_hash)
    values (v_org, v_inc, 'ack', 'whatsapp', v_tel, pg_temp.h('nonce-ack'));
  insert into public.approvals (org_id, incident_id, action_kind, channel, recipient, nonce_hash, params)
    values (v_org, v_inc, 'block_ip', 'whatsapp', v_tel, pg_temp.h('nonce-blk'), '{"etapa":"proponer"}');
  s := s || ' ack_incidente=' || (select case when count(*) = 1 then 'ok' else 'MAL' end from public.approvals
                                    where incident_id = v_inc and action_kind = 'ack')
         || ' block_ip=' || (select case when count(*) = 1 then 'ok' else 'MAL' end from public.approvals
                               where incident_id = v_inc and action_kind = 'block_ip') || ' | ';

  -- 4) canje del botón fix: un solo uso, solo el remitente de la fila, no vencido; devuelve code_review_id
  select * into f from public.vg_redeem_approval(null, pg_temp.h('nonce-fix'), v_tel);
  s := s || '4 canje: fix=' || (case when f.id is null then 0 else 1 end)
         || '/' || (case when f.code_review_id = r and f.incident_id is null then 'rev_ok' else 'MAL' end)
         || '/' || coalesce(f.action_kind, '-');
  select count(*) into n from public.vg_redeem_approval(null, pg_temp.h('nonce-fix'), v_tel);
  s := s || ' repetido=' || n;
  select count(*) into n from public.vg_redeem_approval(null, pg_temp.h('nonce-rvs'), '584249998877');
  s := s || ' otro_tel=' || n;
  update public.approvals set expires_at = now() - interval '1 second' where nonce_hash = pg_temp.h('nonce-rvs');
  select count(*) into n from public.vg_redeem_approval(null, pg_temp.h('nonce-rvs'), v_tel);
  s := s || ' vencido=' || n || ' | ';

  -- 5) «Silenciar repo 1 h»: muted_until en la configuración, filtrando por id y org como el Worker
  update public.code_review_configs set muted_until = now() + interval '1 hour' where id = v_cfg and org_id = v_org;
  s := s || '5 silencio: muted=' || (select (muted_until > now())::text from public.code_review_configs where id = v_cfg)
         || ' | ';

  -- 6) whatsapp_action: lista cerrada y siempre con su fecha
  s := s || '6 whatsapp_action:';
  update public.code_reviews set whatsapp_action = 'muted', whatsapp_action_at = now() where id = r;
  s := s || ' muted=' || (select case when whatsapp_action = 'muted' then 'ok' else 'MAL' end
                            from public.code_reviews where id = r);
  begin
    update public.code_reviews set whatsapp_action = 'borrado', whatsapp_action_at = now() where id = r;
    s := s || ' rara=ENTRO';
  exception when check_violation then s := s || ' rara=23514';
  end;
  begin
    update public.code_reviews set whatsapp_action = 'fix_sent', whatsapp_action_at = null where id = r;
    s := s || ' sin_fecha=ENTRO';
  exception when check_violation then s := s || ' sin_fecha=23514';
  end;
  s := s || ' | ';

  -- 7) borrar la revisión borra sus botones
  delete from public.code_reviews where id = r;
  s := s || '7 cascada: ' || (select count(*) from public.approvals where code_review_id = r) || ' | ';

  -- 8) privilegios: anon y authenticated no leen las tablas tocadas ni canjean
  select count(*) into n from (values ('anon'), ('authenticated')) ro(rol),
         (values ('public.approvals'), ('public.code_review_configs'), ('public.code_reviews')) t(tabla)
   where has_table_privilege(ro.rol, t.tabla, 'select');
  s := s || '8 privilegios anon/auth: ' || n || ' de 6 tablas, rpc '
         || has_function_privilege('anon', 'public.vg_redeem_approval(uuid, bytea, text)', 'execute') || '/'
         || has_function_privilege('authenticated', 'public.vg_redeem_approval(uuid, bytea, text)', 'execute');
  raise exception 'RESULTADO %', s;
end $$;
