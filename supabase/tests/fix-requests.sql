-- supabase/tests/fix-requests.sql · 0023: una petición abierta por hallazgo, la FK a un hallazgo de la misma org, las
-- transiciones (enviado → arreglando → corregido; cerradas no se reabren), el cierre automático cuando el hallazgo deja
-- de estar abierto (verified/fixed = corregido, ignored = cancelado), las políticas (miembros leen; owner/admin no
-- anónimo crean y cancelan; viewer y anónimo no) y los privilegios (anon y authenticated sin nada, como todo public).
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0023 (o pegado detrás de la migración en la misma
-- llamada). Siempre termina en ERROR a propósito: el mensaje lleva el resultado y la excepción deshace todo (orgs,
-- usuarios, hallazgos, peticiones y los grants temporales con los que se prueban las políticas).
-- Resultado esperado:
--   1 abierta: primera=enviado segunda=23505 arreglando=23505 | 2 otra org=23503 |
--   3 transiciones: arreglando=ok started=true volver=23514 cerrar_sin_fecha=23514 cancelar=ok reabrir=23514
--   mover=23514 nueva_tras_cerrar=ok |
--   4 cierre: verified=cancelado,corregido fixed=corregido ignored=cancelado reabrir_hallazgo=corregido |
--   5 rls: admin_ve=1 otra_org_ve=0 admin_crea=ok crea_en_otra=42501 viewer_crea=42501 viewer_cancela=0
--   admin_arreglando=42501 admin_cancela=1 anon_ve=0 |
--   6 privilegios anon/auth: 0 de 22, rls=true politicas=3 realtime=true cierre=true
create or replace function pg_temp.hallazgo(p_org uuid, p_regla text) returns uuid language sql as $$
  insert into public.findings (org_id, module, rule_id, severity, title, resource, dedupe_key)
  values (p_org, 'codebase', p_regla, 'high', 'Prueba ' || p_regla, 'src/' || lower(p_regla) || '.ts',
          encode(sha256(convert_to('fix-requests|' || p_org || '|' || p_regla, 'UTF8')), 'hex'))
  returning id
$$;
create or replace function pg_temp.como(p_user uuid, p_anon boolean default false) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'is_anonymous', p_anon)::text, true);
$$;

do $$
declare
  v_a uuid; v_b uuid;
  u_admin uuid := gen_random_uuid(); u_viewer uuid := gen_random_uuid(); u_anon uuid := gen_random_uuid();
  f1 uuid; f2 uuid; f3 uuid; f4 uuid; f5 uuid; fb uuid;
  v_id uuid;
  s text := '';
  n int;
begin
  insert into public.orgs (name, slug) values ('Prueba fix A', 'prueba-fix-a-' || substr(md5(random()::text), 1, 8))
    returning id into v_a;
  insert into public.orgs (name, slug) values ('Prueba fix B', 'prueba-fix-b-' || substr(md5(random()::text), 1, 8))
    returning id into v_b;
  insert into auth.users (id, email, is_anonymous) values
    (u_admin, 'fix-admin-' || u_admin || '@vanguard.test', false),
    (u_viewer, 'fix-viewer-' || u_viewer || '@vanguard.test', false),
    (u_anon, null, true);
  insert into public.org_members (org_id, user_id, role) values
    (v_a, u_admin, 'admin'), (v_a, u_viewer, 'viewer'), (v_a, u_anon, 'admin');
  f1 := pg_temp.hallazgo(v_a, 'CB_PRUEBA_UNO');   f2 := pg_temp.hallazgo(v_a, 'CB_PRUEBA_DOS');
  f3 := pg_temp.hallazgo(v_a, 'CB_PRUEBA_TRES');  f4 := pg_temp.hallazgo(v_a, 'CB_PRUEBA_CUATRO');
  f5 := pg_temp.hallazgo(v_a, 'CB_PRUEBA_CINCO'); fb := pg_temp.hallazgo(v_b, 'CB_PRUEBA_OTRA');

  -- 1) una abierta por hallazgo
  s := s || '1 abierta:';
  insert into public.fix_requests (org_id, finding_id) values (v_a, f1) returning id into v_id;
  s := s || ' primera=' || (select status from public.fix_requests where id = v_id);
  begin insert into public.fix_requests (org_id, finding_id) values (v_a, f1); s := s || ' segunda=ENTRO';
  exception when unique_violation then s := s || ' segunda=23505'; end;
  begin insert into public.fix_requests (org_id, finding_id, status, started_at) values (v_a, f1, 'arreglando', now());
    s := s || ' arreglando=ENTRO';
  exception when unique_violation then s := s || ' arreglando=23505'; end;

  -- 2) un hallazgo de otra org no entra (FK compuesta)
  begin insert into public.fix_requests (org_id, finding_id) values (v_a, fb); s := s || ' | 2 otra org=ENTRO';
  exception when foreign_key_violation then s := s || ' | 2 otra org=23503'; end;

  -- 3) transiciones
  s := s || ' | 3 transiciones:';
  update public.fix_requests set status = 'arreglando', started_at = now() where id = v_id;
  s := s || ' arreglando=ok started=' || (select started_at is not null from public.fix_requests where id = v_id);
  begin update public.fix_requests set status = 'enviado' where id = v_id; s := s || ' volver=ENTRO';
  exception when check_violation then s := s || ' volver=23514'; end;
  begin update public.fix_requests set status = 'cancelado' where id = v_id; s := s || ' cerrar_sin_fecha=ENTRO';
  exception when check_violation then s := s || ' cerrar_sin_fecha=23514'; end;
  update public.fix_requests set status = 'cancelado', closed_at = now() where id = v_id;
  s := s || ' cancelar=ok';
  begin update public.fix_requests set status = 'arreglando', closed_at = null where id = v_id; s := s || ' reabrir=ENTRO';
  exception when check_violation then s := s || ' reabrir=23514'; end;
  begin update public.fix_requests set finding_id = f2 where id = v_id; s := s || ' mover=ENTRO';
  exception when check_violation then s := s || ' mover=23514'; end;
  insert into public.fix_requests (org_id, finding_id) values (v_a, f1);
  s := s || ' nueva_tras_cerrar=ok';

  -- 4) el hallazgo deja de estar abierto → su petición abierta se cierra sola
  s := s || ' | 4 cierre:';
  update public.findings set status = 'verified', verified_at = now() where id = f1;
  s := s || ' verified=' || (select string_agg(status, ',' order by status) from public.fix_requests where finding_id = f1);
  insert into public.fix_requests (org_id, finding_id, status, started_at) values (v_a, f2, 'arreglando', now());
  update public.findings set status = 'fixed' where id = f2;
  s := s || ' fixed=' || (select status from public.fix_requests where finding_id = f2);
  insert into public.fix_requests (org_id, finding_id) values (v_a, f3);
  update public.findings set status = 'ignored', status_reason = 'prueba' where id = f3;
  s := s || ' ignored=' || (select status from public.fix_requests where finding_id = f3);
  update public.findings set status = 'open' where id = f2;                   -- reabrir el hallazgo no reabre la petición
  s := s || ' reabrir_hallazgo=' || (select status from public.fix_requests where finding_id = f2);

  -- 5) políticas, con grants temporales (decisión (a): en producción authenticated no tiene ninguno)
  grant select, insert, update on public.fix_requests to authenticated;
  s := s || ' | 5 rls:';
  insert into public.fix_requests (org_id, finding_id) values (v_b, fb);     -- una de otra org, como postgres
  insert into public.fix_requests (org_id, finding_id) values (v_a, f4) returning id into v_id;
  set local role authenticated;
  perform pg_temp.como(u_admin);
  select count(*) into n from public.fix_requests where finding_id = f4;  s := s || ' admin_ve=' || n;
  select count(*) into n from public.fix_requests where org_id = v_b;     s := s || ' otra_org_ve=' || n;
  begin insert into public.fix_requests (org_id, finding_id, requested_by) values (v_a, f5, u_admin); s := s || ' admin_crea=ok';
  exception when insufficient_privilege then s := s || ' admin_crea=42501'; end;
  begin insert into public.fix_requests (org_id, finding_id, requested_by) values (v_b, fb, u_admin); s := s || ' crea_en_otra=ENTRO';
  exception when insufficient_privilege then s := s || ' crea_en_otra=42501'; end;
  perform pg_temp.como(u_viewer);
  begin insert into public.fix_requests (org_id, finding_id, requested_by) values (v_a, f3, u_viewer); s := s || ' viewer_crea=ENTRO';
  exception when insufficient_privilege then s := s || ' viewer_crea=42501'; end;
  update public.fix_requests set status = 'cancelado', closed_at = now() where id = v_id;
  get diagnostics n = row_count;  s := s || ' viewer_cancela=' || n;
  perform pg_temp.como(u_admin);
  begin update public.fix_requests set status = 'arreglando', started_at = now() where id = v_id; s := s || ' admin_arreglando=ENTRO';
  exception when insufficient_privilege then s := s || ' admin_arreglando=42501'; end;
  update public.fix_requests set status = 'cancelado', closed_at = now() where id = v_id;
  get diagnostics n = row_count;  s := s || ' admin_cancela=' || n;
  perform pg_temp.como(u_anon, true);                                         -- anónimo «admin» de una org que no es demo
  select count(*) into n from public.fix_requests where org_id = v_a;     s := s || ' anon_ve=' || n;
  reset role;
  revoke select, insert, update on public.fix_requests from authenticated;

  -- 6) privilegios: ni anon ni authenticated tocan fix_requests (7 de tabla + 4 de columna, por rol); RLS con 3 políticas
  select count(*) into n
    from (values ('anon'), ('authenticated')) ro(rol),
         (values ('select', true), ('insert', true), ('update', true), ('delete', false), ('truncate', false),
                 ('references', true), ('trigger', false)) p(priv, columna),
         (values (false), (true)) c(de_columna)
   where (not c.de_columna or p.columna)
     and case when c.de_columna then has_any_column_privilege(ro.rol, 'public.fix_requests', p.priv)
              else has_table_privilege(ro.rol, 'public.fix_requests', p.priv) end;
  s := s || ' | 6 privilegios anon/auth: ' || n || ' de 22, rls='
         || (select relrowsecurity from pg_class where oid = 'public.fix_requests'::regclass)
         || ' politicas=' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'fix_requests')
         || ' realtime=' || exists (select 1 from pg_trigger where tgname = 'vg_broadcast'
                                       and tgrelid = 'public.fix_requests'::regclass)
         || ' cierre=' || exists (select 1 from pg_trigger where tgname = 'vg_fix_request_cierre'
                                     and tgrelid = 'public.findings'::regclass);
  raise exception 'RESULTADO %', s;
end $$;
