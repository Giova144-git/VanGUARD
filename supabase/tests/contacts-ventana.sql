-- supabase/tests/contacts-ventana.sql · 0008i: vg_replace_contacts conserva wa_last_inbound_at y optin_at (y verified_at)
-- de los teléfonos que siguen en la lista, aunque cambie el nombre; un teléfono nuevo nace sin ellos y uno que sale de la
-- lista se borra. anon y authenticated no leen las columnas nuevas.
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0008i. Siempre termina en ERROR a propósito: el
-- mensaje lleva el resultado y la excepción deshace todo (no queda ningún contacto de prueba en la org idor-a).
-- Resultado esperado:
--   mismo id:true | nombre:Persona Renombrada | wa_last_inbound_at:true | optin_at:true | verified_at:true |
--   nuevo sin ventana:true | borrado:true | authenticated lee:false | anon lee:false
do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'idor-a');
  v_t timestamptz := now() - interval '2 hours';
  v_id uuid;
  c public.contacts;
  r text := '';
begin
  if v_org is null then raise exception 'RESULTADO falta la org idor-a'; end if;
  -- Teléfonos ficticios (+1 555 01xx): no son de nadie.
  insert into public.contacts (org_id, name, phone_e164, whatsapp, voice, priority)
    values (v_org, 'Persona Prueba', '+15550100991', true, false, 1) returning id into v_id;
  update public.contacts set wa_last_inbound_at = v_t, optin_at = v_t, verified_at = v_t where id = v_id;

  -- La misma lista con otro nombre, más un teléfono nuevo: el upsert no debe tocar las columnas de 0008i.
  perform public.vg_replace_contacts(v_org, jsonb_build_array(
    jsonb_build_object('name', 'Persona Renombrada', 'phone_e164', '+15550100991', 'whatsapp', true, 'voice', false, 'priority', 1),
    jsonb_build_object('name', 'Persona Nueva', 'phone_e164', '+15550100992', 'whatsapp', true, 'voice', false, 'priority', 2)));
  select * into c from public.contacts where org_id = v_org and phone_e164 = '+15550100991';
  r := r || 'mismo id:' || (c.id is not distinct from v_id)
         || ' | nombre:' || coalesce(c.name, '(sin fila)')
         || ' | wa_last_inbound_at:' || (c.wa_last_inbound_at is not distinct from v_t)
         || ' | optin_at:' || (c.optin_at is not distinct from v_t)
         || ' | verified_at:' || (c.verified_at is not distinct from v_t) || ' | ';
  select * into c from public.contacts where org_id = v_org and phone_e164 = '+15550100992';
  r := r || 'nuevo sin ventana:'
         || (c.id is not null and c.wa_last_inbound_at is null and c.optin_at is null and c.verified_at is null) || ' | ';

  -- Sin el teléfono en la lista, su fila se borra (y con ella su ventana): si vuelve, empieza de cero.
  perform public.vg_replace_contacts(v_org, jsonb_build_array(
    jsonb_build_object('name', 'Persona Nueva', 'phone_e164', '+15550100992', 'whatsapp', true, 'voice', false, 'priority', 1)));
  r := r || 'borrado:' || (not exists (select 1 from public.contacts where id = v_id)) || ' | ';

  -- 0008h: nada para anon ni authenticated en public, tampoco en las columnas nuevas.
  r := r || 'authenticated lee:'
         || (has_column_privilege('authenticated', 'public.contacts', 'wa_last_inbound_at', 'SELECT')
             or has_column_privilege('authenticated', 'public.contacts', 'optin_at', 'SELECT'))
         || ' | anon lee:'
         || (has_column_privilege('anon', 'public.contacts', 'wa_last_inbound_at', 'SELECT')
             or has_column_privilege('anon', 'public.contacts', 'optin_at', 'SELECT'));
  raise exception 'RESULTADO %', r;
end $$;
