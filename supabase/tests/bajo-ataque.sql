-- supabase/tests/bajo-ataque.sql · 0017: un solo modo bajo ataque vivo (proposed o executed) por org y objetivo; uno
-- failed o undone libera el host; otra org y block_ip no chocan; toda fila under_attack_on nace con previous
-- {connection_id, zone_id, scope host|zone}; anon y authenticated siguen sin leer actions.
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0017 (o pegado detrás de la migración en la misma
-- llamada, para probarla antes de aplicarla; pegarla DOS veces delante prueba además que es reaplicable). Siempre
-- termina en ERROR a propósito: el mensaje lleva el resultado y la excepción deshace todo (no queda ninguna fila).
-- Resultado esperado:
--   1 alta:ok | 2 segunda proposed:23505 | 3 executed y otra executed:23505 | 4 tras failed:ok | 5 tras undone:ok |
--   6 otra org:ok | 7 block_ip repetido:ok | 8 checks: sin_previous=23514 sin_zona=23514 scope_malo=23514
--   sin_scope=23514 array=23514 block_sin_previous=ok zona=ok | 9 esquema: indice=1 check=1 |
--   10 privilegios anon/auth: false/false
do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'idor-a');
  v_otra uuid := (select id from public.orgs where slug = 'idor-b');
  v_host text := 'prueba-ataque.vanguard.test';
  v_prev jsonb := jsonb_build_object('connection_id', gen_random_uuid(), 'zone_id', repeat('a', 32), 'scope', 'host',
                                     'ref', 'vg_ua_' || repeat('0', 32));
  a1 uuid; a2 uuid;
  s text := '';
begin
  if v_org is null or v_otra is null then raise exception 'RESULTADO faltan las orgs idor-a e idor-b'; end if;

  -- 1) la primera activación en curso entra
  insert into public.actions (org_id, kind, target, status, previous)
    values (v_org, 'under_attack_on', v_host, 'proposed', v_prev) returning id into a1;
  s := s || '1 alta:ok | ';

  -- 2) otra proposed del mismo host y org (dos confirmaciones a la vez) choca
  begin
    insert into public.actions (org_id, kind, target, status, previous) values (v_org, 'under_attack_on', v_host, 'proposed', v_prev);
    s := s || '2 segunda proposed:ENTRO | ';
  exception when unique_violation then s := s || '2 segunda proposed:23505 | ';
  end;

  -- 3) ya activa (executed): una segunda executed del mismo host choca
  update public.actions set status = 'executed', provider_ref = repeat('b', 32) where id = a1;
  begin
    insert into public.actions (org_id, kind, target, status, previous) values (v_org, 'under_attack_on', v_host, 'executed', v_prev);
    s := s || '3 executed y otra executed:ENTRO | ';
  exception when unique_violation then s := s || '3 executed y otra executed:23505 | ';
  end;

  -- 4) y 5) failed o undone ya no ocupan el host
  update public.actions set status = 'failed' where id = a1;
  insert into public.actions (org_id, kind, target, status, previous)
    values (v_org, 'under_attack_on', v_host, 'proposed', v_prev) returning id into a2;
  s := s || '4 tras failed:ok | ';
  update public.actions set status = 'undone', undone_at = now() where id = a2;
  insert into public.actions (org_id, kind, target, status, previous) values (v_org, 'under_attack_on', v_host, 'executed', v_prev);
  s := s || '5 tras undone:ok | ';

  -- 6) el mismo host en otra org no choca (el índice es por org)
  insert into public.actions (org_id, kind, target, status, previous) values (v_otra, 'under_attack_on', v_host, 'executed', v_prev);
  s := s || '6 otra org:ok | ';

  -- 7) el índice es solo de under_attack_on: dos block_ip vivos con el mismo target siguen entrando
  insert into public.actions (org_id, kind, target, status) values (v_org, 'block_ip', v_host, 'proposed');
  insert into public.actions (org_id, kind, target, status) values (v_org, 'block_ip', v_host, 'executed');
  s := s || '7 block_ip repetido:ok | ';

  -- 8) el check de previous (D8), con un objetivo libre para que no salte antes el índice
  s := s || '8 checks:';
  begin
    insert into public.actions (org_id, kind, target, status) values (v_org, 'under_attack_on', 'x1.vanguard.test', 'proposed');
    s := s || ' sin_previous=ENTRO';
  exception when check_violation then s := s || ' sin_previous=23514';
  end;
  begin
    insert into public.actions (org_id, kind, target, status, previous)
      values (v_org, 'under_attack_on', 'x2.vanguard.test', 'proposed', v_prev - 'zone_id');
    s := s || ' sin_zona=ENTRO';
  exception when check_violation then s := s || ' sin_zona=23514';
  end;
  begin
    insert into public.actions (org_id, kind, target, status, previous)
      values (v_org, 'under_attack_on', 'x3.vanguard.test', 'proposed', v_prev || '{"scope":"org"}');
    s := s || ' scope_malo=ENTRO';
  exception when check_violation then s := s || ' scope_malo=23514';
  end;
  begin
    insert into public.actions (org_id, kind, target, status, previous)
      values (v_org, 'under_attack_on', 'x4.vanguard.test', 'proposed', v_prev - 'scope');
    s := s || ' sin_scope=ENTRO';
  exception when check_violation then s := s || ' sin_scope=23514';
  end;
  begin
    insert into public.actions (org_id, kind, target, status, previous)
      values (v_org, 'under_attack_on', 'x5.vanguard.test', 'proposed', '["connection_id", "zone_id"]');
    s := s || ' array=ENTRO';
  exception when check_violation then s := s || ' array=23514';
  end;
  insert into public.actions (org_id, kind, target, status) values (v_org, 'block_ip', 'x6.vanguard.test', 'proposed');
  s := s || ' block_sin_previous=ok';
  insert into public.actions (org_id, kind, target, status, previous)
    values (v_org, 'under_attack_on', 'vanguard.test', 'proposed', v_prev || '{"scope":"zone"}');
  s := s || ' zona=ok | ';

  -- 9) esquema: un índice y un check (reaplicar la migración no los duplica)
  s := s || '9 esquema: indice=' || (select count(*) from pg_indexes
                                       where schemaname = 'public' and indexname = 'actions_bajo_ataque_vivo_uq')
         || ' check=' || (select count(*) from pg_constraint
                            where conname = 'actions_bajo_ataque_previous_chk' and conrelid = 'public.actions'::regclass)
         || ' | ';

  -- 10) privilegios: 0008h sigue valiendo para actions
  s := s || '10 privilegios anon/auth: ' || has_table_privilege('anon', 'public.actions', 'select') || '/'
         || has_table_privilege('authenticated', 'public.actions', 'select');
  raise exception 'RESULTADO %', s;
end $$;
