-- supabase/tests/bloqueo.sql · 0016 (bloqueo de merge con críticos y cierre del PR): el check con nombre de connections
-- (GitHub admite kind 'action', Supabase no), un solo token de acciones de GitHub por org, los valores por defecto de las
-- columnas nuevas, sus checks (gate_findings ≤ 20 y sin secretos, códigos cortos, umbral, gate_last_error solo del token,
-- gate_pr_action del anexo) y que anon y authenticated siguen sin leer nada.
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0016 (o pegado detrás de la migración en la misma
-- llamada, para probarla antes de aplicarla). Siempre termina en ERROR a propósito: el mensaje lleva el resultado y la
-- excepción deshace todo (no queda ninguna fila de prueba). Necesita las orgs idor-a e idor-b (supabase/seed/dev-idor.sql).
-- Resultado esperado:
--   1 check: con_nombre=1 viejo=0 | 2 alta: github_action=ok supabase_action=23514
--   segunda=23505(connections_github_accion_uidx) otra_org=ok cloudflare_action=ok |
--   3 defaults: gate=false/critical/cerrar_pr=true findings=[] pr=-/- |
--   4 checks: 21=23514 secreto=23514 motivo_secreto=23514 motivo_corto=23514 error=23514 min=23514 last_error=23514
--   pr_action=23514 pr_error=23514 blocking=23514 valido=ok | 5 privilegios anon/auth: 0 de 4 tablas, 0 de 6 columnas
create or replace function pg_temp.alta(p_org uuid, p_provider text, p_kind text, p_meta jsonb, p_semilla text)
returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform public.vg_create_connection(
    jsonb_build_object('id', v_id, 'org_id', p_org, 'provider', p_provider, 'kind', p_kind, 'label', 'prueba bloqueo',
                       'meta', p_meta, 'last4', 'abcd', 'scopes', '[]'::jsonb, 'capabilities', '{}'::jsonb),
    jsonb_build_object('sealed', '{"v":1,"kid":"v1","iv":"x","ct":"x","ivk":"x","wdek":"x"}'::jsonb, 'kid', 'v1',
                       'fingerprint', encode(sha256(convert_to('bloqueo|' || p_semilla, 'UTF8')), 'hex')));
  return v_id;
end $$;
-- Prueba un UPDATE que debe fallar por un check: '23514' si lo rechaza el check, 'ENTRO' si pasa, otro código si no.
create or replace function pg_temp.rechaza(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ENTRO';
exception when check_violation then return '23514';
          when others then return sqlstate;
end $$;

do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'idor-a');
  v_otra uuid := (select id from public.orgs where slug = 'idor-b');
  v_conn uuid;
  v_cfg uuid := gen_random_uuid();
  v_rev uuid;
  v_c text;
  -- Valores con forma de secreto armados en tiempo de ejecución: ningún literal en el repo.
  v_secreto text := 'gh' || 'p_' || repeat('A1b2', 9);
  s text := '';
  n int;
begin
  if v_org is null or v_otra is null then raise exception 'faltan las orgs idor-a e idor-b'; end if;

  -- 1) el check sin nombre de 0003 ya no está; queda uno con nombre
  select count(*) into n from pg_constraint where conrelid = 'public.connections'::regclass and contype = 'c'
     and conname = 'connections_accion_proveedor';
  s := s || '1 check: con_nombre=' || n;
  select count(*) into n from pg_constraint where conrelid = 'public.connections'::regclass and contype = 'c'
     and conname <> 'connections_accion_proveedor' and pg_get_constraintdef(oid) like '%kind = ''read''::text%';
  s := s || ' viejo=' || n || ' | ';

  -- 2) altas: GitHub action entra (una por org), Supabase action no, Cloudflare action sigue entrando
  s := s || '2 alta:';
  v_conn := pg_temp.alta(v_org, 'github', 'read', '{"repo_full_name":"acme/bloqueo","repo_id":42}', 'lectura');
  perform pg_temp.alta(v_org, 'github', 'action',
    '{"repo_full_name":"acme/bloqueo","repo_id":42,"branch":"main","purpose":"commit_statuses"}', 'estados');
  s := s || ' github_action=ok';
  begin
    perform pg_temp.alta(v_org, 'supabase', 'action', '{"project_ref":"abcdefghijklmnopqrst"}', 'supabase');
    s := s || ' supabase_action=ENTRO';
  exception when check_violation then s := s || ' supabase_action=23514';
  end;
  begin
    perform pg_temp.alta(v_org, 'github', 'action', '{"repo_full_name":"acme/bloqueo","repo_id":42}', 'estados-2');
    s := s || ' segunda=ENTRO';
  exception when unique_violation then
    get stacked diagnostics v_c = constraint_name;
    s := s || ' segunda=23505(' || coalesce(v_c, '?') || ')';
  end;
  perform pg_temp.alta(v_otra, 'github', 'action', '{"repo_full_name":"otra/repo","repo_id":7}', 'estados-otra');
  s := s || ' otra_org=ok';
  perform pg_temp.alta(v_org, 'cloudflare', 'action', '{"zone_id":"0123456789abcdef0123456789abcdef"}', 'cf-accion');
  s := s || ' cloudflare_action=ok | ';

  -- 3) valores por defecto: el bloqueo nace apagado, umbral crítico, «Cerrar los PR» encendido, sin nada publicado
  insert into public.code_review_configs (id, org_id, connection_id, branch, secret_sealed, secret_kid)
    values (v_cfg, v_org, v_conn, 'main', '{"v":1,"kid":"v1","iv":"x","ct":"x","ivk":"x","wdek":"x"}', 'v1');
  insert into public.code_reviews (org_id, config_id, event, branch, pr_number, base_sha, head_sha)
    values (v_org, v_cfg, 'pull_request', 'main', 7, repeat('a', 40), repeat('b', 40)) returning id into v_rev;
  s := s || '3 defaults: gate=' || (select gate_enabled || '/' || gate_min || '/cerrar_pr=' || gate_close_pr
                                      from public.code_review_configs where id = v_cfg)
         || ' findings=' || (select gate_findings::text from public.code_reviews where id = v_rev)
         || ' pr=' || (select coalesce(gate_pr_action, '-') || '/' || coalesce(gate_pr_error, '-')
                         from public.code_reviews where id = v_rev) || ' | ';

  -- 4) checks de las columnas nuevas
  s := s || '4 checks:'
    || ' 21=' || pg_temp.rechaza(format('update public.code_reviews set gate_findings = %L where id = %L',
         (select jsonb_agg(jsonb_build_object('rule_id', 'CB_SECRET_AWS', 'severity', 'critical', 'title', 't',
                                              'resource', 'r', 'finding_id', null)) from generate_series(1, 21)), v_rev))
    || ' secreto=' || pg_temp.rechaza(format('update public.code_reviews set gate_findings = %L where id = %L',
         jsonb_build_array(jsonb_build_object('rule_id', 'CB_SECRET_GITHUB_PAT', 'severity', 'critical',
                                              'title', 'Token de GitHub', 'resource', 'src/' || v_secreto || '.ts:1')), v_rev))
    || ' motivo_secreto=' || pg_temp.rechaza(format(
         'update public.code_reviews set gate_override_reason = %L where id = %L', 'clave ' || v_secreto, v_rev))
    || ' motivo_corto=' || pg_temp.rechaza(format(
         'update public.code_reviews set gate_override_reason = %L where id = %L', 'ok', v_rev))
    || ' error=' || pg_temp.rechaza(format('update public.code_reviews set gate_error = %L where id = %L',
         'Forbidden 403', v_rev))
    || ' min=' || pg_temp.rechaza(format('update public.code_review_configs set gate_min = %L where id = %L',
         'medium', v_cfg))
    || ' last_error=' || pg_temp.rechaza(format('update public.code_review_configs set gate_last_error = %L where id = %L',
         'limite', v_cfg))
    || ' pr_action=' || pg_temp.rechaza(format('update public.code_reviews set gate_pr_action = %L where id = %L',
         'cerrado', v_rev))
    || ' pr_error=' || pg_temp.rechaza(format('update public.code_reviews set gate_pr_error = %L where id = %L',
         'Bad 422', v_rev))
    || ' blocking=' || pg_temp.rechaza(format('update public.code_reviews set gate_blocking = -1 where id = %L', v_rev));
  update public.code_reviews set gate_blocking = 1, gate_state = 'failure', gate_error = null, gate_published_at = now(),
         gate_findings = jsonb_build_array(jsonb_build_object('finding_id', null, 'rule_id', 'CB_SECRET_STRIPE_LIVE',
           'severity', 'critical', 'title', 'Clave live de Stripe en el código', 'resource', 'src/lib/cobros.ts:3')),
         gate_pr_action = 'closed', gate_pr_error = null, gate_pr_at = now(),
         gate_override_reason = 'clave de prueba documentada'
   where id = v_rev;
  update public.code_review_configs set gate_enabled = true, gate_min = 'high', gate_last_error = 'forbidden',
         gate_close_pr = false where id = v_cfg;
  s := s || ' valido=ok | ';

  -- 5) privilegios: anon y authenticated no leen las tablas ni las columnas nuevas
  select count(*) into n from (values ('anon'), ('authenticated')) ro(rol),
         (values ('public.code_reviews'), ('public.code_review_configs')) t(tabla)
   where has_table_privilege(ro.rol, t.tabla, 'select');
  s := s || '5 privilegios anon/auth: ' || n || ' de 4 tablas, ';
  select count(*) into n from (values ('anon'), ('authenticated')) ro(rol),
         (values ('public.code_reviews', 'gate_findings'), ('public.code_reviews', 'gate_pr_action'),
                 ('public.code_review_configs', 'gate_close_pr')) t(tabla, col)
   where has_column_privilege(ro.rol, t.tabla, t.col, 'select');
  s := s || n || ' de 6 columnas';
  raise exception 'RESULTADO %', s;
end $$;
