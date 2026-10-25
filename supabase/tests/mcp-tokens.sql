-- supabase/tests/mcp-tokens.sql · 0014 + 0014b: el cable trampa del name (mcp_tokens_name_no_secreto) rechaza un name con
-- forma de secreto al insertar y al renombrar y acepta uno normal; la restricción queda validada; anon y authenticated no
-- tienen ningún privilegio sobre mcp_tokens (ni de tabla ni de columna) y la tabla tiene RLS sin políticas.
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0014b (o pegado detrás de la migración en la misma
-- llamada, para probarla antes de aplicarla). Siempre termina en ERROR a propósito: el mensaje lleva el resultado y la
-- excepción deshace todo (no queda ni la org ni los tokens de prueba).
-- Resultado esperado:
--   1 check: normal=1 vgk=23514 ghp=23514 sb_secret=23514 renombrar=23514 validada=true |
--   2 privilegios anon/auth: 0 de 22, rls=true politicas=0
create or replace function pg_temp.hash(t text) returns text language sql immutable as $$
  select encode(sha256(convert_to('mcp-tokens.sql|' || t, 'UTF8')), 'hex')
$$;

do $$
declare
  v_org uuid;
  v_id uuid;
  s text := '';
  n int;
begin
  insert into public.orgs (name, slug) values ('Prueba MCP tokens', 'prueba-mcp-' || substr(md5(random()::text), 1, 8))
    returning id into v_org;

  -- 1) el check del name: un nombre normal entra; un vgk_ completo, un PAT de GitHub o una secret key de Supabase no,
  --    ni al insertar ni al renombrar una fila que ya estaba
  s := s || '1 check:';
  insert into public.mcp_tokens (org_id, name, token_hash, last4)
    values (v_org, 'Claude Code de Ana', pg_temp.hash('normal'), 'AAAA') returning id into v_id;
  s := s || ' normal=' || (select count(*) from public.mcp_tokens where id = v_id);
  begin
    insert into public.mcp_tokens (org_id, name, token_hash) values (v_org, 'mi vgk_' || repeat('A', 43), pg_temp.hash('vgk'));
    s := s || ' vgk=ENTRO';
  exception when check_violation then s := s || ' vgk=23514';
  end;
  begin
    insert into public.mcp_tokens (org_id, name, token_hash) values (v_org, 'ghp_' || repeat('a1B2', 9), pg_temp.hash('ghp'));
    s := s || ' ghp=ENTRO';
  exception when check_violation then s := s || ' ghp=23514';
  end;
  begin
    insert into public.mcp_tokens (org_id, name, token_hash) values (v_org, 'sb_secret_' || repeat('x', 20), pg_temp.hash('sb'));
    s := s || ' sb_secret=ENTRO';
  exception when check_violation then s := s || ' sb_secret=23514';
  end;
  begin
    update public.mcp_tokens set name = 'copia vgk_' || repeat('B', 43) where id = v_id;
    s := s || ' renombrar=ENTRO';
  exception when check_violation then s := s || ' renombrar=23514';
  end;
  s := s || ' validada=' || coalesce((select convalidated::text from pg_constraint
                                       where conname = 'mcp_tokens_name_no_secreto'
                                         and conrelid = 'public.mcp_tokens'::regclass), 'FALTA') || ' | ';

  -- 2) privilegios: ni anon ni authenticated tocan mcp_tokens (7 de tabla + 4 de columna, por rol); RLS sin políticas
  select count(*) into n
    from (values ('anon'), ('authenticated')) ro(rol),
         (values ('select', true), ('insert', true), ('update', true), ('delete', false), ('truncate', false),
                 ('references', true), ('trigger', false)) p(priv, columna),
         (values (false), (true)) c(de_columna)
   where (not c.de_columna or p.columna)
     and case when c.de_columna then has_any_column_privilege(ro.rol, 'public.mcp_tokens', p.priv)
              else has_table_privilege(ro.rol, 'public.mcp_tokens', p.priv) end;
  s := s || '2 privilegios anon/auth: ' || n || ' de 22, rls='
         || (select relrowsecurity from pg_class where oid = 'public.mcp_tokens'::regclass)
         || ' politicas=' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'mcp_tokens');
  raise exception 'RESULTADO %', s;
end $$;
