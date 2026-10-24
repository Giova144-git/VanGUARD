-- supabase/tests/rls.sql · literal de PLAN_MAESTRO §05.12. Se corre tras 0008 y tras cada migración posterior con
-- execute_sql del MCP o el editor SQL (antes falla por tablas que aún no existen; hasta 0008 basta con
-- `select tablename from pg_tables where schemaname = 'public' and not rowsecurity` = 0 filas). Termina en ERROR si algo falla.
do $$
declare bad text[] := '{}'; r record;
begin
  if has_table_privilege('authenticated', 'public.connection_secrets', 'select') then bad := bad || 'secrets legibles'::text; end if;
  if has_table_privilege('authenticated', 'public.approvals', 'select') then bad := bad || 'approvals legibles'::text; end if;
  if has_table_privilege('anon', 'public.findings', 'select') then bad := bad || 'anon lee findings'::text; end if;
  if has_table_privilege('authenticated', 'public.findings', 'update') then bad := bad || 'authenticated escribe'::text; end if;
  if has_column_privilege('authenticated', 'public.contacts', 'phone_e164', 'select') then bad := bad || 'telefonos visibles'::text; end if;
  if has_table_privilege('authenticated', 'vault.decrypted_secrets', 'select') then bad := bad || 'vault legible'::text; end if;
  if has_function_privilege('authenticated', 'public.vg_crypto_material(int)', 'execute') then bad := bad || 'material ejecutable'::text; end if;
  for r in select tablename t from pg_tables where schemaname = 'public' and not rowsecurity loop
    bad := bad || ('sin RLS: ' || r.t); end loop;
  for r in select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.prosecdef
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') loop
    bad := bad || ('definer sin search_path: ' || r.f); end loop;
  for r in select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') loop
    bad := bad || ('anon ejecuta: ' || r.f); end loop;
  for r in select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef and p.proname <> 'join_demo_org'
             and has_function_privilege('authenticated', p.oid, 'execute') loop     -- vg_ai_reserve, vg_upsert_*…: solo service_role
    bad := bad || ('authenticated ejecuta: ' || r.f); end loop;
  for r in select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'v')
             and has_table_privilege('authenticated', c.oid, 'insert, update, delete') loop
    bad := bad || ('authenticated escribe en: ' || r.t); end loop;
  if cardinality(bad) > 0 then raise exception 'rls.sql FALLA: %', array_to_string(bad, ' | '); end if;
end $$;
-- Aislamiento con JWT simulado (datos de dev-idor.sql; begin/rollback: no cambia nada en el proyecto): debe devolver 0
begin;
select set_config('request.jwt.claims', json_build_object('sub', id, 'role', 'authenticated')::text, true)
  from auth.users where email = 'idor-a@vanguard.test';
set local role authenticated;
select count(*) as debe_ser_0 from public.findings where org_id = '00000000-0000-4000-a000-00000000b002';
rollback;
